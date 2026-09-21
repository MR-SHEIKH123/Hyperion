/**
 * The one queue that answers "what is waiting on me?".
 *
 * `healthSummary()` answers a different question — *is anything broken* — and the
 * difference is the whole reason this file exists. A pending approval is not a
 * fault: the permission engine is working exactly as designed, and the run is
 * parked on purpose. A dashboard that showed a parked approval as ill health would
 * teach the user to ignore the light that matters. So the two are separate
 * endpoints with separate vocabularies, and this one is an *inbox*.
 *
 * The feed (`GET /api/activity`) is the third thing, and the distinction is
 * chronological versus actionable: a feed entry says what happened, in order, and
 * a finished task stays in it forever because that is what a history is for. An
 * item here exists only while something is unfinished, and it leaves the moment it
 * is resolved — the same task appearing in both is correct and not a duplicate
 * (the feed has its completion, the queue had its wait).
 *
 * Three rules the shape encodes:
 *
 *   - **One item per thing, not one per symptom.** A `ready_for_review` run that
 *     produced a plan becomes a `plan_ready` item and not two, because the plan is
 *     *why* it wants review and the user has one decision to make.
 *   - **Only live states.** A failed run the user already saw fail is not waiting
 *     on anyone, so `error` is not a queue item — except when the error *is* the
 *     interruption (see below), where the run is a thing to restart rather than a
 *     thing that happened.
 *   - **`sources` is part of the contract.** Every source A1 enumerates is
 *     reported with `ok`, `empty` or `unavailable`, and an unavailable source
 *     carries the reason. A queue that silently omits a category looks identical
 *     to a queue where that category is fine, and the user cannot tell which.
 */

import { getDb } from '../../db/adapter.ts';
import { countPendingApprovals, listAllPendingApprovals } from '../../db/approvals.ts';
import { queryErrorLog } from '../../db/errorLog.ts';
import { mcpStatus } from '../../orchestrator/agents.ts';
import { listPausedRuns } from '../../orchestrator/runState.ts';
import { spendStatus } from '../limits/budget.ts';

import type { PendingApproval } from '../../db/approvals.ts';
import type { TaskRunState, TaskRunTool } from '../../db/taskRuns.ts';

export type AttentionKind =
  /** A tool call the permission engine parked, waiting on a decision. */
  | 'approval_required'
  /** A run that produced a plan and wants the user's eyes before it acts. */
  | 'plan_ready'
  /** A run cut off by a restart. Resumable in Chat; a task has to be restarted. */
  | 'interrupted'
  /** Waiting on something it cannot resolve alone, or a paused provider outage. */
  | 'paused'
  | 'blocked'
  /** Work that is done and specifically wants review, with no plan attached. */
  | 'ready_for_review'
  | 'scheduled_run_failed'
  | 'backup_failure'
  | 'spending_cap'
  | 'mcp_disconnected';

export type AttentionTool = 'chat' | 'code' | 'cowork' | 'design' | 'system';

/** Where an item points. The ids are the deep link; the shell owns its own routes. */
export interface AttentionItem {
  /** Stable across polls, so a UI can animate a new item without re-reading the list. */
  id: string;
  kind: AttentionKind;
  tool: AttentionTool;
  title: string;
  detail: string;
  /** When the wait started — the approval's creation, the run's update. */
  createdAt: number;
  taskId?: string;
  runId?: string;
  chatId?: string;
  /** The call that resolves it, when one exists. Never a frontend route. */
  resolve?: { method: 'POST'; path: string; body?: Record<string, unknown> };
}

export interface AttentionSource {
  source: string;
  status: 'ok' | 'empty' | 'unavailable';
  count: number;
  /** Present when `unavailable`: why, in the terms of the missing thing. */
  reason?: string;
}

export interface AttentionQueue {
  generatedAt: number;
  /** The number of items, which is what `items` has after its own limit. */
  total: number;
  counts: Partial<Record<AttentionKind, number>>;
  items: AttentionItem[];
  sources: AttentionSource[];
}

/**
 * The order the queue is read in, which is part of the contract rather than a
 * presentation choice: something that has parked a run outranks something that
 * wants a look, and both outrank a warning about the future.
 */
const KIND_RANK: Record<AttentionKind, number> = {
  approval_required: 0,
  blocked: 1,
  plan_ready: 2,
  interrupted: 3,
  paused: 4,
  ready_for_review: 5,
  scheduled_run_failed: 6,
  backup_failure: 7,
  spending_cap: 8,
  mcp_disconnected: 9,
};

/**
 * How far back a failed *request* counts as a live problem.
 *
 * Only for the two sources with no run record to consult. A scheduled run has a
 * row whose `last_status` a later success clears, so it needs no window; a backup
 * has no row at all, so its failure is visible only as an error-log entry and the
 * window is the only thing standing between "a backup just failed" and "a backup
 * failed in March". A day is the shortest window that still catches last night's
 * run.
 */
const RECENT_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The share of the daily cap at which the queue warns, before anything is refused. */
const SPEND_WARNING_RATIO = 0.8;

const CHAT_TOOL = 'chat' as const;

interface TaskRunRow {
  run_id: string;
  task_id: string;
  tool: string;
  chat_id: string | null;
  state: string;
  pause_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  updated_at: number;
}

interface PlanStepRow {
  run_id: string;
  detail: string | null;
}

/**
 * The first line of a plan step, which is what a queue row can show.
 *
 * `task_steps.detail` holds the plan as text (or the tool arguments for a
 * `tool_call`), so this takes the first non-empty line and bounds it. Truncation
 * is visible rather than silent: a title that ends mid-sentence with an ellipsis
 * reads as "there is more", which is true.
 */
function firstLine(text: string | null, limit = 120): string {
  const line = (text ?? '')
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (line === undefined) return 'A plan is ready for review.';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function approvalItem(approval: PendingApproval): AttentionItem {
  return {
    id: `approval:${approval.id}`,
    kind: 'approval_required',
    tool: approval.tool === CHAT_TOOL ? CHAT_TOOL : (approval.tool as AttentionTool),
    title: `${approval.toolName} needs a decision`,
    detail:
      approval.reason ??
      `Refused by ${approval.matchedLayer ?? 'a permission rule'} and parked, not failed. The call replays unchanged if you allow it.`,
    createdAt: approval.createdAt,
    taskId: approval.taskId,
    ...(approval.runId === null ? {} : { runId: approval.runId }),
    resolve: { method: 'POST', path: `/api/${approval.tool}/tasks/${approval.taskId}/approve` },
  };
}

function taskRunItem(run: TaskRunRow, plan: string | null): AttentionItem | null {
  const tool = run.tool as TaskRunTool;
  const base = {
    taskId: run.task_id,
    runId: run.run_id,
    ...(run.chat_id === null ? {} : { chatId: run.chat_id }),
  };
  const state = run.state as TaskRunState;

  if (state === 'error') {
    // Only the reconciled interruption is a queue item: it means "the server
    // restarted under this run", which leaves something to restart. Any other
    // `error` is a failure the user was already told about, and a queue is not a
    // history — that is what the feed and the error console are for.
    if (run.error_code !== 'internal_error') return null;
    return {
      id: `interrupted:${run.run_id}`,
      kind: 'interrupted',
      tool,
      title: `${tool} task was interrupted by a restart`,
      detail: run.error_message ?? 'The server restarted while this task was running.',
      createdAt: run.updated_at,
      ...base,
    };
  }

  if (state === 'blocked') {
    return {
      id: `blocked:${run.run_id}`,
      kind: 'blocked',
      tool,
      title: `${tool} task is blocked`,
      detail: run.pause_reason ?? run.error_message ?? 'The run is waiting on something it cannot resolve alone.',
      createdAt: run.updated_at,
      ...base,
    };
  }

  if (state === 'paused') {
    return {
      id: `paused:${run.run_id}`,
      kind: 'paused',
      tool,
      title: `${tool} task is paused`,
      detail: run.pause_reason ?? 'The run is paused and can be resumed.',
      createdAt: run.updated_at,
      ...base,
    };
  }

  if (state === 'ready_for_review') {
    // One item, not two: the plan is why it wants review.
    return plan === null
      ? {
          id: `review:${run.run_id}`,
          kind: 'ready_for_review',
          tool,
          title: `${tool} task is ready for review`,
          detail: run.pause_reason ?? 'The work is done and specifically wants your eyes.',
          createdAt: run.updated_at,
          ...base,
        }
      : {
          id: `plan:${run.run_id}`,
          kind: 'plan_ready',
          tool,
          title: `${tool} task has a plan ready`,
          detail: plan,
          createdAt: run.updated_at,
          ...base,
        };
  }

  return null;
}

function chatPausedItem(run: {
  runId: string;
  chatId: string;
  pauseReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: number;
}): AttentionItem {
  const interrupted = run.errorCode === 'internal_error';
  return {
    id: `${interrupted ? 'interrupted' : 'paused'}:${run.runId}`,
    kind: interrupted ? 'interrupted' : 'paused',
    tool: CHAT_TOOL,
    title: interrupted ? 'A response was interrupted by a restart' : 'A response is paused',
    detail:
      run.errorMessage ?? run.pauseReason ?? 'The run is paused and can be resumed.',
    createdAt: run.updatedAt,
    runId: run.runId,
    chatId: run.chatId,
    resolve: { method: 'POST', path: '/api/chat/resume', body: { runId: run.runId } },
  };
}

function spendItem(status: ReturnType<typeof spendStatus>): AttentionItem | null {
  if (status.capUsd === null) return null;
  const startedAt = new Date().setHours(0, 0, 0, 0);
  const unpriced =
    status.unpricedRequestsToday > 0
      ? ` ${status.unpricedRequestsToday} request(s) today have no price row, so the total is a floor.`
      : '';

  if (status.capReached) {
    return {
      id: 'spending:cap',
      kind: 'spending_cap',
      tool: 'system',
      title: "Today's spending cap is reached",
      detail:
        `Spent $${status.spentUsd.toFixed(2)} of $${status.capUsd.toFixed(2)}. ` +
        `Autonomous runs are refused until it resets at the next local midnight.${unpriced}`,
      createdAt: startedAt,
    };
  }

  if (status.spentUsd >= status.capUsd * SPEND_WARNING_RATIO) {
    return {
      id: 'spending:warning',
      kind: 'spending_cap',
      tool: 'system',
      title: `${Math.round((status.spentUsd / status.capUsd) * 100)}% of today's spending cap is used`,
      detail:
        `Spent $${status.spentUsd.toFixed(2)} of $${status.capUsd.toFixed(2)}, $${status.remainingUsd?.toFixed(2) ?? '0.00'} left. ` +
        `Autonomous runs are refused at the cap.${unpriced}`,
      createdAt: startedAt,
    };
  }

  return null;
}

/**
 * Everything waiting on the user, newest wait last within its kind.
 *
 * Reads live state only: the approvals table, the two run tables, the scheduled
 * task's own `last_status`, the spend window, the MCP supervisor and the error
 * log. No caching — a queue that lags behind the thing it queues is worse than a
 * queue with fewer categories.
 */
export function attentionQueue(now = Date.now()): AttentionQueue {
  const items: AttentionItem[] = [];
  const sources: AttentionSource[] = [];

  const pending = listAllPendingApprovals();
  for (const approval of pending) items.push(approvalItem(approval));
  const pendingTotal = countPendingApprovals();
  sources.push({
    source: 'pending_approvals',
    status: pendingTotal === 0 ? 'empty' : 'ok',
    count: pendingTotal,
  });

  const runs = getDb()
    .prepare<TaskRunRow>(
      `SELECT run_id, task_id, tool, chat_id, state, pause_reason, error_code, error_message, updated_at
         FROM task_runs
        WHERE state IN ('paused', 'blocked', 'ready_for_review', 'error')`,
    )
    .all();
  const plans = new Map(
    getDb()
      .prepare<PlanStepRow>(
        `SELECT run_id, detail FROM task_steps WHERE kind = 'plan' ORDER BY step ASC`,
      )
      .all()
      .map((row) => [row.run_id, firstLine(row.detail)]),
  );
  let runItems = 0;
  for (const run of runs) {
    const item = taskRunItem(run, plans.get(run.run_id) ?? null);
    if (item !== null) {
      items.push(item);
      runItems += 1;
    }
  }
  sources.push({ source: 'task_runs', status: runItems === 0 ? 'empty' : 'ok', count: runItems });

  // Chat has its own run table and its own state machine (`chat_runs`), and its
  // paused state is the one a user sees as "a reply stopped halfway". Reused from
  // `runState.ts` rather than re-queried, so the resume route and this queue can
  // never disagree about what a paused run is.
  const pausedChatRuns = listPausedRuns();
  for (const run of pausedChatRuns) items.push(chatPausedItem(run));
  sources.push({
    source: 'chat_runs',
    status: pausedChatRuns.length === 0 ? 'empty' : 'ok',
    count: pausedChatRuns.length,
  });

  // `last_status` is the scheduler's own verdict and a later success clears it, so
  // this needs no time window to stay honest.
  const failedSchedules = getDb()
    .prepare<{ id: string; name: string; last_run_at: number | null; error_message: string | null }>(
      `SELECT t.id, t.name, t.last_run_at, r.error_message
         FROM scheduled_tasks t
         LEFT JOIN scheduled_task_runs r ON r.id = (
           SELECT id FROM scheduled_task_runs WHERE task_id = t.id ORDER BY started_at DESC LIMIT 1
         )
        WHERE t.last_status = 'failed'`,
    )
    .all();
  for (const task of failedSchedules) {
    items.push({
      id: `schedule:${task.id}`,
      kind: 'scheduled_run_failed',
      tool: 'cowork',
      title: `Scheduled task "${task.name}" failed on its last run`,
      detail: task.error_message ?? 'The scheduler ran it and it failed. The next occurrence will still fire.',
      createdAt: task.last_run_at ?? now,
      taskId: task.id,
    });
  }
  sources.push({
    source: 'scheduled_task_runs',
    status: failedSchedules.length === 0 ? 'empty' : 'ok',
    count: failedSchedules.length,
  });

  // Backups have no run record — a backup is a request, not a scheduled job — so a
  // failure is visible only in the error log. Detection-by-error-log is stated
  // rather than hidden, and the window is why it cannot grow stale: the honest fix
  // is a backup run record (register: 1.29 has no state layer yet).
  const backupErrors = queryErrorLog({
    severity: 'error',
    since: now - RECENT_FAILURE_WINDOW_MS,
    limit: 200,
  }).filter((entry) => (entry.endpoint ?? '').startsWith('/api/backup'));
  const latestBackupError = backupErrors[0];
  if (latestBackupError !== undefined) {
    items.push({
      id: `backup:${latestBackupError.id}`,
      kind: 'backup_failure',
      tool: 'system',
      title: 'A backup request failed',
      detail: `${latestBackupError.error_message} (${latestBackupError.endpoint ?? 'unknown endpoint'})`,
      createdAt: latestBackupError.timestamp,
    });
  }
  sources.push({
    source: 'backup_failures',
    status: backupErrors.length === 0 ? 'empty' : 'ok',
    count: backupErrors.length,
    reason:
      'detected from the error log over the last 24h: a backup has no run record, so a success leaves nothing to compare a failure against',
  });

  const spend = spendStatus(now);
  const spendWarning = spendItem(spend);
  if (spendWarning !== null) items.push(spendWarning);
  sources.push({
    source: 'spending',
    status: spend.capUsd === null ? 'unavailable' : spendWarning === null ? 'empty' : 'ok',
    count: spendWarning === null ? 0 : 1,
    ...(spend.capUsd === null ? { reason: 'no daily spending cap is configured' } : {}),
  });

  // Only a server whose supervisor reports an error is a disconnect. `stopped` is a
  // user's choice — a disabled server must not appear as a problem to fix.
  const mcp = mcpStatus();
  const errored = mcp.managed ? mcp.servers.filter((server) => server.state === 'error') : [];
  for (const server of errored) {
    items.push({
      id: `mcp:${server.name}`,
      kind: 'mcp_disconnected',
      tool: 'system',
      title: `MCP server "${server.name}" is not running`,
      detail: server.lastError ?? 'The supervisor reports an error and the server is not connected.',
      createdAt: now,
    });
  }
  sources.push({
    source: 'mcp',
    status: !mcp.managed ? 'unavailable' : errored.length === 0 ? 'empty' : 'ok',
    count: errored.length,
    ...(mcp.managed ? {} : { reason: 'the MCP process manager is not managed by this process' }),
  });

  items.sort((a, b) => {
    const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    // Oldest first inside a kind: something that has waited longer has waited
    // longer, and a queue that reordered by recency would bury the oldest prompt.
    return rank !== 0 ? rank : a.createdAt - b.createdAt;
  });

  const counts: Partial<Record<AttentionKind, number>> = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;

  return { generatedAt: now, total: items.length, counts, items, sources };
}
