/**
 * Cost and runaway safeguards — Part 1.19.
 *
 * Everything in Hyperion that can act unsupervised — scheduled Cowork runs,
 * subagent chains, parallel Code worktrees — could previously run without a
 * ceiling. Nothing looks broken until the first time it costs money, which is
 * exactly why this exists.
 *
 * Three separate limits, three different shapes, and the distinction between
 * them matters:
 *
 *   1. A **daily spend cap** gates the *start* of autonomous work only. It is
 *      checked against the `usage_log` rows that already exist — there is no
 *      new cost-tracking mechanism here, just a question asked of the old one.
 *
 *   2. A **per-task ceiling** (tokens, iterations) is enforced *during* a run
 *      by the agent loop calling `TaskBudget.charge()` / `.step()`. When it
 *      trips, the task stops cleanly and is recorded `stopped` with
 *      `ceiling_reached`, not `error` — nothing broke.
 *
 *   3. A **subagent count limit** caps fan-out within one parent task,
 *      complementing Prompt 3's one-level depth limit.
 *
 * The load-bearing rule, from the spec: **live user-initiated work is never
 * blocked by the spending cap.** The cap protects against unsupervised runaway
 * cost, not against a person deciding to spend more in a session they are
 * watching. So the gate takes an explicit `origin` and there is deliberately no
 * default value — a caller has to say which kind of work it is, because a
 * defaulted-to-`autonomous` gate would eventually block a live chat, and a
 * defaulted-to-`live` one would silently exempt the very tasks the cap exists
 * for.
 */

import { summarizeUsage } from '../../db/usage.ts';
import {
  dailySpendCapUsd,
  subagentCountLimit,
  taskIterationCeiling,
  taskTokenCeiling,
} from '../../db/settings.ts';
import { AppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';

const log = createLogger('limits');

/**
 * Who asked for this work.
 *
 * `live` is a human waiting on a response right now. `autonomous` is anything
 * that started itself: a scheduled task firing, a subagent being spawned.
 */
export type WorkOrigin = 'live' | 'autonomous';

/** Local midnight, matching how `summarizeUsage` buckets `byDay`. */
function startOfLocalDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export interface SpendStatus {
  /** null when no cap is configured. */
  capUsd: number | null;
  /** Priced spend since local midnight. */
  spentUsd: number;
  /** null when there is no cap to remain under. */
  remainingUsd: number | null;
  /** True when an autonomous task would be refused right now. */
  capReached: boolean;
  /**
   * Requests today whose model/provider pair has no price row.
   *
   * Surfaced rather than hidden because it bounds how much the figure above can
   * be trusted: unpriced traffic is real spend this cap cannot see. `usage.ts`
   * refuses to default an unknown price to zero, and this inherits that
   * honesty instead of quietly presenting a partial total as the whole.
   */
  unpricedRequestsToday: number;
  /** When the window resets — the next local midnight. */
  windowResetsAt: number;
}

export function spendStatus(now = Date.now()): SpendStatus {
  const capUsd = dailySpendCapUsd();
  const from = startOfLocalDay(now);
  const summary = summarizeUsage({ from });
  const spentUsd = summary.totals.costUsd;

  return {
    capUsd,
    spentUsd,
    remainingUsd: capUsd === null ? null : Math.max(0, capUsd - spentUsd),
    capReached: capUsd !== null && spentUsd >= capUsd,
    unpricedRequestsToday: summary.totals.unpricedRequests,
    windowResetsAt: from + 24 * 60 * 60 * 1000,
  };
}

/**
 * Refuse an autonomous start when today's spend has reached the cap.
 *
 * Live work returns immediately without even reading the usage table — the
 * exemption is structural, not a branch inside the check, so no future edit to
 * the cap logic can accidentally start blocking a chat.
 *
 * The refusal is `spending_cap_reached` (429): a quota that lifts by itself at
 * the next local midnight, which the error names so the caller can say when.
 */
export function assertWithinSpendCap(
  origin: WorkOrigin,
  label: string,
  now = Date.now(),
): void {
  if (origin === 'live') return;

  const status = spendStatus(now);
  if (!status.capReached) return;

  log.warn('refusing autonomous work: daily spend cap reached', {
    label,
    capUsd: status.capUsd,
    spentUsd: status.spentUsd,
  });

  throw new AppError(
    'spending_cap_reached',
    `Today's spending cap of $${status.capUsd?.toFixed(2)} has been reached, so autonomous work is paused until ${new Date(status.windowResetsAt).toLocaleString()}. Work you start yourself is unaffected.`,
    {
      details: {
        label,
        capUsd: status.capUsd,
        spentUsd: Number(status.spentUsd.toFixed(6)),
        windowResetsAt: status.windowResetsAt,
        unpricedRequestsToday: status.unpricedRequestsToday,
      },
      // Retrying the same request tomorrow succeeds, but retrying it *now*
      // cannot, and `retryable` drives immediate re-attempts.
      retryable: false,
    },
  );
}

export interface CeilingSnapshot {
  tokensUsed: number;
  tokenCeiling: number;
  iterations: number;
  iterationCeiling: number;
  subagentsSpawned: number;
  subagentLimit: number;
}

/** Why a budget stopped a task. Rides in `pause_reason` on the run row. */
export type CeilingKind = 'token_budget' | 'iteration_limit' | 'subagent_limit';

export const CEILING_REASON = 'ceiling_reached';

/**
 * A single task's budget.
 *
 * Created once per run and handed to the agent loop, which reports what it
 * consumes. This is deliberately a passive accountant rather than an enforcer
 * that can kill a run: it cannot interrupt work already in flight, and
 * pretending otherwise would be a false promise. `exceeded()` is the question
 * the loop asks between steps, so the stop lands at a boundary where partial
 * results have already been saved — which is what makes the graceful
 * stop-and-preserve behaviour possible at all.
 *
 * Limits are read once at construction. A user raising the ceiling mid-run
 * should not silently un-stop a task that already reported itself stopped, and
 * re-reading per call would make the same run answer the same question two
 * different ways.
 */
export class TaskBudget {
  readonly taskId: string;
  readonly tokenCeiling: number;
  readonly iterationCeiling: number;
  readonly subagentLimit: number;

  private tokensUsed = 0;
  private iterations = 0;
  private subagentsSpawned = 0;
  private tripped: CeilingKind | null = null;

  constructor(taskId: string, overrides: Partial<CeilingLimits> = {}) {
    this.taskId = taskId;
    this.tokenCeiling = overrides.tokenCeiling ?? taskTokenCeiling();
    this.iterationCeiling = overrides.iterationCeiling ?? taskIterationCeiling();
    this.subagentLimit = overrides.subagentLimit ?? subagentCountLimit();
  }

  /** Record tokens spent. Returns the ceiling that tripped, or null. */
  charge(tokensIn: number, tokensOut: number): CeilingKind | null {
    this.tokensUsed += Math.max(0, tokensIn) + Math.max(0, tokensOut);
    if (this.tripped === null && this.tokensUsed >= this.tokenCeiling) {
      this.trip('token_budget');
    }
    return this.tripped;
  }

  /** Record one agentic loop iteration. Returns the ceiling that tripped, or null. */
  step(): CeilingKind | null {
    this.iterations += 1;
    if (this.tripped === null && this.iterations > this.iterationCeiling) {
      this.trip('iteration_limit');
    }
    return this.tripped;
  }

  /**
   * Claim a subagent slot.
   *
   * Throws rather than returning a flag, unlike `charge` and `step`: a spawn is
   * a discrete request that can be refused before anything starts, so there is
   * no partial work to preserve and no reason to make the caller check. The
   * count still trips the budget, so a parent that catches this and carries on
   * cannot spawn a sixth subagent by ignoring the fifth refusal.
   */
  claimSubagent(): void {
    if (this.subagentsSpawned >= this.subagentLimit) {
      this.trip('subagent_limit');
      throw new AppError(
        'bad_request',
        `This task has already spawned its limit of ${this.subagentLimit} subagents.`,
        { details: { taskId: this.taskId, subagentLimit: this.subagentLimit } },
      );
    }
    this.subagentsSpawned += 1;
  }

  /** The ceiling that has tripped, or null while the task is within budget. */
  exceeded(): CeilingKind | null {
    return this.tripped;
  }

  snapshot(): CeilingSnapshot {
    return {
      tokensUsed: this.tokensUsed,
      tokenCeiling: this.tokenCeiling,
      iterations: this.iterations,
      iterationCeiling: this.iterationCeiling,
      subagentsSpawned: this.subagentsSpawned,
      subagentLimit: this.subagentLimit,
    };
  }

  private trip(kind: CeilingKind): void {
    this.tripped = kind;
    log.info('task reached a configured ceiling', { taskId: this.taskId, kind, ...this.snapshot() });
  }
}

export interface CeilingLimits {
  tokenCeiling: number;
  iterationCeiling: number;
  subagentLimit: number;
}

/** The configured ceilings, for `GET /api/settings/limits`. */
export function ceilingLimits(): CeilingLimits {
  return {
    tokenCeiling: taskTokenCeiling(),
    iterationCeiling: taskIterationCeiling(),
    subagentLimit: subagentCountLimit(),
  };
}
