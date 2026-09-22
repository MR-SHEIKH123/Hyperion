/**
 * Provider registry: the live model list and the capability question.
 *
 * There is no curated model catalogue in this app. Whatever the active provider
 * reports is what exists, identified by its raw provider-side ID. That makes the
 * model list a network resource, so it is cached — with a TTL, in the DB rather
 * than in memory, so a restart does not blank the model picker.
 *
 * The cache has a second, more important job: it answers the *capability* check
 * before a request is sent. "Does this provider even offer this model?" must be
 * answerable without spending an upstream call to find out.
 */
import { env } from '../config/env.ts';
import { DEFAULT_CONTEXT_TOKENS, OLLAMA_DEFAULT_CONTEXT_TOKENS } from '../services/agent/compaction.ts';
import { AppError } from '../util/errors.ts';
import { createLogger } from '../util/logger.ts';
import { adapterFor, detectLocalProvider } from './adapters.ts';
import {
  createProvider,
  findProvider,
  findProviderByName,
  getActiveProvider,
  listFailoverCandidates,
  listProviders,
  requireActiveProvider,
  saveModelCache,
  saveModelCacheError,
  updateProvider,
} from './repository.ts';
import type { ModelInfo, ProviderRecord } from '../types/core.ts';

const log = createLogger('registry');

/** Name reserved for the auto-detected local runner, so re-detecting updates it. */
export const LOCAL_PROVIDER_NAME = 'Ollama (local)';

function isFresh(provider: ProviderRecord): boolean {
  return (
    provider.models !== null &&
    provider.modelsFetchedAt !== null &&
    Date.now() - provider.modelsFetchedAt < env.modelCacheTtlMs
  );
}

/**
 * Models for a provider, from cache when fresh.
 *
 * On a refresh failure with a usable stale cache, the stale list is returned
 * rather than an error: a momentary blip upstream should not empty the model
 * dropdown the user is looking at. The failure is recorded in `models_error` so
 * the UI can show that the list may be out of date.
 */
export async function getModels(
  provider: ProviderRecord,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<ModelInfo[]> {
  if (!options.force && isFresh(provider)) {
    return provider.models ?? [];
  }

  try {
    const models = await adapterFor(provider).listModels(provider, options.signal);
    saveModelCache(provider.id, models);
    log.debug('model list refreshed', { provider: provider.name, count: models.length });
    return models;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    saveModelCacheError(provider.id, message);

    if (provider.models !== null) {
      log.warn('model refresh failed; serving stale cache', {
        provider: provider.name,
        reason: message,
      });
      return provider.models;
    }
    throw error;
  }
}

/** Models for the currently enabled provider — backs GET /api/providers/active/models. */
export async function getActiveModels(
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<{ provider: ProviderRecord; models: ModelInfo[] }> {
  const provider = requireActiveProvider();
  return { provider, models: await getModels(provider, options) };
}

/**
 * The capability check.
 *
 * Deliberately cache-only and synchronous: it runs on the hot path before every
 * request, and a network call here would defeat the purpose of avoiding one.
 * `null` means "no cache yet" and is distinct from `false` ("cached, and the
 * model is absent") — the caller must not treat unknown as a mismatch and
 * refuse to send.
 */
export function cachedSupportsModel(provider: ProviderRecord, modelId: string): boolean | null {
  if (provider.models === null) return null;
  return provider.models.some((model) => matchesModelId(model.id, modelId));
}

/**
 * Model IDs are compared loosely because gateways rewrite them: the same model
 * may be `gpt-4o`, `openai/gpt-4o` or `gpt-4o:latest` depending on the vendor.
 * Refusing an exact-match miss would produce false "not supported" errors for a
 * model the provider genuinely serves.
 */
export function matchesModelId(candidate: string, requested: string): boolean {
  if (candidate === requested) return true;
  return normalizeModelId(candidate) === normalizeModelId(requested);
}

function normalizeModelId(id: string): string {
  const lower = id.trim().toLowerCase();
  const withoutTag = lower.replace(/:latest$/, '');
  const lastSegment = withoutTag.slice(withoutTag.lastIndexOf('/') + 1);
  return lastSegment;
}

/**
 * Ensure a provider's model cache is populated, ignoring refresh failures.
 *
 * Used before routing: a fetch failure here should not abort the request, since
 * the request itself is about to test the provider anyway. An unpopulated cache
 * makes the capability check return `null` (unknown), which routes as "try it".
 */
export async function ensureModelsCached(
  provider: ProviderRecord,
  signal?: AbortSignal,
): Promise<ProviderRecord> {
  if (isFresh(provider)) return provider;
  try {
    const models = await getModels(provider, { signal });
    return { ...provider, models, modelsFetchedAt: Date.now() };
  } catch {
    return provider;
  }
}

// --- local runner ----------------------------------------------------------

export interface LocalDetectionResult {
  detected: boolean;
  baseUrl: string;
  models: ModelInfo[];
  attempts: number;
  reason?: string;
  /** Set only when detection succeeded and the provider row was created/updated. */
  providerId?: string;
}

/**
 * Probe for a local runner and register it if found.
 *
 * Failure is reported once and not retried in the background, per spec: if
 * Ollama is not running there is nothing to poll for, and a background scanner
 * would be a permanent source of log noise and wakeups on a machine that simply
 * does not have it installed.
 */
export async function detectAndRegisterLocal(
  baseUrl = env.ollamaUrl,
): Promise<LocalDetectionResult> {
  const result = await detectLocalProvider(baseUrl);

  if (!result.detected) {
    log.info('local provider not detected', { baseUrl, attempts: result.attempts });
    return result;
  }

  // Update-in-place, so repeated detection does not accumulate duplicate rows.
  const existing = findProviderByName(LOCAL_PROVIDER_NAME);
  const provider = existing
    ? updateProvider(existing.id, { baseUrl })
    : createProvider({ name: LOCAL_PROVIDER_NAME, type: 'local', baseUrl, priority: 200 });

  saveModelCache(provider.id, result.models);
  log.info('local provider detected', { baseUrl, models: result.models.length });

  return { ...result, providerId: provider.id };
}

// --- test connection -------------------------------------------------------

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  modelCount?: number;
  code?: string;
}

/**
 * Informational reachability test. Never throws — a failed test is a result to
 * display, not an error that should unwind whatever the user was doing.
 */
export async function testProviderConnection(
  provider: ProviderRecord,
): Promise<ConnectionTestResult> {
  try {
    const models = await adapterFor(provider).listModels(
      provider,
      AbortSignal.timeout(env.localDetectTimeoutMs * 4),
    );
    saveModelCache(provider.id, models);
    return {
      ok: true,
      message: `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`,
      modelCount: models.length,
    };
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    return {
      ok: false,
      message: appError?.message ?? (error instanceof Error ? error.message : String(error)),
      ...(appError ? { code: appError.code } : {}),
    };
  }
}

// --- summary ---------------------------------------------------------------

export interface RegistrySummary {
  activeProviderId: string | null;
  activeProviderName: string | null;
  providerCount: number;
  hasAnyProvider: boolean;
}

export function summarize(): RegistrySummary {
  const active = getActiveProvider();
  return {
    activeProviderId: active?.id ?? null,
    activeProviderName: active?.name ?? null,
    providerCount: listProviders().length,
    hasAnyProvider: listProviders().length > 0,
  };
}

/**
 * The ModelInfo for a model id, from caches only \u2014 active provider first, then
 * failover candidates in order.
 *
 * This runs at the start of every agent run, to size the context window, so it
 * must never fetch: a provider blip must not stand in front of work the user
 * can already see is possible. A miss everywhere returns null and the caller
 * reports the window as `assumed` \u2014 the request itself validates the model
 * when it goes out.
 */
/**
 * The declared context ceiling that applies to a run (Part 1.28).
 *
 * The window ladder's first rung, resolved in one place because four call sites
 * need it and they must agree: the chat context read, and the three agent loops.
 * A provider id picks that provider; nothing picks the active one, which is the
 * same choice `orchestrator/chat.ts` makes when a chat carries no provider of its
 * own.
 *
 * **What this deliberately does not do** is follow a mid-run failover. The window
 * is resolved once, at run start, from the provider that would serve — the model
 * cache is read at the same moment and for the same reason (a run start must not
 * wait on the network). A failover to a provider with a different declared ceiling
 * therefore leaves the run sized against the first one, which is stated here
 * rather than papered over: the alternative is re-deciding the window mid-stream,
 * and that would mean a compaction boundary that depends on which endpoint
 * happened to answer.
 */
export function contextWindowOverride(providerId?: string | null): number | undefined {
  const provider = providerId === undefined || providerId === null ? getActiveProvider() : findProvider(providerId);
  return provider?.maxContextTokens ?? undefined;
}

/**
 * The bottom rung for a provider that told us nothing (Part 1.28).
 *
 * Only the local runner differs, and it differs in the direction that matters:
 * Ollama loads a model with a 4 096-token window by default and **truncates**
 * input past it instead of refusing, so the gateway default of 8 192 would let a
 * conversation look like it fits while the model silently answered a shortened
 * prompt. Every other type keeps `DEFAULT_CONTEXT_TOKENS`.
 *
 * Resolved from the same provider the override is resolved from, so the two
 * rungs can never describe different endpoints — including the failover caveat
 * `contextWindowOverride` carries.
 */
export function contextWindowFallback(providerId?: string | null): number {
  const provider = providerId === undefined || providerId === null ? getActiveProvider() : findProvider(providerId);
  return provider?.type === 'local' ? OLLAMA_DEFAULT_CONTEXT_TOKENS : DEFAULT_CONTEXT_TOKENS;
}

export function findCachedModel(modelId: string): ModelInfo | null {
  const active = getActiveProvider();
  const candidates = [
    ...(active === null ? [] : [active]),
    ...listFailoverCandidates(active?.id),
  ];
  for (const provider of candidates) {
    const hit = provider.models?.find((model) => matchesModelId(model.id, modelId));
    if (hit !== undefined) return hit;
  }
  return null;
}
