/**
 * The pause/resume state machine, persisted in `chat_runs`.
 *
 * This is the most important behavioural contract in the app, so the state
 * lives in SQLite rather than in memory. A paused run must survive a browser
 * reload *and* a PM2 restart — if the state were only in memory, a crash
 * during a provider outage would silently convert "paused, resumable, history
 * intact" into "gone", which is exactly the failure this machine exists to
 * prevent.
 *
 * Legal transitions:
 *
 *   idle ──▶ running ──▶ complete
 *              │  ▲
 *              │  └──── resume ────┐
 *              ▼                   │
 *            paused ───────────────┘
 *              │
 *              └──▶ error   (terminal; only via an explicit abandon)
 *
 * Notably `paused` is NOT terminal and NOT an error. A run only reaches
 * `error` when the user abandons it, or on a failure that cannot be paused
 * meaningfully (e.g. the chat itself is gone).
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../db/adapter.ts';
import { AppError } from '../util/errors.ts';
import type { PauseReason, RunState, RunStateSnapshot, ToolName } from '../types/core.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('runstate');

interface RunRow {
  id: string;
  chat_id: string;
  tool: string;
  state: string;
  pause_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  model_id: string | null;
  provider_id: string | null;
  message_id: string | null;
  attempt: number;
  created_at: number;
  updated_at: number;
  provider_name?: string | null;
}

const SELECT = `
  SELECT r.*, p.name AS provider_name
  FROM chat_runs r
  LEFT JOIN providers p ON p.id = r.provider_id
`;

function mapRow(row: RunRow): RunStateSnapshot {
  return {
    runId: row.id,
    chatId: row.chat_id,
    tool: row.tool as ToolName,
    state: row.state as RunState,
    pauseReason: (row.pause_reason as PauseReason | null) ?? null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    modelId: row.model_id,
    providerId: row.provider_id,
    providerName: row.provider_name ?? null,
    messageId: row.message_id,
    attempt: row.attempt,
    updatedAt: row.updated_at,
  };
}

export function findRun(runId: string): RunStateSnapshot | null {
  const row = getDb().prepare<RunRow>(`${SELECT} WHERE r.id = ?`).get(runId);
  return row ? mapRow(row) : null;
}

export function requireRun(runId: string): RunStateSnapshot {
  const run = findRun(runId);
  if (!run) throw new AppError('run_not_found', `No run with id "${runId}".`);
  return run;
}

/** The most recent run for a chat, whatever its state. */
export function latestRunForChat(chatId: string): RunStateSnapshot | null {
  const row = getDb()
    .prepare<RunRow>(`${SELECT} WHERE r.chat_id = ? ORDER BY r.created_at DESC LIMIT 1`)
    .get(chatId);
  return row ? mapRow(row) : null;
}

/** Paused runs, newest first. Powers the "resume where you left off" banner. */
export function listPausedRuns(chatId?: string): RunStateSnapshot[] {
  const db = getDb();
  const rows = chatId
    ? db.prepare<RunRow>(`${SELECT} WHERE r.state = 'paused' AND r.chat_id = ? ORDER BY r.updated_at DESC`).all(chatId)
    : db.prepare<RunRow>(`${SELECT} WHERE r.state = 'paused' ORDER BY r.updated_at DESC`).all();
  return rows.map(mapRow);
}

export interface CreateRunInput {
  chatId: string;
  tool: ToolName;
  modelId?: string | null;
  providerId?: string | null;
  messageId?: string | null;
}

export function createRun(input: CreateRunInput): RunStateSnapshot {
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO chat_runs
         (id, chat_id, tool, state, model_id, provider_id, message_id, attempt, created_at, updated_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, 1, ?, ?)`,
    )
    .run(id, input.chatId, input.tool, input.modelId ?? null, input.providerId ?? null, input.messageId ?? null, now, now);
  log.debug(`run ${id} started (${input.tool}/${input.chatId})`);
  return requireRun(id);
}

/**
 * Records which provider/model a run is actually executing on. Called again
 * after a failover so the persisted run reflects the provider that is really
 * serving it, not the one originally chosen.
 */
export function attachExecution(
  runId: string,
  input: { providerId?: string | null; modelId?: string | null; messageId?: string | null },
): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (input.providerId !== undefined) {
    sets.push('provider_id = ?');
    values.push(input.providerId);
  }
  if (input.modelId !== undefined) {
    sets.push('model_id = ?');
    values.push(input.modelId);
  }
  if (input.messageId !== undefined) {
    sets.push('message_id = ?');
    values.push(input.messageId);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(Date.now(), runId);
  getDb().prepare(`UPDATE chat_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export interface PauseInput {
  runId: string;
  reason: PauseReason;
  code: string;
  message: string;
}

/**
 * Pauses a run. Idempotent: pausing an already-paused run just refreshes the
 * reason, which is what a second failure during a manual retry should do.
 *
 * A completed run is never dragged back into `paused` — once the assistant
 * message is finished, a late error is a logging concern, not a pause.
 */
export function pauseRun(input: PauseInput): RunStateSnapshot {
  const run = requireRun(input.runId);
  if (run.state === 'complete') {
    log.warn(`ignoring pause of completed run ${input.runId} (${input.code})`);
    return run;
  }
  getDb()
    .prepare(
      `UPDATE chat_runs
         SET state = 'paused', pause_reason = ?, error_code = ?, error_message = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(input.reason, input.code, input.message, Date.now(), input.runId);
  log.info(`run ${input.runId} paused: ${input.reason} (${input.code})`);
  return requireRun(input.runId);
}

/**
 * Moves a paused run back to `running` and bumps the attempt counter.
 *
 * Only a paused run can resume. Guarding here (rather than trusting callers)
 * is what stops a double-click on "Retry" from starting two concurrent
 * generations against the same run.
 */
export function resumeRun(
  runId: string,
  input: { providerId?: string | null; modelId?: string | null } = {},
): RunStateSnapshot {
  const run = requireRun(runId);
  if (run.state !== 'paused') {
    throw new AppError(
      'run_not_paused',
      `Run "${runId}" is ${run.state}, not paused; nothing to resume.`,
      { details: { state: run.state } },
    );
  }
  getDb()
    .prepare(
      `UPDATE chat_runs
         SET state = 'running',
             pause_reason = NULL,
             error_code = NULL,
             error_message = NULL,
             attempt = attempt + 1,
             provider_id = COALESCE(?, provider_id),
             model_id = COALESCE(?, model_id),
             updated_at = ?
       WHERE id = ?`,
    )
    .run(input.providerId ?? null, input.modelId ?? null, Date.now(), runId);
  const next = requireRun(runId);
  log.info(`run ${runId} resumed (attempt ${next.attempt})`);
  return next;
}

export function completeRun(runId: string): RunStateSnapshot {
  getDb()
    .prepare(
      `UPDATE chat_runs
         SET state = 'complete', pause_reason = NULL, error_code = NULL, error_message = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .run(Date.now(), runId);
  return requireRun(runId);
}

/**
 * Terminal failure. Reserved for cases a pause cannot help with — a deleted
 * chat, a corrupt request, or the user explicitly abandoning the exchange.
 * Provider trouble should call `pauseRun`.
 */
export function failRun(runId: string, code: string, message: string): RunStateSnapshot {
  getDb()
    .prepare(`UPDATE chat_runs SET state = 'error', error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`)
    .run(code, message, Date.now(), runId);
  log.warn(`run ${runId} failed: ${code} — ${message}`);
  return requireRun(runId);
}

/**
 * Called once at boot. A run left `running` when the process died is not
 * actually running any more, so it is demoted to `paused` with an honest
 * reason instead of lying to the UI about being in flight forever.
 */
export function reconcileOrphanedRuns(): number {
  const result = getDb()
    .prepare(
      `UPDATE chat_runs
         SET state = 'paused',
             pause_reason = 'provider_failure',
             error_code = 'internal_error',
             error_message = 'The server restarted while this response was streaming. The conversation is intact; retry to continue.',
             updated_at = ?
       WHERE state = 'running'`,
    )
    .run(Date.now());
  const count = Number(result.changes ?? 0);
  if (count > 0) log.warn(`recovered ${count} run(s) interrupted by a restart`);
  return count;
}
