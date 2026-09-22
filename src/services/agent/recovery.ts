/**
 * What an interrupted run left behind, and which of the three recoveries apply.
 *
 * Prompt 1.31 lists a recovery surface next to the `interrupted` state, and the
 * state half landed without it: a run that was killed mid-flight is now demoted
 * honestly on boot, but nothing tells a person what survived or what they can do
 * about it. The three verbs in the item are *view the partial work*, *resume* and
 * *discard*, and each of them already has a mechanism — this module composes the
 * facts those three need, and it does not invent a fourth:
 *
 *   - **view the partial work** — `task_steps` has recorded every tool call, plan,
 *     compaction, approval and model turn since migration `014`, and the loop has
 *     been writing rows into it the whole time. Until now `listSteps` and
 *     `summarizeSteps` had **no production reader at all**: the history of a run
 *     was written and never read back. This is that reader.
 *   - **resume** — a re-run of the task, which is what the continuation routes are
 *     not: `claimParkedRun` only moves a parked (`blocked` / `ready_for_review`)
 *     run, and an interrupted run is terminal, so there is no conversation to
 *     replay. A re-run is refused while a live run owns the task, so that is the
 *     one thing checked here.
 *   - **discard** — `POST /api/storage/worktrees/:name/discard`, on the leftover
 *     directory this run's edits are sitting in.
 *
 * ## Why the worktree answer is live rather than the last scan
 *
 * The attention queue reports `orphanedWorktreeSnapshot()` because `GET
 * /api/attention` is synchronous and a scan spawns git per directory. This read
 * asks about **one** task, so it looks the directory up by name and risk-checks
 * only that one: a person deciding whether to throw away their own uncommitted
 * edits should be told what is on disk now, not what a scan saw when the process
 * started.
 *
 * ## What it deliberately does not say
 *
 * `canResume` is a fact about *this process* — no live run owns the task — and not
 * a promise that the re-run will succeed. A task can be re-run and fail again for
 * any reason the first one did, and claiming otherwise here would make this
 * module a second, worse implementation of the run route's own validation. The
 * report says what is in the way (a live run) and nothing more.
 */
import { latestRunForTask, type TaskRun, type TaskRunTool } from '../../db/taskRuns.ts';
import {
  listSteps,
  summarizeSteps,
  type TaskStep,
  type TaskStepSummary,
} from '../../db/taskSteps.ts';
import { hasConversation, loadConversation } from '../../db/taskMessages.ts';
import { liveRunFor } from '../../orchestrator/cancel.ts';
import { findOrphanForTask, getWorktree, type OrphanedWorktree } from '../code/worktree.ts';
import { AppError } from '../../util/errors.ts';

/**
 * How many of a run's steps the report carries.
 *
 * A long run has thousands, and the surface for this is "what did it get as far
 * as doing?" — the tail answers that, the SQL summary answers "how much in
 * total", and `omitted` states the difference so a bounded list never reads as a
 * complete one. The same rule the worktree scan's `unchecked` follows.
 */
const STEP_TAIL = 50;

export interface RecoveryReport {
  run: TaskRun;
  /**
   * Whether this is the case the surface exists for.
   *
   * The report answers for **any** run rather than 404-ing on a finished one,
   * because the state a caller meant to ask about can have moved on between the
   * list and the click — and "it completed, there is nothing to recover" is a
   * better answer than an error that reads like the task never existed.
   */
  interrupted: boolean;
  /**
   * Why it ended, as recorded, or null when nothing was recorded about why.
   *
   * Keyed off the reason columns rather than off "did it stop": a run that
   * *completed* stopped too, and has no reason to report — the moment it finished
   * is in the run row. Filling this in for every terminal state would put a
   * `{ code: null, message: null }` where a reader expects a cause.
   */
  stop: { code: string | null; message: string | null; at: number | null } | null;
  partial: {
    /** The run's last `STEP_TAIL` steps, oldest first. */
    steps: TaskStep[];
    /** Totals over *every* step, computed in SQL. */
    summary: TaskStepSummary;
    /** Steps left out of `steps` by that bound. Zero for most runs. */
    omitted: number;
    lastStepAt: number | null;
    /**
     * The parked-run conversation snapshot, when one survived.
     *
     * Reported because it is the honest answer to "did the run's own words
     * survive the process?" — and because the answer does **not** make an
     * interrupted run continuable. `task_messages` exists so a *parked* run can
     * be replayed; a re-run of an interrupted task starts a fresh conversation.
     */
    conversation: { durable: boolean; messages: number };
  };
  /** The leftover checkout holding this run's edits, when it is still on disk. */
  worktree: OrphanedWorktree | null;
  actions: {
    resume: { possible: boolean; reason: string | null };
    discard: { possible: boolean; name: string | null; requiresForce: boolean; reason: string | null };
  };
}

/**
 * Compose the report for the latest run of a task.
 *
 * 404 for a task with no run at all, on the same reasoning as the state route:
 * "I have never heard of this task" and "this task's run is not in a state to
 * recover" are different answers, and only the first means the caller is asking
 * about something that does not exist.
 */
export async function recoveryReport(tool: TaskRunTool, taskId: string): Promise<RecoveryReport> {
  const run = latestRunForTask(tool, taskId);
  if (run === null) {
    throw new AppError('not_found', `No ${tool} task run recorded for "${taskId}".`, {
      details: { taskId },
    });
  }

  const steps = listSteps(run.runId);
  const summary = summarizeSteps(run.runId);
  const tail = steps.slice(-STEP_TAIL);
  const orphan = await findOrphanForTask(taskId);

  // A registered worktree is a live task's checkout. `findOrphanForTask` will not
  // return one, so this is only used to say *why* there is nothing to discard —
  // the difference between "your edits are gone" and "they are in use right now"
  // is exactly the kind of thing this surface must not blur.
  const registered = getWorktree(taskId) ?? null;
  const live = liveRunFor(tool, taskId);

  return {
    run,
    interrupted: run.state === 'interrupted',
    stop:
      run.errorCode === null && run.pauseReason === null && run.errorMessage === null
        ? null
        : { code: run.errorCode, message: run.errorMessage, at: run.completedAt ?? run.updatedAt },
    partial: {
      steps: tail,
      summary,
      omitted: steps.length - tail.length,
      lastStepAt: steps.length === 0 ? null : (steps[steps.length - 1]?.createdAt ?? null),
      conversation: { durable: hasConversation(taskId), messages: loadConversation(taskId).length },
    },
    worktree: orphan,
    actions: {
      resume:
        live === null
          ? { possible: true, reason: null }
          : {
              possible: false,
              reason: `this task is already running in this process (run ${live}), so a re-run would be refused`,
            },
      discard:
        orphan !== null
          ? {
              possible: true,
              name: orphan.name,
              // The route refuses a directory that holds work unless it is forced,
              // and `checked: false` is "git could not say" — which is never safe.
              requiresForce: orphan.risk !== null || !orphan.checked,
              reason: null,
            }
          : {
              possible: false,
              name: null,
              requiresForce: false,
              reason:
                registered !== null
                  ? 'a running task owns this checkout, so it is not an orphan'
                  : 'no leftover checkout for this task is on disk',
            },
    },
  };
}
