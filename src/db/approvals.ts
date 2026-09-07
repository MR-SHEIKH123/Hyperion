/**
 * Pending approvals: the durable half of an `ask` verdict.
 *
 * When the permission engine answers `ask`, the run stops mid-conversation with
 * one specific call waiting on a decision. That call has to survive the process:
 * the SSE stream that announced it drops when the phone locks, and the answer may
 * arrive minutes later from a different connection. So the call is written here
 * verbatim — name, arguments, and the verdict that produced it — and the run parks.
 *
 * Three details are load-bearing.
 *
 * **The arguments are stored exactly as the model emitted them.** Continuation
 * replays this call, and a re-serialized approximation is a different call. The
 * user approved a specific write to a specific path; anything else is a different
 * question they were never asked.
 *
 * **`allow_session` lives in this table, not in memory.** 1.27 §1 says a session
 * allowance is "cleared on task end", which means it has to outlive a park — and a
 * park can outlive the process. An in-memory set would silently forget every
 * allowance the moment the server restarted, re-asking the user for something they
 * had already granted, which is exactly how a confirmation prompt becomes noise
 * people click through.
 *
 * **There is no foreign key.** Same reasoning as `015_subagent_runs.sql`: an
 * unattended run may park with no `task_runs` row, and `startTaskRun` is
 * `INSERT OR REPLACE`, so a cascading relation would delete the approval during
 * exactly the retry it needs to survive. `run_id` is correlation metadata.
 */
import { randomUUID } from 'node:crypto';

import { getDb } from './adapter.ts';
import { AppError } from '../util/errors.ts';

import type { PermissionAction, PermissionLayer, PermissionRule } from '../types/core.ts';

/**
 * Where an approval got to.
 *
 * `allow_once` and `allow_session` are kept apart after the fact, not just at the
 * moment of deciding: the first is spent and the second is a standing rule, and a
 * single `allowed` value would make it impossible to tell which the user chose
 * when reading the history back.
 *
 * `expired` exists for the reaper — a park abandoned past its TTL has its
 * approvals closed out rather than left `pending` forever, so "what is this task
 * waiting on?" has an honest answer.
 */
export const APPROVAL_STATES = ['pending', 'allow_once', 'allow_session', 'denied', 'expired'] as const;

export type ApprovalState = (typeof APPROVAL_STATES)[number];

/** The three answers a user can give. `expired` is never a decision. */
export const APPROVAL_DECISIONS = ['allow_once', 'allow_session', 'deny'] as const;

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

const ID_MAX = 200;
const NAME_MAX = 200;
const ARGUMENTS_MAX = 32_000;
const REASON_MAX = 1_000;

export interface PendingApproval {
  id: string;
  runId: string | null;
  taskId: string;
  tool: string;
  /** The wire name the model asked for, e.g. `wigolo.search`. */
  toolName: string;
  /** Verbatim JSON, replayed unchanged on continuation. */
  arguments: string;
  /** The derived key the verdict was reached under, e.g. `wigolo_search`. */
  permissionKey: string;
  matchedPattern: string | null;
  matchedLayer: PermissionLayer | null;
  reason: string | null;
  state: ApprovalState;
  createdAt: number;
  resolvedAt: number | null;
}

interface ApprovalRow {
  id: string;
  run_id: string | null;
  task_id: string;
  tool: string;
  tool_name: string;
  arguments: string;
  permission_key: string;
  matched_pattern: string | null;
  matched_layer: string | null;
  reason: string | null;
  state: string;
  created_at: number;
  resolved_at: number | null;
}

function mapRow(row: ApprovalRow): PendingApproval {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    tool: row.tool,
    toolName: row.tool_name,
    arguments: row.arguments,
    permissionKey: row.permission_key,
    matchedPattern: row.matched_pattern,
    matchedLayer: row.matched_layer as PermissionLayer | null,
    reason: row.reason,
    state: row.state as ApprovalState,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export interface RecordApprovalInput {
  runId?: string | undefined;
  taskId: string;
  tool: string;
  toolName: string;
  arguments: string;
  permissionKey: string;
  matchedPattern?: string | null;
  matchedLayer?: PermissionLayer | null;
  reason?: string | undefined;
}

/**
 * Record a call that stopped for a decision.
 *
 * An identical pending approval is returned rather than duplicated. A model that
 * re-emits the same call after the park — or a continuation that replays a
 * conversation still ending in it — must not stack up a second row asking the same
 * question, or the user would have to answer twice to get past it once.
 */
export function recordApproval(input: RecordApprovalInput): PendingApproval {
  const taskId = requiredText(input.taskId, 'taskId', ID_MAX);
  const toolName = requiredText(input.toolName, 'toolName', NAME_MAX);
  const permissionKey = requiredText(input.permissionKey, 'permissionKey', NAME_MAX);
  const args = boundedArguments(input.arguments);

  const existing = getDb()
    .prepare<ApprovalRow>(
      `SELECT * FROM pending_approvals
        WHERE task_id = ? AND state = 'pending' AND tool_name = ? AND arguments = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(taskId, toolName, args);
  if (existing) return mapRow(existing);

  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO pending_approvals
         (id, run_id, task_id, tool, tool_name, arguments, permission_key,
          matched_pattern, matched_layer, reason, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      id,
      input.runId ?? null,
      taskId,
      requiredText(input.tool, 'tool', NAME_MAX),
      toolName,
      args,
      permissionKey,
      input.matchedPattern ?? null,
      input.matchedLayer ?? null,
      input.reason === undefined ? null : clip(input.reason, REASON_MAX),
      Date.now(),
    );
  return requireApproval(id);
}

export function getApproval(id: string): PendingApproval | null {
  const row = getDb().prepare<ApprovalRow>('SELECT * FROM pending_approvals WHERE id = ?').get(id);
  return row ? mapRow(row) : null;
}

/** Everything still waiting on this task, oldest first. */
export function listPendingApprovals(taskId: string): PendingApproval[] {
  return getDb()
    .prepare<ApprovalRow>(
      `SELECT * FROM pending_approvals WHERE task_id = ? AND state = 'pending' ORDER BY created_at`,
    )
    .all(taskId)
    .map(mapRow);
}

/**
 * Apply a decision, once.
 *
 * The `state = 'pending'` guard is the mutex. Two clients answering the same
 * prompt — a phone and a laptop showing the same task — must not both trigger a
 * continuation against one worktree, so the second one loses here rather than
 * halfway through a duplicate run.
 *
 * Deciding an already-decided approval returns what it actually became instead of
 * failing. Approving something a moment after somebody else did is a race the user
 * cannot avoid, and matches how `cancelTaskRoute` treats a finished run.
 */
export function resolveApproval(
  id: string,
  decision: ApprovalDecision,
): { approval: PendingApproval; applied: boolean } {
  const state: ApprovalState = decision === 'deny' ? 'denied' : decision;
  const updated = getDb()
    .prepare(
      `UPDATE pending_approvals SET state = ?, resolved_at = ? WHERE id = ? AND state = 'pending'`,
    )
    .run(state, Date.now(), requiredText(id, 'approvalId', ID_MAX));

  const approval = getApproval(id);
  if (approval === null) {
    throw new AppError('not_found', `No approval "${id}" was found.`, { details: { approvalId: id } });
  }
  return { approval, applied: updated.changes !== 0 };
}

/**
 * The session-layer rules a task's decisions add up to.
 *
 * `allow_once` is deliberately absent: it authorises exactly the replay that
 * follows it, which the continuation applies to that one call, and turning it into
 * a rule would make "just this time" mean "from now on".
 *
 * The rule is keyed on the permission key and scoped to the pattern that matched,
 * so approving a write to `src/a.ts` under a `src/**` rule grants that rule rather
 * than the whole tool. A verdict with no pattern was a scalar rule, so the
 * allowance is scalar too.
 */
export function sessionPermissionRules(taskId: string): Record<string, PermissionRule> {
  const rows = getDb()
    .prepare<ApprovalRow>(
      `SELECT * FROM pending_approvals
        WHERE task_id = ? AND state = 'allow_session' ORDER BY created_at`,
    )
    .all(taskId);

  const out: Record<string, PermissionRule> = {};
  const allow: PermissionAction = 'allow';
  for (const row of rows) {
    if (row.matched_pattern === null) {
      out[row.permission_key] = allow;
      continue;
    }
    const existing = out[row.permission_key];
    if (typeof existing === 'string') continue; // already allowed outright
    out[row.permission_key] = { ...(existing ?? {}), [row.matched_pattern]: allow };
  }
  return out;
}

/**
 * Close out a task's approvals.
 *
 * Called on the terminal transition, because 1.27 §1 requires session allowances
 * to be cleared when the task ends: an allowance that outlived its task would
 * silently pre-approve a *different* run that happened to reuse the id.
 *
 * Still-pending rows become `expired` rather than being deleted — the history of
 * what a run stopped to ask is worth keeping even once the answer no longer
 * matters.
 */
export function closeApprovals(taskId: string): number {
  const now = Date.now();
  const expired = getDb()
    .prepare(
      `UPDATE pending_approvals SET state = 'expired', resolved_at = ?
        WHERE task_id = ? AND state = 'pending'`,
    )
    .run(now, taskId);
  const cleared = getDb()
    .prepare(
      `UPDATE pending_approvals SET state = 'expired', resolved_at = ?
        WHERE task_id = ? AND state = 'allow_session'`,
    )
    .run(now, taskId);
  return expired.changes + cleared.changes;
}

function requireApproval(id: string): PendingApproval {
  const approval = getApproval(id);
  if (approval === null) throw new Error(`approval "${id}" vanished immediately after being written`);
  return approval;
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') {
    throw new AppError('bad_request', `${field} must be a string.`, { details: { field } });
  }
  const text = value.trim();
  if (text.length === 0 || text.length > maximum) {
    throw new AppError('bad_request', `${field} must contain between 1 and ${maximum} characters.`, {
      details: { field },
    });
  }
  return text;
}

/**
 * Arguments are bounded but never reshaped.
 *
 * A call whose arguments exceed the cap is refused outright rather than stored
 * truncated: truncated JSON is unreplayable, and a recorded approval that cannot
 * be replayed is worse than no approval at all — the user would authorise
 * something the continuation then silently could not perform.
 */
function boundedArguments(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AppError('bad_request', 'Tool arguments must be a JSON string.', {
      details: { field: 'arguments' },
    });
  }
  if (value.length > ARGUMENTS_MAX) {
    throw new AppError('bad_request', 'Tool arguments are too large to record for approval.', {
      details: { field: 'arguments', limit: ARGUMENTS_MAX },
    });
  }
  return value;
}

function clip(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
