/**
 * "What has this thing been doing?" — in sentences, not log lines.
 *
 * This is not the debug console. `GET /api/errors` already serves raw records
 * for when something is broken; the feed is for the ordinary case where the user
 * has been away and wants to catch up. So each entry carries a plain-language
 * title, a status from one shared vocabulary, and a link to whatever it produced.
 * Nothing here surfaces a stack trace or an internal code.
 *
 * Three sources, unified: `task_runs` (an interactive Code, Cowork or Design run),
 * `scheduled_task_runs` (a run that fired on a timer while nobody watched), and
 * `subagent_runs` (a Code task handing one bounded piece of work to a child). Their
 * stored status vocabularies differ because they answer different questions, so all
 * three are mapped onto one set the UI can branch on once.
 *
 * The prompt named subagent delegation as a third source, and this paragraph used
 * to say nothing recorded one — "there is no table and no writer". That stopped
 * being true when the durable subagent record landed: `subagent_runs` is written by
 * the Code agent's delegation path (`startSubagentRun` before the child runs and
 * `finishSubagentRun` however it ends, including the aborted case), and **nothing
 * read it outside its own module** — a child run's lifecycle was write-only, which
 * is the same shape of gap `task_steps` had before the recovery read. It is the
 * feed's third source now, merged like the other two. That needed one thing the old
 * paragraph did not anticipate: an entry kind of its own, because a delegated child
 * is neither a task run nor a scheduled one and labelling it as either would be a
 * small lie in the one field a client branches on.
 *
 * Ordering is by `started_at`, never by "last updated". `started_at` is the only
 * column in these tables that cannot change after the row is written, and a
 * cursor is only sound over a key that holds still: ordering by an updated time
 * would let a long-running task jump forward past the cursor a client is holding
 * and take rows with it, which reads as entries silently vanishing from the feed.
 */

import { getDb } from '../../db/adapter.ts';
import { usageByRun, type TaskUsage } from '../../db/usage.ts';
import { parkSummary, stopSummary } from '../agent/parkMessages.ts';

export type ActivityKind = 'task' | 'scheduled-task' | 'subagent';

/**
 * One vocabulary over all three sources. `paused` only ever comes from an
 * interactive run and `skipped` only from a scheduled one, but the UI branches on
 * a single set rather than needing to know which source an entry came from first.
 *
 * `stopped` and `interrupted` were added when this vocabulary met the states that
 * came after it. Migration `012` made a user-stopped run `stopped` rather than
 * `error`, and `020` made a run the dead process left behind `interrupted`; this
 * mapping knew `complete`, `error`, `paused` and nothing else, so both fell through
 * to `running` and the feed announced **"Code task is still running"** for a run
 * that ended — at the newest end of the feed, and forever. Mapping them onto
 * `failed` would have been the mistake `012` argued against in the other direction
 * (printing a failure the work did not suffer), and `success` would invent an
 * outcome. Two more words are the honest answer, and the states are genuinely
 * different from each other: one is the user or a limit ending the run, the other
 * is the process disappearing under it.
 */
export type ActivityStatus =
  | 'running'
  | 'paused'
  | 'success'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'skipped';

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
  /**
   * What this run cost, when anything was recorded (v4 §6.2).
   *
   * `null` means nothing is known — a run from before per-task accounting, or one
   * that never reached a provider — and must not be rendered as `$0.00`. Within a
   * present value, `costUsd` is null when no logged request had a price, and
   * `priced` says whether the figure is the whole bill. The rule the usage module
   * has always kept applies here unchanged: unpriced is not free.
   *
   * Scoped to the **run**, not the task, because an entry describes one execution.
   * A task's total — which additionally includes what its delegated children spent
   * — is what `/api/{tool}/tasks/:taskId/state` reports.
   */
  spend: ActivitySpend | null;
}

/** The cost fields an entry carries. See `ActivityEntry.spend`. */
export interface ActivitySpend {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  priced: boolean;
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

interface SubagentFeedRow {
  id: string;
  parent_task_id: string;
  child_task_id: string;
  sequence: number;
  state: string;
  prompt: string;
  summary: string | null;
  error_message: string | null;
  started_at: number;
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
  if (state === 'stopped') return 'stopped';
  if (state === 'interrupted') return 'interrupted';
  // `paused` was written by nothing that runs a task; the reachable "not running,
  // not over" states are the parks (`blocked`, `ready_for_review`), which are
  // continuable and carry the reason they parked. Both read as `paused` here,
  // because that is the fact the feed is reporting: it has not finished and it can
  // be carried on.
  if (state === 'paused' || state === 'blocked' || state === 'ready_for_review') return 'paused';
  return 'running';
}

function taskTitle(tool: string, status: ActivityStatus): string {
  const label = toolLabel(tool);
  if (status === 'success') return `${label} task finished`;
  if (status === 'failed') return `${label} task failed`;
  if (status === 'paused') return `${label} task paused`;
  if (status === 'stopped') return `${label} task was stopped`;
  if (status === 'interrupted') return `${label} task was interrupted`;
  return `${label} task is still running`;
}

function mapTaskRun(row: TaskRunFeedRow, spend: ActivitySpend | null): ActivityEntry {
  const status = taskStatus(row.state);

  return {
    id: `task:${row.run_id}`,
    kind: 'task',
    timestamp: row.started_at,
    status,
    title: taskTitle(row.tool, status),
    // The reason and the failure message are the two things worth saying in prose.
    // Everything else about the run is a debug-console concern.
    //
    // A park's reason is a *token* (`plan_ready`, `context_exhausted`), and this
    // line used to print it raw — the same defect the attention queue had, in a
    // second reader of the same column: `parkMessages.ts` owns the words, so the
    // token is translated here (`stopSummary` covers the stop tokens, of which
    // `ceiling_reached` is the one worth saying out loud). An interrupted run
    // carries the sentence reconciliation wrote, which is exactly what a reader
    // wants ("The server restarted while this task was running.").
    detail:
      status === 'paused'
        ? (parkSummary(row.pause_reason) ?? row.error_message)
        : status === 'failed' || status === 'interrupted' || status === 'stopped'
          ? (row.error_message ?? stopSummary(row.pause_reason))
          : null,
    link: row.chat_id === null ? null : { kind: 'chat', chatId: row.chat_id },
    spend,
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

function mapScheduledRun(row: ScheduledRunFeedRow, spend: ActivitySpend | null): ActivityEntry {
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
    // Keyed by the same id the execution ran under: the scheduler uses
    // `startRun`'s id for both the `scheduled_task_runs` row and the allocated
    // `task_runs` row, so a scheduled entry's spend is found like any other run's.
    spend,
  };
}

/** How a child run's state reads in the feed's vocabulary. */
function subagentStatus(state: string): ActivityStatus {
  if (state === 'complete') return 'success';
  if (state === 'error') return 'failed';
  // A child that was `stopped` was aborted — with its parent, by a cancel, or by
  // the user pressing Stop — which is the same fact `stopped` reports for a task
  // run, so it is the same word rather than a second one for the same thing.
  if (state === 'stopped') return 'stopped';
  return 'running';
}

/**
 * The child's own first line, clipped, as the thing to recognise it by.
 *
 * A delegated child has no name and no chat: the prompt the parent wrote *is* its
 * identity ("review the parser changes"), and the alternative identifiers are a
 * uuid and a sequence number. The first line is taken rather than the whole prompt
 * because a prompt is a paragraph and a feed title is a line; the full text stays
 * in `subagent_runs` for whoever needs it.
 */
function childLabel(prompt: string): string {
  const line = prompt.split('\n').find((part) => part.trim() !== '') ?? prompt;
  const trimmed = line.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
}

function subagentTitle(prompt: string, status: ActivityStatus): string {
  const label = childLabel(prompt);
  if (status === 'success') return `Delegated task \u201c${label}\u201d finished`;
  if (status === 'failed') return `Delegated task \u201c${label}\u201d failed`;
  if (status === 'stopped') return `Delegated task \u201c${label}\u201d was stopped`;
  return `Delegated task \u201c${label}\u201d is still running`;
}

function mapSubagentRun(row: SubagentFeedRow): ActivityEntry {
  const status = subagentStatus(row.state);

  return {
    id: `subagent:${row.id}`,
    kind: 'subagent',
    timestamp: row.started_at,
    status,
    title: subagentTitle(row.prompt, status),
    // The child's own summary, written by the loop that ran it, or the failure it
    // reported. Both are already sentences for a person.
    detail: row.summary ?? row.error_message,
    // No link: a child has no chat of its own, and linking it to the parent's would
    // make one entry look like a place to go and read the other one's transcript —
    // the parent has its own entry on this same page.
    link: null,
    // No spend, and this is a fact about the record rather than a missing read: a
    // delegated child shares the parent's context, so its provider requests are
    // logged against the parent's task *and* the parent's run, which means the
    // parent's entry on this page already includes them. Reading a figure for the
    // child would mean inventing one, and showing the parent's figure twice would
    // make a page of two entries look twice as expensive as the page of one.
    spend: null,
  };
}

/** The usage summary as the feed reports it, or null when nothing was logged. */
function toSpend(usage: TaskUsage | undefined): ActivitySpend | null {
  if (usage === undefined) return null;
  return {
    requests: usage.requests,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    costUsd: usage.costUsd,
    priced: usage.priced,
  };
}

/**
 * A page of the merged feed, newest first.
 *
 * Each source is queried for its own `limit` rows and the lists are merged in
 * memory. Taking `limit` from each is enough to be correct: the true newest
 * `limit` entries of the union cannot include a row that was not among the newest
 * `limit` of its own table. Three sources rather than two, and the third is the
 * one that had no reader at all before this.
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

  // The third source. `subagent_runs` is written by the Code agent's delegation
  // path and was read by nothing; `started_at` is its cursor column, and a child's
  // prompt is bounded at write time (16 000 characters), so a page of them cannot
  // be the thing that makes this read expensive.
  const subagentRows = db
    .prepare<SubagentFeedRow>(
      `SELECT id, parent_task_id, child_task_id, sequence, state, prompt, summary,
              error_message, started_at
         FROM subagent_runs
        WHERE started_at < ?
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(before, limit);

  // One query for every run on the page rather than one per entry. Both spend
  // sources are keyed by the same id — a scheduled run's execution row carries the
  // id `startRun` returned for its `scheduled_task_runs` row — so a single map
  // answers for both, over the union of the two id sets. A subagent id is
  // deliberately absent from this list: a child's requests are logged against its
  // parent's run, so its own id keys no usage rows and asking would return nothing
  // while the parent's entry already carries the figure.
  const spendByRun = usageByRun([
    ...taskRows.map((row) => row.run_id),
    ...scheduledRows.map((row) => row.id),
  ]);

  // `visibleTaskRuns` runs first so the spend map is queried over exactly the
  // rows that will be rendered — a deduped scheduled run is one entry, not two,
  // and it reads its spend through the scheduled id (the same key either way).
  const merged = [
    ...visibleTaskRuns(taskRows).map((row) => mapTaskRun(row, toSpend(spendByRun.get(row.run_id)))),
    ...scheduledRows.map((row) => mapScheduledRun(row, toSpend(spendByRun.get(row.id)))),
    ...subagentRows.map(mapSubagentRun),
  ]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);

  // A full page implies there may be more; a short one is the end. The cursor is
  // the last entry's timestamp and the next page is strictly older than it.
  const last = merged.length === limit ? merged[merged.length - 1] : undefined;

  return { entries: merged, nextBefore: last?.timestamp ?? null };
}

/**
 * One entry per scheduled execution, not two.
 *
 * Since 1.27 a scheduled run writes to **both** tables: `scheduled_task_runs` for
 * the scheduling outcome and `task_runs` for the execution state (see
 * `cowork/scheduler.ts`). They are different facts and both are worth keeping, but
 * they describe one thing that did not happen twice, and a feed showing it twice
 * reads as the scheduler having fired twice.
 *
 * The scheduled entry wins because it carries what the user recognises: the task's
 * *name*, its artifact link, and the human summary the scheduler writes for a skip.
 *
 * Filtering against `scheduled_tasks` rather than against the rows in this page
 * keeps the answer page-independent: a `task_runs` row whose partner happened to
 * fall outside the current window would otherwise reappear as a second entry on
 * one page and not on the next. An interactive run cannot be caught by this,
 * because its `task_id` is a chat or Code task id and never a scheduled-task id.
 */
function visibleTaskRuns(rows: TaskRunFeedRow[]): TaskRunFeedRow[] {
  if (rows.length === 0) return rows;
  const scheduled = new Set(
    getDb()
      .prepare<{ id: string }>('SELECT id FROM scheduled_tasks')
      .all()
      .map((row) => row.id),
  );
  return scheduled.size === 0 ? rows : rows.filter((row) => !scheduled.has(row.task_id));
}
