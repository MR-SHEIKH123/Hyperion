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
 * Four things here are load-bearing, and each exists because the obvious
 * alternative fails in a specific way.
 *
 * **The mode gate sits at exactly one place.** `dispatchToolCall` is the only
 * function in this module that invokes anything, and the Ask/Plan/Act decision is
 * made inside it. Checking the mode where the loop *builds* a request instead
 * would leave every future call site free to skip it — and the whole point of a
 * read-only mode is that it cannot be bypassed by a code path nobody remembered
 * to guard.
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
 */

import { updateTaskRunState } from '../../db/taskRuns.ts';
import { nextStepNumber, recordStep } from '../../db/taskSteps.ts';
import { taskIterationCeiling } from '../../db/settings.ts';
import { AppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';

import type { TaskRunTool } from '../../db/taskRuns.ts';
import type { AgentContext, ToolCall } from '../../types/core.ts';

const log = createLogger('agentloop');

/**
 * What the user has authorised for this run.
 *
 * These are the three modes the UI offers, and they are a permission level rather
 * than a personality: the same prompt in `ask` and in `act` produces the same
 * intentions and a different set of permitted actions.
 */
export type AgentMode = 'ask' | 'plan' | 'act';

/** Whether running a tool can change anything outside the process. */
export type ToolEffect = 'read' | 'mutate';

/**
 * Names a tool's effect. Supplied by the agent, because only the agent knows its
 * own tool set.
 *
 * Answering `undefined` is allowed and means "not classified" — never "harmless".
 * See the module comment: this module folds `undefined` into `mutate`.
 */
export interface ToolPolicy {
  effect(toolName: string): ToolEffect | undefined;
}

/** Runs one tool call for real. Provided by the agent. */
export interface ToolRunner {
  (call: ToolCall): Promise<string>;
}

/** A mutating call that Plan mode recorded instead of running. */
export interface PlannedAction {
  toolName: string;
  arguments: string;
  /** Why it was not run, in words the UI can show next to the action. */
  reason: string;
}

/** Why a dispatch attempt did not run the tool. */
export type RefusalReason = 'ask_mode' | 'plan_mode';

export interface DispatchResult {
  ran: boolean;
  /** The tool's own output, or the refusal text fed back to the model. */
  output: string;
  refusedBecause?: RefusalReason;
}

export interface ModeGateInput {
  runId: string;
  mode: AgentMode;
  policy: ToolPolicy;
  run: ToolRunner;
  call: ToolCall;
  /** Collects what Plan mode declined to run. Mutated in place. */
  plan?: PlannedAction[];
}

/**
 * The single dispatch point.
 *
 * A refusal is returned as ordinary tool output rather than thrown. The model is
 * mid-conversation and needs to hear *why* it cannot act so it can answer in
 * prose or propose a plan; an exception would abort the run and lose the turn the
 * user was waiting for. A refusal is a result, not a failure — so `ok` is
 * recorded `true` for the step. It did what it was asked to do.
 */
export async function dispatchToolCall(input: ModeGateInput): Promise<DispatchResult> {
  const { call, mode, policy, runId } = input;
  const effect = policy.effect(call.name) ?? 'mutate';

  if (mode === 'ask') {
    const output =
      `Refused: this run is in Ask mode, which answers questions and runs nothing. ` +
      `Describe what \`${call.name}\` would do, or ask the user to switch to Plan or Act mode.`;
    recordRefusal(runId, mode, call, 'ask_mode');
    return { ran: false, output, refusedBecause: 'ask_mode' };
  }

  if (mode === 'plan' && effect === 'mutate') {
    const reason = `\`${call.name}\` changes things, and this run is in Plan mode.`;
    const output =
      `Refused: ${reason} It has been added to the plan for the user to approve. ` +
      `Continue planning, or finish and present the plan.`;
    input.plan?.push({ toolName: call.name, arguments: call.arguments, reason });
    recordRefusal(runId, mode, call, 'plan_mode');
    return { ran: false, output, refusedBecause: 'plan_mode' };
  }

  const step = nextStepNumber(runId);
  try {
    const output = await input.run(call);
    recordStep({ runId, step, kind: 'tool_call', mode, toolName: call.name, ok: true, detail: output });
    return { ran: true, output };
  } catch (error) {
    // The message is recorded, never the provider's or the shell's raw body: a
    // failing tool commonly echoes the arguments it was given, and those can
    // carry a credential the user pasted into the prompt.
    const message = error instanceof Error ? error.message : 'the tool failed';
    recordStep({ runId, step, kind: 'tool_call', mode, toolName: call.name, ok: false, detail: message });
    throw error;
  }
}

function recordRefusal(runId: string, mode: AgentMode, call: ToolCall, reason: RefusalReason): void {
  recordStep({
    runId,
    step: nextStepNumber(runId),
    kind: mode === 'plan' ? 'plan' : 'note',
    mode,
    toolName: call.name,
    ok: true,
    detail: reason,
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
  /** The same call repeated past the limit. */
  | 'loop_detected'
  /** Plan mode produced a plan and is waiting for approval. */
  | 'plan_ready'
  /** The iteration ceiling ran out. */
  | 'iteration_ceiling';

const PARK_STATE: Record<ParkReason, 'blocked' | 'ready_for_review'> = {
  redaction_blocked: 'blocked',
  loop_detected: 'blocked',
  iteration_ceiling: 'blocked',
  plan_ready: 'ready_for_review',
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
  runId: string,
  reason: ParkReason,
  detail: string,
): void {
  const state = PARK_STATE[reason];
  updateTaskRunState(runId, state);
  recordStep({ runId, step: nextStepNumber(runId), kind: 'note', ok: false, detail: `${reason}: ${detail}` });
  ctx.emit('task_parked', { runId, state, reason, detail });
  ctx.log.warn(`parked run ${runId} as ${state}`, { reason });
}

/**
 * Translate a refused outbound send into a parked run when nobody is watching.
 *
 * `assertOutboundSafe` throws `redaction_flagged` on the assumption that a user
 * is there to look at the finding and decide. An unattended run — a scheduled
 * task, a queued task the user has navigated away from — has nobody to ask, and
 * the two wrong answers are both worse than parking: sending anyway defeats the
 * check, and failing the run as an error tells the user their task broke rather
 * than that it is waiting on them.
 *
 * Re-thrown unchanged when a user *is* present, so the 409 reaches the UI that
 * knows how to acknowledge it.
 */
export function parkOnRedaction(
  ctx: Pick<AgentContext, 'emit' | 'log'>,
  runId: string,
  error: unknown,
  unattended: boolean,
): never {
  if (!unattended || !(error instanceof AppError) || error.code !== 'redaction_flagged') {
    throw error;
  }
  parkRun(ctx, runId, 'redaction_blocked', error.message);
  throw new AppError(
    'redaction_flagged',
    'This task was paused because its next message appeared to contain a credential and no one was ' +
      'watching to approve sending it. Open the task to review and resume it.',
    { retryable: false, details: { runId, unattended: true } },
  );
}

// --- the loop ------------------------------------------------------------

export interface AgentLoopInput {
  runId: string;
  tool: TaskRunTool;
  mode: AgentMode;
  policy: ToolPolicy;
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
  /** Mutating calls Plan mode collected instead of running. */
  plan: PlannedAction[];
}

/**
 * Drive one agent task to a stopping point.
 *
 * Stops for exactly four reasons: the model asked for nothing further, the repeat
 * guard tripped, the iteration ceiling ran out, or Plan mode gathered a plan
 * worth showing. Cancellation is checked at the top of every iteration — a long
 * loop that only checks `signal` around the LLM call keeps running tools after
 * the user has clicked stop.
 */
export async function runAgentLoop(
  input: AgentLoopInput,
  ctx: AgentContext,
): Promise<AgentLoopResult> {
  const ceiling = input.iterationCeiling ?? taskIterationCeiling();
  const guard = new RepeatGuard(input.repeatLimit);
  const plan: PlannedAction[] = [];

  let feedback: ToolFeedback[] = [];
  let iterations = 0;

  while (iterations < ceiling) {
    if (ctx.signal.aborted) throw new AppError('aborted', 'The run was cancelled.');
    iterations += 1;

    let calls: ToolCall[];
    try {
      calls = await input.turn(feedback);
    } catch (error) {
      parkOnRedaction(ctx, input.runId, error, input.unattended === true);
    }

    if (calls.length === 0) {
      if (plan.length > 0) {
        parkRun(ctx, input.runId, 'plan_ready', `${plan.length} action(s) need approval`);
        return { completed: false, iterations, parked: 'plan_ready', plan };
      }
      return { completed: true, iterations, plan };
    }

    feedback = [];
    for (const call of calls) {
      if (guard.exceeded(call)) {
        parkRun(
          ctx,
          input.runId,
          'loop_detected',
          `\`${call.name}\` was called ${guard.count(call)} times with identical arguments`,
        );
        return { completed: false, iterations, parked: 'loop_detected', plan };
      }

      const result = await dispatchToolCall({
        runId: input.runId,
        mode: input.mode,
        policy: input.policy,
        run: input.run,
        call,
        plan,
      });
      feedback.push({ call, output: result.output, ran: result.ran });
    }
  }

  parkRun(ctx, input.runId, 'iteration_ceiling', `stopped after ${iterations} iterations`);
  log.warn(`run ${input.runId} hit the iteration ceiling`, { ceiling });
  return { completed: false, iterations, parked: 'iteration_ceiling', plan };
}
