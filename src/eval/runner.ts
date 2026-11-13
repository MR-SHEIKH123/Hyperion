/**
 * The live-eval runner: throwaway world in, one suite out.
 *
 * Isolation is the first rule. The entry script points `HYPERION_HOME` at a
 * fresh directory before any product module is imported (env.ts fixes paths
 * at import time), this module migrates a database inside it, seeds the
 * provider from the profile, and the caller deletes the whole directory on
 * the way out — `--keep` is the debugging exception. Nothing here reads or
 * writes the user's real home, and nothing here is reachable from `npm test`
 * except through an injected executor.
 *
 * Budget guards live here too: a per-run wall-clock timer (the product has
 * no per-run timeout to reuse), and whole-eval token/dollar ceilings checked
 * between runs — an aborted run never starts, and the report says so.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getDb } from '../db/adapter.ts';
import { finishTaskRun, getTaskRun, startTaskRun } from '../db/taskRuns.ts';
import { SseStream } from '../orchestrator/sse.ts';
import { createAgentContext } from '../orchestrator/agentContext.ts';
import { requireAgent } from '../orchestrator/agents.ts';
import { createProvider, deleteProvider, findProviderByName } from '../providers/repository.ts';
import { findCachedModel, contextWindowOverride } from '../providers/registry.ts';
import { ceilingLimits } from '../services/limits/budget.ts';
import { parseToolArguments } from '../services/agent/toolArguments.ts';
import { redactSecrets } from '../util/redact.ts';

import { aggregateScenario, buildObservations, collectRunMetrics } from './metrics.ts';
import { outcomeOf } from './outcome.ts';
import { EVAL_SCENARIOS, evalTaskId, scenarioInput } from './scenarios.ts';

import type { CapturedEvent, RunMetrics } from './metrics.ts';
import type { EvalConfig, EvalPlan } from './config.ts';
import type { EvalResults } from './report.ts';
import type { Outcome } from './outcome.ts';
import type { EvalScenario, ScenarioWorld } from './scenarios.ts';
import type { AgentContext, StreamChunk, TaskInput, TaskResult } from '../types/core.ts';
import type { SseSink } from '../orchestrator/sse.ts';

export interface RunRecord {
  scenario: string;
  repeat: number;
  taskId: string;
  runId: string;
  outcome: Outcome;
  pass: boolean;
  structuralDetail: string;
  error?: { code: string; message: string };
  metrics: RunMetrics;
  /** Only present with `--include-transcripts`; stripped before results.json. */
  prompt?: string;
  transcript?: { requests: string[]; events: string[] };
}

export interface RunJob {
  scenario: EvalScenario;
  repeat: number;
  taskId: string;
  modelId: string;
  projectDir: string;
  config: EvalConfig;
}

export interface SuiteDeps {
  /** Test seam: the budget-abort tests inject a fake executor. */
  executeRun?: (job: RunJob) => Promise<RunRecord>;
}

/** Open the throwaway database, register the production agent modules. */
export async function prepareEvalWorld(home: string): Promise<void> {
  const { ensureDirectories } = await import('../config/env.ts');
  const { openDatabase, setDb } = await import('../db/adapter.ts');
  const { runMigrations } = await import('../db/migrate.ts');
  ensureDirectories();
  const dbFile = path.join(home, 'eval.db');
  setDb(openDatabase(dbFile));
  runMigrations(getDb());
  const { registerProductionModules } = await import('../services/agent/composition.ts');
  registerProductionModules();
}

/** Seed (or re-seed) the profile's provider as the enabled provider. */
export function seedProfileProvider(config: EvalConfig): void {
  const name = `eval-${config.profile.name}`;
  const existing = findProviderByName(name);
  if (existing !== null) deleteProvider(existing.id);
  createProvider({
    name,
    type: config.profile.type,
    baseUrl: config.profile.baseUrl,
    apiKey: config.profile.apiKey,
    enabled: true,
  });
}

/** What `--plan` prints — computed from the same ceilings the run enforces. */
export function buildPlan(config: EvalConfig, scenarios: readonly EvalScenario[]): EvalPlan {
  const limits = ceilingLimits();
  const runs = scenarios.length * config.repeats;
  return {
    profile: {
      name: config.profile.name,
      baseUrl: config.profile.baseUrl,
      model: config.profile.model,
      hasApiKey: config.profile.apiKey !== null,
      type: config.profile.type,
    },
    repeats: config.repeats,
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      tool: scenario.tool,
      prompt: scenario.prompt,
    })),
    runs,
    perRun: {
      tokenCeiling: limits.tokenCeiling,
      stepCeiling: limits.iterationCeiling,
      wallClockMs: config.runTimeoutMs,
    },
    total: {
      // Derived, never invented: the existing per-task budget times the runs
      // the plan would make. `HYPERION_EVAL_TOTAL_TOKENS` tightens it.
      tokenCeiling: config.totalTokenCeiling ?? limits.tokenCeiling * runs,
      usdCeiling: config.totalUsdCeiling,
    },
  };
}

// --- one run ----------------------------------------------------------------

interface SinkCapture {
  sink: SseSink;
  events: CapturedEvent[];
}

/**
 * An SSE sink that captures frames instead of writing a socket.
 *
 * `headersSent: true` keeps `SseStream` from touching headers it does not
 * own; every `event:` frame the product emits is parsed back out, which is
 * the same stream a browser would have seen.
 */
function createCaptureSink(): SinkCapture {
  const events: CapturedEvent[] = [];
  const sink: SseSink = {
    write(chunk: string): boolean {
      for (const frame of chunk.split('\n\n')) {
        if (frame.trim() === '') continue;
        let name = '';
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event: ')) name = line.slice('event: '.length);
          else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length));
        }
        if (name === '' || dataLines.length === 0) continue;
        try {
          const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
          const channel =
            typeof data['channel'] === 'string' ? (data['channel'] as string) : name;
          events.push({ channel, data });
        } catch {
          // A frame that will not parse is not a run failure; the harness
          // reports what it could read.
        }
      }
      return true;
    },
    end(): void {
      /* nothing to close */
    },
    writableEnded: false,
    headersSent: true,
    setHeader: () => undefined,
    on: () => undefined,
  };
  return { sink, events };
}

interface StreamObservation {
  ttftMs: number | null;
  malformedToolCalls: number;
  requests: string[];
}

/**
 * Wrap `ctx.llm.stream` to watch the two things nothing records: the time of
 * the first chunk, and whether a tool call's arguments parse. The loop's own
 * counters stay the source of truth for steps and spend — this observes the
 * wire, it does not re-count the run.
 */
function observeStreams(ctx: AgentContext, startedAt: number): StreamObservation {
  const observation: StreamObservation = { ttftMs: null, malformedToolCalls: 0, requests: [] };
  const original = ctx.llm.stream.bind(ctx.llm);
  ctx.llm.stream = (request): AsyncGenerator<StreamChunk, void, unknown> => {
    observation.requests.push(
      JSON.stringify({ modelId: request.modelId, messages: request.messages }),
    );
    return (async function* watched(): AsyncGenerator<StreamChunk, void, unknown> {
      for await (const chunk of original(request)) {
        if (observation.ttftMs === null) observation.ttftMs = Date.now() - startedAt;
        if (chunk.type === 'tool_call') {
          try {
            parseToolArguments(chunk.call.arguments);
          } catch {
            observation.malformedToolCalls += 1;
          }
        }
        yield chunk;
      }
    })();
  };
  return observation;
}

/** Mirror the route's tail: settle a row still claiming `running`. */
function settleRunRow(runId: string, failed: boolean): void {
  try {
    if (getTaskRun(runId)?.state !== 'running') return;
    finishTaskRun(runId, failed ? 'error' : 'complete');
  } catch {
    // Bookkeeping must not fail the eval; the outcome mapper reads the row
    // next and reports what is actually there.
  }
}

export async function executeRun(job: RunJob): Promise<RunRecord> {
  const { scenario, repeat, taskId, modelId, projectDir, config } = job;
  const runId = randomUUID();
  startTaskRun({ runId, taskId, tool: scenario.tool });

  const { sink, events } = createCaptureSink();
  const sse = new SseStream(sink);
  const timeout = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeout.abort();
  }, config.runTimeoutMs);
  timer.unref?.();

  const ctx = createAgentContext({
    tool: scenario.tool,
    chatId: `eval-${taskId}`,
    modelId,
    sse,
    taskId,
    runId,
    cancelSignal: timeout.signal,
  });

  const startedAt = Date.now();
  const observation = observeStreams(ctx, startedAt);
  const input: TaskInput = scenarioInput(scenario, taskId, modelId);

  let result: TaskResult;
  const agent = requireAgent(scenario.tool);
  // The abort above is the real timeout; this race is the backstop for a
  // provider that ignores it. Without one, a hung request would hang the eval
  // itself, and the wall-clock ceiling would exist only on paper.
  let stopGrace: (() => void) | undefined;
  const backstop = new Promise<TaskResult>((resolve) => {
    const grace = setTimeout(() => {
      resolve({
        ok: false,
        summary: 'Wall-clock ceiling passed and the run did not settle after abort.',
        error: {
          code: 'eval_timeout',
          message: `not settled ${config.runTimeoutMs} ms + grace after abort`,
        },
      });
    }, config.runTimeoutMs + 5_000);
    grace.unref?.();
    stopGrace = () => clearTimeout(grace);
  });
  try {
    result = await Promise.race([agent.runTask(input, ctx), backstop]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = {
      ok: false,
      summary: 'The run threw before returning a result.',
      error: { code: 'eval_run_failed', message },
    };
  } finally {
    clearTimeout(timer);
    stopGrace?.();
    sse.close();
  }
  const totalMs = Date.now() - startedAt;

  settleRunRow(runId, result.error !== undefined);
  const row = getTaskRun(runId);
  const outcome = outcomeOf({
    timedOut,
    state: row?.state ?? null,
    pauseReason: row?.pauseReason ?? null,
    error: result.error,
  });

  const metrics = collectRunMetrics({
    runId,
    events,
    ttftMs: observation.ttftMs,
    totalMs,
    malformedToolCalls: observation.malformedToolCalls,
    repairedToolCalls: 0, // the repo has no repair path; a future one lands here
  });

  const structural = scenario.check({
    result,
    projectDir,
    knowledgeCited: metrics.knowledgeSources > 0,
  });

  const record: RunRecord = {
    scenario: scenario.id,
    repeat,
    taskId,
    runId,
    outcome,
    pass: structural.pass,
    structuralDetail: structural.detail,
    ...(result.error === undefined ? {} : { error: result.error }),
    metrics,
  };
  if (config.includeTranscripts) {
    record.prompt = scenario.prompt;
    record.transcript = {
      requests: observation.requests.map((request) => redactSecrets(request)),
      events: events.map((event) => redactSecrets(JSON.stringify(event))),
    };
  }
  return record;
}

// --- the suite --------------------------------------------------------------

export interface SuiteResult {
  runs: RunRecord[];
  aborted: string | null;
  /** Scenarios that never started because a ceiling was hit. */
  skipped: { scenario: string; repeat: number }[];
}

/**
 * Run the suite, checking whole-eval ceilings between runs.
 *
 * The token ceiling defaults to the existing per-task budget times the planned
 * runs; a dollar ceiling applies only when one was configured, because a
 * price is a fact about the model, not something this harness may guess.
 */
export async function runSuite(
  config: EvalConfig,
  scenarios: readonly EvalScenario[],
  deps: SuiteDeps = {},
): Promise<SuiteResult> {
  const execute = deps.executeRun ?? executeRun;
  const plan = buildPlan(config, scenarios);
  const totalTokenCeiling = plan.total.tokenCeiling;
  const runs: RunRecord[] = [];
  const skipped: { scenario: string; repeat: number }[] = [];
  let aborted: string | null = null;
  let tokensSpent = 0;
  let usdSpent = 0;

  const worlds = new Map<string, ScenarioWorld>();

  for (const scenario of scenarios) {
    for (let repeat = 1; repeat <= config.repeats; repeat += 1) {
      if (aborted !== null) {
        skipped.push({ scenario: scenario.id, repeat });
        continue;
      }
      if (tokensSpent >= totalTokenCeiling) {
        aborted = `token ceiling ${totalTokenCeiling} reached after ${runs.length} run(s)`;
        skipped.push({ scenario: scenario.id, repeat });
        continue;
      }
      if (config.totalUsdCeiling !== null && usdSpent >= config.totalUsdCeiling) {
        aborted = `dollar ceiling ${config.totalUsdCeiling} reached after ${runs.length} run(s)`;
        skipped.push({ scenario: scenario.id, repeat });
        continue;
      }

      if (!worlds.has(scenario.id)) {
        worlds.set(scenario.id, await scenario.setup({ taskId: evalTaskId(scenario.id, repeat) }));
      }
      const world = worlds.get(scenario.id) as ScenarioWorld;
      const taskId = evalTaskId(scenario.id, repeat);
      const record = await execute({
        scenario,
        repeat,
        taskId,
        modelId: config.profile.model,
        projectDir: world.projectDir,
        config,
      });
      runs.push(record);
      tokensSpent += record.metrics.tokens.in + record.metrics.tokens.out;
      if (record.metrics.costUsd !== null) usdSpent += record.metrics.costUsd;
    }
  }

  return { runs, aborted, skipped };
}

/** Assemble everything a result set is made of. */
export function buildResults(
  config: EvalConfig,
  suite: SuiteResult,
  scenarios: readonly EvalScenario[] = EVAL_SCENARIOS,
  options: { createdAt?: Date; contextWindowAssumed?: boolean } = {},
): EvalResults {
  const createdAt = options.createdAt ?? new Date();
  const aggregates = scenarios
    .map((scenario) => {
      const runs = suite.runs.filter((run) => run.scenario === scenario.id);
      return aggregateScenario(scenario.id, runs);
    })
    .filter((aggregate) => aggregate.runs > 0);

  const totals = suite.runs.reduce(
    (accumulator, run) => ({
      tokens: {
        in: accumulator.tokens.in + run.metrics.tokens.in,
        out: accumulator.tokens.out + run.metrics.tokens.out,
        cached: accumulator.tokens.cached + run.metrics.tokens.cached,
        reasoning: accumulator.tokens.reasoning + run.metrics.tokens.reasoning,
      },
      costUsd:
        run.metrics.costUsd === null
          ? accumulator.costUsd
          : (accumulator.costUsd ?? 0) + run.metrics.costUsd,
      anyPriced: accumulator.anyPriced || run.metrics.costUsd !== null,
      unpricedRequests: accumulator.unpricedRequests + run.metrics.unpricedRequests,
    }),
    {
      tokens: { in: 0, out: 0, cached: 0, reasoning: 0 },
      costUsd: null as number | null,
      anyPriced: false,
      unpricedRequests: 0,
    },
  );

  const contextWindowAssumed =
    options.contextWindowAssumed ??
    (findCachedModel(config.profile.model) === null &&
      contextWindowOverride() === undefined);

  const observations = buildObservations({
    aggregates,
    runs: suite.runs,
    totals: {
      tokens: totals.tokens,
      costUsd: totals.anyPriced ? totals.costUsd : null,
      unpricedRequests: totals.unpricedRequests,
      aborted: suite.aborted,
    },
    contextWindowAssumed,
  });

  return {
    schema: 1,
    createdAt: createdAt.toISOString(),
    profile: {
      name: config.profile.name,
      baseUrl: config.profile.baseUrl,
      model: config.profile.model,
      type: config.profile.type,
      hasApiKey: config.profile.apiKey !== null,
    },
    options: {
      repeats: config.repeats,
      runTimeoutMs: config.runTimeoutMs,
      totalTokenCeiling: config.totalTokenCeiling,
      totalUsdCeiling: config.totalUsdCeiling,
      includeTranscripts: config.includeTranscripts,
    },
    runs: suite.runs,
    aggregates,
    totals: {
      runs: suite.runs.length,
      tokens: totals.tokens,
      costUsd: totals.anyPriced ? totals.costUsd : null,
      priced: suite.runs.length > 0 && suite.runs.every((run) => run.metrics.priced),
      unpricedRequests: totals.unpricedRequests,
      aborted: suite.aborted,
    },
    observations,
  };
}

/** Remove the throwaway home unless `--keep` asked to preserve it. */
export function cleanupWorld(home: string, keep: boolean): void {
  if (keep) return;
  fs.rmSync(home, { recursive: true, force: true });
}
