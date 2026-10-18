import {
  activeModelsResponseSchema,
  activeProviderResponseSchema,
  colibriAdvisorySchema,
  colibriProbeSchema,
  connectionTestSchema,
  localDetectionSchema,
  providerEnabledResponseSchema,
  providerModelsResponseSchema,
  providerResponseSchema,
  providersResponseSchema,
  puterAdvisorySchema,
} from '../contracts/wire/providers';
import { request } from './client';
import { networkError, responseError } from './errors';

import type { providerTypeSchema } from '../contracts/wire/providers';
import type { z } from 'zod';

type ProviderType = z.infer<typeof providerTypeSchema>;

/**
 * Providers — the Settings 2.5 slice-1 client (docs/API.md §3).
 *
 * Every shape comes from the real handlers in `src/http/providers.ts`. Two
 * answers need naming because a surface built on a guess gets them wrong:
 * enable/disable spread the registry summary in beside the provider, and
 * DELETE answers 204 with no body, so it cannot go through `request()`
 * (which parses a JSON body) and is fetched here directly.
 *
 * No secret ever leaves this module in a log or an error: request bodies
 * carrying `apiKey` are handed to `fetch` and nowhere else, and every read
 * shape carries `hasKey`/`apiKeyHint` only.
 */

export interface CreateProviderInput {
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey?: string | null;
  priority?: number;
  enabled?: boolean;
  egressProxy?: string | null;
  maxContextTokens?: number | null;
}

export interface UpdateProviderInput {
  name?: string;
  baseUrl?: string;
  priority?: number;
  apiKey?: string | null;
  egressProxy?: string | null;
  maxContextTokens?: number | null;
}

export interface ProviderZdrInput {
  support: 'unknown' | 'supported_default' | 'supported_opt_in' | 'not_supported' | 'not_applicable';
  requestFlag?: { location: 'header' | 'body'; key: string; value: string } | null;
  confirmed?: boolean;
  note?: string | null;
}

export const getProviders = (signal?: AbortSignal) =>
  request('/api/providers', providersResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export const getProvider = (id: string, signal?: AbortSignal) =>
  request(`/api/providers/${encodeURIComponent(id)}`, providerResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export const getActiveProvider = (signal?: AbortSignal) =>
  request('/api/providers/active', activeProviderResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export const getActiveModels = (signal?: AbortSignal) =>
  request('/api/providers/active/models', activeModelsResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export const createProvider = (input: CreateProviderInput, signal?: AbortSignal) =>
  request('/api/providers', providerResponseSchema, {
    method: 'POST',
    body: input,
    ...(signal === undefined ? {} : { signal }),
  });

export const updateProvider = (id: string, input: UpdateProviderInput, signal?: AbortSignal) =>
  request(`/api/providers/${encodeURIComponent(id)}`, providerResponseSchema, {
    method: 'PATCH',
    body: input,
    ...(signal === undefined ? {} : { signal }),
  });

/** 204, no body — the one provider answer `request()` cannot parse. */
export async function deleteProvider(id: string, signal?: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/providers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok) throw await responseError(response);
}

export const enableProvider = (
  id: string,
  options: { acknowledgeSlow?: boolean; signal?: AbortSignal } = {},
) =>
  request(`/api/providers/${encodeURIComponent(id)}/enable`, providerEnabledResponseSchema, {
    method: 'POST',
    body: options.acknowledgeSlow === true ? { acknowledgeSlow: true } : {},
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

export const disableProvider = (id: string, signal?: AbortSignal) =>
  request(`/api/providers/${encodeURIComponent(id)}/disable`, providerEnabledResponseSchema, {
    method: 'POST',
    body: {},
    ...(signal === undefined ? {} : { signal }),
  });

export const getProviderModels = (id: string, refresh = false, signal?: AbortSignal) =>
  request(
    `/api/providers/${encodeURIComponent(id)}/models${refresh ? '?refresh=true' : ''}`,
    providerModelsResponseSchema,
    { ...(signal === undefined ? {} : { signal }) },
  );

/** Informational only: a failed test is a result to show, not a thrown error. */
export const testProvider = (id: string, signal?: AbortSignal) =>
  request(`/api/providers/${encodeURIComponent(id)}/test`, connectionTestSchema, {
    method: 'POST',
    body: {},
    ...(signal === undefined ? {} : { signal }),
  });

export const detectLocal = (baseUrl?: string, signal?: AbortSignal) =>
  request('/api/providers/detect-local', localDetectionSchema, {
    method: 'POST',
    body: baseUrl === undefined || baseUrl.trim() === '' ? {} : { baseUrl },
    ...(signal === undefined ? {} : { signal }),
  });

export const getPuterAdvisory = (signal?: AbortSignal) =>
  request('/api/providers/puter/advisory', puterAdvisorySchema, { ...(signal === undefined ? {} : { signal }) });

export const getColibriAdvisory = (signal?: AbortSignal) =>
  request('/api/providers/colibri/advisory', colibriAdvisorySchema, { ...(signal === undefined ? {} : { signal }) });

export const probeColibri = (baseUrl?: string, signal?: AbortSignal) =>
  request('/api/providers/colibri/probe', colibriProbeSchema, {
    method: 'POST',
    body: baseUrl === undefined || baseUrl.trim() === '' ? {} : { baseUrl },
    ...(signal === undefined ? {} : { signal }),
  });

export const setProviderZdr = (id: string, input: ProviderZdrInput, signal?: AbortSignal) =>
  request(`/api/providers/${encodeURIComponent(id)}/zdr`, providerResponseSchema, {
    method: 'PUT',
    body: input,
    ...(signal === undefined ? {} : { signal }),
  });
