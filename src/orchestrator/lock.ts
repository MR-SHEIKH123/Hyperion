/**
 * Single-active-job lock.
 *
 * One generation at a time across the entire app, regardless of which tool
 * asked for it. This is deliberately an in-process lock rather than a DB row:
 * the constraint only has meaning for work this process is actually running,
 * and a lock persisted across a crash would leave the app permanently busy
 * with a job that no longer exists.
 *
 * Two modes, driven by the `concurrency_mode` setting:
 *   reject (default) — a second request fails immediately with `busy` (409)
 *   queue            — a second request waits its turn (FIFO)
 *
 * Rejecting is the default because a browser UI that gets an immediate,
 * explicit "something else is running" is easier to reason about than one
 * whose request appears to hang.
 */

import { randomUUID } from 'node:crypto';
import { AppError } from '../util/errors.ts';
import type { ToolName } from '../types/core.ts';
import { createLogger } from '../util/logger.ts';
import { env } from '../config/env.ts';

const log = createLogger('lock');


export type ConcurrencyMode = 'reject' | 'queue';

export interface JobInfo {
  /** Opaque id of the running job. */
  id: string;
  tool: ToolName;
  /** Human-readable label for the busy message, e.g. a chat id or task name. */
  label?: string;
  startedAt: number;
}

export interface JobHandle {
  readonly id: string;
  /** Releases the lock. Idempotent — safe to call from a `finally`. */
  release(): void;
}

export interface AcquireOptions {
  tool: ToolName;
  label?: string;
  mode?: ConcurrencyMode;
  /** Abort waiting while queued. Has no effect once the lock is held. */
  signal?: AbortSignal;
  /** Max time to wait in queue mode before giving up with `busy`. */
  waitMs?: number;
  /**
   * Code lane only: the task this slot belongs to. Recorded so a slot can be
   * joined back to its worktree for `GET /api/code/tasks`. The global lock
   * ignores it — it holds one job, which `label` already identifies.
   */
  taskId?: string;
}

interface Waiter {
  resolve: (handle: JobHandle) => void;
  reject: (error: unknown) => void;
  options: AcquireOptions;
  timer?: NodeJS.Timeout;
  cleanup: () => void;
}

const DEFAULT_WAIT_MS = 5 * 60_000;

let current: JobInfo | null = null;
const waiters: Waiter[] = [];

export function currentJob(): JobInfo | null {
  return current ? { ...current } : null;
}

export function isBusy(): boolean {
  return current !== null;
}

export function queueDepth(): number {
  return waiters.length;
}

function busyError(): AppError {
  const job = current;
  const detail = job
    ? `A ${job.tool} request has been running since ${new Date(job.startedAt).toISOString()}.`
    : 'Another request is already running.';
  return new AppError(
    'busy',
    `${detail} Hyperion runs one generation at a time; wait for it to finish or stop it first.`,
    { retryable: true, details: job ? { tool: job.tool, jobId: job.id, startedAt: job.startedAt } : undefined },
  );
}

function take(options: AcquireOptions): JobHandle {
  const id = randomUUID();
  current = {
    id,
    tool: options.tool,
    label: options.label,
    startedAt: Date.now(),
  };
  log.debug(`acquired ${id} (${options.tool}${options.label ? ` ${options.label}` : ''})`);

  let released = false;
  return {
    id,
    release(): void {
      if (released) return;
      released = true;
      // Only clear if we are still the holder. A stale handle released late
      // must never steal the lock out from under whoever holds it now.
      if (current?.id === id) {
        current = null;
        log.debug(`released ${id}`);
        pump();
      }
    },
  };
}

function pump(): void {
  if (current !== null) return;
  const next = waiters.shift();
  if (!next) return;
  next.cleanup();
  next.resolve(take(next.options));
}

/**
 * Acquires the app-wide job lock.
 *
 * Always pair with `release()` in a `finally` — an unreleased lock wedges the
 * whole application, which is the one failure mode this module must not have.
 */
export async function acquire(options: AcquireOptions): Promise<JobHandle> {
  const mode = options.mode ?? 'reject';

  if (current === null && waiters.length === 0) {
    return take(options);
  }

  if (mode === 'reject') {
    throw busyError();
  }

  if (options.signal?.aborted) {
    throw new AppError('aborted', 'Request was aborted before the job lock became available.');
  }

  return await new Promise<JobHandle>((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      options,
      cleanup: () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        options.signal?.removeEventListener('abort', onAbort);
      },
    };

    function drop(error: unknown): void {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      waiter.cleanup();
      reject(error);
    }

    function onAbort(): void {
      drop(new AppError('aborted', 'Request was aborted while waiting for the job lock.'));
    }

    waiter.timer = setTimeout(() => {
      drop(
        new AppError(
          'busy',
          `Timed out after ${options.waitMs ?? DEFAULT_WAIT_MS}ms waiting for the current job to finish.`,
          { retryable: true },
        ),
      );
    }, options.waitMs ?? DEFAULT_WAIT_MS);
    // Deliberately not unref'd: this timeout is the only mechanism that moves a
    // parked waiter forward, so if nothing else held the event loop, an unref'd
    // timer would never fire and the waiter would hang forever (the process
    // would simply exit out from under it). Shutdown stays bounded without it:
    // a client disconnect aborts the waiter, clearing the timer, and the
    // force-exit timer in installShutdownHandlers caps anything left behind.

    options.signal?.addEventListener('abort', onAbort, { once: true });
    waiters.push(waiter);
  });
}

/**
 * Runs `fn` while holding the lock, releasing it however `fn` ends.
 * Prefer this over manual acquire/release wherever the work is a single call.
 */
export async function withLock<T>(options: AcquireOptions, fn: (handle: JobHandle) => Promise<T>): Promise<T> {
  const handle = await acquire(options);
  try {
    return await fn(handle);
  } finally {
    handle.release();
  }
}

/** Test hook. Drops the current holder and fails every waiter. */
export function resetLock(): void {
  current = null;
  while (waiters.length > 0) {
    const waiter = waiters.pop();
    waiter?.cleanup();
    waiter?.reject(new AppError('aborted', 'Job lock was reset.'));
  }
}

// ---------------------------------------------------------------------------
// Code lane
// ---------------------------------------------------------------------------

/**
 * A second, independent lock governing Code tasks only.
 *
 * The app-wide lock above exists because two chat generations racing for the
 * same provider is confusing, not because it is technically impossible. Code is
 * the case where that reasoning inverts: a task is minutes of agentic editing
 * against its own git worktree, so a second one costs nothing but provider
 * throughput, and forcing the user to wait out a long refactor before starting
 * an unrelated one is the actual defect.
 *
 * So Code runs in a *counting* lane (default 2) rather than taking the global
 * lock. The two are deliberately unaware of each other: Chat, Cowork and Design
 * still serialise through `acquire()` exactly as before, and a Code task in
 * flight neither blocks them nor is blocked by them.
 *
 * Isolation between the parallel tasks themselves is not this module's job —
 * that is `resolveInSubtree` in security/fsScope.ts, plus one worktree per task.
 */

export interface LaneInfo {
  id: string;
  label?: string;
  /** Set when the caller named a task, which is what owns the worktree. */
  taskId?: string;
  startedAt: number;
}

export interface LaneStatus {
  /** How many tasks are running right now. */
  running: number;
  /** The configured ceiling. */
  limit: number;
  /** How many are parked waiting for a slot (queue mode only). */
  queued: number;
  /** Detail on each running task, for `GET /api/code/tasks`. */
  active: LaneInfo[];
}

interface LaneWaiter {
  resolve: (handle: JobHandle) => void;
  reject: (error: unknown) => void;
  options: AcquireOptions;
  timer?: NodeJS.Timeout;
  cleanup: () => void;
}

const laneRunning = new Map<string, LaneInfo>();
const laneWaiters: LaneWaiter[] = [];

// Read once here rather than at every call so a test can move the ceiling
// without reaching into process.env and re-importing the config module.
let laneLimit = Math.max(1, env.codeLaneLimit);

export function codeLaneLimit(): number {
  return laneLimit;
}

export function codeLaneStatus(): LaneStatus {
  return {
    running: laneRunning.size,
    limit: laneLimit,
    queued: laneWaiters.length,
    active: [...laneRunning.values()].map((info) => ({ ...info })),
  };
}

export function codeLaneHasCapacity(): boolean {
  return laneRunning.size < laneLimit && laneWaiters.length === 0;
}

/**
 * Exported so the route layer can reject a full lane *before* it switches the
 * response into an SSE stream — a caller that gets JSON can read the error, one
 * that gets an event stream has to parse it out of the body.
 */
export function codeLaneBusyError(): AppError {
  return new AppError(
    'busy',
    `All ${laneLimit} Code slots are in use. Wait for one of the running tasks to ` +
      'finish, or stop one first.',
    {
      retryable: true,
      details: { running: laneRunning.size, limit: laneLimit, queued: laneWaiters.length },
    },
  );
}

function takeLane(options: AcquireOptions): JobHandle {
  const id = randomUUID();
  const info: LaneInfo = { id, startedAt: Date.now() };
  if (options.label !== undefined) info.label = options.label;
  if (options.taskId !== undefined) info.taskId = options.taskId;
  laneRunning.set(id, info);
  log.debug(`code lane acquired ${id}${options.label ? ` (${options.label})` : ''}`);

  let released = false;
  return {
    id,
    release(): void {
      if (released) return;
      released = true;
      // Keyed by id, so a late release can only ever drop its own slot — it
      // cannot free a slot that has since been handed to another task.
      if (laneRunning.delete(id)) {
        log.debug(`code lane released ${id}`);
        pumpLane();
      }
    },
  };
}

function pumpLane(): void {
  while (laneRunning.size < laneLimit) {
    const next = laneWaiters.shift();
    if (!next) return;
    next.cleanup();
    next.resolve(takeLane(next.options));
  }
}

/**
 * Acquires one Code slot. Same reject/queue semantics as the global lock.
 * Always pair with `release()` in a `finally`.
 */
export async function acquireCodeLane(options: AcquireOptions): Promise<JobHandle> {
  const mode = options.mode ?? 'reject';

  // The waiters check keeps the queue FIFO: a slot freed while others are
  // parked belongs to whoever has been waiting longest, not to a fresh caller.
  if (laneRunning.size < laneLimit && laneWaiters.length === 0) {
    return takeLane(options);
  }

  if (mode === 'reject') {
    throw codeLaneBusyError();
  }

  if (options.signal?.aborted) {
    throw new AppError('aborted', 'Request was aborted before a Code slot became available.');
  }

  return await new Promise<JobHandle>((resolve, reject) => {
    const waiter: LaneWaiter = {
      resolve,
      reject,
      options,
      cleanup: () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        options.signal?.removeEventListener('abort', onAbort);
      },
    };

    function drop(error: unknown): void {
      const index = laneWaiters.indexOf(waiter);
      if (index >= 0) laneWaiters.splice(index, 1);
      waiter.cleanup();
      reject(error);
    }

    function onAbort(): void {
      drop(new AppError('aborted', 'Request was aborted while waiting for a Code slot.'));
    }

    waiter.timer = setTimeout(() => {
      drop(
        new AppError(
          'busy',
          `Timed out after ${options.waitMs ?? DEFAULT_WAIT_MS}ms waiting for a Code slot.`,
          { retryable: true },
        ),
      );
    }, options.waitMs ?? DEFAULT_WAIT_MS);
    // Not unref'd, for the same reason as the global lock's waiter timer: an
    // unref'd timeout would never fire when the waiter is the only pending
    // work, and the wait-give-up contract (CONTRACTS.md) requires it to.

    options.signal?.addEventListener('abort', onAbort, { once: true });
    laneWaiters.push(waiter);
  });
}

/** Runs `fn` holding one Code slot, releasing it however `fn` ends. */
export async function withCodeLane<T>(
  options: AcquireOptions,
  fn: (handle: JobHandle) => Promise<T>,
): Promise<T> {
  const handle = await acquireCodeLane(options);
  try {
    return await fn(handle);
  } finally {
    handle.release();
  }
}

/** Test hook. Empties the lane and fails every waiter. */
export function resetCodeLane(limit = env.codeLaneLimit): void {
  laneLimit = Math.max(1, limit);
  laneRunning.clear();
  while (laneWaiters.length > 0) {
    const waiter = laneWaiters.pop();
    waiter?.cleanup();
    waiter?.reject(new AppError('aborted', 'Code lane was reset.'));
  }
}

