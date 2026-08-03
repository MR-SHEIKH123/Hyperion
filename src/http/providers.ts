/**
 * Provider registry endpoints.
 *
 * Every provider leaves this layer through `toPublic()`, which strips the
 * encrypted key and exposes only `hasKey` plus a last-4 hint. That conversion
 * is the reason no route here returns a `ProviderRecord` directly.
 */

import { Router } from 'express';

import {
  createProvider,
  deleteProvider,
  disableProvider,
  enableProvider,
  getActiveProvider,
  listProviders,
  requireProvider,
  toPublic,
  updateProvider,
} from '../providers/repository.ts';
import {
  detectAndRegisterLocal,
  getActiveModels,
  getModels,
  summarize,
  testProviderConnection,
} from '../providers/registry.ts';
import { isProviderType, PROVIDER_TYPES } from '../types/core.ts';
import { AppError } from '../util/errors.ts';
import { wrap } from './errors.ts';
import { asBool, asNumber, asString, body, pathParam, queryBool } from './params.ts';

export const providersRouter: Router = Router();

providersRouter.get(
  '/',
  wrap((_req, res) => {
    res.json({ providers: listProviders().map(toPublic), ...summarize() });
  }),
);

providersRouter.post(
  '/',
  wrap((req, res) => {
    const input = body(req);
    const type = asString(input.type, 'type');
    // Validated against the shared union rather than a hard-coded pair, so
    // adding a provider type in one place cannot leave this route rejecting it.
    if (!isProviderType(type)) {
      throw new AppError(
        'bad_request',
        `type must be one of ${PROVIDER_TYPES.map((t) => `"${t}"`).join(', ')}.`,
        { details: { field: 'type', allowed: PROVIDER_TYPES } },
      );
    }
    // `enabled` comes from the body only. Nothing here activates a provider on
    // the caller's behalf: `detectAndRegisterLocal` stays the sole auto-register
    // path and it only ever creates type 'local', so an opencodex proxy is never
    // switched on without an explicit request.
    const provider = createProvider({
      name: asString(input.name, 'name'),
      type,
      baseUrl: asString(input.baseUrl, 'baseUrl'),
      apiKey: input.apiKey === undefined ? null : asString(input.apiKey, 'apiKey'),
      priority: asNumber(input.priority, 'priority'),
      enabled: asBool(input.enabled, 'enabled'),
    });
    res.status(201).json({ provider: toPublic(provider) });
  }),
);

/**
 * Local-runner detection. A miss is a normal, final answer — the spec is
 * explicit that there is no background re-scanning — so it returns 200 with
 * `detected: false` rather than an error the frontend has to special-case.
 */
providersRouter.post(
  '/detect-local',
  wrap(async (req, res) => {
    const baseUrl = body(req).baseUrl;
    const result = await detectAndRegisterLocal(
      typeof baseUrl === 'string' && baseUrl.trim() !== '' ? baseUrl : undefined,
    );
    res.json(result);
  }),
);

/** Models from whichever provider is active. No curated list anywhere. */
providersRouter.get(
  '/active/models',
  wrap(async (req, res) => {
    const { provider, models } = await getActiveModels({ force: queryBool(req, 'refresh') === true });
    res.json({ providerId: provider.id, providerName: provider.name, models });
  }),
);

providersRouter.get(
  '/:id',
  wrap((req, res) => {
    res.json({ provider: toPublic(requireProvider(pathParam(req, 'id'))) });
  }),
);

providersRouter.patch(
  '/:id',
  wrap((req, res) => {
    const input = body(req);
    const provider = updateProvider(pathParam(req, 'id'), {
      name: input.name === undefined ? undefined : asString(input.name, 'name'),
      baseUrl: input.baseUrl === undefined ? undefined : asString(input.baseUrl, 'baseUrl'),
      priority: asNumber(input.priority, 'priority'),
      apiKey: input.apiKey === undefined ? undefined : (input.apiKey === null ? null : asString(input.apiKey, 'apiKey')),
    });
    res.json({ provider: toPublic(provider) });
  }),
);

providersRouter.delete(
  '/:id',
  wrap((req, res) => {
    deleteProvider(pathParam(req, 'id'));
    res.status(204).end();
  }),
);

/** Enabling one provider disables the previously active one (standby). */
providersRouter.post(
  '/:id/enable',
  wrap((req, res) => {
    const provider = enableProvider(pathParam(req, 'id'));
    res.json({ provider: toPublic(provider), ...summarize() });
  }),
);

providersRouter.post(
  '/:id/disable',
  wrap((req, res) => {
    res.json({ provider: toPublic(disableProvider(pathParam(req, 'id'))), ...summarize() });
  }),
);

providersRouter.get(
  '/:id/models',
  wrap(async (req, res) => {
    const provider = requireProvider(pathParam(req, 'id'));
    const models = await getModels(provider, { force: queryBool(req, 'refresh') === true });
    res.json({ providerId: provider.id, models });
  }),
);

/** Informational only — never a gate on saving a provider. */
providersRouter.post(
  '/:id/test',
  wrap(async (req, res) => {
    res.json(await testProviderConnection(requireProvider(pathParam(req, 'id'))));
  }),
);

providersRouter.get(
  '/active/current',
  wrap((_req, res) => {
    const active = getActiveProvider();
    res.json({ provider: active ? toPublic(active) : null });
  }),
);
