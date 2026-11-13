/**
 * What a run spent, did and produced — read from the records the loop
 * already keeps. No parallel counters: steps come from `task_steps`, spend
 * from `usage_log`, knowledge from `run_knowledge_sources`, parks from the
 * run row and the captured event stream. The only things measured here are
 * the ones nothing records yet (wall clock, time-to-first-token), and those
 * wrap the run rather than edit it.
 */
import { getDb } from '../db/adapter.ts';
import { listRunKnowledge } from '../db/runKnowledge.ts';

import type { Outcome } from './outcome.ts';

export interface TokenTotals {
  in: number;
  out: number;
  cached: number;
  reasoning: number;
}

export interface RunMetrics {
  steps: number;
  turns: number;
  /** Tool calls by name, successful and refused alike. */
  toolCalls: Record<string, number>;
  /** `tool_call` steps that threw — a failing tool, not a refusal. */
  failedToolCalls: number;
  /** Gate refusals: the loop's own refusal reasons, from the step detail. */
  permissionRefusals: number;
  /** Tool-call arguments that were not a JSON object when parsed. */
  malformedToolCalls: number;
  /** The repo has no repair path; recorded so a future one shows up here. */
  repairedToolCalls: number;
  /** `task_parked` events carrying the repeat-guard / doom-loop reasons. */
  repeatGuardTriggers: number;
  doomLoopTriggers: number;
  compactions: number;
  approvalEvents: number;
  tokens: TokenTotals;
  ttftMs: number | null;
  totalMs: number;
  /** `null` while any request in the run was unpriced — never rendered as 0. */
  costUsd: number | null;
  priced: boolean;
  unpricedRequests: number;
  knowledgeSources: number;
}

const REFUSAL_REASONS = [
  'approval_required',
  'permission_denied',
  'ask_mode',
  'plan_mode',
  'approval_invalid',
] as const;

interface StepCountRow {
  kind: string;
  count: number;
  tool_name: string | null;
  ok: number | null;
  detail: string | null;
}

/** Read one run's story out of the tables the product already writes. */
export function collectRunMetrics(input: {
  runId: string;
  events: readonly CapturedEvent[];
  ttftMs: number | null;
  totalMs: number;
  malformedToolCalls: number;
  repairedToolCalls: number;
}): RunMetrics {
  const db = getDb();
  const { runId } = input;

  const steps = db
    .prepare<{ count: number }>('SELECT COUNT(*) AS count FROM task_steps WHERE run_id = ?')
    .get(runId);

  const byKind = db
    .prepare<StepCountRow>(
      `SELECT kind, COUNT(*) AS count, tool_name, ok, detail
         FROM task_steps WHERE run_id = ?
        GROUP BY kind, tool_name, ok, detail`,
    )
    .all(runId);

  let turns = 0;
  let compactions = 0;
  const toolCalls: Record<string, number> = {};
  let failedToolCalls = 0;
  let permissionRefusals = 0;
  for (const row of byKind) {
    const count = Number(row.count);
    if (row.kind === 'turn') turns += count;
    if (row.kind === 'compression') compactions += count;
    if (row.kind === 'tool_call' && row.tool_name !== null) {
      toolCalls[row.tool_name] = (toolCalls[row.tool_name] ?? 0) + count;
      if (row.ok === 0) failedToolCalls += count;
    }
    if (row.detail !== null && (REFUSAL_REASONS as readonly string[]).includes(row.detail)) {
      permissionRefusals += count;
    }
  }

  // A parked approval parks the whole run; count the events as observed.
  const approvalEvents = input.events.filter(
    (event) => event.channel === 'approval_required',
  ).length;
  const parkedReasons = input.events
    .filter((event) => event.channel === 'task_parked')
    .map((event) => String((event.data as { reason?: unknown }).reason ?? ''));
  const repeatGuardTriggers = parkedReasons.filter((reason) => reason === 'loop_detected').length;
  const doomLoopTriggers = parkedReasons.filter((reason) => reason === 'doom_loop').length;

  const usage = db
    .prepare<{
      tokens_in: number | null;
      tokens_out: number | null;
      cache_read: number | null;
      reasoning: number | null;
      cost: number | null;
      requests: number;
      unpriced: number;
    }>(
      `SELECT
         SUM(tokens_in) AS tokens_in,
         SUM(tokens_out) AS tokens_out,
         SUM(cache_read_tokens) AS cache_read,
         SUM(reasoning_tokens) AS reasoning,
         SUM(cost_usd) AS cost,
         COUNT(*) AS requests,
         SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
       FROM usage_log
       WHERE run_id = ? AND status IN ('ok', 'partial')`,
    )
    .get(runId);

  const requests = Number(usage?.requests ?? 0);
  const unpricedRequests = Number(usage?.unpriced ?? 0);
  // Priced sum over priced rows only: `SUM(cost_usd)` already ignores NULLs,
  // so a partially priced run reports the priced part plus the unpriced count.
  const costUsd = requests === 0 || unpricedRequests === requests || usage?.cost == null
    ? null
    : Number(usage.cost);

  const knowledge = listRunKnowledge(runId).length;

  return {
    steps: Number(steps?.count ?? 0),
    turns,
    toolCalls,
    failedToolCalls,
    permissionRefusals,
    malformedToolCalls: input.malformedToolCalls,
    repairedToolCalls: input.repairedToolCalls,
    repeatGuardTriggers,
    doomLoopTriggers,
    compactions,
    approvalEvents,
    tokens: {
      in: Number(usage?.tokens_in ?? 0),
      out: Number(usage?.tokens_out ?? 0),
      cached: Number(usage?.cache_read ?? 0),
      reasoning: Number(usage?.reasoning ?? 0),
    },
    ttftMs: input.ttftMs,
    totalMs: input.totalMs,
    costUsd,
    priced: requests > 0 && unpricedRequests === 0,
    unpricedRequests,
    knowledgeSources: knowledge,
  };
}

/** One captured `event:` frame from the harness's SSE sink. */
export interface CapturedEvent {
  channel: string;
  data: Record<string, unknown>;
}

// --- aggregation -----------------------------------------------------------

export interface NumericSummary {
  n: number;
  median: number;
  min: number;
  max: number;
}

/** Standard median: middle value, or the mean of the two middles. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function summarize(values: readonly number[]): NumericSummary {
  if (values.length === 0) return { n: 0, median: 0, min: 0, max: 0 };
  return {
    n: values.length,
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

export interface ScenarioAggregate {
  scenario: string;
  runs: number;
  passes: number;
  passRate: number;
  outcomes: Record<string, number>;
  steps: NumericSummary;
  tokensIn: NumericSummary;
  tokensOut: NumericSummary;
  totalMs: NumericSummary;
  ttftMs: NumericSummary;
  /** `null` when no run in the group was priced. */
  costUsdMedian: number | null;
  unpricedRuns: number;
}

export function aggregateScenario(
  scenario: string,
  runs: readonly {
    outcome: Outcome;
    pass: boolean;
    metrics: RunMetrics;
  }[],
): ScenarioAggregate {
  const priced = runs.filter((run) => run.metrics.costUsd !== null);
  const outcomes: Record<string, number> = {};
  for (const run of runs) {
    outcomes[run.outcome] = (outcomes[run.outcome] ?? 0) + 1;
  }
  const passes = runs.filter((run) => run.pass).length;
  return {
    scenario,
    runs: runs.length,
    passes,
    passRate: runs.length === 0 ? 0 : passes / runs.length,
    outcomes,
    steps: summarize(runs.map((run) => run.metrics.steps)),
    tokensIn: summarize(runs.map((run) => run.metrics.tokens.in)),
    tokensOut: summarize(runs.map((run) => run.metrics.tokens.out)),
    totalMs: summarize(runs.map((run) => run.metrics.totalMs)),
    ttftMs: summarize(
      runs
        .map((run) => run.metrics.ttftMs)
        .filter((value): value is number => typeof value === 'number'),
    ),
    costUsdMedian: priced.length === 0 ? null : median(priced.map((run) => run.metrics.costUsd as number)),
    unpricedRuns: runs.filter((run) => !run.metrics.priced).length,
  };
}

// --- observations ----------------------------------------------------------

export interface ObservationInput {
  aggregates: readonly ScenarioAggregate[];
  runs: readonly { scenario: string; metrics: RunMetrics; outcome: Outcome }[];
  totals: { tokens: TokenTotals; costUsd: number | null; unpricedRequests: number; aborted: string | null };
  contextWindowAssumed: boolean;
}

/**
 * Anomalies worth a human's attention — reported, never asserted.
 *
 * Every line is a measurement with a threshold stated in the line itself, so
 * a reader can disagree with the threshold without doubting the number.
 */
export function buildObservations(input: ObservationInput): string[] {
  const observations: string[] = [];

  const malformedTotal = input.runs.reduce((sum, run) => sum + run.metrics.malformedToolCalls, 0);
  if (malformedTotal > 0) {
    observations.push(
      `${malformedTotal} malformed tool-call argument set(s) across ${input.runs.length} run(s) — the model emitted JSON that was not an object.`,
    );
  }

  if (input.contextWindowAssumed) {
    observations.push(
      'The context window was assumed (provider fallback), not reported by the model or the provider cache — any compaction threshold was applied to a guessed window.',
    );
  }

  const tokenInTotal = input.totals.tokens.in;
  const cachedTotal = input.totals.tokens.cached;
  if (tokenInTotal > 0 && cachedTotal === 0) {
    observations.push(
      `0% cache-hit rate: ${cachedTotal} cached prompt tokens of ${tokenInTotal} prompt tokens — the provider reported no cache reads at all.`,
    );
  }

  if (input.totals.unpricedRequests > 0) {
    observations.push(
      `${input.totals.unpricedRequests} request(s) were unpriced; cost is reported as unpriced, never as zero.`,
    );
  }

  for (const aggregate of input.aggregates) {
    if (aggregate.runs > 0 && aggregate.passRate === 0) {
      observations.push(`Scenario "${aggregate.scenario}" passed 0 of ${aggregate.runs} run(s).`);
    }
    const blocked = aggregate.outcomes['blocked'] ?? 0;
    if (blocked > 0) {
      observations.push(
        `Scenario "${aggregate.scenario}" parked on permissions in ${blocked} of ${aggregate.runs} run(s) — never auto-approved; how often the agent hits ask is a result.`,
      );
    }
    const timeout = aggregate.outcomes['timeout'] ?? 0;
    if (timeout > 0) {
      observations.push(
        `Scenario "${aggregate.scenario}" hit the wall-clock timeout in ${timeout} of ${aggregate.runs} run(s).`,
      );
    }
  }

  const refusals = input.runs.reduce((sum, run) => sum + run.metrics.permissionRefusals, 0);
  if (refusals > 0) {
    observations.push(`${refusals} permission refusal(s) were recorded across the suite.`);
  }

  if (input.totals.aborted !== null) {
    observations.push(`The eval aborted early: ${input.totals.aborted}`);
  }

  return observations;
}
