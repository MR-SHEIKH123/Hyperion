/**
 * Scheduled task definitions and their run history.
 *
 * A scheduled task is a saved Cowork prompt plus a recurrence. The scheduler
 * (`scheduler.ts`) reads from here; the HTTP layer writes to here. This module
 * deliberately knows nothing about running anything — it parses schedules,
 * answers "is this due?", and records what happened.
 *
 * ## Schedule format
 *
 * `daily:HH:MM` or `weekly:D:HH:MM`, where D is 0-6 with 0 = Sunday. The spec
 * asked for "daily/weekly at a given time" and explicitly not full cron, so
 * this is the whole grammar. Two consequences worth stating out loud:
 *
 *   - Times are **local**, not UTC. A user who asks for a 9am digest means 9am
 *     where they are, and would be reasonably annoyed to get it at 3am after a
 *     DST shift. Local-time `Date` arithmetic handles this; we never touch UTC.
 *
 *   - Due-ness is computed from `last_run_at`, not from a wall-clock match. A
 *     tick that lands at 09:04 must still fire a 09:00 task, or a machine that
 *     was asleep at exactly the right minute would silently skip the day. The
 *     rule is: due when the most recent scheduled occurrence at-or-before now
 *     is later than the last run. That makes a missed window fire late rather
 *     than not at all, and makes a second tick inside one window a no-op.
 */

import { getDb } from '../../db/adapter.ts';
import { AppError } from '../../util/errors.ts';

import type { BindValue } from '../../db/adapter.ts';

export type RunStatus = 'running' | 'success' | 'failed' | 'skipped';

export interface ScheduledTaskRow {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  model_id: string;
  chat_id: string | null;
  cwd: string | null;
  enabled: number;
  last_run_at: number | null;
  last_status: string | null;
  created_at: number;
  updated_at: number;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  modelId: string;
  chatId: string | null;
  cwd: string | null;
  enabled: boolean;
  lastRunAt: number | null;
  lastStatus: RunStatus | null;
  createdAt: number;
  updatedAt: number;
  /** When this task fires next, given its schedule. Convenience for the UI. */
  nextRunAt: number;
}

export interface TaskRunRow {
  id: string;
  task_id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  artifact_key: string | null;
  artifact_version: number | null;
  summary: string | null;
  error_code: string | null;
  error_message: string | null;
}

export interface TaskRun {
  id: string;
  taskId: string;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  artifact: { key: string; version: number } | null;
  summary: string | null;
  error: { code: string; message: string } | null;
}

// --- schedule parsing ------------------------------------------------------

export interface ParsedSchedule {
  kind: 'daily' | 'weekly';
  /** 0-6, Sunday = 0. Only meaningful when kind is 'weekly'. */
  weekday: number;
  hour: number;
  minute: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function badSchedule(value: string): AppError {
  return new AppError(
    'bad_request',
    `Invalid schedule "${value}". Expected "daily:HH:MM" or "weekly:D:HH:MM" (D is 0-6, Sunday = 0).`,
    { details: { field: 'schedule' } },
  );
}

function toInt(part: string | undefined, max: number, raw: string): number {
  if (part === undefined || !/^\d{1,2}$/.test(part)) throw badSchedule(raw);
  const value = Number(part);
  if (value > max) throw badSchedule(raw);
  return value;
}

export function parseSchedule(value: string): ParsedSchedule {
  const parts = value.trim().toLowerCase().split(':');
  const kind = parts[0];

  if (kind === 'daily') {
    if (parts.length !== 3) throw badSchedule(value);
    return {
      kind: 'daily',
      weekday: 0,
      hour: toInt(parts[1], 23, value),
      minute: toInt(parts[2], 59, value),
    };
  }

  if (kind === 'weekly') {
    if (parts.length !== 4) throw badSchedule(value);
    return {
      kind: 'weekly',
      weekday: toInt(parts[1], 6, value),
      hour: toInt(parts[2], 23, value),
      minute: toInt(parts[3], 59, value),
    };
  }

  throw badSchedule(value);
}

/** Canonical form, so "DAILY:9:5" and "daily:09:05" are stored identically. */
export function formatSchedule(parsed: ParsedSchedule): string {
  const hh = String(parsed.hour).padStart(2, '0');
  const mm = String(parsed.minute).padStart(2, '0');
  return parsed.kind === 'daily' ? `daily:${hh}:${mm}` : `weekly:${parsed.weekday}:${hh}:${mm}`;
}

/**
 * The most recent occurrence at or before `now`. Built with local-time `Date`
 * arithmetic rather than by subtracting fixed millisecond spans, so a DST
 * transition shifts the wall-clock slot instead of dragging it an hour off.
 */
export function previousOccurrence(parsed: ParsedSchedule, now: number): number {
  const at = new Date(now);
  at.setHours(parsed.hour, parsed.minute, 0, 0);

  if (parsed.kind === 'daily') {
    if (at.getTime() > now) at.setDate(at.getDate() - 1);
    return at.getTime();
  }

  // Walk back to the requested weekday, then back one more week if that lands
  // in the future (today is the right day but the time hasn't come yet).
  const delta = (at.getDay() - parsed.weekday + 7) % 7;
  at.setDate(at.getDate() - delta);
  if (at.getTime() > now) at.setDate(at.getDate() - 7);
  return at.getTime();
}

export function nextOccurrence(parsed: ParsedSchedule, now: number): number {
  const at = new Date(previousOccurrence(parsed, now));
  if (parsed.kind === 'daily') at.setDate(at.getDate() + 1);
  else at.setDate(at.getDate() + 7);
  return at.getTime();
}

/**
 * Due when the latest scheduled slot is newer than the last run.
 *
 * A task that has never run is due only if its first slot has already passed
 * *and* fell after the task was created — otherwise saving a "daily at 09:00"
 * task at 23:00 would fire it immediately off this morning's slot, which reads
 * as a bug to anyone watching.
 */
export function isDue(task: ScheduledTask, now = Date.now()): boolean {
  if (!task.enabled) return false;
  const parsed = parseSchedule(task.schedule);
  const slot = previousOccurrence(parsed, now);

  if (task.lastRunAt === null) {
    const period = parsed.kind === 'daily' ? DAY_MS : WEEK_MS;
    return slot >= task.createdAt && now - slot < period;
  }

  return slot > task.lastRunAt;
}

// --- mapping ---------------------------------------------------------------

function asRunStatus(value: string | null): RunStatus | null {
  return value === 'running' || value === 'success' || value === 'failed' || value === 'skipped'
    ? value
    : null;
}

function mapTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    schedule: row.schedule,
    modelId: row.model_id,
    chatId: row.chat_id,
    cwd: row.cwd,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    lastStatus: asRunStatus(row.last_status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextRunAt: nextOccurrence(parseSchedule(row.schedule), Date.now()),
  };
}

function mapRun(row: TaskRunRow): TaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: asRunStatus(row.status) ?? 'failed',
    artifact:
      row.artifact_key !== null && row.artifact_version !== null
        ? { key: row.artifact_key, version: row.artifact_version }
        : null,
    summary: row.summary,
    error:
      row.error_code !== null ? { code: row.error_code, message: row.error_message ?? '' } : null,
  };
}

const TASK_COLUMNS = `id, name, prompt, schedule, model_id, chat_id, cwd, enabled,
                      last_run_at, last_status, created_at, updated_at`;

// --- CRUD ------------------------------------------------------------------

export function listScheduledTasks(): ScheduledTask[] {
  return getDb()
    .prepare<ScheduledTaskRow>(
      `SELECT ${TASK_COLUMNS} FROM scheduled_tasks ORDER BY created_at DESC`,
    )
    .all()
    .map(mapTask);
}

export function findScheduledTask(id: string): ScheduledTask | null {
  const row = getDb()
    .prepare<ScheduledTaskRow>(`SELECT ${TASK_COLUMNS} FROM scheduled_tasks WHERE id = ?`)
    .get(id);
  return row ? mapTask(row) : null;
}

export function requireScheduledTask(id: string): ScheduledTask {
  const task = findScheduledTask(id);
  if (!task) {
    throw new AppError('not_found', `Scheduled task "${id}" does not exist.`);
  }
  return task;
}

export interface CreateScheduledTaskInput {
  name: string;
  prompt: string;
  schedule: string;
  modelId: string;
  chatId?: string | null;
  cwd?: string | null;
  enabled?: boolean;
}

function taskId(): string {
  return `sch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function createScheduledTask(input: CreateScheduledTaskInput): ScheduledTask {
  const now = Date.now();
  const id = taskId();
  const schedule = formatSchedule(parseSchedule(input.schedule));

  getDb()
    .prepare(
      `INSERT INTO scheduled_tasks
         (id, name, prompt, schedule, model_id, chat_id, cwd, enabled,
          last_run_at, last_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(
      id,
      input.name,
      input.prompt,
      schedule,
      input.modelId,
      input.chatId ?? null,
      input.cwd ?? null,
      input.enabled ?? true,
      now,
      now,
    );

  return requireScheduledTask(id);
}

export interface UpdateScheduledTaskInput {
  name?: string;
  prompt?: string;
  schedule?: string;
  modelId?: string;
  chatId?: string | null;
  cwd?: string | null;
  enabled?: boolean;
}

export function updateScheduledTask(id: string, input: UpdateScheduledTaskInput): ScheduledTask {
  requireScheduledTask(id);

  const sets: string[] = [];
  const params: BindValue[] = [];
  const set = (column: string, value: BindValue): void => {
    sets.push(`${column} = ?`);
    params.push(value);
  };

  if (input.name !== undefined) set('name', input.name);
  if (input.prompt !== undefined) set('prompt', input.prompt);
  if (input.schedule !== undefined) set('schedule', formatSchedule(parseSchedule(input.schedule)));
  if (input.modelId !== undefined) set('model_id', input.modelId);
  if (input.chatId !== undefined) set('chat_id', input.chatId);
  if (input.cwd !== undefined) set('cwd', input.cwd);
  if (input.enabled !== undefined) set('enabled', input.enabled);

  if (sets.length > 0) {
    set('updated_at', Date.now());
    params.push(id);
    getDb()
      .prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
  }

  return requireScheduledTask(id);
}

export function deleteScheduledTask(id: string): void {
  requireScheduledTask(id);
  // Run history goes with it via ON DELETE CASCADE.
  getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

/** Enabled tasks whose latest slot has passed. The scheduler's only query. */
export function dueScheduledTasks(now = Date.now()): ScheduledTask[] {
  return listScheduledTasks().filter((task) => isDue(task, now));
}

// --- run history -----------------------------------------------------------

function runId(): string {
  return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Open a run row before the work starts. Recording the attempt up front means
 * a crash mid-run leaves visible evidence (a row stuck at "running") instead
 * of looking like the task simply never came due.
 */
export function startRun(task: string, at = Date.now()): string {
  const id = runId();
  getDb()
    .prepare(
      `INSERT INTO scheduled_task_runs (id, task_id, started_at, finished_at, status)
       VALUES (?, ?, ?, NULL, 'running')`,
    )
    .run(id, task, at);
  return id;
}

export interface FinishRunInput {
  status: Exclude<RunStatus, 'running'>;
  summary?: string | null;
  artifact?: { key: string; version: number } | null;
  error?: { code: string; message: string } | null;
}

/**
 * Close a run and mirror its outcome onto the task.
 *
 * `last_run_at` is stamped for every terminal status including `skipped`, so a
 * task that couldn't get the lock this window doesn't stay due and retry on
 * every tick for the rest of the day — it waits for its next slot like normal.
 */
export function finishRun(id: string, task: string, input: FinishRunInput): void {
  const now = Date.now();
  const db = getDb();

  db.prepare(
    `UPDATE scheduled_task_runs
        SET finished_at = ?, status = ?, summary = ?,
            artifact_key = ?, artifact_version = ?,
            error_code = ?, error_message = ?
      WHERE id = ?`,
  ).run(
    now,
    input.status,
    input.summary ?? null,
    input.artifact?.key ?? null,
    input.artifact?.version ?? null,
    input.error?.code ?? null,
    input.error?.message ?? null,
    id,
  );

  db.prepare('UPDATE scheduled_tasks SET last_run_at = ?, last_status = ? WHERE id = ?').run(
    now,
    input.status,
    task,
  );
}

export function listTaskRuns(task: string, limit = 50): TaskRun[] {
  requireScheduledTask(task);
  return getDb()
    .prepare<TaskRunRow>(
      `SELECT id, task_id, started_at, finished_at, status, artifact_key,
              artifact_version, summary, error_code, error_message
         FROM scheduled_task_runs
        WHERE task_id = ?
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(task, limit)
    .map(mapRun);
}
