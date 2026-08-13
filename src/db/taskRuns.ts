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
 */
export type TaskRunState =
  | 'running'
  | 'paused'
  | 'complete'
  | 'error'
  | 'blocked'
  | 'ready_for_review'
  | 'stopped';

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
}

/**
 * Record a task as running.
 *
 * `INSERT OR REPLACE` on the primary key: a retried run id is the same run
 * being restarted, and leaving the old terminal row in place would make a
 * reconnecting client believe a task that is running right now had finished.
 */
export function startTaskRun(input: StartTaskRunInput): TaskRun {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO task_runs
         (run_id, task_id, tool, chat_id, state, started_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    )
    .run(input.runId, input.taskId, input.tool, input.chatId ?? null, now, now);
  return requireTaskRun(input.runId);
}

/**
 * Move a run to a terminal or paused state.
 *
 * `complete`, `error` and `stopped` stamp `completed_at`; `paused` and `running`
 * clear it, so a resumed run does not carry a completion time it has not
 * reached. The reason columns are always rewritten — a run that resumes must not
 * keep the error that paused it, or the UI will show a stale failure over live
 * output.
 */
export function finishTaskRun(
  runId: string,
  state: TaskRunState,
  reason?: { pauseReason?: string | undefined; code?: string | undefined; message?: string | undefined },
): void {
  const now = Date.now();
  const terminal = state === 'complete' || state === 'error' || state === 'stopped';
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
}

/**
 * Move a live run to a non-terminal state, mid-run.
 *
 * This is how the agent loop says "I am waiting on the user" (`blocked`) or
 * "come look at this" (`ready_for_review`) while the run is still live — the
 * multi-task view should reflect that reality now, not only once the run ends.
 *
 * Deliberately separate from `finishTaskRun`: it never touches `completed_at`
 * (the run has not ended) and never rewrites the reason columns (a run that
 * blocks must not lose the pause/error reason it may already carry, and a run
 * that becomes ready for review has no new reason to record). Only `state` and
 * `updated_at` move.
 */
export function updateTaskRunState(runId: string, state: TaskRunState): void {
  getDb()
    .prepare('UPDATE task_runs SET state = ?, updated_at = ? WHERE run_id = ?')
    .run(state, Date.now(), runId);
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
      `SELECT * FROM task_runs
        WHERE tool = ? AND task_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .get(tool, taskId);
  return row ? mapRow(row) : null;
}

/**
 * Demote runs a dead process left mid-flight, mirroring `reconcileOrphanedRuns`
 * for chat.
 *
 * A row saying `running` after a restart is a lie the state endpoint would
 * repeat forever, leaving a client waiting on a stream nothing will ever write
 * to. `error` rather than `paused`: unlike a chat run there is no resume path
 * for a task whose agent process is gone, so claiming it is resumable would be
 * the same lie in a different shape.
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
  const result = getDb()
    .prepare(
      // SET expressions see the pre-update row, so this CASE reads the state the
      // crash left behind and names the right cause for each.
      `UPDATE task_runs
          SET state = 'error',
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
  return Number(result.changes ?? 0);
}
