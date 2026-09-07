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
import { zdrRequirement } from '../db/settings.ts';
import { isZdrEligible, orderByZdr, zdrStatusFor } from '../services/safety/zdr.ts';
import type {
  CompletionRequest,
  ProviderRecord,
  TokenUsage,
  ToolCall,
  ZdrRequirement,
} from '../types/core.ts';

const log = createLogger('router');

/**
 * The refusal raised when the standing policy is `require` and nothing eligible
 * can serve the request.
 *
 * Built in one place because the message has work to do. With every provider
 * defaulting to `zdr_support = 'unknown'`, switching `require` on blocks every
 * remote provider until support is recorded per provider — correct fail-closed
 * behaviour that reads exactly like a bug unless the error says so plainly.
 */
function zdrRefusal(provider: ProviderRecord, modelId: string): AppError {
  const status = zdrStatusFor(provider);
  return new AppError(
    'zdr_requirement_unmet',
    `Zero data retention is set to "require", and ${provider.name} is recorded as "${status}". ` +
      `No other configured provider both offers "${modelId}" and satisfies the requirement. ` +
      'Record this provider\'s ZDR support, or lower the requirement in Settings. ' +
      'Providers start as "unknown", which never satisfies "require".',
    {
      retryable: false,
      details: { requirement: 'require', provider: provider.name, zdrStatus: status, modelId },
    },
  );
}

/**
 * The refusal raised when a *failover* finds candidates but the ZDR requirement
 * bars all of them.
 *
 * Deliberately `zdr_requirement_unmet` and not `no_healthy_provider`. Both stop
 * the run, but they mean opposite things: an outage lifts on its own and is worth
 * retrying, while a privacy refusal never will. Reporting this as an outage would
 * teach the user to wait for a recovery that cannot happen.
 */
function zdrFailoverRefusal(failed: ProviderRecord, modelId: string): AppError {
  return new AppError(
    'zdr_requirement_unmet',
    `${failed.name} is not responding, and every other configured provider that offers ` +
      `"${modelId}" is barred by the zero-data-retention requirement. The conversation is ` +
      'paused; your history is intact. Record ZDR support for one of those providers, or lower ' +
      'the requirement in Settings.',
    {
      retryable: false,
      details: { requirement: 'require', failedProvider: failed.name, modelId },
    },
  );
}

/**
 * Pre-dispatch ZDR gate for a caller that persists state before it streams.
 *
 * Not redundant with the filtering inside `selectProvider`. A refusal that
 * surfaces from within `stream()` arrives after the caller has written a user
 * turn and an assistant placeholder, and `orchestrator/chat.ts` documents that a
 * refusal must leave the transcript exactly as it was. This answers the same
 * question early, so the caller can refuse before writing anything.
 *
 * Reads only cached state — no `ensureModelsCached`, no network. It runs on the
 * request path before anything is written, and a decision to refuse must not
 * depend on whether a model list happened to fetch. An unknown model cache
 * therefore counts as "might serve", which is the same benefit of the doubt
 * `selectProvider` gives.
 */
export function assertZdrDispatchable(intended: ProviderRecord | null, modelId: string): void {
  const requirement = zdrRequirement();
  // `prefer` never refuses — it sorts. `off` is not a policy at all.
  if (requirement !== 'require' || intended === null) return;
  if (isZdrEligible(intended, requirement)) return;

  const alternative = orderByZdr(listFailoverCandidates(intended.id), requirement).find(
    (candidate) => cachedSupportsModel(candidate, modelId) !== false,
  );
  if (!alternative) throw zdrRefusal(intended, modelId);
}

/** Why the router moved off the provider it started with. */
export type SwitchReason = 'capability_mismatch' | 'health_failure' | 'zdr_requirement';

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
 * Pick a provider for `modelId`, applying the ZDR policy and then the capability
 * check.
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

  // ZDR is checked before capability, deliberately. Both can send the request
  // elsewhere, but they answer different questions and the user needs the right
  // one: a provider that is barred on privacy grounds must not be reported as
  // lacking the model, which would send the user off to fix the wrong thing.
  const requirement = zdrRequirement();
  if (requirement === 'require' && !isZdrEligible(start, requirement)) {
    const eligible = await findEligibleProviderWithModel(modelId, start.id, requirement);
    if (!eligible) throw zdrRefusal(start, modelId);

    return {
      provider: eligible,
      switched: true,
      from: start,
      reason: 'zdr_requirement',
      message:
        `${start.name} does not satisfy the zero-data-retention requirement ` +
        `(${zdrStatusFor(start)}); using ${eligible.name} instead.`,
    };
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
    // Under `require`, an empty candidate list may be empty *because* ZDR
    // filtered it, and reporting that as a missing model would tell the user to
    // change models when the policy is what refused. Distinguish the two by
    // asking whether anything would have been available without the filter.
    if (requirement === 'require' && (await findProviderWithModel(modelId, primed.id, 'off'))) {
      throw zdrRefusal(primed, modelId);
    }
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
 *
 * Candidates pass through `orderByZdr` before anything is probed: under `require`
 * an ineligible provider is removed outright, so it is never a failover target;
 * under `prefer` it sorts last, so an eligible one wins whenever there is one.
 * `requirementOverride` exists only so the caller can ask what would have been
 * available without the ZDR filter, in order to word the refusal correctly.
 */
async function findProviderWithModel(
  modelId: string,
  excludeId: string,
  requirementOverride?: ZdrRequirement,
): Promise<ProviderRecord | null> {
  const candidates = orderByZdr(
    listFailoverCandidates(excludeId),
    requirementOverride ?? zdrRequirement(),
  );

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

/**
 * The `require` path's replacement search.
 *
 * Distinct from `findProviderWithModel` in one way that matters: an unknown model
 * cache is accepted here (`!== false`), because refusing on a privacy requirement
 * must not additionally require that we have already listed the alternative's
 * models. Being unable to prove a provider has the model is not a reason to send
 * the request to one that breaks the user's policy — but it is a reason to try.
 */
async function findEligibleProviderWithModel(
  modelId: string,
  excludeId: string,
  requirement: ZdrRequirement,
): Promise<ProviderRecord | null> {
  for (const candidate of orderByZdr(listFailoverCandidates(excludeId), requirement)) {
    const primed = await ensureModelsCached(candidate);
    if (cachedSupportsModel(primed, modelId) !== false) return primed;
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
        // Which refusal depends on *why* the list came up empty. Asking again
        // with the policy set aside separates "nothing else can serve this model"
        // from "the policy barred everything that could" — the first is an
        // outage, the second is a privacy decision, and they call for opposite
        // responses from the user.
        const requirement = zdrRequirement();
        if (requirement === 'require' && (await pickHealthyAlternative(request.modelId, tried, 'off'))) {
          log.warn('every healthy alternative is barred by the ZDR requirement', {
            failed: provider.name,
          });
          throw zdrFailoverRefusal(provider, request.modelId);
        }
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

/**
 * Next provider that both serves the model and has not already been tried.
 *
 * The candidate list passes through `orderByZdr` before any of it is probed,
 * which is what closes the mid-run failover hole for `require`: an ineligible
 * provider is not in the list, so it cannot become the replacement no matter what
 * happens to the one that failed. Under `prefer` it stays in the list but sorts
 * last, and that residual exposure is the documented cost of `prefer`.
 *
 * `requirementOverride` is how the caller asks the counterfactual — what would
 * have been available with no policy — so an empty result can be reported as the
 * right kind of failure.
 */
async function pickHealthyAlternative(
  modelId: string,
  tried: Set<string>,
  requirementOverride?: ZdrRequirement,
): Promise<ProviderRecord | null> {
  const candidates = orderByZdr(listFailoverCandidates(), requirementOverride ?? zdrRequirement());
  for (const candidate of candidates) {
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
