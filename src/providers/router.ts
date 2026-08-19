/**
 * Request routing: which provider serves this request, and what happens when it
 * fails.
 *
 * The two failure modes the spec insists on separating are separated here:
 *
 *   CAPABILITY MISMATCH — the provider does not offer the requested model at
 *     all. Not retryable, and not worth a round trip to discover: the cached
 *     model list is consulted *before* dispatch, and if the model is absent we
 *     switch to a provider that has it, or fail with `no_provider_for_model`.
 *     Zero upstream calls wasted.
 *
 *   HEALTH FAILURE — the provider offers the model but the request errors or
 *     times out. This is where the 2-consecutive-failures-in-20s threshold
 *     applies (see health.ts). Tripping it evicts the provider and fails over.
 *
 * One rule governs everything else in this file: FAILOVER IS ONLY TRANSPARENT
 * BEFORE THE FIRST TOKEN. Once the model has emitted output, silently restarting
 * on another provider would duplicate or contradict text the user has already
 * read. After first output, a failure is surfaced to the caller with the partial
 * text intact, and the run pauses instead. That is the pause-never-crash
 * contract, and it is why `stream()` yields events rather than just returning.
 */
import { AppError, toAppError } from '../util/errors.ts';
import { createLogger } from '../util/logger.ts';
import { adapterFor } from './adapters.ts';
import { recordFailure, recordSuccess, resetHealth } from './health.ts';
import { cachedSupportsModel, ensureModelsCached } from './registry.ts';
import {
  enableProvider,
  getActiveProvider,
  listFailoverCandidates,
  requireProvider,
} from './repository.ts';
import type { CompletionRequest, ProviderRecord, TokenUsage, ToolCall } from '../types/core.ts';

const log = createLogger('router');

/** Why the router moved off the provider it started with. */
export type SwitchReason = 'capability_mismatch' | 'health_failure';

export type RouteEvent =
  /** Always first. Tells the caller which provider actually got the request. */
  | { type: 'provider'; provider: ProviderRecord; modelId: string; attempt: number }
  | { type: 'token'; text: string }
  /**
   * A tool call the model requested. Forwarded rather than swallowed so the
   * agent loop above sees it; failover treats it as output, because a provider
   * that has already asked for a tool cannot be swapped out mid-decision.
   */
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: TokenUsage }
  /** A different provider is about to be tried. Emitted before any of its output. */
  | { type: 'switched'; from: ProviderRecord; to: ProviderRecord; reason: SwitchReason; message: string }
  | { type: 'done'; finishReason?: string };

export interface RouteOptions {
  /** Force a specific provider (a manual switch); skips active-provider lookup. */
  providerId?: string;
  /**
   * Make the chosen provider the app-wide active one. Default true: with a
   * single-active-provider model, routing elsewhere and leaving the old one
   * flagged active would make the UI lie about what is serving requests.
   */
  makeActive?: boolean;
  /** Disable failover entirely (used by test-connection style calls). */
  noFailover?: boolean;
}

// --- selection -------------------------------------------------------------

export interface Selection {
  provider: ProviderRecord;
  /** True when the requested provider could not serve the model. */
  switched: boolean;
  from?: ProviderRecord;
  reason?: SwitchReason;
  message?: string;
}

/**
 * Pick a provider for `modelId`, applying the capability check.
 *
 * An empty/unknown model cache is treated as "might work", not as a mismatch:
 * refusing to send because we have not managed to fetch a model list yet would
 * turn a transient listing failure into a hard outage.
 */
export async function selectProvider(
  modelId: string,
  options: RouteOptions = {},
): Promise<Selection> {
  const start = options.providerId ? requireProvider(options.providerId) : getActiveProvider();

  if (!start) {
    throw new AppError(
      'no_active_provider',
      'No provider is enabled. Enable a provider in Settings before sending a request.',
    );
  }

  const primed = await ensureModelsCached(start);
  const supported = cachedSupportsModel(primed, modelId);

  if (supported !== false) {
    // Either confirmed present, or unknown — in both cases, try it.
    return { provider: primed, switched: false };
  }

  // Confirmed absent. Look for someone who does have it, without sending
  // anything upstream to the provider we already know cannot serve it.
  const alternative = await findProviderWithModel(modelId, primed.id);
  if (!alternative) {
    throw new AppError(
      'no_provider_for_model',
      `No configured provider offers the model "${modelId}". ` +
        `${primed.name} does not list it. Pick a different model, or add a provider that serves it.`,
      { retryable: false, details: { modelId, checkedProvider: primed.name } },
    );
  }

  return {
    provider: alternative,
    switched: true,
    from: primed,
    reason: 'capability_mismatch',
    message: `${primed.name} does not offer "${modelId}"; using ${alternative.name} instead.`,
  };
}

/**
 * Find a configured provider whose cached list contains `modelId`.
 *
 * Only cached lists are consulted for providers that have one. A provider with
 * no cache at all gets one refresh attempt, because otherwise a newly added
 * provider could never be discovered as a fallback.
 */
async function findProviderWithModel(
  modelId: string,
  excludeId: string,
): Promise<ProviderRecord | null> {
  const candidates = listFailoverCandidates(excludeId);

  for (const candidate of candidates) {
    if (cachedSupportsModel(candidate, modelId) === true) return candidate;
  }

  for (const candidate of candidates) {
    if (candidate.models !== null) continue; // already checked above
    const primed = await ensureModelsCached(candidate);
    if (cachedSupportsModel(primed, modelId) === true) return primed;
  }

  return null;
}

// --- streaming -------------------------------------------------------------

/**
 * Stream a completion, handling capability routing and health failover.
 *
 * Attempt policy, and why it is not a contradiction of "never auto-retry into
 * the same broken state":
 *
 *   - The health threshold is *two* consecutive failures. Reaching it therefore
 *     requires a second attempt. That second attempt is made against the same
 *     provider only when nothing has been emitted yet, so it costs the user
 *     nothing but latency and cannot duplicate output.
 *   - Once the threshold trips, the provider is evicted and a *different*
 *     provider is tried. Trying somewhere else is not retrying into the same
 *     broken state.
 *   - When neither of those applies, the error propagates and the caller pauses
 *     the run. Nothing retries after that without the user asking.
 */
export async function* stream(
  request: CompletionRequest,
  options: RouteOptions = {},
): AsyncGenerator<RouteEvent, void, unknown> {
  const selection = await selectProvider(request.modelId, options);

  let provider = selection.provider;
  if (selection.switched && selection.from) {
    yield {
      type: 'switched',
      from: selection.from,
      to: provider,
      reason: selection.reason ?? 'capability_mismatch',
      message: selection.message ?? '',
    };
  }
  if (options.makeActive !== false && !provider.enabled) {
    provider = enableProvider(provider.id);
  }

  const tried = new Set<string>();
  let attempt = 0;

  for (;;) {
    attempt++;
    tried.add(provider.id);
    yield { type: 'provider', provider, modelId: request.modelId, attempt };

    let emitted = false;

    try {
      for await (const chunk of adapterFor(provider).stream(provider, request)) {
        if (chunk.type === 'token') {
          emitted = true;
          yield { type: 'token', text: chunk.text };
        } else if (chunk.type === 'tool_call') {
          // Counts as output: the decision to call a tool is part of the answer,
          // so retrying it on another provider would duplicate a side effect.
          emitted = true;
          yield { type: 'tool_call', call: chunk.call };
        } else if (chunk.type === 'usage') {
          yield { type: 'usage', usage: chunk.usage };
        } else {
          yield { type: 'done', ...(chunk.finishReason ? { finishReason: chunk.finishReason } : {}) };
        }
      }
      recordSuccess(provider.id);
      return;
    } catch (error) {
      const appError = toAppError(error);

      // A user-initiated abort is not a provider fault and must not be retried,
      // failed over, or counted against health.
      if (appError.code === 'aborted') throw appError;

      const verdict = recordFailure(provider.id, appError);

      // Output already reached the user. Anything we do now risks duplicating or
      // contradicting it, so hand the failure up and let the run pause with the
      // partial text preserved.
      if (emitted) {
        log.warn('provider failed mid-output; pausing rather than failing over', {
          provider: provider.name,
          code: appError.code,
        });
        throw appError;
      }

      if (options.noFailover || !appError.retryable) throw appError;

      // Below the threshold: one more attempt on the same provider is what
      // *produces* the second data point the threshold needs.
      if (!verdict.unhealthy) {
        log.debug('retrying same provider before threshold', {
          provider: provider.name,
          consecutive: verdict.consecutive,
        });
        continue;
      }

      // Threshold tripped — evict and move on.
      const next = await pickHealthyAlternative(request.modelId, tried);
      if (!next) {
        log.warn('no healthy alternative provider', { failed: provider.name });
        throw new AppError(
          'no_healthy_provider',
          `${provider.name} is not responding, and no other configured provider can serve ` +
            `"${request.modelId}". The conversation is paused; your history is intact.`,
          { details: { failedProvider: provider.name, cause: appError.message }, retryable: false },
        );
      }

      yield {
        type: 'switched',
        from: provider,
        to: next,
        reason: 'health_failure',
        message: `${provider.name} failed ${verdict.consecutive} times; switched to ${next.name}.`,
      };

      // enableProvider disables the failed one in the same transaction, which is
      // exactly the "disable it and switch" the spec asks for. We deliberately do
      // NOT disable when there is no replacement: leaving the user with zero
      // active providers turns a recoverable blip into a dead app.
      provider = options.makeActive === false ? next : enableProvider(next.id);
    }
  }
}

/** Next provider that both serves the model and has not already been tried. */
async function pickHealthyAlternative(
  modelId: string,
  tried: Set<string>,
): Promise<ProviderRecord | null> {
  for (const candidate of listFailoverCandidates()) {
    if (tried.has(candidate.id)) continue;
    const primed = await ensureModelsCached(candidate);
    // `null` (unknown) is allowed through: an unprobed provider is worth trying
    // when the alternative is having none at all.
    if (cachedSupportsModel(primed, modelId) !== false) return primed;
  }
  return null;
}

// --- non-streaming ---------------------------------------------------------

export interface CompleteResult {
  text: string;
  usage: TokenUsage;
  provider: ProviderRecord;
  finishReason?: string;
}

/** Buffered convenience wrapper for agent modules that do not want a stream. */
export async function complete(
  request: CompletionRequest,
  options: RouteOptions = {},
): Promise<CompleteResult> {
  let text = '';
  let usage: TokenUsage = { tokensIn: 0, tokensOut: 0 };
  let provider: ProviderRecord | null = null;
  let finishReason: string | undefined;

  for await (const event of stream(request, options)) {
    if (event.type === 'token') text += event.text;
    else if (event.type === 'usage') usage = event.usage;
    else if (event.type === 'provider') provider = event.provider;
    else if (event.type === 'done') finishReason = event.finishReason;
  }

  if (!provider) {
    throw new AppError('internal_error', 'Stream completed without selecting a provider');
  }
  return { text, usage, provider, ...(finishReason ? { finishReason } : {}) };
}

/**
 * Clear a provider's failure streak so the next request is judged on its own
 * merits. Called when the user manually retries a paused run — an explicit
 * "try again" should not be pre-judged by the failures that caused the pause.
 */
export function clearFailureState(providerId: string): void {
  resetHealth(providerId);
}
