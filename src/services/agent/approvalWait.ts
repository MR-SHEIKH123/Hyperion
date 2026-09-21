/**
 * How long a prompt waits, and what happens when nobody answers (1.31).
 *
 * The deadline itself is a setting (`approval_wait_ttl_hours`), and this module is
 * where the three things that must agree about it live together:
 *
 *   1. the sweep that closes expired prompts (`expireWaitingApprovals`),
 *   2. the deadline a client is told about (`approvalExpiresAt`), and
 *   3. the interval the sweep is wired to at boot and on the cleanup timer.
 *
 * They are one module because they are one number. A route that computed
 * `createdAt + 72h` on its own, or a sweep that read a different fallback, would
 * disagree with the reaper in exactly the situation a deadline exists for — after
 * a restart or a settings change — and the disagreement would be invisible until a
 * prompt expired at a time the UI had not predicted.
 *
 * **The sweep expires the question, not the task.** A parked run whose prompt
 * expired stays parked and stays continuable: `POST /continue` without an
 * `approvalId` replays the conversation, the gated call is re-emitted, and the user
 * is asked again with fresh arguments against the current checkout. Ending the run
 * instead would turn a timer into the thing that destroyed a recoverable task, and
 * the tree has no vocabulary for "stopped, but the work is fine" other than the
 * states a restart already writes.
 */
import { expireStaleApprovals } from '../../db/approvals.ts';
import { approvalWaitTtlHours } from '../../db/settings.ts';
import { createLogger } from '../../util/logger.ts';

import type { PendingApproval } from '../../db/approvals.ts';

const log = createLogger('approvals');

/** The configured wait, in milliseconds. */
export function approvalWaitTtlMs(): number {
  return approvalWaitTtlHours() * 3_600_000;
}

/** When a prompt created at `createdAt` stops being answerable. */
export function approvalExpiresAt(createdAt: number): number {
  return createdAt + approvalWaitTtlMs();
}

/**
 * Close every prompt past the deadline, and say so.
 *
 * Synchronous and single-pass like `runCleanup`, and for the same reason: it is
 * one bounded UPDATE over an indexed table, so it can run inside a request-free
 * moment without giving anything up. It is called from the cleanup tick and once at
 * boot — boot because a deadline can pass while no process is running, which is the
 * case a timer-only sweep would miss entirely.
 *
 * The count is logged rather than returned-and-forgotten: a prompt disappearing
 * from the queue is a change the user did not make, so it has to be attributable in
 * the log to the sweep that made it.
 */
export function expireWaitingApprovals(now = Date.now()): PendingApproval[] {
  const expired = expireStaleApprovals({ ttlMs: approvalWaitTtlMs(), now });
  if (expired.length > 0) {
    const oldest = expired.reduce((min, approval) => Math.min(min, approval.createdAt), now);
    log.info('prompts expired without an answer', {
      count: expired.length,
      tasks: [...new Set(expired.map((approval) => approval.taskId))].length,
      oldestWaitHours: Math.round(((now - oldest) / 3_600_000) * 10) / 10,
    });
  }
  return expired;
}
