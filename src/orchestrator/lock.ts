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
    `${detail} AIStudio runs one generation at a time; wait for it to finish or stop it first.`,
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
    // Do not let a queued waiter hold the event loop open during shutdown.
    waiter.timer.unref?.();

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
