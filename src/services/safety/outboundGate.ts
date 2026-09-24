/**
 * The credential gate on the **task-run** path: the other half of `outbound.ts`.
 *
 * `assertOutboundSafe` was written to be called from anywhere — it is pure, it
 * reads no database and no settings, and it says so in its own module comment —
 * and then it was called from exactly one place. `orchestrator/chat.ts` scans a
 * chat turn; a Code, Cowork or Design run reaches a remote provider through
 * `orchestrator/agentContext.ts` and was scanned by nobody. A credential-shaped
 * prompt in a task run went out unchecked with the redaction check switched on.
 *
 * Two things make wiring the call site harder than it looks, and both are decided
 * here rather than at the call site:
 *
 * **1. A task run has no way to acknowledge interactively.** The chat path refuses
 * with `redaction_flagged` and the client resends with `acknowledgeSensitive: true`;
 * the task routes read no such field, so "resend with a flag" is not an answer a
 * task can give. The finding is answered by **an approval**, through the ticket
 * mechanism S1 built for `ask` verdicts: the run parks, the question is recorded,
 * the user allows or denies it, and the continuation replays against an armed
 * ticket. The user's instructions say not to invent a parallel acknowledgement
 * path, and this is the existing one — the ticket binds the specific finding the
 * way it already binds a specific command, so it authorises that send and nothing
 * else.
 *
 * **2. The ticket is checked before the scan decides, not after.** A park that
 * re-scanned on resume would find the same credential in the same replayed
 * conversation and park again, forever. So the order is: scan (pure, no side
 * effects), and *only if something was found* ask whether an approved ticket
 * already covers this finding. `assertOutboundSafe` is still what refuses — this
 * module does not raise its own error — it is simply not called when the answer
 * is already in hand.
 *
 * The scan itself stays in `outbound.ts`, and this module keeps no copy of its
 * rules. What it owns is the *question*: what an outbound-send approval binds, in
 * a form that can be stored, shown to the user, and compared.
 */

import { getActiveProvider } from '../../providers/repository.ts';
import { acceptsTicketRun, getTaskRun } from '../../db/taskRuns.ts';
import { redactionCheckEnabled } from '../../db/settings.ts';
import { liveTicketForQuestion, settleTicket } from '../../db/approvalTickets.ts';
import { assertOutboundSafe, egressClassFor, scanForSensitive } from './outbound.ts';

import type { TicketBinding } from '../../db/approvalTickets.ts';
import type { ChatMessage } from '../../types/core.ts';
import type { SecretKind } from '../../util/redact.ts';
import type { EgressSubject, SensitiveHit, SensitiveReport } from './outbound.ts';

/**
 * The `tool_name` an outbound-send approval is recorded under.
 *
 * Not a tool. Nothing dispatches it and no provider offers it — it names the
 * *question* the user is asked, in the same column a real tool's name lives, so
 * the ticket store's own lookup (`task_id, tool_name, arguments`) works on it
 * unchanged. Inventing a second mechanism for "send anyway" questions is exactly
 * what this wiring is meant to avoid.
 */
export const OUTBOUND_SEND_TOOL = 'outbound_send';

/**
 * The `revision` a send ticket binds.
 *
 * A tool call's ticket binds the permission stack it was judged under, so that
 * editing a rule invalidates it. A send is judged under no permission stack: the
 * rules that decide it are the detection patterns, which live in code rather than
 * in configuration a user edits. So this is a constant, and it is a constant
 * *named for what it is* rather than a value pretending to be a hash — the field
 * is `NOT NULL` and something has to occupy it, and the honest occupant is a
 * marker saying "no configuration revision is bound here".
 *
 * The things that *can* move under a send are bound for real: the finding is the
 * `arguments`, the destination is the `workspace`.
 */
const SEND_REVISION = 'outbound';

/** The parts of a finding an approval binds, in the form they are stored. */
export interface OutboundQuestion {
  kinds: SecretKind[];
  hits: readonly SensitiveHit[];
  /** Which provider the flagged payload was going to. Null when none was active. */
  providerId: string | null;
}

/**
 * The question string, in one spelling used by both sides of the park.
 *
 * Deterministic and re-derivable from the refusal's own `details`, which is the
 * point: the gate computes it when it refuses, and the loop recomputes it from
 * the error it caught when it records the approval. Two spellings of one question
 * would mint a ticket no future send could ever match, and the run would park for
 * an approval it had already been granted.
 *
 * It carries **no matched text** — kinds, kinds' positions and lengths only. The
 * approval row is rendered to the user and listed by `GET .../approvals`, and a
 * question that quoted the credential would publish the thing being protected.
 * Offsets and lengths are enough to review, and enough to bind: the same span in
 * the same turn of the same conversation is the same finding.
 */
export function outboundQuestion(parts: OutboundQuestion): string {
  const hits = [...parts.hits]
    .map((hit) => ({
      messageIndex: hit.messageIndex,
      role: hit.role,
      kind: hit.kind,
      index: hit.index,
      length: hit.length,
    }))
    .sort(
      (a, b) =>
        a.messageIndex - b.messageIndex ||
        a.index - b.index ||
        (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
    );
  return JSON.stringify({
    v: 1,
    kinds: [...parts.kinds].sort(),
    hits,
    providerId: parts.providerId,
  });
}

/**
 * The same question, rebuilt from a `redaction_flagged` refusal.
 *
 * `assertOutboundSafe` puts `kinds` and `hits` in `details` and never the matched
 * text, so the reconstruction is exact. `providerId` is there for this purpose —
 * see `outbound.ts`. A refusal that is missing any of the three cannot be bound
 * to a question, and `null` is the answer: the run parks with nothing recorded
 * rather than with a question that does not describe what was found.
 */
export function questionFromRefusal(details: Record<string, unknown> | undefined): string | null {
  if (details === undefined) return null;
  const kinds = details.kinds;
  const hits = details.hits;
  if (!Array.isArray(kinds) || !Array.isArray(hits)) return null;
  const providerId = typeof details.providerId === 'string' ? details.providerId : null;
  return outboundQuestion({
    kinds: kinds as SecretKind[],
    hits: hits as SensitiveHit[],
    providerId,
  });
}

/**
 * The ticket binding for an outbound send.
 *
 * Two fields are borrowed from their tool-call meaning and the borrowing is worth
 * stating, because a reader comparing this to `liveBinding` in `loop.ts` would
 * otherwise assume a mistake:
 *
 *   - **`workspace` is the destination.** For a tool call it is the directory the
 *     call executes in; the analogue for a send is the provider the bytes go to.
 *     A send approved to one provider is not a send approved to another, and
 *     putting the provider id here is what makes that true in one comparison.
 *   - **`parentTaskId` is always null.** A delegated child sends through the
 *     parent's `llm` and is logged against the parent's task and run, so there is
 *     no second task identity to bind — this is the pre-S1 case, not a gap.
 */
export function outboundSendBinding(input: {
  taskId: string;
  /** Absent for a headless run, whose ticket binds no run (S1). */
  runId?: string | undefined;
  providerId: string | null;
  question: string;
}): TicketBinding {
  return {
    toolName: OUTBOUND_SEND_TOOL,
    permissionKey: OUTBOUND_SEND_TOOL,
    arguments: input.question,
    workspace: input.providerId ?? '',
    taskId: input.taskId,
    runId: input.runId ?? null,
    parentTaskId: null,
    revision: SEND_REVISION,
  };
}

export interface TaskSendGateInput {
  messages: readonly ChatMessage[];
  /** The task the run belongs to: what a send approval is keyed by (S1). */
  taskId: string;
  /** The live run. Absent for a headless run, whose task is its whole identity. */
  runId?: string | undefined;
}

/**
 * Refuse a task run's outbound send whose payload carries a credential, unless an
 * approved ticket already covers this finding.
 *
 * Returns the report when the send may proceed — including the ordinary case
 * where nothing was found — and throws `redaction_flagged` otherwise. The throw
 * is `assertOutboundSafe`'s own, with its own wording and its own 409; this
 * function raises nothing of its own, so there is one refusal in the tree and one
 * place the frontend learns what it looks like.
 *
 * Skipped entirely for a provider that is not `remote`, for the reason `outbound.ts`
 * gives at length: a local model is not egress, and warning about a payload that
 * never left the machine teaches the user to dismiss the warning. The class is
 * computed here as well as inside `assertOutboundSafe` so that a local run is not
 * scanned at all — the payload of a long task is not small, and the scan is a
 * heuristic over regexes that has no business running on every turn of a run
 * that never leaves the box.
 */
export function assertTaskOutboundSafe(input: TaskSendGateInput): SensitiveReport | null {
  if (!redactionCheckEnabled()) return null;

  const provider = getActiveProvider();
  const subject: EgressSubject | null = provider;
  // A null provider is `unknown`, and `unknown` is not gated — see `outbound.ts`.
  if (egressClassFor(subject) !== 'remote') return null;

  const report = scanForSensitive(input.messages);
  if (!report.flagged) return report;

  const providerId = provider?.id ?? null;
  const question = outboundQuestion({ kinds: report.kinds, hits: report.hits, providerId });

  // Checked *before* the gate, on a payload already known to be flagged: this is
  // the half that keeps an approved resume from parking again. One indexed read
  // answers "is there an authorisation for this kind of question at all?", so the
  // common case — a finding with no approval behind it — costs no settlement.
  const ticket = liveTicketForQuestion(input.taskId, OUTBOUND_SEND_TOOL);
  if (ticket !== null) {
    const settlement = settleTicket({
      live: outboundSendBinding({
        taskId: input.taskId,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        providerId,
        question,
      }),
      runAccepts: (ticketRunId) =>
        acceptsTicketRun({
          runId: input.runId,
          continuedFrom: input.runId === undefined ? null : (getTaskRun(input.runId)?.continuedFrom ?? null),
          ticketRunId,
        }),
      // Not consumed. A tool call runs once; this send is re-made on **every
      // turn** of the run, with the same conversation and therefore the same
      // finding. Spending the ticket on the first of them would park on the
      // second and ask the identical question again — the noise failure
      // `approvals.ts` names as how a confirmation prompt becomes something
      // people click through, except here it would also be an infinite park.
      consume: false,
    });
    if (settlement.kind === 'granted') return report;
  }

  // Throws `redaction_flagged`. Unreachable-return is dead code, and it is typed
  // out rather than asserted so a future signature change is a compile error.
  assertOutboundSafe({ messages: input.messages, provider: subject, enabled: true });
  return report;
}
