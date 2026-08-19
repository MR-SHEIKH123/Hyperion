/**
 * The registry of runs that can still be stopped.
 *
 * Cancelling a task is not the same as losing its client. `sse.signal` fires
 * only when the browser disconnects, so stopping a run through it would tear
 * down the very stream that still has to deliver the `stopped` frame and
 * whatever partial work was done. `createAgentContext` therefore takes a
 * separate `cancelSignal`, and this module is where those signals live between
 * the moment a run starts and the moment it ends.
 *
 * In-process by design, exactly like the job lock: a cancellation only has
 * meaning for work this process is actually running, and a registry persisted
 * across a restart would offer to stop runs that no longer exist. Boot-time
 * reconciliation already demotes rows a dead process left behind.
 *
 * Registration happens **before** the lock rather than inside it, so a task
 * parked in the queue is cancellable too. That is the case a naive
 * implementation misses: a queued task has no controller of its own yet, has not
 * written a `task_runs` row, and would look to the cancel endpoint like a task
 * that was never heard of.
 *
 * The `cancelled` flag is kept beside the signal because the two answer
 * different questions. The signal stops the work; the flag is how the route that
 * owns the run learns *why* it stopped, and therefore whether to record
 * `stopped`/`cancelled` or a genuine `error`. An abort raised by a disconnect and
 * an abort raised by a cancel arrive at the same `catch`, and only this flag
 * tells them apart.
 */

import { createLogger } from '../util/logger.ts';

import type { AgentTool } from './agents.ts';

const log = createLogger('cancel');

/**
 * The `pause_reason` written on a run that a user stopped.
 *
 * Shared rather than repeated as a literal so the endpoint, the run routes and
 * the scheduler cannot drift into recording three spellings of one reason. It
 * sits alongside `CEILING_REASON` from the budget module, which plays the same
 * role for a run stopped by a spending ceiling.
 */
export const CANCEL_REASON = 'cancelled';

export interface Cancellable {
  /** The `task_runs.run_id` this registration belongs to. */
  readonly runId: string;
  /** Pass to `createAgentContext`, and to the lock so a queued run can leave. */
  readonly signal: AbortSignal;
  /** True once someone asked for this run to stop. */
  readonly cancelled: boolean;
  /**
   * Drop the registration. Idempotent, and safe to call from a `finally` — it
   * only clears the index when this registration is still the one held there.
   */
  dispose(): void;
}

interface Entry {
  runId: string;
  tool: AgentTool;
  taskId: string;
  controller: AbortController;
  cancelled: boolean;
}

const byRunId = new Map<string, Entry>();
const byTask = new Map<string, Entry>();

function taskKey(tool: AgentTool, taskId: string): string {
  return `${tool}:${taskId}`;
}

/**
 * Make a run cancellable for as long as it is live.
 *
 * A task id can be reused — the user retries, the frontend sends the same id —
 * so the newest registration wins the `(tool, taskId)` index. The previous one
 * keeps working through its own `runId` and disposes itself normally; it simply
 * stops being what "cancel this task" resolves to, which is right, because the
 * run the user is looking at is the current one.
 */
export function registerCancellable(
  runId: string,
  tool: AgentTool,
  taskId: string,
): Cancellable {
  const entry: Entry = {
    runId,
    tool,
    taskId,
    controller: new AbortController(),
    cancelled: false,
  };
  byRunId.set(runId, entry);
  byTask.set(taskKey(tool, taskId), entry);

  return {
    runId,
    signal: entry.controller.signal,
    get cancelled(): boolean {
      return entry.cancelled;
    },
    dispose(): void {
      byRunId.delete(runId);
      // Keyed check, mirroring the job lock's release: a late dispose must not
      // unregister a retry that has since taken this task id.
      if (byTask.get(taskKey(tool, taskId)) === entry) {
        byTask.delete(taskKey(tool, taskId));
      }
    },
  };
}

/**
 * Ask the live run for a task to stop, if there is one.
 *
 * Returns the run id that was signalled, or `null` when nothing live owns this
 * task. `null` is not a failure: the run may have finished a moment ago, or be
 * a row left behind in a non-terminal state, and both of those are cancelled by
 * a state transition instead. The endpoint decides which case it is.
 *
 * Aborting is idempotent — a second cancel of the same run is a no-op on an
 * already-aborted controller, and the flag is already set.
 */
export function cancelRun(tool: AgentTool, taskId: string): string | null {
  const entry = byTask.get(taskKey(tool, taskId));
  if (entry === undefined) return null;
  entry.cancelled = true;
  if (!entry.controller.signal.aborted) {
    entry.controller.abort();
    log.info('cancelled a live run', { tool, taskId, runId: entry.runId });
  }
  return entry.runId;
}

/**
 * Whether this run was stopped on purpose.
 *
 * The run routes call this from the tail of their promise chain, where a
 * cancelled run and a broken one are otherwise indistinguishable: both surface
 * as an aborted request. Answering `true` is what turns an `error` row into a
 * `stopped`/`cancelled` one.
 *
 * Deliberately keyed by run id rather than task id, so a retry that reused the
 * task id cannot make the previous attempt look cancelled.
 */
export function isCancelled(runId: string): boolean {
  return byRunId.get(runId)?.cancelled ?? false;
}

/** How many runs could be cancelled right now. Diagnostics and tests. */
export function cancellableCount(): number {
  return byRunId.size;
}

/** Test hook. Forgets every registration without aborting anything. */
export function resetCancellations(): void {
  byRunId.clear();
  byTask.clear();
}
