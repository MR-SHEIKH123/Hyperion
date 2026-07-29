/**
 * Runtime health tracking for the auto-failover rule.
 *
 * The rule: a provider that fails N consecutive times (default 2) inside a short
 * window (default ~20s) while serving live requests is marked unhealthy and
 * taken out of rotation.
 *
 * Three distinctions this module exists to keep straight:
 *
 *   1. This is NOT local-provider detection. Detection is a one-shot probe with
 *      3 attempts, run when the user toggles the local provider on
 *      (`detectLocalProvider` in adapters.ts). This is the continuous check
 *      applied to live traffic. Conflating them would either make detection
 *      evict providers or make failover rescan endlessly.
 *
 *   2. Only *retryable* failures count. A 401 means the key is wrong; retrying
 *      or failing over cannot fix that, and counting it would let one typo evict
 *      an otherwise perfectly healthy provider. `AppError.retryable` is the
 *      single source of truth for that judgement (see adapters/failFromResponse).
 *
 *   3. "Consecutive" is enforced literally: any success clears the streak. And
 *      the window means a failure at 09:00 and another at 17:00 are two isolated
 *      incidents, not a trend — stale failures are dropped before counting.
 *
 * State is in-memory by design. A restart should start from a clean slate: the
 * process was just down, so a persisted "unhealthy" verdict from before it would
 * be evidence about a world that no longer exists. The durable `health_status`
 * column is for display and failover ordering, not for this counter.
 */
import { env } from '../config/env.ts';
import { AppError } from '../util/errors.ts';
import { recordHealth } from './repository.ts';
import { createLogger } from '../util/logger.ts';
import type { HealthStatus } from '../types/core.ts';

const log = createLogger('health');

interface Tracker {
  /** Timestamps of recent consecutive retryable failures, oldest first. */
  failures: number[];
  unhealthySince: number | null;
}

const trackers = new Map<string, Tracker>();

function trackerFor(providerId: string): Tracker {
  let tracker = trackers.get(providerId);
  if (!tracker) {
    tracker = { failures: [], unhealthySince: null };
    trackers.set(providerId, tracker);
  }
  return tracker;
}

/** A success proves the provider is alive; any failure streak is void. */
export function recordSuccess(providerId: string): void {
  const tracker = trackerFor(providerId);
  const wasUnhealthy = tracker.unhealthySince !== null;

  tracker.failures = [];
  tracker.unhealthySince = null;

  recordHealth(providerId, 'healthy');
  if (wasUnhealthy) {
    log.info('provider recovered', { providerId });
  }
}

export interface FailureVerdict {
  /** True when this failure tripped the threshold and the provider was evicted. */
  unhealthy: boolean;
  /** Consecutive retryable failures currently inside the window. */
  consecutive: number;
  /** False when the failure was not health-relevant (e.g. a bad API key). */
  counted: boolean;
  status: HealthStatus;
}

/**
 * Record a failed live request.
 *
 * Returns whether the provider should now be taken out of rotation, so the
 * caller (the router) decides what to do about it — this module only judges.
 */
export function recordFailure(providerId: string, error: unknown): FailureVerdict {
  const appError = error instanceof AppError ? error : null;

  // Non-retryable failures (bad key, malformed request, user abort) say nothing
  // about provider availability. Recorded for display, excluded from the count.
  if (appError && !appError.retryable) {
    recordHealth(providerId, 'degraded', { message: appError.message });
    return {
      unhealthy: false,
      consecutive: trackerFor(providerId).failures.length,
      counted: false,
      status: 'degraded',
    };
  }

  const tracker = trackerFor(providerId);
  const now = Date.now();

  // Drop failures that fell out of the window: they are a previous, resolved
  // incident, not part of the current streak.
  tracker.failures = tracker.failures.filter((at) => now - at < env.healthWindowMs);
  tracker.failures.push(now);

  const consecutive = tracker.failures.length;
  const message = appError?.message ?? String(error);

  if (consecutive >= env.healthFailureThreshold) {
    tracker.unhealthySince = now;
    recordHealth(providerId, 'unhealthy', { message });
    log.warn('provider marked unhealthy', {
      providerId,
      consecutive,
      windowMs: env.healthWindowMs,
      reason: message,
    });
    return { unhealthy: true, consecutive, counted: true, status: 'unhealthy' };
  }

  recordHealth(providerId, 'degraded', { message });
  log.debug('provider failure recorded', { providerId, consecutive, reason: message });
  return { unhealthy: false, consecutive, counted: true, status: 'degraded' };
}

/** In-memory view; the DB column is the durable one. */
export function isUnhealthy(providerId: string): boolean {
  return trackers.get(providerId)?.unhealthySince !== null;
}

export function consecutiveFailures(providerId: string): number {
  const tracker = trackers.get(providerId);
  if (!tracker) return 0;
  const now = Date.now();
  return tracker.failures.filter((at) => now - at < env.healthWindowMs).length;
}

/**
 * Forget everything known about a provider's health.
 *
 * Used when the user manually retries or edits a provider: an explicit user
 * action is a request to re-evaluate from scratch, and holding the old verdict
 * would make the retry button pointless.
 */
export function resetHealth(providerId: string): void {
  trackers.delete(providerId);
}

/** Test hook. */
export function resetAllHealth(): void {
  trackers.clear();
}
