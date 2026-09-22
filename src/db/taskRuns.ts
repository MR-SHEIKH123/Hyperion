/**
 * Task run state, persisted so a dropped SSE stream is recoverable.
 *
 * Code, Cowork and Design stream their work over an event stream that a phone
 * locking its screen or a laptop sleeping will drop. The stream is the only
 * channel those tools have, so without a record on disk a reconnecting client
 * cannot tell "still running" from "finished while you were away" from "died".
 * This table is that record, and `GET /api/{tool}/tasks/:taskId/state` is how a
 * client reads it back.
 *
 * Deliberately coarse: state, the reason it stopped, and timestamps. Progress
 * detail, partial output and tool-call transcripts stay on the stream, because
 * persisting them would make every token a write and still not reproduce the
 * stream faithfully. A reconnecting client learns whether to wait, retry, or
 * show a result — which is the question it actually has.
 *
 * The vocabulary matches `RunState` in `src/types/core.ts` (`running`, `paused`,
 * `complete`, `error`) rather than inventing a parallel one, so a frontend that
 * already branches on chat run state does not need a second mapping.
 */

import { getDb } from './adapter.ts';
import { closeApprovals } from './approvals.ts';
import { activeProject } from './projects.ts';
import { clearConversation } from './taskMessages.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('taskruns');

/**
 * The states a task run can hold. `idle` never reaches the table.
 *
 * `blocked` and `ready_for_review` are written mid-run by the agent loop via
 * `updateTaskRunState` — `blocked` when the run is waiting on something it
 * cannot resolve alone (a confirmation, a missing dependency, a redaction
 * flag on an unattended run), `ready_for_review` when the work is done and
 * specifically wants the user's eyes. Neither is terminal: the run is still
 * live, so `completed_at` stays null until a real ending.
 *
 * `stopped` is terminal and means the run ended early at a ceiling the user
 * configured (Part 1.19), with `pause_reason = 'ceiling_reached'`. It is not
 * `error` because nothing broke, and not `paused` because there is nothing to
 * resume into — the same ceiling would trip again immediately.
 *
 * `interrupted` is terminal too, and means the run ended because something
 * outside it stopped the process (a restart, most often — migration `020`, item
 * 1.31). Not `error`, because the work did not fail; not `paused`, because a
 * task run has no resume path. The cause still rides in `error_code`
 * (`internal_error`), and rows written before `020` keep their old shape
 * (`state = 'error'` with that code), so history is never rewritten.
 */
export type TaskRunState =
  | 'running'
  | 'paused'
  | 'complete'
  | 'error'
  | 'blocked'
  | 'ready_for_review'
  | 'stopped'
  | 'interrupted';

/**
 * The states a run has *finished* in — nothing is executing, nothing is waiting
 * on a decision, and no process is needed to make the row mean anything.
 */
export type TerminalTaskRunState = 'complete' | 'error' | 'stopped' | 'interrupted';

/** Everything that is not terminal — the runs a switch warning is about. */
export type ActiveTaskRunState = Exclude<TaskRunState, TerminalTaskRunState>;

/**
 * The two halves of the vocabulary, written so they cannot fall out of step.
 *
 * `TERMINAL_STATES` fixes the terminal set; `ACTIVE_STATES` is a `Record` over
 * everything that is **not** terminal, so a state added to `TaskRunState` fails
 * the build here until somebody decides which half it belongs to. The
 * alternative — a hand-maintained "not in this list" filter at the call site —
 * drops a new state silently, and the failure mode of a listing is an empty
 * screen that nobody reports as a bug.
 *
 * `blocked` and `ready_for_review` are active on purpose: a run parked on an
 * approval has not ended, and the person deciding whether it is safe to switch
 * away from a project is exactly the person who needs to be told something in it
 * is still waiting for them.
 */
const TERMINAL_STATES: Record<TerminalTaskRunState, true> = {
  complete: true,
  error: true,
  stopped: true,
  interrupted: true,
};

const ACTIVE_STATES: Record<Exclude<TaskRunState, TerminalTaskRunState>, true> = {
  running: true,
  paused: true,
  blocked: true,
  ready_for_review: true,
};

export const TERMINAL_RUN_STATES = Object.keys(TERMINAL_STATES) as TerminalTaskRunState[];
export const ACTIVE_RUN_STATES = Object.keys(ACTIVE_STATES) as ActiveTaskRunState[];

/** The active half, when a caller has a state it read rather than wrote. */
export function isActiveRunState(state: TaskRunState): state is ActiveTaskRunState {
  return (ACTIVE_RUN_STATES as readonly TaskRunState[]).includes(state);
}

/** Tools that own a task run. Chat has `chat_runs` and its own state machine. */
export type TaskRunTool = 'code' | 'cowork' | 'design';

export interface TaskRun {
  runId: string;
  taskId: string;
  tool: TaskRunTool;
  chatId: string | null;
  state: TaskRunState;
  pauseReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /**
   * The parked run this one continues, when it is a continuation (S1, migration
   * `026`). Null for every run that started on its own.
   *
   * `supersede()` already wrote the link as prose in the parked row's
   * `pause_reason` (`continued_as:<runId>`), which is the right shape for a user
   * reading why a run ended and the wrong shape for a check: an approval ticket
   * asks *this* direction — given the live run, is it the run the ticket was
   * minted for, or one that records it as its predecessor? Deriving that from a
   * sentence would put a prose edit between the user and every continuation.
   */
  continuedFrom: string | null;
  /**
   * The project this run was scoped to when it started (migration `027`), or
   * null when there is no project to name.
   *
   * Read at the moment the row is written rather than passed in by the caller,
   * because the value has to agree with the directory the run's own path
   * resolution reads — both come from `active_project_id`, and a caller that
   * supplied its own answer could disagree with where the run actually worked.
   * That also means no future call site can forget it and produce an
   * invisible run: there is exactly one place that starts a run.
   *
   * Null is a real state and not an error: a run started with nothing open works
   * in the default projects root, which is not a project row, and rows written
   * before `027` have no scope recorded anywhere. The listing that reads this
   * reports those as unattributed instead of guessing.
   */
  projectId: string | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
}

interface TaskRunRow {
  run_id: string;
  task_id: string;
  tool: string;
  chat_id: string | null;
  state: string;
  pause_reason: string | null;
  continued_from: string | null;
  project_id: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
}

function mapRow(row: TaskRunRow): TaskRun {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    tool: row.tool as TaskRunTool,
    chatId: row.chat_id,
    state: row.state as TaskRunState,
    pauseReason: row.pause_reason,
    continuedFrom: row.continued_from ?? null,
    projectId: row.project_id ?? null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export interface StartTaskRunInput {
  runId: string;
  taskId: string;
  tool: TaskRunTool;
  chatId?: string | undefined;
  /** Set by the continuation route: the parked run this run is carrying on. */
  continuedFrom?: string | undefined;
}

/**
 * Record a task as running.
 *
 * `INSERT OR REPLACE` on the primary key: a retried run id is the same run
 * being restarted, and leaving the old terminal row in place would make a
 * reconnecting client believe a task that is running right now had finished.
 *
 * The project stamp is read here, from the same setting the run's own path
 * resolution reads (`active_project_id` through `fsScope`), so the row cannot
 * claim a directory the run was not scoped to. A continuation is stamped the
 * same way as a fresh run — with the project that is open when it starts —
 * because that is where it is actually working; inheriting the parked run's
 * project would name a directory this run may not resolve a single path in.
 */
export function startTaskRun(input: StartTaskRunInput): TaskRun {
  const now = Date.now();
  const projectId = activeProject()?.id ?? null;
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO task_runs
         (run_id, task_id, tool, chat_id, continued_from, project_id, state, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    )
    .run(
      input.runId,
      input.taskId,
      input.tool,
      input.chatId ?? null,
      input.continuedFrom ?? null,
      projectId,
      now,
      now,
    );
  return requireTaskRun(input.runId);
}

/**
 * Move a run to a terminal or paused state.
 *
 * `complete`, `error`, `stopped` and `interrupted` stamp `completed_at`;
 * `paused` and `running` clear it, so a resumed run does not carry a completion
 * time it has not reached. The reason columns are always rewritten — a run that resumes must not
 * keep the error that paused it, or the UI will show a stale failure over live
 * output.
 */
export function finishTaskRun(
  runId: string,
  state: TaskRunState,
  reason?: { pauseReason?: string | undefined; code?: string | undefined; message?: string | undefined },
): void {
  const now = Date.now();
  const terminal = state === 'complete' || state === 'error' || state === 'stopped' || state === 'interrupted';
  const run = terminal ? getTaskRun(runId) : null;

  getDb()
    .prepare(
      `UPDATE task_runs
          SET state = ?,
              pause_reason = ?,
              error_code = ?,
              error_message = ?,
              updated_at = ?,
              completed_at = ?
        WHERE run_id = ?`,
    )
    .run(
      state,
      reason?.pauseReason ?? null,
      reason?.code ?? null,
      reason?.message ?? null,
      now,
      terminal ? now : null,
      runId,
    );

  if (run !== null) releaseTaskState(run.tool, run.taskId);
}

/**
 * Drop what a task was only keeping in order to be continued.
 *
 * Called on the terminal transition, inline, and **not** left to the cleanup timer.
 * Both halves are load-bearing:
 *
 * The conversation snapshot is stored verbatim and unredacted, because continuation
 * has to replay exactly what the agent saw. Tool results in it carry full file
 * contents and raw command output, so a live snapshot is effectively a partial copy
 * of the user's source tree. What bounds that exposure is not the content but the
 * *window* — "while parked" — and this delete is what closes it. A timer-based sweep
 * would leave the window open for up to a day, which is a different guarantee from
 * the one `docs/CONTRACTS.md` states.
 *
 * Session allowances are cleared for a different reason: 1.27 requires them to be
 * cleared when the task ends, and an allowance outliving its task would silently
 * pre-approve a *later* run that happened to reuse the id.
 *
 * Skipped when another attempt of the same task is still live. A task id is reused
 * across attempts, so a superseded run reaching a terminal state must not delete the
 * snapshot its successor is about to continue from.
 *
 * Failures are logged and swallowed: this is called from the tail of a run that has
 * already ended, and turning bookkeeping into an exception there would report a
 * finished task as broken. A missed delete is caught by the cleanup backstop.
 */
function releaseTaskState(tool: TaskRunTool, taskId: string): void {
  try {
    const live = getDb()
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM task_runs
          WHERE task_id = ? AND tool = ?
            AND state NOT IN ('complete', 'error', 'stopped')`,
      )
      .get(taskId, tool);
    if ((live?.n ?? 0) > 0) return;

    clearConversation(taskId);
    closeApprovals(taskId);
  } catch (error) {
    log.warn(`task ${taskId}: could not release its continuation state: ${String(error)}`);
  }
}

/**
 * Move a live run to a non-terminal state, mid-run.
 *
 * This is how the agent loop says "I am waiting on the user" (`blocked`) or
 * "come look at this" (`ready_for_review`) while the run is still live — the
 * multi-task view should reflect that reality now, not only once the run ends.
 *
 * Deliberately separate from `finishTaskRun`: it never touches `completed_at`
 * (the run has not ended) and it never *clears* a reason. `state` and `updated_at`
 * always move; the reason columns move only when the caller supplies one.
 *
 * **A park now supplies one** (`pauseReason`, 1.31). It did not before, and the
 * cost was visible in two places that were written expecting it: the Attention
 * Center's `blocked` / `paused` / `ready_for_review` items read
 * `pause_reason ?? <a generic sentence>`, so every parked run showed the generic
 * sentence, and an unattended run had nothing to say beyond "failed". The token
 * written here is the `ParkReason` (`plan_ready`, `redaction_blocked`, …) and NOT
 * the sentence — see `services/agent/parkMessages.ts` for why the translation
 * lives at the point of display.
 *
 * The old rule is preserved, not replaced: a bare transition still leaves the
 * columns alone, because a run that becomes `ready_for_review` on a reason the
 * caller did not state must not lose an earlier, still-true one — and because
 * clearing them here would erase a `ceiling_reached` or `approval_denied` the
 * history needs.
 */
export function updateTaskRunState(
  runId: string,
  state: TaskRunState,
  reason: { pauseReason?: string | undefined } = {},
): void {
  if (reason.pauseReason === undefined) {
    getDb()
      .prepare('UPDATE task_runs SET state = ?, updated_at = ? WHERE run_id = ?')
      .run(state, Date.now(), runId);
    return;
  }
  getDb()
    .prepare('UPDATE task_runs SET state = ?, pause_reason = ?, updated_at = ? WHERE run_id = ?')
    .run(state, reason.pauseReason, Date.now(), runId);
}

/** The two states a parked run can be in, both non-terminal and both continuable. */
export const PARKED_STATES: readonly TaskRunState[] = ['blocked', 'ready_for_review'];

/**
 * Claim a parked run for continuation, atomically.
 *
 * **This transition is the mutex**, and it is the only thing standing between two
 * concurrent `POST /continue` calls and two agents running against one worktree.
 * The condition is in the SQL rather than in a read-then-write, because a read
 * followed by a write is exactly the race being prevented — both callers would see
 * `ready_for_review` and both would proceed.
 *
 * Zero rows changed means somebody else already claimed it, or the run was never
 * parked. The caller distinguishes those by reading the row afterwards; either way
 * it must not start an agent.
 *
 * A run resolving an *approval* is additionally guarded by the `pending_approvals`
 * state transition, but a bare continue of `plan_ready` has no second guard, so
 * this one has to be sufficient on its own.
 */
export function claimParkedRun(runId: string): boolean {
  const changed = getDb()
    .prepare(
      `UPDATE task_runs SET state = 'running', updated_at = ?
        WHERE run_id = ? AND state IN ('blocked', 'ready_for_review')`,
    )
    .run(Date.now(), runId).changes;
  return changed !== 0;
}

/**
 * Put a claimed run back the way it was, because the continuation never started.
 *
 * `claimParkedRun` moves the park to `running` and the route only gets as far as
 * starting a new run *inside* the lane. Between those two points there is a wait:
 * a Code continuation queues behind the lane, and the wait can end without a
 * continuation — the client disconnects (which aborts the lane waiter, since the
 * SSE stream is the run's own liveness) or the queue times out. Measured against
 * the tree, the run was left `running` with no process behind it: `requireContinuable`
 * refuses it (`not parked`), the next boot demotes it to `interrupted`, and the
 * user's park was gone because they closed a tab.
 *
 * So the claim is released, and the guard is the mirror of the claim's: only a row
 * that is still `running` *and* has no continuation of its own moves. `state` and
 * `pauseReason` come from the row read before the claim, which is the only place
 * they exist — `claimParkedRun` overwrote neither, but nothing else knows what the
 * park was waiting on.
 *
 * Returns whether the release happened. `false` is not an error: it means a
 * continuation did start, and its own state is the truth.
 */
export function releaseParkedRun(
  runId: string,
  parked: { state: 'blocked' | 'ready_for_review'; pauseReason: string | null },
): boolean {
  const changed = getDb()
    .prepare(
      `UPDATE task_runs SET state = ?, pause_reason = ?, updated_at = ?
        WHERE run_id = ? AND state = 'running'`,
    )
    .run(parked.state, parked.pauseReason, Date.now(), runId).changes;
  return changed !== 0;
}

export function getTaskRun(runId: string): TaskRun | null {
  const row = getDb()
    .prepare<TaskRunRow>('SELECT * FROM task_runs WHERE run_id = ?')
    .get(runId);
  return row ? mapRow(row) : null;
}

function requireTaskRun(runId: string): TaskRun {
  const run = getTaskRun(runId);
  if (run === null) {
    throw new Error(`task run "${runId}" vanished immediately after being written`);
  }
  return run;
}

/**
 * The most recent run for a task, which is what a reconnecting client wants.
 *
 * A task id can be reused across attempts — the user retries, the frontend
 * sends the same id — so ordering by `started_at` and taking one row answers
 * "what is happening with this task now", not "what once happened to it".
 */
export function latestRunForTask(tool: TaskRunTool, taskId: string): TaskRun | null {
  const row = getDb()
    .prepare<TaskRunRow>(
      // `rowid` breaks ties on equal `started_at`: two attempts of one task can
      // start inside the same millisecond (a retry of a fast failure), and
      // "whichever row SQLite happened to reach first" is not an answer a
      // caller can reason about. The rowid is insertion order, so the tie goes
      // to the attempt that was actually started last.
      `SELECT * FROM task_runs
        WHERE tool = ? AND task_id = ?
        ORDER BY started_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(tool, taskId);
  return row ? mapRow(row) : null;
}

/**
 * Every task in one project that has not finished yet, newest first.
 *
 * `projectId: null` asks the other half of the same question — the runs with no
 * project to name. The two calls together are what the listing route reports, so
 * a caller cannot present the per-project answer as complete while unattributed
 * runs exist, and the query is written once rather than twice.
 *
 * Two rules shape the SQL:
 *
 * - **Only the latest run for a task.** A task id can be run again — a retry, a
 *   continuation — and the states are one-way, so an older row for the same
 *   `(tool, task_id)` is history. Listing both would count one task twice, which
 *   is exactly the number a switch warning is made of. The ordering mirrors
 *   `latestRunForTask` down to its tie-break, so the two cannot disagree about
 *   which run is current.
 * - **Terminal states are excluded.** A finished run is not something to warn
 *   about; the point of the read is work that is still going or still waiting.
 *   The set comes from `ACTIVE_RUN_STATES`, whose typing makes a new state a
 *   compile error until it is classified.
 */
export function activeTaskRuns(projectId: string | null): TaskRun[] {
  const placeholders = ACTIVE_RUN_STATES.map(() => '?').join(', ');
  const rows = getDb()
    .prepare<TaskRunRow>(
      `SELECT * FROM task_runs r
        WHERE r.project_id IS ?
          AND r.state IN (${placeholders})
          AND r.run_id = (
                SELECT r2.run_id FROM task_runs r2
                 WHERE r2.tool = r.tool AND r2.task_id = r.task_id
                 ORDER BY r2.started_at DESC, r2.rowid DESC
                 LIMIT 1
              )
        ORDER BY r.started_at DESC, r.run_id DESC`,
    )
    .all(projectId, ...ACTIVE_RUN_STATES);
  return rows.map(mapRow);
}

/**
 * Demote runs a dead process left mid-flight, mirroring `reconcileOrphanedRuns`
 * for chat.
 *
 * A row saying `running` after a restart is a lie the state endpoint would
 * repeat forever, leaving a client waiting on a stream nothing will ever write
 * to. `interrupted` rather than `paused`: unlike a chat run there is no resume
 * path for a task whose agent process is gone, so claiming it is resumable
 * would be the same lie in a different shape. `interrupted` rather than `error`
 * as well: nothing about the task failed, the process running it went away, and
 * a state that cries error on every unclean shutdown teaches the user to ignore
 * errors. The cause rides in `error_code`, so a reader that only knows the old
 * shape still finds `internal_error` there.
 *
 * **`blocked` is demoted too, and that is the subtle half.** A blocked run waits
 * for an answer only its own live process can consume — a confirmation is
 * delivered into the agent loop, not into this table. Once that process dies
 * nothing can unblock the run, so leaving the row `blocked` strands it forever
 * behind a prompt whose answer now goes nowhere, and the notification feed keeps
 * advertising it as awaiting a decision the user can no longer give.
 *
 * **`ready_for_review` is deliberately left alone.** There the work is already
 * finished and merely wants a human to look at it; no live process is needed to
 * show a result that already exists, so demoting it would report completed work
 * as failed and discard something real. That is the dividing line — demote a
 * state that needed a process it no longer has, preserve one whose value
 * survives the restart.
 */
export function reconcileOrphanedTaskRuns(): number {
  const now = Date.now();
  // Read the parks *before* demoting them: after the UPDATE below the state is
  // `interrupted`, and the task ids are exactly what closing their prompts needs.
  const abandonedParks = getDb()
    .prepare<{ task_id: string }>(`SELECT task_id FROM task_runs WHERE state = 'blocked'`)
    .all()
    .map((row) => row.task_id);
  const result = getDb()
    .prepare(
      // SET expressions see the pre-update row, so this CASE reads the state the
      // crash left behind and names the right cause for each.
      `UPDATE task_runs
          SET state = 'interrupted',
              error_code = 'internal_error',
              error_message = CASE state
                WHEN 'blocked'
                  THEN 'The server restarted while this task was waiting for you, so it can no longer receive an answer.'
                ELSE 'The server restarted while this task was running.'
              END,
              updated_at = ?,
              completed_at = ?
        WHERE state IN ('running', 'blocked')`,
    )
    .run(now, now);

  // A demoted run's question is unanswerable — the message above says as much
  // ("it can no longer receive an answer") — so leaving its `pending_approvals`
  // rows `pending` would keep a dead prompt listed as answerable, in the task's own
  // approval list and as an attention item whose `resolve` call can only fail.
  // Closing them is the same terminal-transition rule `finishTaskRun` applies; the
  // difference is only that a restart, not a task, is what ended this run.
  for (const taskId of abandonedParks) closeApprovals(taskId);

  return Number(result.changes ?? 0);
}
