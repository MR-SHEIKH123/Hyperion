/**
 * Durable lifecycle for the bounded child runs a Code task delegates.
 *
 * Only identity, state, and the bounded result returned to the parent live
 * here. Provider turns and tool transcripts remain owned by the shared agent
 * loop; duplicating them would turn this small recovery record into a second
 * conversation store.
 */
import { randomUUID } from 'node:crypto';

import { getDb } from './adapter.ts';
import { AppError } from '../util/errors.ts';

export type SubagentRunState = 'running' | 'complete' | 'error' | 'stopped';

const ID_MAX = 200;
const PROMPT_MAX = 16_000;
const SUMMARY_MAX = 4_000;
const ERROR_CODE_MAX = 120;
const ERROR_MESSAGE_MAX = 1_000;

export interface SubagentRun {
  id: string;
  parentRunId: string | null;
  parentTaskId: string;
  childTaskId: string;
  sequence: number;
  depth: 1;
  state: SubagentRunState;
  prompt: string;
  summary: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
}

interface SubagentRunRow {
  id: string;
  parent_run_id: string | null;
  parent_task_id: string;
  child_task_id: string;
  sequence: number;
  depth: number;
  state: string;
  prompt: string;
  summary: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
}

function mapRow(row: SubagentRunRow): SubagentRun {
  return {
    id: row.id,
    parentRunId: row.parent_run_id,
    parentTaskId: row.parent_task_id,
    childTaskId: row.child_task_id,
    sequence: row.sequence,
    depth: 1,
    state: row.state as SubagentRunState,
    prompt: row.prompt,
    summary: row.summary,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export interface StartSubagentRunInput {
  parentRunId?: string;
  parentTaskId: string;
  childTaskId: string;
  sequence: number;
  prompt: string;
}

export function startSubagentRun(input: StartSubagentRunInput): SubagentRun {
  const parentTaskId = requiredText(input.parentTaskId, 'parentTaskId', ID_MAX);
  const childTaskId = requiredText(input.childTaskId, 'childTaskId', ID_MAX);
  const prompt = requiredText(input.prompt, 'prompt', PROMPT_MAX);
  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw new AppError('bad_request', 'A subagent requires parent and child identities, a prompt, and a positive sequence.');
  }

  const now = Date.now();
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO subagent_runs
         (id, parent_run_id, parent_task_id, child_task_id, sequence, depth, state,
          prompt, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'running', ?, ?, ?)`,
    )
    .run(id, input.parentRunId ?? null, parentTaskId, childTaskId, input.sequence, prompt, now, now);
  return requireSubagentRun(id);
}

export function finishSubagentRun(
  id: string,
  state: Exclude<SubagentRunState, 'running'>,
  result: { summary?: string; errorCode?: string; errorMessage?: string } = {},
): void {
  const runId = requiredText(id, 'id', ID_MAX);
  const terminal = terminalResult(state, result);
  const now = Date.now();
  const updated = getDb()
    .prepare(
      `UPDATE subagent_runs
          SET state = ?, summary = ?, error_code = ?, error_message = ?,
              updated_at = ?, completed_at = ?
        WHERE id = ? AND state = 'running'`,
    )
    .run(
      terminal.state,
      terminal.summary,
      terminal.errorCode,
      terminal.errorMessage,
      now,
      now,
      runId,
    );
  if (updated.changes !== 0) return;

  if (getSubagentRun(runId) === null) {
    throw new AppError('not_found', `Subagent run "${runId}" was not found.`);
  }
  throw new AppError('conflict', `Subagent run "${runId}" has already finished.`);
}

export function getSubagentRun(id: string): SubagentRun | null {
  const row = getDb()
    .prepare<SubagentRunRow>('SELECT * FROM subagent_runs WHERE id = ?')
    .get(id);
  return row ? mapRow(row) : null;
}

export function listSubagentRuns(parentTaskId: string): SubagentRun[] {
  return getDb()
    .prepare<SubagentRunRow>(
      'SELECT * FROM subagent_runs WHERE parent_task_id = ? ORDER BY sequence',
    )
    .all(parentTaskId)
    .map(mapRow);
}

function requireSubagentRun(id: string): SubagentRun {
  const row = getSubagentRun(id);
  if (row === null) throw new Error(`subagent run "${id}" vanished immediately after being written`);
  return row;
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') {
    throw new AppError('bad_request', `${field} must be a string.`);
  }
  const text = value.trim();
  if (text.length === 0 || text.length > maximum) {
    throw new AppError('bad_request', `${field} must contain between 1 and ${maximum} characters.`);
  }
  return text;
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined) return null;
  return requiredText(value, field, maximum);
}

function terminalResult(
  state: Exclude<SubagentRunState, 'running'>,
  result: { summary?: string; errorCode?: string; errorMessage?: string },
): { state: Exclude<SubagentRunState, 'running'>; summary: string | null; errorCode: string | null; errorMessage: string | null } {
  if (state !== 'complete' && state !== 'error' && state !== 'stopped') {
    throw new AppError('bad_request', 'A subagent must finish as complete, error, or stopped.');
  }
  const summary = optionalText(result.summary, 'summary', SUMMARY_MAX);
  const errorCode = optionalText(result.errorCode, 'errorCode', ERROR_CODE_MAX);
  const errorMessage = optionalText(result.errorMessage, 'errorMessage', ERROR_MESSAGE_MAX);
  if (state === 'error' && (errorCode === null || errorMessage === null)) {
    throw new AppError('bad_request', 'An errored subagent requires an error code and message.');
  }
  if (state !== 'error' && (errorCode !== null || errorMessage !== null)) {
    throw new AppError('bad_request', 'Only an errored subagent may store error details.');
  }
  return { state, summary, errorCode, errorMessage };
}
