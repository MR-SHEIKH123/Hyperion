/**
 * The scheduled-task runner.
 *
 * Every minute this asks `scheduledTasks.ts` what is due and runs it through
 * exactly the same machinery a live `POST /api/cowork/run-task` uses: the same
 * agent module, the same app-wide job lock, the same `createAgentContext`. The
 * only thing that differs is where the SSE events go — see `headlessSink`.
 *
 * Running in-process rather than issuing a loopback HTTP request to our own
 * port is a deliberate departure from the letter of the spec. The intent of
 * "fire the same endpoint" is that there must not be a second, divergent
 * execution path, and sharing the agent + lock + context achieves that without
 * making a background job depend on the HTTP listener being up, on knowing our
 * own bind port, or on parsing our own SSE stream back into a result.
 *
 * ## The busy case
 *
 * A scheduled task that comes due while the user is mid-run does **not** barge
 * in. It takes the lock in `queue` mode and waits its turn, up to
 * `HYPERION_SCHEDULED_TASK_WAIT_MS`. If it never gets in, the run is recorded
 * as `skipped` rather than `failed` — nothing went wrong, the machine was busy
 * — and `last_run_at` is still stamped so it waits for its next slot instead of
 * retrying on every tick for the rest of the day.
 *
 * ## Two history tables, two different questions
 *
 * `scheduled_task_runs` records the **scheduling** outcome: did the cron fire,
 * was it skipped because the app was busy or the cap was reached. `task_runs`
 * records the **execution** state: running, parked, complete, error.
 *
 * This path wrote only the first until 1.27, and the omission was not harmless.
 * `createAgentContext` was called with no `runId`, so `parkRun` skipped both the
 * state write and the step row — a scheduled park was invisible and had nothing to
 * continue from. Worse, `parkOnBlockedSend` guards on a per-*module* `unattended`
 * flag that production never set, so `redaction_blocked` and `zdr_blocked` were
 * unreachable outside tests. Both are fixed by allocating a `task_runs` row here
 * and putting `unattended` on `TaskInput` where a per-run property belongs.
 *
 * The consequence is a visible behaviour change for existing scheduled tasks: they
 * now appear in `GET /api/cowork/tasks/:taskId/state`, write step history, and can
 * *park* where they previously errored. All three are improvements; the last one
 * changes what users see, so it belongs in a release note.
 *
 * ## Why this fires with no browser open
 *
 * PM2 keeps the backend alive independently of any tab, which is the entire
 * point: a 07:00 digest must not require the user to have left a page open
 * overnight. Nothing here is gated on a session, and the result reaches the
 * user through a push notification instead of an open stream.
 *
 * ## The spending cap
 *
 * Because nothing here is gated on a session, this is the one path that can
 * spend money while the user is asleep — which is why the daily cap is checked
 * here and not in the chat routes. Live work is deliberately exempt (see
 * `services/limits/budget.ts`).
 */


import { env } from '../../config/env.ts';
import { findChat } from '../../db/chats.ts';
import { finishTaskRun, getTaskRun, startTaskRun } from '../../db/taskRuns.ts';
import { requireAgent } from '../../orchestrator/agents.ts';
import { createAgentContext } from '../../orchestrator/agentContext.ts';
import { registerCancellable } from '../../orchestrator/cancel.ts';
import { withLock } from '../../orchestrator/lock.ts';
import { SseStream } from '../../orchestrator/sse.ts';
import { AppError } from '../../util/errors.ts';
import { createIntervalJob } from '../../util/intervalJob.ts';
import { createLogger } from '../../util/logger.ts';
import { assertWithinSpendCap } from '../limits/budget.ts';
import { sendPush } from '../notify/push.ts';
import {
  dueScheduledTasks,
  finishRun,
  requireScheduledTask,
  startRun,
} from './scheduledTasks.ts';


import type { SseSink } from '../../orchestrator/sse.ts';
import type { TaskInput, TaskResult } from '../../types/core.ts';
import type { IntervalJob } from '../../util/intervalJob.ts';
import type { ScheduledTask } from './scheduledTasks.ts';

const log = createLogger('scheduler');

/** Once a minute: fine enough that an HH:MM slot fires within the minute. */
const INTERVAL_MS = 60_000;

/**
 * Longer than cleanup's 1min and the backup job's 5min. A task that was due
 * while the machine was off should still fire soon after boot, but not while
 * migrations and provider reconciliation are still settling.
 */
const BOOT_DELAY_MS = 2 * 60_000;

/**
 * Somewhere for `SseStream` to write when nobody is listening.
 *
 * `SseStream` takes a structural sink rather than a concrete `ServerResponse`
 * precisely so a run can be driven without a socket. The agent still emits its
 * progress events; they simply go nowhere, and the outcome is captured from
 * `runTask`'s return value instead.
 */
function headlessSink(): SseSink {
  return {
    write: () => true,
    end: () => {},
    writableEnded: false,
    headersSent: true,
    setHeader: () => undefined,
    on: () => undefined,
  };
}

/**
 * A scheduled run needs a chat to write into. Tasks may name one; those that
 * don't get a synthetic per-run id so their messages and artifacts still have
 * somewhere coherent to live rather than colliding in a shared bucket.
 */
function chatIdFor(task: ScheduledTask, runId: string): string {
  return task.chatId ?? `sched_${task.id}_${runId}`;
}

/**
 * `task_runs.chat_id` is a real foreign key and a scheduled run's chat id is
 * usually synthetic, so it names no row. Stored as NULL rather than allowed to
 * fail the insert: the link is a convenience, and losing the whole execution
 * record over it would be the wrong trade — the same reasoning `http/agents.ts`
 * gives for its own `linkedChatId`.
 */
function linkedChatId(chatId: string): string | undefined {
  return findChat(chatId) === null ? undefined : chatId;
}

async function notify(task: ScheduledTask, result: TaskResult): Promise<void> {
  await sendPush({
    reason: 'scheduled-task',
    title: result.ok ? `${task.name} finished` : `${task.name} failed`,
    body: result.summary || (result.ok ? 'Completed with no summary.' : 'The run did not finish.'),
    // Tagging by task id collapses yesterday's notification into today's
    // rather than stacking one per day in the tray.
    tag: `scheduled-task:${task.id}`,
    url: '/cowork',
  });
}

/**
 * Run one task to completion, recording a history row either way.
 *
 * Never throws: a task that fails is a recorded outcome, not a reason to
 * abandon the remaining due tasks or to kill the interval job.
 */
export async function runScheduledTask(id: string): Promise<void> {
  const task = requireScheduledTask(id);
  const runId = startRun(task.id);

  /**
   * A scheduled run is stoppable too, under the task's own id — that is the
   * handle the user has for it in the UI, and a run nobody is watching is
   * exactly the kind that most needs an off switch.
   *
   * Registered before the lock so a task queued behind the user's own work is
   * cancellable as well: a run that could not be stopped for however long that
   * work takes would look to the cancel endpoint like a task never heard of.
   */
  const cancellable = registerCancellable(runId, 'cowork', task.id);

  /**
   * Whether a `task_runs` row exists yet.
   *
   * Allocated inside the lock, so a task cancelled while queued has none — and a
   * terminal update against an id with no row would silently match nothing.
   */
  let allocated = false;

  /**
   * Stamp the execution state, never at the cost of the run.
   *
   * Separate from `finishRun`, because the two record different things and D17
   * turns on that distinction: `scheduled_task_runs` records the *scheduling*
   * outcome (did the cron fire, was it skipped), and `task_runs` records the
   * *execution* state (running, parked, complete). A scheduled execution
   * genuinely has execution state, and before 1.27 it had nowhere to put it.
   *
   * A parked run has already written its own non-terminal state and must keep it:
   * `finishTaskRun` rewrites the pause and error columns, so overwriting a park
   * would erase the thing the user has to answer.
   */
  const markExecution = (
    state: 'complete' | 'error' | 'stopped',
    error?: { code: string; message: string },
  ): void => {
    if (!allocated) return;
    const current = getTaskRun(runId)?.state;
    if (current !== 'running') return;
    try {
      finishTaskRun(runId, state, {
        ...(error === undefined ? {} : { code: error.code, message: error.message }),
      });
    } catch (failure) {
      log.warn(`scheduled run ${runId}: recording ${state} failed: ${String(failure)}`);
    }
  };

  /**
   * Record a stopped scheduled run.
   *
   * `skipped`, not `failed`: the run was stopped on purpose, and a red mark
   * against a task working exactly as told is a lie the history would keep
   * repeating. `skipped` also stamps `last_run_at`, which is what stops this
   * task coming due again on the very next tick — a cancelled run that stayed
   * due would restart within the minute and ignore the user's decision.
   */
  const finishCancelled = (): void => {
    finishRun(runId, task.id, {
      status: 'skipped',
      summary: 'Stopped before it finished.',
    });
    markExecution('stopped');
    log.info('scheduled task stopped', { id: task.id });
  };


  const input: TaskInput = {
    tool: 'cowork',
    chatId: chatIdFor(task, runId),
    modelId: task.modelId,
    prompt: task.prompt,
    mode: 'act',
    // The defining property of this path. Nobody is watching, so a refused send
    // or a call needing approval must park and be continuable rather than fail —
    // see `TaskInput.unattended` for why this is per-run and not per-module.
    unattended: true,
    ...(task.cwd === null ? {} : { cwd: task.cwd }),
  };

  try {
    // Before the agent, before the lock: a refused task should not hold up a
    // task the user is watching, and it must not reach a provider at all.
    assertWithinSpendCap('autonomous', `scheduled:${task.name}`);

    const agent = requireAgent('cowork');
    const sse = new SseStream(headlessSink());


    const result = await withLock(
      {
        tool: 'cowork',
        label: `scheduled:${task.name}`,
        // Queue regardless of the user's concurrency preference. 'reject' is a
        // sensible answer to a person who can retry; there is nobody here to
        // retry, so waiting is the only behaviour that isn't just a silent loss.
        mode: 'queue',
        waitMs: env.scheduledTaskWaitMs,
        // A cancelled task leaves the queue immediately instead of sitting out
        // the remaining wait to record a `skipped` nobody asked for.
        signal: cancellable.signal,
      },
      async () => {
        // Inside the lock, for the same reason `http/agents.ts` records inside
        // its lock: a task waiting its turn has not started yet, and a row
        // claiming otherwise would have the UI watching for progress that cannot
        // begin.
        startTaskRun({
          runId,
          taskId: task.id,
          tool: 'cowork',
          chatId: linkedChatId(input.chatId),
        });
        allocated = true;

        const ctx = createAgentContext({
          tool: 'cowork',
          chatId: input.chatId,
          modelId: input.modelId,
          sse,
          taskId: task.id,
          // Passed now, where before it was omitted. Without it `parkRun` skipped
          // both the state write and the step row, so a scheduled park was
          // invisible and had nothing to continue from.
          runId,
          cancelSignal: cancellable.signal,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        });
        return await agent.runTask(input, ctx);
      },
    );

    sse.close();

    // An agent that honours `ctx.signal` returns what it had rather than
    // throwing, so a stopped run reaches here looking finished. Checked before
    // the history row is written, and before the push: a notification saying
    // this "finished" would contradict the stop the user just asked for.
    if (cancellable.cancelled) {
      finishCancelled();
      return;
    }

    const artifact = result.artifacts?.[0];
    finishRun(runId, task.id, {
      status: result.ok ? 'success' : 'failed',
      summary: result.summary,
      ...(artifact ? { artifact } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    // A parked run has already written its own non-terminal state, and must not
    // have it overwritten: `finishTaskRun` rewrites the pause and error columns,
    // so stamping `complete` here would erase the park the user has to answer.
    markExecution(result.ok ? 'complete' : 'error', result.error);

    log.info('scheduled task finished', { id: task.id, ok: result.ok });
    await notify(task, result);
  } catch (error) {
    // Cancelling aborts whatever the run was waiting on, so it lands here as an
    // `aborted` error. Handled ahead of every other branch because the reason
    // the run stopped is a decision, not the exception it raised on the way out.
    if (cancellable.cancelled) {
      finishCancelled();
      return;
    }

    // Losing the queue race is not a failure — the app was busy with work the
    // user was actually watching, which rightly wins.
    const busy = error instanceof AppError && error.code === 'busy';
    // Nor is hitting the spending cap: the task was refused by a rule the user
    // set, so recording it as `failed` would put a red mark against a task that
    // is working exactly as configured. The reason is kept in `error` either
    // way, so the history still says which of the two it was.
    const capped = error instanceof AppError && error.code === 'spending_cap_reached';
    const skipped = busy || capped;

    finishRun(runId, task.id, {
      status: skipped ? 'skipped' : 'failed',
      summary: busy
        ? 'Skipped: the app was busy with another job.'
        : capped
          ? "Skipped: today's spending cap has been reached."
          : null,
      error:
        error instanceof AppError
          ? { code: error.code, message: error.message }
          : { code: 'internal_error', message: String(error) },
    });
    markExecution(
      skipped ? 'stopped' : 'error',
      error instanceof AppError
        ? { code: error.code, message: error.message }
        : { code: 'internal_error', message: String(error) },
    );

    if (busy) {
      log.warn('scheduled task skipped; app busy', { id: task.id });
      return;
    }

    // Deliberately silent: the cap fires once per due task for the rest of the
    // day, and a push per skip would turn one budget decision into a stream of
    // notifications about work that was never going to run.
    if (capped) return;

    log.error('scheduled task failed', { id: task.id, error: String(error) });
    await notify(task, { ok: false, summary: `${task.name} failed to run.` });
  } finally {
    // Every exit unregisters, including the early returns above. A registration
    // left behind would keep offering to cancel a run that has already ended,
    // and would shadow the next attempt at this task id.
    cancellable.dispose();
  }

}

/**
 * One sweep. Tasks run one after another rather than in parallel: they all
 * contend for the same single job lock anyway, so firing them concurrently
 * would just make all but one wait out its timeout and record a `skipped` it
 * didn't deserve.
 */
export async function runDueTasks(now = Date.now()): Promise<number> {
  const due = dueScheduledTasks(now);
  if (due.length === 0) return 0;

  log.info('running due scheduled tasks', { count: due.length });
  for (const task of due) {
    await runScheduledTask(task.id);
  }
  return due.length;
}

const job: IntervalJob = createIntervalJob({
  name: 'task scheduler',
  intervalMs: INTERVAL_MS,
  bootDelayMs: BOOT_DELAY_MS,
  disabled: env.schedulerDisabled,
  tick: () => runDueTasks(),
});

export function startTaskScheduler(): void {
  job.start();
}

export function stopTaskScheduler(): void {
  job.stop();
}

/** Test seam — a job whose interval is a minute is otherwise unobservable. */
export function runTaskSchedulerNow(): Promise<void> {
  return job.runNow();
}
