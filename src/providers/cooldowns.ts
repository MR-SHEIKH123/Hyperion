/**
 * Per-error-type provider cooldowns (Prompt 1 addendum 1.36, the part the text
 * specifies numerically).
 *
 * The gap this closes is not the health threshold. `health.ts` evicts a provider
 * after *two retryable* failures in a window, and deliberately excludes
 * non-retryable ones so that one wrong key cannot evict a live provider. That
 * exclusion left a hole: a 401 was not counted, so nothing stopped the very next
 * request from hitting the same dead key, and the one after that, for as long as
 * the user left it configured. A rate-limited provider was worse — a 429 *is*
 * retryable, so the router's own retry policy would spend the second attempt
 * immediately, which is the behaviour the limit exists to punish.
 *
 * So the two mechanisms answer different questions and both are needed:
 *
 *   - **health** answers "is this provider broken?" — an availability judgement
 *     with a threshold, and the thing failover keys off.
 *   - **cooldown** answers "may I talk to it right now, and how long until I
 *     should try again?" — a per-failure-class back-off with no threshold at all.
 *     One 401 is enough to set one, because the key being wrong is not a matter
 *     of degree.
 *
 * The classes and their durations are the addendum's table, not a tuned guess:
 * 401/403 → 60m, 402 → 30m, 429 → 5m, 404 → 2m, 5xx → 1m, network → 30s. A 429
 * carries one wrinkle the others do not — providers send `Retry-After` to say how
 * long *they* want — so a 429's cooldown is the longer of the table value and the
 * header, clamped to `COOLDOWN_MAX_MS`. The clamp is the addendum's "capped
 * backoff": a gateway that answers `Retry-After: 86400` must not take a provider
 * out of rotation for a day on the strength of one header, since the cap is what
 * keeps a cooldown recoverable rather than a decommission.
 *
 * Deliberately *not* cooled:
 *
 *   - Other 4xx. A 400 means the request was malformed, which is this process's
 *     bug; cooling the provider would hide it behind a back-off that looks like
 *     the provider's fault.
 *   - `aborted`. A user cancelling is not a provider event.
 *   - Anything with no provider meaning at all (`bad_request`, `not_found` from
 *     our own routes): `classifyFailure` returns null and nothing is recorded.
 *
 * State is in-memory, for the same reason health state is: a restart was a
 * process coming up clean, and a cooldown persisted from before it would be a
 * claim about a world that no longer exists. It is also the "deadlock reset":
 * every cooldown expires, every explicit user action clears one, and nothing here
 * can hold a provider out of rotation permanently.
 */
import { AppError } from '../util/errors.ts';
import { createLogger } from '../util/logger.ts';
import type { ProviderCooldown, ProviderFailureClass } from '../types/core.ts';

const log = createLogger('cooldown');

/**
 * The failure classes, declared once in `types/core.ts`.
 *
 * A type alias rather than a second union: the class now crosses the wire inside
 * `ProviderCooldown`, so a class added here without being added there (or the
 * reverse) would be a frontend that cannot label a state the backend enforces.
 */
export type FailureClass = ProviderFailureClass;

/** The addendum's table. Values in milliseconds. */
export const COOLDOWN_MS: Record<FailureClass, number> = {
  auth: 60 * 60_000,
  payment: 30 * 60_000,
  rate_limit: 5 * 60_000,
  not_found: 2 * 60_000,
  server: 60_000,
  network: 30_000,
};

/** Human words for the class, so a message cannot drift from the table. */
export const CLASS_LABEL: Record<FailureClass, string> = {
  auth: 'the credentials were rejected',
  payment: 'the account cannot be billed',
  rate_limit: 'the provider is rate limiting',
  not_found: 'the endpoint was not found',
  server: 'the provider returned a server error',
  network: 'the provider could not be reached',
};

/** No cooldown may exceed this, however large a `Retry-After` claims to be. */
export const COOLDOWN_MAX_MS = 60 * 60_000;

export interface Cooldown {
  providerId: string;
  failureClass: FailureClass;
  /** Epoch ms at which the provider may be tried again. */
  until: number;
  /** The cooldown's length, after the Retry-After merge and the cap. */
  ms: number;
  /** Where the duration came from — the table, or the provider's own header. */
  source: 'table' | 'retry_after';
}

const cooldowns = new Map<string, Cooldown>();

/**
 * Which class of failure this is, or null when the error says nothing about the
 * provider and no cooldown should be recorded.
 *
 * The HTTP status decides first where there is one, because the status is what
 * distinguishes "rate limited" (429, worth pausing) from "bad request" (400, our
 * bug) — a distinction the typed error alone blurs, since both arrive as
 * `provider_error`. Falls back to the code for failures that never had a
 * response: unreachable and timeout are the network class.
 */
export function classifyFailure(error: unknown): FailureClass | null {
  const appError = error instanceof AppError ? error : null;

  // A raw throw out of `fetch` (DNS, refused connection, TLS) is a network
  // fault even though it never became an AppError.
  if (appError === null) return 'network';
  if (appError.code === 'aborted') return null;

  const status = appError.details?.['status'];
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'auth';
    if (status === 402) return 'payment';
    if (status === 429) return 'rate_limit';
    if (status === 404) return 'not_found';
    if (status >= 500) return 'server';
    return null;
  }

  switch (appError.code) {
    case 'provider_auth_failed':
      return 'auth';
    case 'provider_unreachable':
    case 'provider_timeout':
      return 'network';
    case 'provider_error':
      // No status attached: an adapter-level failure with a provider cause.
      return 'server';
    default:
      return null;
  }
}

export interface RecordCooldownOptions {
  /** The provider's own `Retry-After`, in seconds, when it sent one. */
  retryAfterSeconds?: number | null;
  /** Injectable clock, so tests do not have to move the real one. */
  now?: number;
}

/**
 * Record that talking to `providerId` just failed this way.
 *
 * Returns null when the failure carries no provider meaning. Otherwise the
 * cooldown replaces any previous one: the newest failure is the most informative
 * — a provider that was rate limited and is now rejecting the key should be
 * parked for the hour, not the five minutes.
 */
export function recordCooldown(
  providerId: string,
  error: unknown,
  options: RecordCooldownOptions = {},
): Cooldown | null {
  const failureClass = classifyFailure(error);
  if (failureClass === null) return null;

  const now = options.now ?? Date.now();
  const tableMs = COOLDOWN_MS[failureClass];

  // Retry-After is only meaningful for a rate limit, and only when it asks for
  // *more* time than the table — a provider saying "try again in 2s" is not a
  // reason to poll it sooner than this process would anyway.
  const retryAfterMs =
    failureClass === 'rate_limit' &&
    typeof options.retryAfterSeconds === 'number' &&
    Number.isFinite(options.retryAfterSeconds)
      ? Math.max(0, options.retryAfterSeconds) * 1000
      : 0;

  const requested = Math.max(tableMs, retryAfterMs);
  const ms = Math.min(requested, COOLDOWN_MAX_MS);

  const cooldown: Cooldown = {
    providerId,
    failureClass,
    until: now + ms,
    ms,
    source: retryAfterMs > tableMs ? 'retry_after' : 'table',
  };

  cooldowns.set(providerId, cooldown);
  log.warn('provider cooled down', {
    providerId,
    failureClass,
    ms,
    source: cooldown.source,
    reason: error instanceof AppError ? error.message : String(error),
  });
  return cooldown;
}

/**
 * The live cooldown for a provider, or null.
 *
 * Reading is where expiry is applied, so a stale entry can never be observed:
 * there is no janitor to forget to run, and an entry that has run out is dropped
 * on sight rather than lingering as state that has to be reasoned about.
 */
export function cooldownFor(providerId: string, now: number = Date.now()): Cooldown | null {
  const cooldown = cooldowns.get(providerId);
  if (cooldown === undefined) return null;
  if (cooldown.until <= now) {
    cooldowns.delete(providerId);
    return null;
  }
  return cooldown;
}

export function isCoolingDown(providerId: string, now: number = Date.now()): boolean {
  return cooldownFor(providerId, now) !== null;
}

/** Every provider currently cooling down, for ordering a candidate list. */
export function coolingProviderIds(now: number = Date.now()): Set<string> {
  const cooling = new Set<string>();
  for (const id of [...cooldowns.keys()]) {
    if (isCoolingDown(id, now)) cooling.add(id);
  }
  return cooling;
}

/** "4m" — short, because it sits inside switch and refusal messages. */
function humanRemaining(remainingMs: number): string {
  const seconds = Math.ceil(remainingMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)}m`;
}

/**
 * The cooldown as one object for a reader that has to *show* it, or null.
 *
 * The facts and the sentence come out of a single read at a single instant, which
 * is the point: a caller composing them from two calls could catch the moment a
 * cooldown expires and produce "waiting 0s" beside no cooldown at all. The
 * sentence is built here rather than by the caller for the same reason
 * `parkSummary` exists — the routing decision and the disclosure are describing
 * one event, and two phrasings of it drift.
 */
export function cooldownSnapshot(
  providerId: string,
  now: number = Date.now(),
): (ProviderCooldown & { failureClass: FailureClass }) | null {
  const cooldown = cooldownFor(providerId, now);
  if (cooldown === null) return null;
  return {
    until: cooldown.until,
    failureClass: cooldown.failureClass,
    source: cooldown.source,
    reason: `${CLASS_LABEL[cooldown.failureClass]} — waiting ${humanRemaining(cooldown.until - now)}`,
  };
}

/**
 * Why this provider is being skipped, worded for a person, or null.
 *
 * The class is named rather than the status code: "the credentials were
 * rejected" tells the user what to fix, and "401" does not. A view of the
 * snapshot above rather than a second phrasing of it.
 */
export function describeCooldown(providerId: string, now: number = Date.now()): string | null {
  return cooldownSnapshot(providerId, now)?.reason ?? null;
}

/**
 * Forget a cooldown because something changed.
 *
 * Every user action that re-evaluates a provider lands here (`resetHealth` is the
 * single entry point): editing the key, testing the connection, re-enabling it.
 * Holding the old verdict would make the retry pointless, which is the same
 * argument the health tracker makes for its own state.
 */
export function clearCooldown(providerId: string): void {
  if (cooldowns.delete(providerId)) {
    log.debug('provider cooldown cleared', { providerId });
  }
}

/** Test hook. */
export function resetAllCooldowns(): void {
  cooldowns.clear();
}
