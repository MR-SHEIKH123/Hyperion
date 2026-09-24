/**
 * Approval tickets: the binding between an approved call and the call that runs (S1).
 *
 * The problem this closes is a *time* gap, not a lock. A call that evaluates to
 * `ask` stops the run mid-conversation; the answer may arrive minutes later, from
 * another connection, after a restart, and it is carried out by a **second run id**
 * that replays a stored conversation. Everything between the decision and the
 * execution is indirect — a replayed transcript, a re-generated tool call, a
 * re-evaluated permission stack — and until this module existed nothing checked
 * that the call about to run was the call that was approved.
 *
 * So a ticket is minted where the call is recorded (everything it binds is only
 * known there), armed where the decision lands, and **settled at the gate**: the
 * live execution context is recomputed into the same digest and compared, and the
 * ticket is consumed on the one match it authorises.
 *
 * Four decisions worth stating, because each could have gone the other way:
 *
 *   - **The binding is exact and verbatim.** `arguments` is the string the model
 *     emitted, not a re-serialisation of it; `workspace` is the canonical
 *     cwd/worktree identity of the run; `revision` is the effective permission
 *     stack's own hash. A call that differs in any of them is a different call, and
 *     the refusal names which field moved rather than saying "invalid".
 *   - **A lookup is by the question asked, not by the tool.** Tickets are found by
 *     `(task, tool_name, arguments)` — the same key `recordApproval` dedupes on —
 *     so a *different* command under the same tool finds nothing and parks for a
 *     fresh approval, rather than being refused by an unrelated ticket or, worse,
 *     authorised by one.
 *   - **The digest is stored beside its inputs.** The inputs make a refusal
 *     legible; the digest makes it one comparison that cannot silently stop
 *     covering a field a later change adds.
 *   - **Run identity means lineage, not equality.** A continuation runs under a new
 *     run id by design (`http/continuation.ts` writes a second row so the park's
 *     step history survives), so the check accepts the minting run *or* a run that
 *     records it as `continued_from`. An unrelated run is refused, which is what
 *     the field is for.
 */
import { createHash, randomUUID } from 'node:crypto';

import { getDb } from './adapter.ts';

/** The fields a ticket binds, in the order the digest reads them. */
export const TICKET_FIELDS = [
  'toolName',
  'permissionKey',
  'arguments',
  'workspace',
  'taskId',
  'runId',
  'parentTaskId',
  'revision',
] as const;

export type TicketField = (typeof TICKET_FIELDS)[number];

/** Everything a ticket binds. Recomputed from the live context at settle time. */
export interface TicketBinding {
  toolName: string;
  permissionKey: string;
  /** Verbatim, exactly what the model emitted. */
  arguments: string;
  /** The canonical cwd/worktree identity. */
  workspace: string;
  taskId: string;
  runId: string | null;
  parentTaskId: string | null;
  /** The effective permission-config revision. */
  revision: string;
}

/**
 * How a ticket is doing.
 *
 * `pending` is a question with no answer yet and authorises nothing; `armed` is a
 * single-use authorisation from an `allow_once`; `standing` records an
 * `allow_session` approval, where the *rule* is the authority and the ticket is
 * spent on the first matching execution as a record that the approved call ran;
 * `spent` is used; `void` is an answer of `deny`, an expired question, or a
 * ticket superseded by a fresh one. Only `armed` and `standing` can authorise.
 */
export type TicketState = 'pending' | 'armed' | 'standing' | 'spent' | 'void';

export interface ApprovalTicket {
  id: string;
  approvalId: string;
  tool: string;
  taskId: string;
  runId: string | null;
  parentTaskId: string | null;
  toolName: string;
  permissionKey: string;
  arguments: string;
  workspace: string;
  revision: string;
  digest: string;
  state: TicketState;
  expiresAt: number;
  createdAt: number;
  armedAt: number | null;
  consumedAt: number | null;
  consumedRunId: string | null;
}

interface TicketRow {
  id: string;
  approval_id: string;
  tool: string;
  task_id: string;
  run_id: string | null;
  parent_task_id: string | null;
  tool_name: string;
  permission_key: string;
  arguments: string;
  workspace: string;
  revision: string;
  digest: string;
  state: string;
  expires_at: number;
  created_at: number;
  armed_at: number | null;
  consumed_at: number | null;
  consumed_run_id: string | null;
}

function mapRow(row: TicketRow): ApprovalTicket {
  return {
    id: row.id,
    approvalId: row.approval_id,
    tool: row.tool,
    taskId: row.task_id,
    runId: row.run_id,
    parentTaskId: row.parent_task_id,
    toolName: row.tool_name,
    permissionKey: row.permission_key,
    arguments: row.arguments,
    workspace: row.workspace,
    revision: row.revision,
    digest: row.digest,
    state: row.state as TicketState,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    armedAt: row.armed_at,
    consumedAt: row.consumed_at,
    consumedRunId: row.consumed_run_id,
  };
}

/**
 * The ticket's digest.
 *
 * A length-prefixed join rather than JSON: two fields whose contents are
 * themselves JSON must not be able to shift a boundary and produce the same string
 * from different bindings, and the version prefix means a change to the field list
 * cannot silently reinterpret an old digest as a match.
 */
export function ticketDigest(binding: TicketBinding): string {
  const parts = [TICKET_FIELDS.join(','), ...TICKET_FIELDS.map((field) => {
    const value = binding[field];
    const text = value === null ? '' : String(value);
    return `${text.length}:${text}`;
  })];
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

/** Which bound fields differ between what was approved and what is about to run. */
export function ticketMismatches(expected: TicketBinding, live: TicketBinding): TicketField[] {
  return TICKET_FIELDS.filter((field) => (expected[field] ?? '') !== (live[field] ?? ''));
}

/**
 * Mint the ticket for a call that has stopped for a decision.
 *
 * Called from the same place the pending approval is recorded. A repeat call for
 * a row that already has a live ticket reuses it: `recordApproval` returns the
 * existing question, and a second ticket for one question would make "what did
 * the user approve?" two answers.
 */
export function mintTicket(input: {
  approvalId: string;
  tool: string;
  binding: TicketBinding;
  expiresAt: number;
  now?: number;
}): ApprovalTicket {
  const existing = liveTicketFor(input.binding.taskId, input.binding.toolName, input.binding.arguments);
  if (existing !== null && existing.approvalId === input.approvalId) return existing;

  const now = input.now ?? Date.now();
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO approval_tickets
         (id, approval_id, tool, task_id, run_id, parent_task_id, tool_name, permission_key,
          arguments, workspace, revision, digest, state, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      id,
      input.approvalId,
      input.tool,
      input.binding.taskId,
      input.binding.runId,
      input.binding.parentTaskId,
      input.binding.toolName,
      input.binding.permissionKey,
      input.binding.arguments,
      input.binding.workspace,
      input.binding.revision,
      ticketDigest(input.binding),
      input.expiresAt,
      now,
    );
  return requireTicket(id);
}

/**
 * Arm or void the ticket behind a decision.
 *
 * Called inside `resolveApproval`'s guarded UPDATE path, so a ticket is never
 * armed by a decision that lost the race. `standing` for `allow_session` is not a
 * weaker kind of authorisation — it records that the user approved a *rule*, and
 * the rule is what authorises later calls; the ticket is spent when the approved
 * call itself first runs, which is the fact worth keeping.
 */
export function settleTicketForDecision(
  approvalId: string,
  decision: 'allow_once' | 'allow_session' | 'deny',
  now: number = Date.now(),
): ApprovalTicket | null {
  const state: TicketState = decision === 'deny' ? 'void' : decision === 'allow_once' ? 'armed' : 'standing';
  getDb()
    .prepare(
      `UPDATE approval_tickets SET state = ?, armed_at = ? WHERE approval_id = ? AND state = 'pending'`,
    )
    .run(state, now, approvalId);
  return ticketForApproval(approvalId);
}

/**
 * Void every ticket a task still has open, whatever its state.
 *
 * Called when the task reaches a terminal transition: an `allow_once` armed for a
 * run that has ended authorises nothing, and leaving it live means a later run
 * that reused the task id could spend it. A question with no answer, an armed
 * authorisation, and a standing session record all end with the task (S1).
 */
export function voidTicketsForTask(taskId: string, now: number = Date.now()): number {
  return getDb()
    .prepare(
      `UPDATE approval_tickets SET state = 'void', consumed_at = ?
        WHERE task_id = ? AND state IN ('pending', 'armed', 'standing')`,
    )
    .run(now, taskId).changes;
}

/** Void the tickets belonging to approvals that were just closed out. */
export function voidTicketsForApprovals(approvalIds: readonly string[], now: number = Date.now()): number {
  if (approvalIds.length === 0) return 0;
  const statement = getDb().prepare(
    `UPDATE approval_tickets SET state = 'void', consumed_at = ? WHERE approval_id = ? AND state IN ('pending', 'armed', 'standing')`,
  );
  let changed = 0;
  for (const id of approvalIds) changed += statement.run(now, id).changes;
  return changed;
}

/** One task's newest ticket for one exact call, whatever state it is in. */
export function ticketForCall(taskId: string, toolName: string, args: string): ApprovalTicket | null {
  const row = getDb()
    .prepare<TicketRow>(
      `SELECT * FROM approval_tickets
        WHERE task_id = ? AND tool_name = ? AND arguments = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(taskId, toolName, args);
  return row ? mapRow(row) : null;
}

/**
 * The newest ticket that could still authorise one *class* of question on a task.
 *
 * `settleTicket` finds a ticket by the exact question — for a tool call, the
 * verbatim arguments the model emitted. Some questions are not knowable before
 * doing work: an outbound send's question is the credential-shaped text the scan
 * finds, so settling it means scanning the payload first, and scanning every
 * request only to discover there was nothing to settle is the wrong way round.
 *
 * This is the cheap half of that lookup — one indexed read answering "is there an
 * authorisation for this kind of question at all?" — and the caller does the work
 * and settles properly only when it says yes. State and deadline are filtered here
 * rather than left to the caller because a `spent`, `void` or expired ticket
 * authorises nothing, and "nothing to settle" is exactly the answer that lets the
 * caller skip the work.
 *
 * It never authorises anything by itself: the settlement below is still the check.
 */
export function liveTicketForQuestion(
  taskId: string,
  toolName: string,
  now: number = Date.now(),
): ApprovalTicket | null {
  const row = getDb()
    .prepare<TicketRow>(
      `SELECT * FROM approval_tickets
        WHERE task_id = ? AND tool_name = ? AND state IN ('armed', 'standing') AND expires_at > ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(taskId, toolName, now);
  return row ? mapRow(row) : null;
}

export function ticketForApproval(approvalId: string): ApprovalTicket | null {
  const row = getDb()
    .prepare<TicketRow>('SELECT * FROM approval_tickets WHERE approval_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(approvalId);
  return row ? mapRow(row) : null;
}

export function getTicket(id: string): ApprovalTicket | null {
  const row = getDb().prepare<TicketRow>('SELECT * FROM approval_tickets WHERE id = ?').get(id);
  return row ? mapRow(row) : null;
}

/** Every ticket for a task, newest first. For tests and for a task's own audit view. */
export function listTickets(taskId: string): ApprovalTicket[] {
  return getDb()
    .prepare<TicketRow>('SELECT * FROM approval_tickets WHERE task_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(taskId)
    .map(mapRow);
}

/**
 * Consume one armed ticket.
 *
 * The `state IN ('armed','standing')` guard is the mutex, in the same shape
 * `resolveApproval` uses: two runs cannot both spend one approval, and the loser
 * learns it lost by the zero row count rather than by a second execution.
 */
export function consumeTicket(id: string, consumedRunId: string | null, now: number = Date.now()): boolean {
  const updated = getDb()
    .prepare(
      `UPDATE approval_tickets SET state = 'spent', consumed_at = ?, consumed_run_id = ?
        WHERE id = ? AND state IN ('armed', 'standing')`,
    )
    .run(now, consumedRunId, id);
  return updated.changes > 0;
}

/** Why a ticket did not authorise an execution. Each has its own sentence. */
export type TicketRefusal =
  /** The question is still unanswered, so nothing was approved yet. */
  | 'not_approved'
  /** A decision was recorded, and it was not an allowance. */
  | 'denied'
  /** This ticket's one execution has already happened. */
  | 'already_consumed'
  /** The prompt outlived its deadline before the call ran. */
  | 'expired'
  /** The call no longer matches what was approved; `fields` says what moved. */
  | 'mismatch'
  /** An unrelated run tried to spend a ticket minted for another one. */
  | 'run_replaced';

export interface TicketSettlement {
  kind: 'granted' | 'refused' | 'absent';
  ticket?: ApprovalTicket;
  refusal?: TicketRefusal;
  /** Set for `mismatch`: the bound fields whose live value differs. */
  fields?: TicketField[];
}

/**
 * Decide whether an approved call may run, and spend the ticket if it may.
 *
 * `live` is the execution context *right now* — the call as it is about to be
 * dispatched, the workspace it resolved to, the run driving it, the permission
 * stack as re-read on this continuation. `runAccepts` answers whether the live run
 * is the minting run or a continuation of it; it is a parameter rather than
 * something this module reaches for, because the lineage lives in `task_runs` and
 * the caller already has the row.
 *
 * No ticket for this exact call is `absent`, which is not a refusal: it is the
 * ordinary first-time case, and the caller parks for a decision exactly as it did
 * before tickets existed.
 *
 * `consume: false` settles without spending, for the one question whose approved
 * answer is not a single execution. A tool call runs once, so its ticket is spent
 * on that run; an outbound send is re-made on **every turn of the run**, with the
 * same conversation and therefore the same finding, so spending it on the first
 * send would ask the identical question again on the second — the noise failure
 * `approvals.ts` names, and a park loop with an extra click per iteration. Such a
 * ticket stays live and is ended the way the question it answers is: voided at the
 * task's terminal transition (`voidTicketsForTask`) or expired with its prompt.
 */
export function settleTicket(input: {
  live: TicketBinding;
  runAccepts: (ticketRunId: string | null) => boolean;
  now?: number;
  consume?: boolean;
}): TicketSettlement {
  const ticket = ticketForCall(input.live.taskId, input.live.toolName, input.live.arguments);
  if (ticket === null) return { kind: 'absent' };

  const now = input.now ?? Date.now();
  if (ticket.state === 'void') {
    return { kind: 'refused', ticket, refusal: 'denied' };
  }
  if (ticket.state === 'pending') {
    return { kind: 'refused', ticket, refusal: 'not_approved' };
  }
  if (ticket.expiresAt <= now) {
    voidTicket(ticket.id, now);
    return { kind: 'refused', ticket, refusal: 'expired' };
  }
  if (ticket.state === 'spent') {
    return { kind: 'refused', ticket, refusal: 'already_consumed' };
  }

  const expected: TicketBinding = {
    toolName: ticket.toolName,
    permissionKey: ticket.permissionKey,
    arguments: ticket.arguments,
    workspace: ticket.workspace,
    taskId: ticket.taskId,
    runId: ticket.runId,
    parentTaskId: ticket.parentTaskId,
    revision: ticket.revision,
  };
  // The digest first: it is one comparison over every field, and it is what makes a
  // later field addition a change to `TICKET_FIELDS` rather than a silent hole.
  if (ticketDigest(expected) !== ticket.digest) {
    return { kind: 'refused', ticket, refusal: 'mismatch', fields: ticketMismatches(expected, input.live) };
  }
  // `runId` is deliberately not compared here. A continuation drives the replay
  // under a *new* run id by design, so equality on it would refuse every
  // legitimate replay; run identity is a lineage question, asked on its own below.
  const fields = ticketMismatches(expected, input.live).filter((field) => field !== 'runId');
  if (fields.length > 0) {
    return { kind: 'refused', ticket, refusal: 'mismatch', fields };
  }
  if (!input.runAccepts(ticket.runId)) {
    return { kind: 'refused', ticket, refusal: 'run_replaced', fields: ['runId'] };
  }
  if (input.consume === false) return { kind: 'granted', ticket };
  if (!consumeTicket(ticket.id, input.live.runId, now)) {
    // Lost the race for a ticket that was live a moment ago.
    return { kind: 'refused', ticket: getTicket(ticket.id) ?? ticket, refusal: 'already_consumed' };
  }
  return { kind: 'granted', ticket: getTicket(ticket.id) ?? ticket };
}

function voidTicket(id: string, now: number): void {
  getDb()
    .prepare(
      `UPDATE approval_tickets SET state = 'void', consumed_at = ? WHERE id = ? AND state IN ('pending', 'armed', 'standing')`,
    )
    .run(now, id);
}

/** The one live ticket for a call, if there is one. Used by `mintTicket`'s dedupe. */
function liveTicketFor(taskId: string, toolName: string, args: string): ApprovalTicket | null {
  const row = getDb()
    .prepare<TicketRow>(
      `SELECT * FROM approval_tickets
        WHERE task_id = ? AND tool_name = ? AND arguments = ? AND state IN ('pending', 'armed', 'standing')
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(taskId, toolName, args);
  return row ? mapRow(row) : null;
}

function requireTicket(id: string): ApprovalTicket {
  const ticket = getTicket(id);
  if (ticket === null) throw new Error(`approval ticket "${id}" vanished immediately after being written`);
  return ticket;
}
