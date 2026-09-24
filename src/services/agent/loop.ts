/**
 * The shared agent loop.
 *
 * Every agentic tool — code, cowork, design — runs the same cycle: ask the model
 * what to do, do it, feed the outcome back, repeat until it stops asking. This
 * module owns that cycle so the three agents differ only in their prompts and
 * their tool sets, not in their control flow. An agent that implements its own
 * loop also implements its own version of the mode gate, the iteration ceiling
 * and the parked-state bookkeeping, and the second copy is where they diverge.
 *
 * Five things here are load-bearing, and each exists because the obvious
 * alternative fails in a specific way.
 *
 * **The mode gate sits at exactly one place.** `dispatchToolCall` is the only
 * function in this module that invokes anything, and the permission decision is
 * made inside it. Checking it where the loop *builds* a request instead would
 * leave every future call site free to skip it — and the whole point of a
 * read-only mode is that it cannot be bypassed by a code path nobody remembered
 * to guard.
 *
 * 1.27 replaced the three hardcoded mode branches with one `evaluate()` call and
 * did not move it. The gate is still one function, still called from one place;
 * what changed is that the answer now comes from layered rules instead of a
 * three-way `if`, and that it has a third possible answer — `ask`, which parks the
 * run rather than refusing outright. A `mode`-only caller still gets the original
 * gate byte for byte, which is what makes the reframe checkable rather than
 * asserted: see `PermissionResolver`.
 *
 * **An unknown tool is treated as mutating.** The policy answers `undefined` for
 * a name it has never heard of, and this module reads that as `mutate`. Defaulting
 * the other way would mean any tool added without touching the policy silently
 * becomes runnable in Plan mode, which is the failure the mode exists to prevent.
 *
 * **A parked run is written before it is announced.** `updateTaskRunState` runs
 * before `ctx.emit`. If the order were reversed, a client that acted on the event
 * and then reloaded would find a run still marked `running`, because the process
 * can die between the two statements. The database is the record; SSE is a
 * notification about it.
 *
 * A parked run is **not** finished, which is why this uses `updateTaskRunState`
 * rather than `finishTaskRun`. Parking is mid-run: the run is waiting on the user
 * and will continue. `finishTaskRun` rewrites the pause and error columns, so
 * routing a park through it would erase the provider failure that a run may
 * already be carrying and replace it with a park reason — losing the diagnosis
 * the user needs. The reason for parking lives in the step history instead.
 *
 * **The repeat guard counts identical calls, not iterations.** A ceiling on
 * iterations alone does not catch the common failure, which is a model that keeps
 * making real progress in its own view — calling the same tool with the same
 * arguments and getting the same answer — until the ceiling runs out and the run
 * dies with a confusing budget error rather than the true reason.
 *
 * **The conversation is shortened before it is sent, not after it is refused.**
 * A request larger than the model's window comes back as a hard provider error,
 * typically once tools have already changed files — too late to be anything but a
 * failed run. So the loop compacts at the top of each iteration, ahead of the
 * request rather than in response to its rejection. The loop does not own the
 * message list, though: `turn` does, because only the agent knows how its prompt
 * is assembled. `LoopContextAccess` is how an agent lends the loop enough access
 * to do this, and it is optional precisely so that an agent managing its own
 * context keeps working unchanged.
 */

import { acceptsTicketRun, finishTaskRun, updateTaskRunState } from '../../db/taskRuns.ts';
import { CEILING_REASON } from '../limits/budget.ts';
import { recordApproval } from '../../db/approvals.ts';
import { getTaskRun } from '../../db/taskRuns.ts';
import {
  mintTicket,
  settleTicket,
  type TicketBinding,
  type TicketField,
  type TicketRefusal,
  type TicketSettlement,
} from '../../db/approvalTickets.ts';
import { approvalWaitTtlMs } from './approvalWait.ts';
import { OUTBOUND_SEND_TOOL, outboundSendBinding, questionFromRefusal } from '../safety/outboundGate.ts';
import { snapshotConversation } from '../../db/taskMessages.ts';
import { nextStepNumber, recordStep } from '../../db/taskSteps.ts';
import { taskIterationCeiling } from '../../db/settings.ts';
import { AppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';
import { compactConversation, recordCompaction } from './compaction.ts';
import { describeVerdict } from './permissions.ts';

import type { ErrorCode } from '../../util/errors.ts';

import type { PendingApproval } from '../../db/approvals.ts';
import type { TaskRunTool } from '../../db/taskRuns.ts';
import type { TaskStepKind } from '../../db/taskSteps.ts';
import type { CeilingKind, TaskBudget } from '../limits/budget.ts';
import type { ContextWindow } from './compaction.ts';
import type {
  AgentContext,
  AgentMode,
  AgentProfile,
  ChatMessage,
  PermissionVerdict,
  PlannedAction,
  ToolCall,
} from '../../types/core.ts';

export type { AgentMode, PlannedAction } from '../../types/core.ts';

const log = createLogger('agentloop');

/** Whether running a tool can change anything outside the process. */
export type ToolEffect = 'read' | 'mutate';

/**
 * Names a tool's effect. Supplied by the agent, because only the agent knows its
 * own tool set.
 *
 * Answering `undefined` is allowed and means "not classified" — never "harmless".
 * See the module comment: this module folds `undefined` into `mutate`.
 *
 * Retained after 1.27 rather than replaced by the permission engine, because the
 * engine needs it: the `plan` built-in's rule is "run what only reads, refuse what
 * changes", and which tools fall on each side is a fact about the agent. See
 * `permissions.ts` for why enumerating names in a built-in was not an option.
 */
export interface ToolPolicy {
  effect(toolName: string): ToolEffect | undefined;
}

/** Runs one tool call for real. Provided by the agent. */
export interface ToolRunner {
  (call: ToolCall): Promise<string>;
}

/**
 * Decides one call. Supplied by the agent, which owns the layer stack.
 *
 * Optional throughout: an agent (or a test) that hands the loop no resolver keeps
 * the pre-1.27 mode gate, byte for byte. That fallback is not legacy debt — it is
 * what makes the reframe provably behaviour-preserving, and `dispatchToolCall`
 * remains directly callable with nothing but a mode.
 */
export interface PermissionResolver {
  (input: { call: ToolCall; effect: ToolEffect }): PermissionVerdict;
  /**
   * The revision of the layer stack this resolver evaluates (S1), set by
   * `createPermissionResolver`. Optional because a bespoke resolver — a test's
   * stub, a caller that decided not to use the engine — has no stack to revise, and
   * the loop then has no revision to bind a ticket to rather than binding a lie.
   */
  revision?: string;
}

/** Why a dispatch attempt did not run the tool. */
export type RefusalReason =
  | 'ask_mode'
  | 'plan_mode'
  | 'permission_denied'
  | 'approval_required'
  /** A prior approval existed and no longer covers this call (S1). */
  | 'approval_invalid';

export interface DispatchResult {
  ran: boolean;
  /** The tool's own output, or the refusal text fed back to the model. */
  output: string;
  refusedBecause?: RefusalReason;
  /** Set whenever the permission engine decided, for the caller to park on. */
  verdict?: PermissionVerdict;
}

export interface ModeGateInput {
  runId?: string;
  /** The task this run belongs to. Part of what a ticket binds (S1). */
  taskId?: string;
  mode: AgentMode;
  policy: ToolPolicy;
  run: ToolRunner;
  call: ToolCall;
  /** Collects what Plan mode declined to run. Mutated in place. */
  plan?: PlannedAction[];
  /** When supplied, decides instead of the mode. */
  permissions?: PermissionResolver;
  /** Recorded on the step row alongside the verdict's provenance. */
  profile?: string;
  /**
   * What an approval ticket binds beyond the call itself (S1).
   *
   * Supplied by the agent because only the agent knows them: the canonical
   * workspace the run is contained to, and — for a delegated child — the parent
   * task it belongs to. Omitting it keeps the gate exactly as it was before
   * tickets existed, which is what every caller that has no approvals to honour
   * wants.
   */
  ticket?: TicketContext;
}

/**
 * What the agent tells the loop about where it runs, so a ticket can bind it (S1).
 */
export interface TicketBindingContext {
  /** The canonical cwd/worktree identity this run's calls execute in. */
  workspace: string;
  /** The parent task, when this run was delegated by one. */
  parentTaskId?: string;
}

/** The live facts a ticket is checked against, minus the call being dispatched. */
export interface TicketContext {
  /** The canonical cwd/worktree identity of this run. */
  workspace: string;
  /** The parent task, for a delegated child's call. */
  parentTaskId?: string | undefined;
  /** The effective permission-config revision, as re-read for this run. */
  revision: string;
  /**
   * Whether the live run is the one a ticket was minted for, or a continuation of
   * it. A function because the lineage lives in `task_runs` and the caller has the
   * row; the loop only knows its own run id.
   */
  runAccepts: (ticketRunId: string | null) => boolean;
}

/**
 * The single dispatch point.
 *
 * A refusal is returned as ordinary tool output rather than thrown. The model is
 * mid-conversation and needs to hear *why* it cannot act so it can answer in
 * prose or propose a plan; an exception would abort the run and lose the turn the
 * user was waiting for. A refusal is a result, not a failure — so `ok` is
 * recorded `true` for the step. It did what it was asked to do.
 *
 * `ask` is the exception that is still not an exception: the call does not run and
 * the model is told why, exactly like a denial, but the *caller* additionally
 * parks the run so the user can decide. Throwing here would lose the conversation
 * that the continuation needs to replay.
 */
export async function dispatchToolCall(input: ModeGateInput): Promise<DispatchResult> {
  const { call, mode, policy, runId } = input;
  const effect = policy.effect(call.name) ?? 'mutate';

  if (input.permissions !== undefined) {
    const verdict = input.permissions({ call, effect });

    if (verdict.action === 'deny') {
      // Plan mode's collection lives here now, driven by the `plan` built-in's
      // base mode rather than by a branch on `mode`. A custom profile declaring
      // `mode: plan` therefore collects a plan too, which is the point of making
      // Plan a profile instead of a special case.
      const planned = mode === 'plan' && effect === 'mutate';
      const reason = planned
        ? `\`${call.name}\` changes things, and this run is planning rather than acting.`
        : `\`${call.name}\` is refused by ${describeVerdict(verdict)}.`;
      const output = planned
        ? `Refused: ${reason} It has been added to the plan for the user to approve. ` +
          `Continue planning, or finish and present the plan.`
        : `Refused: ${reason} Only a change to that permission rule alters the answer; ` +
          `do not retry the same call.`;
      if (planned) input.plan?.push({ toolName: call.name, arguments: call.arguments, reason });
      recordGateStep(input, planned ? 'plan' : 'note', planned ? 'plan_mode' : 'permission_denied', verdict);
      return {
        ran: false,
        output,
        refusedBecause: planned ? 'plan_mode' : 'permission_denied',
        verdict,
      };
    }

    if (verdict.action === 'ask') {
      // Continuation is the only path that reaches here with a decision already
      // behind it: the run was parked on this exact call, the user answered, and
      // the replay recomputed the same verdict. The ticket is what turns that
      // recomputation into a *bound* authorisation (S1).
      const settled = settleAgainstTickets(input, call, verdict);
      if (settled.kind === 'granted') return await runTool(input, effect, verdict);
      if (settled.kind === 'refused') {
        // The call does not run, and the model is told what moved rather than that
        // something is "invalid": the usual cause is its own re-generated call, and
        // the fix available to it is to ask again with the call it actually wants.
        const output = ticketRefusalSentence(call.name, settled.refusal ?? 'mismatch', settled.fields ?? []);
        recordGateStep(input, 'approval', 'approval_invalid', verdict);
        return { ran: false, output, refusedBecause: 'approval_invalid', verdict };
      }

      const output =
        `Paused: \`${call.name}\` needs the user's approval (${describeVerdict(verdict)}). ` +
        `The call has been recorded and the task is waiting on a decision. Stop here; ` +
        `do not retry it or work around it.`;
      recordGateStep(input, 'approval', 'approval_required', verdict);
      return { ran: false, output, refusedBecause: 'approval_required', verdict };
    }

    return await runTool(input, effect, verdict);
  }

  if (mode === 'ask') {
    const output =
      `Refused: this run is in Ask mode, which answers questions and runs nothing. ` +
      `Describe what \`${call.name}\` would do, or ask the user to switch to Plan or Act mode.`;
    recordGateStep(input, 'note', 'ask_mode');
    return { ran: false, output, refusedBecause: 'ask_mode' };
  }

  if (mode === 'plan' && effect === 'mutate') {
    const reason = `\`${call.name}\` changes things, and this run is in Plan mode.`;
    const output =
      `Refused: ${reason} It has been added to the plan for the user to approve. ` +
      `Continue planning, or finish and present the plan.`;
    input.plan?.push({ toolName: call.name, arguments: call.arguments, reason });
    recordGateStep(input, 'plan', 'plan_mode');
    return { ran: false, output, refusedBecause: 'plan_mode' };
  }

  return await runTool(input, effect);
}

async function runTool(
  input: ModeGateInput,
  _effect: ToolEffect,
  verdict?: PermissionVerdict,
): Promise<DispatchResult> {
  const { call, mode, runId } = input;
  const step = runId === undefined ? undefined : nextStepNumber(runId);
  try {
    const output = await input.run(call);
    if (runId !== undefined && step !== undefined) {
      recordStep({
        runId,
        step,
        kind: 'tool_call',
        mode,
        toolName: call.name,
        ok: true,
        detail: output,
        ...(input.profile === undefined ? {} : { profile: input.profile }),
        ...(verdict === undefined ? {} : { provenance: describeVerdict(verdict) }),
      });
    }
    return { ran: true, output, ...(verdict === undefined ? {} : { verdict }) };
  } catch (error) {
    // The message is recorded, never the provider's or the shell's raw body: a
    // failing tool commonly echoes the arguments it was given, and those can
    // carry a credential the user pasted into the prompt.
    const message = error instanceof Error ? error.message : 'the tool failed';
    if (runId !== undefined && step !== undefined) {
      recordStep({
        runId,
        step,
        kind: 'tool_call',
        mode,
        toolName: call.name,
        ok: false,
        detail: message,
        ...(input.profile === undefined ? {} : { profile: input.profile }),
        ...(verdict === undefined ? {} : { provenance: describeVerdict(verdict) }),
      });
    }
    throw error;
  }
}

function recordGateStep(
  input: ModeGateInput,
  kind: TaskStepKind,
  reason: RefusalReason,
  verdict?: PermissionVerdict,
): void {
  const { runId } = input;
  if (runId === undefined) return;
  recordStep({
    runId,
    step: nextStepNumber(runId),
    kind,
    mode: input.mode,
    toolName: input.call.name,
    // A refusal did exactly what it was asked to do, so it succeeded. Recording
    // `false` would make every read-only run look like a run full of failures.
    ok: true,
    detail: reason,
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    ...(verdict === undefined ? {} : { provenance: describeVerdict(verdict) }),
  });
}

// --- the repeat guard ------------------------------------------------------

/**
 * How many times the same tool may be called with the same arguments before the
 * run is treated as stuck. Two is a legitimate retry; three is a pattern.
 */
export const DEFAULT_REPEAT_LIMIT = 3;

/**
 * Tracks identical calls.
 *
 * The signature is the tool name plus the verbatim argument string. Parsing the
 * arguments to compare them semantically would be better and is not worth it:
 * a model stuck in a loop re-emits a byte-identical call, because it is
 * regenerating from the same context.
 */
export class RepeatGuard {
  readonly #seen = new Map<string, number>();
  readonly #limit: number;

  constructor(limit: number = DEFAULT_REPEAT_LIMIT) {
    this.#limit = limit;
  }

  /** Records a call and reports whether it has now repeated too often. */
  exceeded(call: ToolCall): boolean {
    const key = `${call.name}\u0000${call.arguments}`;
    const count = (this.#seen.get(key) ?? 0) + 1;
    this.#seen.set(key, count);
    return count > this.#limit;
  }

  count(call: ToolCall): number {
    return this.#seen.get(`${call.name}\u0000${call.arguments}`) ?? 0;
  }
}

// --- parking ---------------------------------------------------------------

/** Why a run stopped without finishing. */
export type ParkReason =
  /** Credential-shaped text, and no user present to acknowledge it. */
  | 'redaction_blocked'
  /**
   * The standing zero-data-retention policy barred every provider that could have
   * served the next request. Distinct from `redaction_blocked`: nothing about the
   * payload is wrong, and no acknowledgement exists that would let it through —
   * only a settings change or a recorded provider fact will.
   */
  | 'zdr_blocked'
  /**
   * The same call repeated past the limit, and the user denied it.
   *
   * Terminal, and no longer the *first* thing a repeat triggers: the guard now
   * raises `doom_loop` and asks. This reason is what a denial lands on, which is
   * why it keeps its `blocked` state and its existing meaning — a run nobody
   * wants continued.
   */
  | 'loop_detected'
  /**
   * The same call repeated past the limit, and the user has not decided yet.
   *
   * Split from `loop_detected` because a stuck model is not always wrong: the
   * common case is a tool that legitimately returns the same answer twice, and
   * killing the run outright throws away everything before the repetition. Asking
   * costs one confirmation and keeps the work.
   */
  | 'doom_loop'
  /** Plan mode produced a plan and is waiting for approval. */
  | 'plan_ready'
  /** A tool call needs the user's explicit go-ahead before it runs. */
  | 'approval_required'
  /** The iteration ceiling ran out. */
  | 'iteration_ceiling'
  /**
   * The conversation is over the model's window and compaction could not shorten
   * it, because everything left is pinned.
   */
  | 'context_exhausted';

const PARK_STATE: Record<ParkReason, 'blocked' | 'ready_for_review'> = {
  redaction_blocked: 'blocked',
  zdr_blocked: 'blocked',
  loop_detected: 'blocked',
  iteration_ceiling: 'blocked',
  // Not `ready_for_review`: there is nothing for the user to approve. The run
  // cannot proceed until something changes — a larger model, a fresh task — and
  // `blocked` is the state that says so.
  context_exhausted: 'blocked',
  plan_ready: 'ready_for_review',
  // Both are `ready_for_review` because both are genuinely waiting on a decision
  // the user can make right now, which is exactly what that state means. A
  // `blocked` approval would tell the UI there is nothing to do.
  approval_required: 'ready_for_review',
  doom_loop: 'ready_for_review',
};

/**
 * Park a run: write the state, then tell the client.
 *
 * The order is the contract. See the module comment — a client told about a state
 * the database does not yet hold will disagree with the server after any reload,
 * and the window is real because nothing guarantees this process survives to the
 * next statement.
 */
export function parkRun(
  ctx: Pick<AgentContext, 'emit' | 'log'>,
  runId: string | undefined,
  reason: ParkReason,
  detail: string,
): void {
  const state = PARK_STATE[reason];
  if (runId !== undefined) {
    // The reason travels with the state as of 1.31. Before this the row said
    // *that* a run was parked and never *why*, so the Attention Center showed a
    // generic sentence where the specific one existed, and an unattended run had
    // nothing to tell the user beyond "failed". The token (not a sentence) is what
    // goes in the column; `parkMessages.ts` owns the wording.
    updateTaskRunState(runId, state, { pauseReason: reason });
    recordStep({ runId, step: nextStepNumber(runId), kind: 'note', ok: false, detail: `${reason}: ${detail}` });
  }
  ctx.emit('task_parked', { ...(runId === undefined ? {} : { runId }), state, reason, detail });
  ctx.log.warn(`parked run${runId === undefined ? '' : ` ${runId}`} as ${state}`, { reason });
}

/**
 * Translate a refused outbound send into a parked run when nobody is watching.
 *
 * Two refusals arrive this way, and both assume a user is present to answer them:
 * `redaction_flagged` shows a finding and asks whether to send anyway, and
 * `zdr_requirement_unmet` reports that the standing privacy policy bars every
 * provider that could serve the turn. An unattended run — a scheduled task, a
 * queued task the user has navigated away from — has nobody to ask, and the two
 * wrong answers are both worse than parking: sending anyway defeats the check, and
 * failing the run as an error tells the user their task broke rather than that it
 * is waiting on them.
 *
 * Re-thrown unchanged when a user *is* present, so the 409 or 403 reaches the UI
 * that knows how to act on it.
 *
 * Named for the condition rather than the cause. It was `parkOnRedaction` while
 * redaction was the only blocked send; a second one arriving is exactly when a
 * name that enumerates causes starts to lie.
 */
/**
 * The park reasons that mean "a send was refused", tied to `ParkReason` through
 * `Extract` so renaming one of them is a compile error here rather than a lookup
 * that silently misses.
 */
type BlockedSendReason = Extract<ParkReason, 'redaction_blocked' | 'zdr_blocked'>;

const BLOCKED_SEND_PARK: Partial<Record<ErrorCode, BlockedSendReason>> = {
  redaction_flagged: 'redaction_blocked',
  zdr_requirement_unmet: 'zdr_blocked',
};

/** The user-facing wording for each parked send, by park reason. */
const BLOCKED_SEND_MESSAGE: Record<BlockedSendReason, string> = {
  // Says "no way to acknowledge it here" rather than "no one was watching". It
  // used to be the second, and it was true then: this branch only ran for an
  // unattended run. Since the scan was wired into the task path it also fires
  // with a browser attached, and telling a user who *is* watching that nobody
  // was would be a small lie in the one sentence they are reading to find out
  // what to do. The finding is answerable now — an approval — so the sentence
  // says how.
  redaction_blocked:
    'This task was paused because its next message appeared to contain a credential, and a task run ' +
    'has no way to send it anyway. Open the task, review the finding, and approve it to let this ' +
    'send through.',
  // Deliberately does not say "review and resume": there is nothing here for the
  // user to approve, and inviting them to approve something would be a lie. The
  // block lifts only when a setting or a recorded provider fact changes.
  zdr_blocked:
    'This task was paused because no provider that can serve it satisfies your zero-data-retention ' +
    'requirement, and no one was watching to decide. Record ZDR support for a provider, or lower the ' +
    'requirement, then resume the task.',
};

export function parkOnBlockedSend(
  ctx: Pick<AgentContext, 'emit' | 'log'>,
  runId: string | undefined,
  error: unknown,
  unattended: boolean,
): never {
  if (!unattended || !(error instanceof AppError)) throw error;

  const reason = BLOCKED_SEND_PARK[error.code];
  if (reason === undefined) throw error;

  parkRun(ctx, runId, reason, error.message);
  throw new AppError(error.code, BLOCKED_SEND_MESSAGE[reason], {
    retryable: false,
    // The flag as the caller stated it, not `true` because a park happened: a
    // redaction finding parks an attended task run too (see
    // `unattendedForBlockedSend`), and an error body is not the place to invent
    // a fact about who was watching.
    details: { runId, unattended },
  });
}

/**
 * Whether a refused send parks this run when the flag says somebody is watching.
 *
 * `parkOnBlockedSend` parks only an unattended run, and that is right for the
 * general case: both refusals it handles are written on the assumption that a
 * user is present to answer them. A *task* run is the exception, and only for one
 * of the two.
 *
 * A `redaction_flagged` finding has exactly one interactive answer in this
 * codebase — the chat composer resends with `acknowledgeSensitive` — and no task
 * route reads that field. So a task run has no interactive answer to wait for
 * even with a browser attached: the finding is answered by an approval, and the
 * park is what makes one possible. `unattended` is therefore overridden here
 * rather than treated as a reason to fail the run.
 *
 * A `zdr_requirement_unmet` refusal keeps the old rule untouched, because nothing
 * can acknowledge it — no approval lets it through, and the block lifts only when
 * a setting or a recorded provider fact changes. An interactive run is better
 * *told* than parked, which is what the flag was for in the first place.
 */
function unattendedForBlockedSend(input: AgentLoopInput, error: unknown): boolean {
  if (error instanceof AppError && error.code === 'redaction_flagged') return true;
  return input.unattended === true;
}

/**
 * Record the question a refused send is waiting on, and mint its ticket.
 *
 * The send half of S1's mechanism, reused rather than reinvented: an ordinary
 * pending approval under `outbound_send`, with a ticket binding the finding and
 * the destination exactly as one binds a tool call's arguments and workspace. The
 * ticket is what stops the park from being a loop — see the comment in
 * `services/safety/outboundGate.ts` for the order the two are checked in.
 *
 * Deliberately not `recordPendingApproval`, which mints only behind an `ask`
 * verdict from the permission engine. Nothing here was refused by a rule, and a
 * synthetic verdict to borrow that function would hang an approval on a layer the
 * engine never consulted. The fields, the dedupe (`recordApproval` returns the
 * identical question rather than stacking a second) and the deadline are the
 * same ones, and the settlement is `settleTicket` — the same call a tool call's
 * ticket is settled by.
 *
 * Cannot end the run. It describes a run that has already stopped, and a storage
 * failure must not turn a question the user can answer into an exception they
 * cannot — the park happens either way, and its step row says why.
 */
function recordBlockedSend(input: AgentLoopInput, error: unknown): PendingApproval | null {
  if (!(error instanceof AppError) || error.code !== 'redaction_flagged') return null;
  if (input.taskId === undefined) {
    log.warn('a run parked on a blocked send with no task id, so nothing was recorded', {
      tool: input.tool,
    });
    return null;
  }
  const question = questionFromRefusal(error.details);
  if (question === null) {
    log.warn('a blocked send carried no finding, so no question was recorded', { tool: input.tool });
    return null;
  }

  const runId = input.runId;
  const providerId = typeof error.details?.providerId === 'string' ? error.details.providerId : null;

  try {
    const approval = recordApproval({
      ...(runId === undefined ? {} : { runId }),
      taskId: input.taskId,
      tool: input.tool,
      toolName: OUTBOUND_SEND_TOOL,
      arguments: question,
      permissionKey: OUTBOUND_SEND_TOOL,
      // What was found, never the matched text: this row is listed by the
      // approvals route and rendered in the task, and a question that quoted the
      // credential would publish the thing the scan exists to protect. The
      // offsets are in `arguments`, which is what an approval's own display
      // shows verbatim.
      reason: `Sending this to a remote provider was held: ${error.message}`,
    });
    mintTicket({
      approvalId: approval.id,
      tool: input.tool,
      binding: outboundSendBinding({ taskId: input.taskId, ...(runId === undefined ? {} : { runId }), providerId, question }),
      expiresAt: Date.now() + approvalWaitTtlMs(),
    });
    return approval;
  } catch (mintError) {
    log.warn('could not record the approval a blocked send is waiting on', {
      tool: input.tool,
      error: mintError instanceof Error ? mintError.message : String(mintError),
    });
    return null;
  }
}

/**
 * Stop a run whose token budget has run out: `stopped` with `ceiling_reached`,
 * not a park.
 *
 * The distinction carries the same weight as the row states themselves. A parked
 * run is waiting on an answer and will continue; a ceiling stop is over, because
 * continuing is exactly what the ceiling forbids. `finishTaskRun` is also the
 * right writer here (unlike a park): the run is terminal, so the pause column
 * naming the reason is its final record, not a diagnosis to protect.
 *
 * Same ordering rule as `parkRun`: the database write lands before the event,
 * because the row is the record and SSE is only a notification about it.
 */
function stopAtCeiling(ctx: AgentContext, input: AgentLoopInput, kind: CeilingKind, detail: string): void {
  snapshotForPark(input);
  if (input.runId !== undefined) {
    finishTaskRun(input.runId, 'stopped', { pauseReason: CEILING_REASON });
    recordStep({ runId: input.runId, step: nextStepNumber(input.runId), kind: 'note', ok: false, detail });
  }
  ctx.emit('ceiling_reached', { ...(input.runId === undefined ? {} : { runId: input.runId }), kind, detail });
  ctx.log.warn(`run${input.runId === undefined ? '' : ` ${input.runId}`} stopped: ${detail}`);
}

// --- the loop ------------------------------------------------------------

/**
 * An agent lending the loop enough access to shorten its conversation.
 *
 * Deliberately not a message array. `turn` builds the request from whatever the
 * agent keeps — an array here, a template plus a history table there — and handing
 * the loop a snapshot would let the two drift: the loop would compact a copy the
 * next `turn` never reads, silently doing nothing. Reading through `messages()`
 * and writing through `replace()` means the loop always sees what will actually
 * be sent.
 */
export interface LoopContextAccess {
  /** The conversation as it stands, in the order it will be sent. */
  messages(): readonly ChatMessage[];
  /** Adopt a shortened conversation. Called only when something was dropped. */
  replace(messages: ChatMessage[]): void;
  /** The model's limit, resolved by the agent via `resolveContextWindow`. */
  window: ContextWindow;
}

export interface AgentLoopInput {
  /** Omitted for scheduled/headless runs, which use scheduled_task_runs instead. */
  runId?: string;
  /**
   * The task this run belongs to. Needed by anything durable that outlives the
   * run row — a recorded approval, a conversation snapshot — because those are
   * keyed by task, not by attempt.
   */
  taskId?: string;
  tool: TaskRunTool;
  mode: AgentMode;
  policy: ToolPolicy;
  /**
   * The resolved profile. Recorded on every step, and its name is what a user
   * sees when asking why a call was refused.
   */
  profile?: AgentProfile;
  /**
   * Where this run's calls execute, for the approval tickets they bind (S1).
   *
   * Only the agent knows this: the loop is told a `ToolRunner` and a policy, and
   * neither says which directory the tools will actually touch. When it is absent
   * — a headless run, a test that dispatches one call — no ticket is minted and
   * none is settled, which is exactly the pre-S1 behaviour: `ask` parks, the
   * decision arms the pending approval, and the replay runs.
   *
   * The permission-config revision comes from `permissions.revision` instead, so
   * that the binding can only ever describe the stack the engine really consults.
   */
  ticketBinding?: TicketBindingContext;
  /**
   * Decides each call. Omitting it keeps the pre-1.27 mode gate exactly — see
   * `PermissionResolver`.
   */
  permissions?: PermissionResolver;
  /** Runs one tool call. Only ever reached through the mode gate. */
  run: ToolRunner;
  /**
   * Asks the model for its next move. Returns the tool calls it wants, if any;
   * an empty array ends the loop.
   */
  turn: (feedback: readonly ToolFeedback[]) => Promise<ToolCall[]>;
  /** No user is watching, so nothing can be acknowledged interactively. */
  unattended?: boolean;
  repeatLimit?: number;
  /** Overrides the stored ceiling. Present for tests, not for callers. */
  iterationCeiling?: number;
  /**
   * The caller's token budget, shared with any subagents.
   *
   * The loop never sees a usage chunk — `turn` does, and charges them as they
   * arrive — so the budget arrives here only to be asked, after each turn,
   * whether it has run out. A ceiling the caller set and nothing enforced would
   * be a setting that lies; omitting the field keeps the loop exactly as before.
   */
  budget?: TaskBudget;
  /**
   * Lets the loop compact the conversation when it approaches the model's window.
   *
   * Optional, and omitting it means no compaction at all rather than a guess. An
   * agent that assembles its prompt fresh from a database on every turn, or that
   * manages its own context, is a legitimate caller and must not have its
   * conversation rewritten by a mechanism that cannot see how it is built.
   */
  context?: LoopContextAccess;
}

export interface ToolFeedback {
  call: ToolCall;
  output: string;
  ran: boolean;
}

export interface AgentLoopResult {
  /** True when the model stopped of its own accord. */
  completed: boolean;
  iterations: number;
  /** Set when the loop stopped early. */
  parked?: ParkReason;
  /** Set when the run stopped because the budget's token ceiling ran out. */
  ceilingReached?: boolean;
  /** Mutating calls Plan mode collected instead of running. */
  plan: PlannedAction[];
  /** The recorded approval a run parked on, for the caller to surface. */
  pendingApprovalId?: string;
}

/**
 * Shorten the conversation if it is close to the model's window.
 *
 * Returns `false` when the conversation is over the threshold and cannot be
 * shortened, which is the caller's cue to park. A compaction that changed nothing
 * because nothing needed changing is the ordinary case and returns `true`.
 */
function compactIfNeeded(
  ctx: AgentContext,
  runId: string | undefined,
  access: LoopContextAccess,
): boolean {
  const result = compactConversation({ messages: access.messages(), window: access.window });

  if (result.compacted) {
    // `recordCompaction` writes the step and emits the event; it returns early on
    // an uncompacted result, so calling it unconditionally would be harmless but
    // would obscure that the replace below is the compacted-only path.
    recordCompaction(ctx, runId, result);
    access.replace(result.messages);
    return true;
  }

  return result.skippedBecause !== 'nothing_droppable';
}

/**
 * Snapshot the conversation, and never let that write end the run.
 *
 * Called immediately before each `parkRun`, from here rather than from inside
 * `parkRun` itself. `parkRun` takes `Pick<AgentContext, 'emit' | 'log'>` — it is
 * deliberately narrow, and agents call it directly — while the conversation lives
 * behind `AgentLoopInput.context`. Widening `parkRun`'s signature to reach it would
 * hand every caller access to something most of them have no business writing.
 *
 * Two absences are legitimate and produce no snapshot: an agent that supplies no
 * `LoopContextAccess` (it assembles its prompt fresh each turn, so there is nothing
 * durable to capture), and a run with no `taskId`. Both are handled by the
 * continuation route refusing with a coded 409 that names the reason, rather than
 * continuing from an empty conversation and re-running the task's first turn while
 * claiming to resume it.
 *
 * Failures are logged and swallowed for the same reason `recordStep` swallows its
 * own: this describes a run that has *already* stopped, and a storage error must
 * not turn a park the user can answer into an exception they cannot.
 */
function snapshotForPark(input: AgentLoopInput): void {
  if (input.taskId === undefined || input.context === undefined) return;
  const access = input.context;
  try {
    snapshotConversation(input.taskId, access.messages(), () => {
      const pruned = compactConversation({
        messages: access.messages(),
        window: access.window,
        // Force the prune rather than asking whether one is needed: the caller has
        // already decided the verbatim form is too large to keep at rest, which is
        // a different question from whether it still fits the model's window.
        trigger: 0,
      });
      return pruned.compacted ? pruned.messages : access.messages();
    });
  } catch (error) {
    log.warn('could not snapshot the conversation for a parked run', {
      taskId: input.taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Drive one agent task to a stopping point.
 *
 * Stops for exactly seven reasons: the model asked for nothing further, the
 * repeat guard tripped, the iteration ceiling ran out, Plan mode gathered a plan
 * worth showing, a call needs the user's approval, the conversation outgrew the
 * context window with nothing left to drop, or the token budget ran out.
 * Cancellation is checked at the top of every iteration — a long loop that only
 * checks `signal` around the LLM call keeps running tools after the user has
 * clicked stop.
 */
export async function runAgentLoop(
  input: AgentLoopInput,
  ctx: AgentContext,
): Promise<AgentLoopResult> {
  const ceiling = input.iterationCeiling ?? taskIterationCeiling();
  const guard = new RepeatGuard(input.repeatLimit);
  const plan: PlannedAction[] = [];
  // Resolved once, for the same reason the permission stack is: a ticket binds
  // *this* run's identity, and re-reading the run row mid-loop would let a
  // superseded run keep authorising calls under its successor's id (S1).
  const ticket = ticketContext(input);

  /** Snapshot, then park. Every stopping point goes through here. */
  const park = (reason: ParkReason, detail: string): void => {
    snapshotForPark(input);
    parkRun(ctx, input.runId, reason, detail);
  };

  let feedback: ToolFeedback[] = [];
  let iterations = 0;

  while (iterations < ceiling) {
    if (ctx.signal.aborted) throw new AppError('aborted', 'The run was cancelled.');
    iterations += 1;
    // The budget's own iteration counter runs alongside the loop's, because the
    // budget is shared with subagents whose iterations this loop never sees.
    input.budget?.step();

    // Before `turn`, not after: the point is to shrink the request while it can
    // still be sent. Compacting in response to a rejection means the run has
    // already failed, usually with tools' side effects on disk behind it.
    if (input.context && !compactIfNeeded(ctx, input.runId, input.context)) {
      park(
        'context_exhausted',
        'the conversation exceeds the model context window and nothing further can be dropped',
      );
      return { completed: false, iterations, parked: 'context_exhausted', plan };
    }

    let calls: ToolCall[];
    try {
      calls = await input.turn(feedback);
    } catch (error) {
      // Snapshotted before the throw, not after: `parkOnBlockedSend` parks and
      // then re-throws, so this is the only point at which the conversation is
      // still reachable. A `redaction_blocked` park with no snapshot would be
      // exactly the dead end this phase exists to remove.
      snapshotForPark(input);
      // Recorded before the park, for the same reason: a blocked send parks
      // *waiting on an answer*, and the answer is given to an approval row. A
      // park with nothing behind it would re-scan the replayed conversation on
      // resume, find the same credential, and park again — forever.
      recordBlockedSend(input, error);
      parkOnBlockedSend(ctx, input.runId, error, unattendedForBlockedSend(input, error));
    }

    if (calls.length === 0) {
      if (plan.length > 0) {
        park('plan_ready', `${plan.length} action(s) need approval`);
        return { completed: false, iterations, parked: 'plan_ready', plan };
      }
      return { completed: true, iterations, plan };
    }

    // A model turn that spent past the ceiling but asked for nothing more just
    // completed: the ceiling exists to stop the *next* spend, so a natural end
    // above still wins. Only a turn that wants to continue is stopped here, and
    // its tool calls are never dispatched.
    if (input.budget !== undefined) {
      const ceiling = input.budget.exceeded();
      if (ceiling !== null) {
        const snapshot = input.budget.snapshot();
        stopAtCeiling(
          ctx,
          input,
          ceiling,
          ceiling === 'token_budget'
            ? `token budget exhausted: ${snapshot.tokensUsed} tokens charged against a ceiling of ${snapshot.tokenCeiling}`
            : `${ceiling} reached: ${snapshot.iterations} iterations against a ceiling of ${snapshot.iterationCeiling}`,
        );
        return { completed: false, iterations, plan, ceilingReached: true };
      }
    }

    feedback = [];
    for (const call of calls) {
      if (guard.exceeded(call)) {
        // Asks rather than killing the run outright. A stuck model is not always
        // wrong — the common case is a tool that legitimately returns the same
        // answer twice — and terminating discards everything before the
        // repetition. `loop_detected` is now what a *denial* lands on.
        const approval = recordPendingApproval(input, ticket, call, undefined, 'doom_loop');
        park(
          'doom_loop',
          `\`${call.name}\` was called ${guard.count(call)} times with identical arguments`,
        );
        ctx.emit('approval_required', {
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(approval === null ? {} : { approvalId: approval.id }),
          tool: input.tool,
          toolName: call.name,
          reason: 'doom_loop',
        });
        return {
          completed: false,
          iterations,
          parked: 'doom_loop',
          plan,
          ...(approval === null ? {} : { pendingApprovalId: approval.id }),
        };
      }

      const result = await dispatchToolCall({
        runId: input.runId,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        mode: input.mode,
        policy: input.policy,
        run: input.run,
        call,
        plan,
        ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
        ...(input.profile === undefined ? {} : { profile: input.profile.name }),
        ...(ticket === undefined ? {} : { ticket }),
      });
      feedback.push({ call, output: result.output, ran: result.ran });

      // An `ask` stops the whole run, not just this call. Carrying on through the
      // remaining calls in the batch would run work the user has not yet agreed
      // to, and would leave the conversation in a state the continuation cannot
      // reproduce — the approved call has to be the next thing that happens.
      //
      // A ticket that no longer covers the call stops the run for the same reason
      // and then some: an approval exists, but not for *this* call, so nobody has
      // agreed to what is about to happen. Treating it as an ordinary refusal and
      // letting the model carry on would quietly drop the requirement that a
      // human agreed — the run parks, asks afresh about the call actually in
      // front of it, and the model is told why (S1).
      if (result.refusedBecause === 'approval_required' || result.refusedBecause === 'approval_invalid') {
        const invalidated = result.refusedBecause === 'approval_invalid';
        const approval = recordPendingApproval(input, ticket, call, result.verdict);
        park(
          'approval_required',
          invalidated
            ? `\`${call.name}\` no longer matches the approval behind it, so it needs a fresh decision`
            : `\`${call.name}\` needs approval${result.verdict === undefined ? '' : ` (${describeVerdict(result.verdict)})`}`,
        );
        ctx.emit('approval_required', {
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(approval === null ? {} : { approvalId: approval.id }),
          tool: input.tool,
          toolName: call.name,
          ...(invalidated ? { reason: 'approval_invalid' } : {}),
          ...(result.verdict === undefined
            ? {}
            : {
                permissionKey: result.verdict.key,
                matchedLayer: result.verdict.layer,
                matchedPattern: result.verdict.pattern,
              }),
        });
        return {
          completed: false,
          iterations,
          parked: 'approval_required',
          plan,
          ...(approval === null ? {} : { pendingApprovalId: approval.id }),
        };
      }
    }
  }

  park('iteration_ceiling', `stopped after ${iterations} iterations`);
  log.warn(`run${input.runId === undefined ? '' : ` ${input.runId}`} hit the iteration ceiling`, { ceiling });
  return { completed: false, iterations, parked: 'iteration_ceiling', plan };
}

/**
 * The live facts a ticket is checked against, or `undefined` when the run cannot
 * supply them (S1).
 *
 * Both halves have to come from the run itself: the workspace from the agent (only
 * it knows where the tools point) and the revision from the resolver (only it knows
 * which stack the engine will read). A run that supplies neither gets no ticket
 * checking at all — the honest pre-S1 behaviour — rather than a comparison against
 * a value the run invented.
 */
function ticketContext(input: AgentLoopInput): TicketContext | undefined {
  const binding = input.ticketBinding;
  const revision = input.permissions?.revision;
  if (binding === undefined || revision === undefined) return undefined;
  // Lineage is read from the run row rather than passed in, because that is where
  // the continuation writes it: a caller-supplied "I am a continuation of X" would
  // be a claim, and this is the check (S1).
  const continuedFrom = input.runId === undefined ? null : (getTaskRun(input.runId)?.continuedFrom ?? null);
  return {
    workspace: binding.workspace,
    ...(binding.parentTaskId === undefined ? {} : { parentTaskId: binding.parentTaskId }),
    revision,
    // The lineage rule itself lives beside the column it reads, because the
    // outbound gate asks the same question of a different kind of ticket.
    runAccepts: (ticketRunId) =>
      acceptsTicketRun({ runId: input.runId, continuedFrom, ticketRunId }),
  };
}

/**
 * The live binding for a call: the same fields a ticket stores, read from the
 * context in front of us (S1).
 */
function liveBinding(
  call: ToolCall,
  permissionKey: string,
  identity: { taskId: string | undefined; runId: string | undefined; ticket: TicketContext },
): TicketBinding {
  return {
    toolName: call.name,
    permissionKey,
    arguments: call.arguments,
    workspace: identity.ticket.workspace,
    taskId: identity.taskId ?? '',
    runId: identity.runId ?? null,
    parentTaskId: identity.ticket.parentTaskId ?? null,
    revision: identity.ticket.revision,
  };
}

/**
 * Ask the ticket store about a call the engine wants a decision for.
 *
 * `absent` is the ordinary case — no ticket, so the caller parks exactly as it did
 * before this existed — and it is also what a *different* call under the same tool
 * gets: the store is keyed by the question the user was asked, so a command they
 * never saw is not authorised by one they did.
 *
 * A caller with no ticket context settles nothing. That is the pre-S1 path, kept
 * deliberately: an agent that cannot say where it runs must not have its approvals
 * compared against a workspace it did not name.
 */
function settleAgainstTickets(
  input: ModeGateInput,
  call: ToolCall,
  verdict: PermissionVerdict,
): TicketSettlement {
  const ticket = input.ticket;
  if (ticket === undefined) return { kind: 'absent' };
  return settleTicket({
    live: liveBinding(call, verdict.key, { taskId: input.taskId, runId: input.runId, ticket }),
    runAccepts: ticket.runAccepts,
  });
}

/** The sentence the model reads when an approval no longer covers the call. */
function ticketRefusalSentence(toolName: string, refusal: TicketRefusal, fields: readonly TicketField[]): string {
  const head = `Refused: the approval for \`${toolName}\` does not cover this call. `;
  switch (refusal) {
    case 'not_approved':
      return `${head}It was recorded but never decided, so nothing has been authorised yet.`;
    case 'denied':
      return `${head}The user declined it, and a declined call does not become allowed by being repeated. Only a change to the permission rule alters the answer.`;
    case 'already_consumed':
      return `${head}That approval has already been spent on one execution — a single approval authorises a single call. Ask again with a fresh request.`;
    case 'expired':
      return `${head}The prompt outlived its deadline before this call ran. Ask again; the user will be asked afresh.`;
    case 'run_replaced':
      return `${head}It was approved for a different run, and this one does not continue it. Ask again from this run.`;
    case 'mismatch':
      return `${head}The approved call was \`${fields.length === 0 ? 'not the same call' : fields.join(', ')}\` different${
        fields.length === 0 ? '' : ' from this one'
      }. Ask again with the call you want to run.`;
  }
}

/**
 * Persist the call a run stopped on, and never let that write end the run.
 *
 * Returns `null` when there is nothing durable to hang it off — no `taskId` — or
 * when the write failed. The park still happens either way: a run that stopped for
 * a decision has stopped whether or not the row landed, and reporting a storage
 * failure as a running task would be the worse lie. The absence is logged, because
 * a park with no approval row is exactly what the continuation route has to refuse.
 */
/**
 * Mint the ticket for an approval, when there is anything to bind it to.
 *
 * Only a permission verdict mints one: a doom-loop park is a repetition problem
 * with no `ask` behind it, and a ticket there would authorise a call the user was
 * never asked about. The write is swallowed for the same reason the approval's is
 * — the park has already happened, and a storage failure must not turn a question
 * the user can answer into an exception they cannot.
 */
function mintForApproval(
  input: AgentLoopInput,
  ticket: TicketContext | undefined,
  approvalId: string,
  call: ToolCall,
  verdict: PermissionVerdict | undefined,
): void {
  if (verdict === undefined || verdict.action !== 'ask' || ticket === undefined) return;
  const live = liveBinding(call, verdict.key, { taskId: input.taskId, runId: input.runId, ticket });
  try {
    mintTicket({
      approvalId,
      tool: input.tool,
      binding: live,
      expiresAt: Date.now() + approvalWaitTtlMs(),
    });
  } catch (error) {
    log.warn('could not mint an approval ticket', {
      approvalId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function recordPendingApproval(
  input: AgentLoopInput,
  ticket: TicketContext | undefined,
  call: ToolCall,
  verdict: PermissionVerdict | undefined,
  reason?: string,
): PendingApproval | null {
  if (input.taskId === undefined) {
    log.warn('a run parked for approval with no task id, so nothing was recorded', {
      tool: input.tool,
      toolName: call.name,
    });
    return null;
  }
  try {
    const approval = recordApproval({
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      taskId: input.taskId,
      tool: input.tool,
      toolName: call.name,
      arguments: call.arguments,
      permissionKey: verdict?.key ?? call.name,
      matchedPattern: verdict?.pattern ?? null,
      matchedLayer: verdict?.layer ?? null,
      ...(verdict === undefined
        ? reason === undefined
          ? {}
          : { reason }
        : { reason: describeVerdict(verdict) }),
    });
    mintForApproval(input, ticket, approval.id, call, verdict);
    return approval;
  } catch (error) {
    log.warn('could not record a pending approval', {
      toolName: call.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
