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
  setProviderZdr,
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
import { colibriAdvisory, probeColibri, requireSlowAcknowledgement } from '../providers/colibri.ts';
import { resetHealth } from '../providers/health.ts';
import { puterAdvisory } from '../providers/puter.ts';
import { redactionCheckEnabled, zdrRequirement } from '../db/settings.ts';
import { egressClassFor, isLoopbackHost, tryEgressProxy } from '../services/safety/outbound.ts';
import { zdrStatusFor } from '../services/safety/zdr.ts';
import { isProviderType, PROVIDER_TYPES, ZDR_FLAG_LOCATIONS, ZDR_SUPPORTS } from '../types/core.ts';
import { AppError } from '../util/errors.ts';
import { wrap } from './errors.ts';
import { asBool, asEnum, asNumber, asPositiveInteger, asString, body, pathParam, queryBool } from './params.ts';

import type { ZdrRequestFlag } from '../types/core.ts';

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
      // `null` and absent both mean "no proxy"; the repository parses whatever it
      // is given and rejects an unusable URL before writing anything.
      egressProxy: input.egressProxy === undefined || input.egressProxy === null
        ? null
        : asString(input.egressProxy, 'egressProxy'),
      // The declared context ceiling (1.28). `asPositiveInteger` refuses zero and
      // fractions with `details.field`; the repository refuses them too, for the
      // callers that never pass through this route.
      maxContextTokens: input.maxContextTokens === undefined || input.maxContextTokens === null
        ? null
        : (asPositiveInteger(input.maxContextTokens, 'maxContextTokens') ?? null),
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

/**
 * What a Puter provider is configured with, where the credential comes from, and
 * where its model list is read from (1.38).
 *
 * Advertised rather than left to documentation because three things about this
 * provider are unlike every other one here: the credential is a minted access
 * token rather than a vendor key, the model catalogue is not `{base}/models`, and
 * the OpenAI-compatible endpoint is a paid-plan feature. A form can state all
 * three before the token is pasted — `requiresPaidPlan` is the one that saves a
 * free-plan user from discovering it through a 402 on their first message.
 */
providersRouter.get(
  '/puter/advisory',
  wrap((_req, res) => {
    res.json(puterAdvisory());
  }),
);

/**
 * The caveat a client must show before enabling a Colibrì provider, plus the
 * suggested base URL for the create form. Read-only: registering and enabling
 * remain explicit, separate acts.
 */
providersRouter.get(
  '/colibri/advisory',
  wrap((_req, res) => {
    res.json(colibriAdvisory());
  }),
);

/**
 * Probe a candidate Colibrì endpoint. Unlike `/detect-local` this registers
 * nothing: Colibrì is added by hand, and the probe exists to confirm the URL
 * before saving it. A miss is 200 with `detected: false`, same as detect-local.
 */
providersRouter.post(
  '/colibri/probe',
  wrap(async (req, res) => {
    const baseUrl = body(req).baseUrl;
    const result = await probeColibri(
      typeof baseUrl === 'string' && baseUrl.trim() !== '' ? baseUrl : undefined,
    );
    res.json({ ...result, defaultBaseUrl: colibriAdvisory().defaultBaseUrl });
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

/**
 * The active provider, whether talking to it leaves the machine, and what its
 * retention story is.
 *
 * Declared above `/:id` deliberately. Express matches in registration order, so
 * with this below the parameter route the literal segment would be read as a
 * provider id and answered `not_found: No provider with id "active"` — which is
 * exactly what a bare `/active` did before this route existed.
 *
 * `egress` and `zdr` are both served here rather than computed in the frontend so
 * there is one definition of which provider types are remote and one of what a
 * given set of recorded facts amounts to. A UI that hardcoded either would keep
 * saying "stays on this machine" after a new remote provider type shipped, or keep
 * calling a status "confirmed" after the rules changed, and nothing would fail
 * loudly enough to notice.
 *
 * 200 with `provider: null` when nothing is enabled: having no active provider
 * is a legitimate state the settings screen has to render, not an error.
 */
providersRouter.get(
  '/active',
  wrap((_req, res) => {
    const active = getActiveProvider();
    const proxy = tryEgressProxy(active?.egressProxy ?? null);
    res.json({
      provider: active ? toPublic(active) : null,
      egress: egressClassFor(active),
      redactionCheckEnabled: redactionCheckEnabled(),
      /**
       * Honest disclosure for the point-of-action privacy line (Part 1.37).
       *
       * Structured rather than a boolean because two different sentences have to
       * be derivable: "this goes through a proxy" and "this goes through a proxy
       * that is not on this machine". The second is the one that changes what the
       * egress class above means, and a frontend that had only a flag would end
       * up asserting the first while the class said `remote` for reasons it could
       * not name. `redacted` is the only URL form that crosses the wire — the
       * credentials in a proxy URL are a secret this interface has never carried.
       */
      egressProxy:
        proxy === null
          ? null
          : {
              redacted: proxy.redacted,
              authority: proxy.authority,
              scheme: proxy.scheme,
              hasCredentials: proxy.hasCredentials,
              offMachine: !isLoopbackHost(proxy.host),
            },
      zdr: {
        // Null rather than a status when nothing is enabled: there is no request
        // this would describe, and inventing `zdr_unknown` would read as a fact
        // about a provider that does not exist.
        status: active ? zdrStatusFor(active) : null,
        requirement: zdrRequirement(),
      },
    });
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
      egressProxy: input.egressProxy === undefined
        ? undefined
        : (input.egressProxy === null ? null : asString(input.egressProxy, 'egressProxy')),
      maxContextTokens: input.maxContextTokens === undefined
        ? undefined
        : (input.maxContextTokens === null
          ? null
          : (asPositiveInteger(input.maxContextTokens, 'maxContextTokens') ?? null)),
    });
    res.json({ provider: toPublic(provider) });
  }),
);

/**
 * Record what is known about this provider's zero-data-retention behaviour.
 *
 * Its own subroute rather than a nested field on `PATCH /:id`, for two reasons.
 * The generic patch is a "leave undefined alone" partial update, and ZDR needs
 * tri-state semantics of its own on `requestFlag` plus a `confirmed` flag whose
 * `false` clears two columns — expressing that through a nested optional object
 * makes "not sent" and "sent as cleared" indistinguishable. And `confirmed: true`
 * is a user attestation, not a settings edit; it deserves a request the user
 * cannot make by accident while renaming a provider.
 *
 * `requestFlag` is tri-state: absent leaves the stored flag alone, `null` removes
 * it, an object replaces it. `confirmed` is deliberately not defaulted — omitting
 * it preserves an existing attestation, so recording a new support value does not
 * silently discard one.
 */
providersRouter.put(
  '/:id/zdr',
  wrap((req, res) => {
    const input = body(req);

    const support = asEnum(input.support, 'support', ZDR_SUPPORTS);
    if (support === undefined) {
      throw new AppError('bad_request', 'support is required.', {
        details: { field: 'support', allowed: ZDR_SUPPORTS },
      });
    }

    let requestFlag: ZdrRequestFlag | null | undefined;
    if (input.requestFlag === null) {
      requestFlag = null;
    } else if (input.requestFlag !== undefined) {
      const raw = input.requestFlag;
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new AppError('bad_request', 'requestFlag must be an object or null.', {
          details: { field: 'requestFlag' },
        });
      }
      const flag = raw as Record<string, unknown>;
      const location = asEnum(flag.location, 'requestFlag.location', ZDR_FLAG_LOCATIONS);
      if (location === undefined) {
        throw new AppError('bad_request', 'requestFlag.location is required.', {
          details: { field: 'requestFlag.location', allowed: ZDR_FLAG_LOCATIONS },
        });
      }
      requestFlag = {
        location,
        key: asString(flag.key, 'requestFlag.key'),
        // Not `asOptionalString`: a flag with no value sends nothing, and storing
        // one would make `zdrStatusFor` report a request that was never made.
        // The credential check on this value lives in `setProviderZdr`.
        value: asString(flag.value, 'requestFlag.value'),
      };
    }

    const provider = setProviderZdr(pathParam(req, 'id'), {
      support,
      ...(requestFlag !== undefined ? { requestFlag } : {}),
      ...(input.confirmed === undefined
        ? {}
        : { confirmed: asBool(input.confirmed, 'confirmed') === true }),
      ...(input.note === undefined ? {} : { note: input.note === null ? null : asString(input.note, 'note') }),
    });

    res.json({ provider: toPublic(provider) });
  }),
);

providersRouter.delete(
  '/:id',
  wrap((req, res) => {
    const id = pathParam(req, 'id');
    deleteProvider(id);
    // The row is gone, so nothing can read this provider's runtime state again:
    // its health tracker and its cooldown are keyed by an id no row holds and
    // would sit in this process until it exits. `resetHealth` is the single entry
    // point for "what we concluded about this provider no longer applies" — it
    // already covers editing the key, testing the connection and re-enabling —
    // and deleting is the gesture that makes the state unreadable rather than
    // merely stale. Found by deleting a provider live while testing 1.36's
    // disclosure and noticing the cooldown outlived the row.
    resetHealth(id);
    res.status(204).end();
  }),
);

/**
 * Enabling one provider disables the previously active one (standby).
 *
 * A Colibrì provider additionally requires `acknowledgeSlow: true`, and is
 * refused with a 400 carrying the caveat text until it arrives. The gate sits
 * here rather than in `enableProvider()` on purpose — automatic failover calls
 * that function to promote a standby, and gating it there would make Colibrì
 * unusable as a fallback at exactly the moment it is wanted.
 */
providersRouter.post(
  '/:id/enable',
  wrap((req, res) => {
    const id = pathParam(req, 'id');
    const acknowledged = asBool(body(req).acknowledgeSlow, 'acknowledgeSlow') === true;
    requireSlowAcknowledgement(requireProvider(id), acknowledged);

    const provider = enableProvider(id);
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
