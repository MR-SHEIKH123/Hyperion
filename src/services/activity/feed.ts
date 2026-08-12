/**
 * "What has this thing been doing?" — in sentences, not log lines.
 *
 * This is not the debug console. `GET /api/errors` already serves raw records
 * for when something is broken; the feed is for the ordinary case where the user
 * has been away and wants to catch up. So each entry carries a plain-language
 * title, a status from one shared vocabulary, and a link to whatever it produced.
 * Nothing here surfaces a stack trace or an internal code.
 *
 * Two sources, unified: `task_runs` (an interactive Code, Cowork or Design run)
 * and `scheduled_task_runs` (a run that fired on a timer while nobody watched).
 * Their status vocabularies differ because they are answering different
 * questions, so both are mapped onto one set the UI can branch on once.
 *
 * The prompt also named subagent delegation as a third source. Nothing in the
 * backend records a delegation event today — there is no table and no writer —
 * so it is deliberately absent rather than faked from something adjacent. When a
 * producer exists, it joins the merge in `activityFeed` and needs no API change.
 *
 * Ordering is by `started_at`, never by "last updated". `started_at` is the only
 * column in either table that cannot change after the row is written, and a
 * cursor is only sound over a key that holds still: ordering by an updated time
 * would let a long-running task jump forward past the cursor a client is holding
 * and take rows with it, which reads as entries silently vanishing from the feed.
 */

import { getDb } from '../../db/adapter.ts';

export type ActivityKind = 'task' | 'scheduled-task';

/**
 * One vocabulary over both sources. `paused` only ever comes from an interactive
 * run and `skipped` only from a scheduled one, but the UI branches on a single
 * set rather than needing to know which source an entry came from first.
 */
export type ActivityStatus = 'running' | 'paused' | 'success' | 'failed' | 'skipped';

export type ActivityLink =
  | { kind: 'chat'; chatId: string }
  | { kind: 'artifact'; key: string; version: number };

export interface ActivityEntry {
  /** Namespaced so the two sources cannot collide on a shared id. */
  id: string;
  kind: ActivityKind;
  timestamp: number;
  status: ActivityStatus;
  /** A whole sentence, ready to render. */
  title: string;
  /** The reason, when there is one worth reading. */
  detail: string | null;
  link: ActivityLink | null;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  /**
   * Feed this back as `before` for the next page. `null` means the last page —
   * distinguishable from "there is more" without a second count query.
   */
  nextBefore: number | null;
}

export interface ActivityQuery {
  limit?: number;
  before?: number;
}

interface TaskRunFeedRow {
  run_id: string;
  task_id: string;
  tool: string;
  chat_id: string | null;
  state: string;
  pause_reason: string | null;
  error_message: string | null;
  started_at: number;
}

interface ScheduledRunFeedRow {
  id: string;
  task_id: string;
  task_name: string | null;
  started_at: number;
  status: string;
  artifact_key: string | null;
  artifact_version: number | null;
  summary: string | null;
  error_message: string | null;
}

const TOOL_LABELS: Record<string, string> = {
  code: 'Code',
  cowork: 'Cowork',
  design: 'Design',
};

function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

/** `RunState` as stored, mapped onto the feed's vocabulary. */
function taskStatus(state: string): ActivityStatus {
  if (state === 'complete') return 'success';
  if (state === 'error') return 'failed';
  if (state === 'paused') return 'paused';
  return 'running';
}

function taskTitle(tool: string, status: ActivityStatus): string {
  const label = toolLabel(tool);
  if (status === 'success') return `${label} task finished`;
  if (status === 'failed') return `${label} task failed`;
  if (status === 'paused') return `${label} task paused`;
  return `${label} task is still running`;
}

function mapTaskRun(row: TaskRunFeedRow): ActivityEntry {
  const status = taskStatus(row.state);

  return {
    id: `task:${row.run_id}`,
    kind: 'task',
    timestamp: row.started_at,
    status,
    title: taskTitle(row.tool, status),
    // The pause reason and the failure message are the two things worth saying
    // in prose. Everything else about the run is a debug-console concern.
    detail: status === 'paused' ? row.pause_reason : status === 'failed' ? row.error_message : null,
    link: row.chat_id === null ? null : { kind: 'chat', chatId: row.chat_id },
  };
}

function scheduledStatus(status: string): ActivityStatus {
  if (status === 'success' || status === 'failed' || status === 'skipped') return status;
  return 'running';
}

function scheduledTitle(name: string, status: ActivityStatus): string {
  if (status === 'success') return `Scheduled task "${name}" finished`;
  if (status === 'failed') return `Scheduled task "${name}" failed`;
  if (status === 'skipped') return `Scheduled task "${name}" was skipped`;
  return `Scheduled task "${name}" is still running`;
}

function mapScheduledRun(row: ScheduledRunFeedRow): ActivityEntry {
  const status = scheduledStatus(row.status);
  const name = row.task_name ?? row.task_id;

  const link: ActivityLink | null =
    row.artifact_key === null || row.artifact_version === null
      ? null
      : { kind: 'artifact', key: row.artifact_key, version: row.artifact_version };

  return {
    id: `scheduled:${row.id}`,
    kind: 'scheduled-task',
    timestamp: row.started_at,
    status,
    title: scheduledTitle(name, status),
    // `summary` is already written for a human — the scheduler puts the reason a
    // skip happened there too — so it leads, and the error message backs it up.
    detail: row.summary ?? row.error_message,
    link,
  };
}

/**
 * A page of the merged feed, newest first.
 *
 * Each source is queried for its own `limit` rows and the two lists are merged
 * in memory. Taking `limit` from each is enough to be correct: the true newest
 * `limit` entries of the union cannot include a row that was not among the
 * newest `limit` of its own table.
 */
export function activityFeed(query: ActivityQuery = {}): ActivityPage {
  const limit = query.limit ?? 50;
  // An absent cursor means "from now backwards". Using a sentinel keeps one SQL
  // statement rather than two that could drift apart.
  const before = query.before ?? Number.MAX_SAFE_INTEGER;
  const db = getDb();

  const taskRows = db
    .prepare<TaskRunFeedRow>(
      `SELECT run_id, task_id, tool, chat_id, state, pause_reason, error_message, started_at
         FROM task_runs
        WHERE started_at < ?
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(before, limit);

  // LEFT JOIN rather than INNER, and the id stands in for a missing name. The
  // `ON DELETE CASCADE` on `task_id` does take a run with its task, so a missing
  // parent should be unreachable — but an INNER JOIN would answer that by
  // dropping the row, which reads as history quietly rewriting itself. Keeping
  // the entry with a degraded title fails visibly instead.

  const scheduledRows = db
    .prepare<ScheduledRunFeedRow>(
      `SELECT r.id, r.task_id, t.name AS task_name, r.started_at, r.status,
              r.artifact_key, r.artifact_version, r.summary, r.error_message
         FROM scheduled_task_runs r
         LEFT JOIN scheduled_tasks t ON t.id = r.task_id
        WHERE r.started_at < ?
        ORDER BY r.started_at DESC
        LIMIT ?`,
    )
    .all(before, limit);

  const merged = [...taskRows.map(mapTaskRun), ...scheduledRows.map(mapScheduledRun)]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);

  // A full page implies there may be more; a short one is the end. The cursor is
  // the last entry's timestamp and the next page is strictly older than it.
  const last = merged.length === limit ? merged[merged.length - 1] : undefined;

  return { entries: merged, nextBefore: last?.timestamp ?? null };
}
