/**
 * The live-eval harness's own logic — everything except live execution.
 *
 * The brief's line: config validation, the refusal to start, budget aborts,
 * metric aggregation and report writing are unit-tested here and *do* run in
 * `npm test`, so the harness cannot silently rot; only the part that spends
 * real tokens is excluded, and even that runs against the mock provider in
 * this file rather than against a network.
 *
 * The two mutation-checked assertions (they must fail if the logic is
 * gutted): the refusal list and the whole-eval token abort.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import type { EvalConfig } from '../src/eval/config.ts';
import type { RunRecord, SuiteResult } from '../src/eval/runner.ts';
import type { EvalScenario } from '../src/eval/scenarios.ts';

const { cleanupHome, freshDb, startMockProvider, testHome } = await import('./helpers.ts');
const configModule = await import('../src/eval/config.ts');
const metricsModule = await import('../src/eval/metrics.ts');
const outcomeModule = await import('../src/eval/outcome.ts');
const reportModule = await import('../src/eval/report.ts');
const runnerModule = await import('../src/eval/runner.ts');
const scenariosModule = await import('../src/eval/scenarios.ts');

const {
  DEFAULT_RUN_TIMEOUT_MS,
  EVAL_ENV,
  parseEvalArgv,
  refusalReasons,
  resolveEvalConfig,
} = configModule;
const { aggregateScenario, buildObservations, median, summarize } = metricsModule;
const { outcomeOf } = outcomeModule;
const { renderCompare, renderMarkdown, sanitizeForDisk, writeResults, writeTranscripts } =
  reportModule;
const { buildPlan, buildResults, runSuite } = runnerModule;
const { EVAL_SCENARIOS, CODE_SEED_CONTENT, CODE_SEED_PATH } = scenariosModule;

/** A scenario-shaped stub for suite/report tests that never execute it. */
function stubScenario(id: string): EvalScenario {
  return {
    id: id as EvalScenario['id'],
    tool: 'code',
    prompt: 'p',
    setup: async () => ({ projectDir: testHome }),
    check: () => ({ pass: true, detail: '' }),
  };
}

const FULL_ENV: Record<string, string | undefined> = {
  [EVAL_ENV.live]: '1',
  [EVAL_ENV.baseUrl]: 'http://127.0.0.1:9',
  [EVAL_ENV.model]: 'test-model',
};

function baseConfig(overrides: Partial<EvalConfig> = {}): EvalConfig {
  return {
    profile: {
      name: 'test',
      baseUrl: 'http://127.0.0.1:9',
      model: 'test-model',
      apiKey: null,
      type: 'local',
    },
    repeats: 1,
    confirm: true,
    keep: false,
    includeTranscripts: false,
    runTimeoutMs: 60_000,
    totalTokenCeiling: null,
    totalUsdCeiling: null,
    resultsRoot: path.join(testHome, 'eval-results-test'),
    ...overrides,
  };
}

beforeEach(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

// --- refusal to start -------------------------------------------------------

describe('the refusal to start', () => {
  it('lists every missing requirement at once, not first-failure-wins', () => {
    const reasons = refusalReasons({}, parseEvalArgv([]));
    assert.equal(reasons.length, 4);
    assert.ok(reasons.some((reason) => reason.includes(EVAL_ENV.live)));
    assert.ok(reasons.some((reason) => reason.includes(EVAL_ENV.baseUrl)));
    assert.ok(reasons.some((reason) => reason.includes(EVAL_ENV.model)));
    assert.ok(reasons.some((reason) => reason.includes('--confirm')));
  });

  it('refuses without the opt-in, the endpoint, the model, or --confirm', () => {
    assert.ok(refusalReasons(FULL_ENV, parseEvalArgv(['--confirm'])).length === 0);
    assert.equal(refusalReasons(FULL_ENV, parseEvalArgv([])).length, 1);
    assert.equal(
      refusalReasons({ ...FULL_ENV, [EVAL_ENV.live]: undefined }, parseEvalArgv(['--confirm']))
        .length,
      1,
    );
    assert.equal(
      refusalReasons({ ...FULL_ENV, [EVAL_ENV.baseUrl]: undefined }, parseEvalArgv(['--confirm']))
        .length,
      1,
    );
    assert.equal(
      refusalReasons({ ...FULL_ENV, [EVAL_ENV.model]: '  ' }, parseEvalArgv(['--confirm']))
        .length,
      1,
    );
  });

  it('gates only runs: a plan and a comparison never spend', () => {
    assert.deepEqual(refusalReasons({}, parseEvalArgv(['--plan'])), []);
    assert.deepEqual(refusalReasons({}, parseEvalArgv(['compare', 'a', 'b'])), []);
    // A plan still needs the profile it describes.
    const plan = resolveEvalConfig({}, parseEvalArgv(['--plan'])).refusal;
    assert.equal(plan.length, 2);
  });

  it('main() returns 2 on refusal and never prepares a world', async () => {
    const { main } = await import('../src/eval/cli.ts');
    const code = await main(['--confirm'], {});
    assert.equal(code, 2);
  });

  it('parseEvalArgv rejects unknown flags and bad repeats', () => {
    assert.throws(() => parseEvalArgv(['--frobnicate']), /Unknown flag/);
    assert.throws(() => parseEvalArgv(['--repeats', '0']), /positive integer/);
    assert.throws(() => parseEvalArgv(['--repeats']), /positive integer/);
    assert.throws(() => parseEvalArgv(['--compare', 'only-one']), /two result directories/);
    assert.equal(parseEvalArgv(['--repeats', '5']).repeats, 5);
    assert.equal(parseEvalArgv(['--plan', '--confirm']).mode, 'plan');
    assert.equal(parseEvalArgv(['compare', 'a', 'b']).mode, 'compare');
  });
});

// --- plan -------------------------------------------------------------------

describe('--plan', () => {
  it('prints what would run and the worst-case ceiling, derived not invented', async () => {
    await runnerModule.prepareEvalWorld(testHome);
    const resolved = resolveEvalConfig(FULL_ENV, parseEvalArgv(['--confirm', '--repeats', '2']));
    assert.equal(resolved.refusal.length, 0);
    assert.equal(resolved.config.runTimeoutMs, DEFAULT_RUN_TIMEOUT_MS);
    const plan = buildPlan(resolved.config, EVAL_SCENARIOS);
    assert.equal(plan.runs, EVAL_SCENARIOS.length * 2);
    assert.equal(plan.perRun.wallClockMs, DEFAULT_RUN_TIMEOUT_MS);
    // Worst case = the existing task budget × planned runs.
    assert.equal(plan.total.tokenCeiling, plan.perRun.tokenCeiling * plan.runs);
    // An env ceiling tightens it rather than being replaced by the derivation.
    const tightened = buildPlan(baseConfig({ totalTokenCeiling: 42 }), EVAL_SCENARIOS);
    assert.equal(tightened.total.tokenCeiling, 42);
  });
});

// --- budget aborts ----------------------------------------------------------

function fakeRecord(
  scenario: string,
  repeat: number,
  tokensIn: number,
  tokensOut: number,
): RunRecord {
  return {
    scenario,
    repeat,
    taskId: `eval-${scenario}-${repeat}`,
    runId: `run-${scenario}-${repeat}`,
    outcome: 'complete',
    pass: true,
    structuralDetail: 'fake',
    metrics: {
      steps: 1,
      turns: 1,
      toolCalls: {},
      failedToolCalls: 0,
      permissionRefusals: 0,
      malformedToolCalls: 0,
      repairedToolCalls: 0,
      repeatGuardTriggers: 0,
      doomLoopTriggers: 0,
      compactions: 0,
      approvalEvents: 0,
      tokens: { in: tokensIn, out: tokensOut, cached: 0, reasoning: 0 },
      ttftMs: 1,
      totalMs: 1,
      costUsd: null,
      priced: false,
      unpricedRequests: 0,
      knowledgeSources: 0,
    },
  };
}

describe('whole-eval budget aborts', () => {
  const fakeScenarios = ['alpha', 'beta', 'gamma'].map((id) => ({
    id: id as 'code-edit',
    tool: 'code' as const,
    prompt: 'p',
    setup: async () => ({ projectDir: testHome }),
    check: () => ({ pass: true, detail: '' }),
  }));

  it('stops starting runs once the token ceiling is hit and says so', async () => {
    let executed = 0;
    const suite = await runSuite(
      baseConfig({ repeats: 1, totalTokenCeiling: 100 }),
      fakeScenarios,
      {
        executeRun: async (job) => {
          executed += 1;
          return fakeRecord(job.scenario.id, job.repeat, 60, 60);
        },
      },
    );
    // 120 tokens spent on the first run: the ceiling is already past.
    assert.equal(executed, 1, 'runs after the ceiling must never start');
    assert.equal(suite.runs.length, 1);
    assert.match(String(suite.aborted), /token ceiling 100 reached/);
    assert.equal(suite.skipped.length, 2);
    const results = buildResults(baseConfig({ totalTokenCeiling: 100 }), suite, fakeScenarios);
    assert.match(String(results.totals.aborted), /token ceiling 100/);
    assert.ok(
      results.observations.some((observation) => observation.includes('aborted early')),
      'the report must say the eval aborted',
    );
  });

  it('aborts on the dollar ceiling only when one was configured', async () => {
    let executed = 0;
    const withDollar = await runSuite(
      baseConfig({ totalUsdCeiling: 0.01 }),
      fakeScenarios,
      {
        executeRun: async (job) => {
          executed += 1;
          const record = fakeRecord(job.scenario.id, job.repeat, 1, 1);
          record.metrics.costUsd = 0.02;
          record.metrics.priced = true;
          return record;
        },
      },
    );
    assert.equal(executed, 1);
    assert.match(String(withDollar.aborted), /dollar ceiling/);

    // No ceiling configured: runs continue, cost is only reported.
    let withoutCeiling = 0;
    const open = await runSuite(baseConfig(), fakeScenarios, {
      executeRun: async (job) => {
        withoutCeiling += 1;
        const record = fakeRecord(job.scenario.id, job.repeat, 1, 1);
        record.metrics.costUsd = 9.99;
        record.metrics.priced = true;
        return record;
      },
    });
    assert.equal(withoutCeiling, 3);
    assert.equal(open.aborted, null);
  });
});

// --- aggregation ------------------------------------------------------------

describe('metric aggregation', () => {
  it('medians: middle value, mean of the two middles, empty is zero', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), 0);
    assert.deepEqual(summarize([]), { n: 0, median: 0, min: 0, max: 0 });
  });

  it('pass rate, outcome histogram, and an unpriced group stays unpriced', () => {
    const runs = [
      { outcome: 'complete' as const, pass: true, metrics: fakeRecord('x', 1, 10, 5).metrics },
      { outcome: 'blocked' as const, pass: false, metrics: fakeRecord('x', 2, 20, 5).metrics },
      { outcome: 'complete' as const, pass: false, metrics: fakeRecord('x', 3, 30, 5).metrics },
    ];
    const aggregate = aggregateScenario('x', runs);
    assert.equal(aggregate.passRate, 1 / 3);
    assert.equal(aggregate.outcomes['complete'], 2);
    assert.equal(aggregate.outcomes['blocked'], 1);
    assert.equal(aggregate.steps.median, 1);
    assert.equal(aggregate.costUsdMedian, null, 'unpriced must not read as $0');
    assert.equal(aggregate.unpricedRuns, 3);
  });

  it('observations name the anomalies with their thresholds in the line', () => {
    const aggregates = [aggregateScenario('s', [
      { outcome: 'blocked' as const, pass: false, metrics: fakeRecord('s', 1, 100, 0).metrics },
    ])];
    const observations = buildObservations({
      aggregates,
      runs: [{ scenario: 's', metrics: fakeRecord('s', 1, 100, 0).metrics, outcome: 'blocked' }],
      totals: {
        tokens: { in: 100, out: 0, cached: 0, reasoning: 0 },
        costUsd: null,
        unpricedRequests: 2,
        aborted: null,
      },
      contextWindowAssumed: true,
    });
    const text = observations.join('\n');
    assert.match(text, /0% cache-hit rate: 0 cached prompt tokens of 100/);
    assert.match(text, /context window was assumed/);
    assert.match(text, /unpriced/);
    assert.match(text, /passed 0 of 1/);
    assert.match(text, /parked on permissions in 1 of 1/);
  });
});

// --- outcomes ---------------------------------------------------------------

describe('outcome mapping', () => {
  it('timeout wins, errors are errors, an approval park is blocked', () => {
    assert.equal(
      outcomeOf({ timedOut: true, state: 'complete', pauseReason: null, error: undefined }),
      'timeout',
    );
    assert.equal(
      outcomeOf({
        timedOut: false,
        state: 'running',
        pauseReason: null,
        error: { code: 'x', message: 'y' },
      }),
      'error',
    );
    // The product parks approval_required as ready_for_review; the brief
    // records a scenario that parked on an approval as blocked.
    assert.equal(
      outcomeOf({
        timedOut: false,
        state: 'ready_for_review',
        pauseReason: 'approval_required',
        error: undefined,
      }),
      'blocked',
    );
    assert.equal(
      outcomeOf({ timedOut: false, state: 'complete', pauseReason: null, error: undefined }),
      'complete',
    );
    assert.equal(
      outcomeOf({
        timedOut: false,
        state: 'ready_for_review',
        pauseReason: 'doom_loop',
        error: undefined,
      }),
      'ready_for_review',
    );
    assert.equal(
      outcomeOf({ timedOut: false, state: null, pauseReason: null, error: undefined }),
      'error',
    );
  });
});

// --- reports ----------------------------------------------------------------

describe('report writing', () => {
  const sampleSuite = (aborted: string | null = null): SuiteResult => ({
    runs: [fakeRecord('alpha', 1, 10, 5)],
    aborted,
    skipped: [],
  });

  it('writes JSON and markdown, keeps keys out, ends on Observations', () => {
    const config = baseConfig({
      profile: {
        name: 'with-key',
        baseUrl: 'http://127.0.0.1:9',
        model: 'm',
        apiKey: 'sk-live-SUPERSECRETVALUE',
        type: 'remote',
      },
    });
    const results = buildResults(config, sampleSuite(), [stubScenario('alpha')]);
    const dir = path.join(testHome, 'report-test');
    const written = writeResults(dir, results);
    const json = fs.readFileSync(written.json, 'utf8');
    assert.ok(!json.includes('SUPERSECRETVALUE'), 'a key must never be written');
    assert.ok(json.includes('"hasApiKey": true'));

    const md = fs.readFileSync(written.md, 'utf8');
    const lastHeading = md.split('\n').filter((line) => line.startsWith('## ')).at(-1);
    assert.equal(lastHeading, '## Observations');
    assert.ok(md.trimEnd().endsWith('None.') || md.includes('- '));
  });

  it('sanitizeForDisk strips prompts and transcripts even when present', () => {
    const config = baseConfig({ includeTranscripts: true });
    const record = fakeRecord('alpha', 1, 1, 1);
    record.prompt = 'secret prompt';
    record.transcript = { requests: ['{}'], events: ['{}'] };
    const results = buildResults(config, { runs: [record], aborted: null, skipped: [] }, [stubScenario('alpha')]);
    const sanitized = sanitizeForDisk(results);
    assert.equal(sanitized.runs[0]?.prompt, undefined);
    assert.equal(sanitized.runs[0]?.transcript, undefined);
  });

  it('transcripts run through redaction', () => {
    const record = fakeRecord('alpha', 1, 1, 1);
    record.prompt = 'my key is sk-live-SUPERSECRETVALUE ok';
    record.transcript = {
      requests: [JSON.stringify({ apiKey: 'sk-live-SUPERSECRETVALUE' })],
      events: [],
    };
    const dir = path.join(testHome, 'transcripts-test');
    const file = writeTranscripts(dir, [record]);
    assert.ok(file !== null);
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(!content.includes('SUPERSECRETVALUE'));
    assert.ok(content.includes('[redacted]'));
  });

  it('compare prints both profiles side by side', () => {
    const left = buildResults(baseConfig(), sampleSuite(), [stubScenario('alpha')]);
    const rightProfile = baseConfig();
    rightProfile.profile = { ...rightProfile.profile, name: 'other' };
    const right = buildResults(rightProfile, sampleSuite('token ceiling 5 reached'), [stubScenario('alpha')]);
    const text = renderCompare(left, right);
    assert.match(text, /test/);
    assert.match(text, /other/);
    assert.match(text, /token ceiling 5 reached/);
  });

  it('markdown reports an unpriced total as unpriced, never as zero', () => {
    const results = buildResults(baseConfig(), sampleSuite(), [stubScenario('alpha')]);
    const md = renderMarkdown(results);
    assert.match(md, /cost: unpriced/);
    assert.doesNotMatch(md, /cost: \$0\.00/);
  });
});

// --- against the mock provider ---------------------------------------------

describe('the suite against the mock provider', () => {
  it('runs the code scenario end to end and records a structural pass', { timeout: 60_000 }, async () => {
    const { prepareEvalWorld, seedProfileProvider, executeRun } = runnerModule;
    await prepareEvalWorld(testHome);

    const mock = await startMockProvider({
      models: ['mock-model'],
      toolCalls: [
        {
          id: 'w1',
          name: 'write',
          arguments: JSON.stringify({
            path: CODE_SEED_PATH,
            content: 'renamed by eval\n',
            expectedSha256: await shaOf(CODE_SEED_CONTENT),
          }),
        },
      ],
      thenBehave: { tokens: ['Renamed.'] },
    });
    try {
      const config = baseConfig({
        profile: {
          name: 'mock',
          // `remote` selects the chat-completions protocol the mock speaks;
          // `local` would speak Ollama's /api/chat (see docs/EVALS.md on
          // picking a profile type).
          baseUrl: mock.baseUrl,
          model: 'mock-model',
          apiKey: null,
          type: 'remote',
        },
        runTimeoutMs: 30_000,
      });
      seedProfileProvider(config);
      const scenario = EVAL_SCENARIOS[0];
      assert.ok(scenario !== undefined);
      const world = await scenario.setup({ taskId: 'eval-code-edit-1' });
      const record = await executeRun({
        scenario,
        repeat: 1,
        taskId: 'eval-code-edit-1',
        modelId: 'mock-model',
        projectDir: world.projectDir,
        config,
      });
      assert.equal(
        record.outcome,
        'complete',
        `metrics=${JSON.stringify(record.metrics)} detail=${record.structuralDetail}`,
      );
      assert.equal(record.pass, true, record.structuralDetail);
      assert.match(record.structuralDetail, /note\.md changed|changedFiles/);
      assert.ok(record.metrics.steps >= 1, 'the write must be a recorded step');
      assert.ok(
        Object.keys(record.metrics.toolCalls).includes('write'),
        `tool calls recorded: ${JSON.stringify(record.metrics.toolCalls)}`,
      );
      assert.equal(record.metrics.ttftMs === null || record.metrics.ttftMs >= 0, true);
    } finally {
      await mock.close();
    }
  });

  it('records a hang as a timeout instead of waiting forever', { timeout: 60_000 }, async () => {
    const { prepareEvalWorld, seedProfileProvider, executeRun } = runnerModule;
    await prepareEvalWorld(testHome);
    const mock = await startMockProvider({ models: ['mock-model'], hang: true });
    try {
      const config = baseConfig({
        profile: {
          name: 'mock-hang',
          baseUrl: mock.baseUrl,
          model: 'mock-model',
          apiKey: null,
          type: 'remote',
        },
        runTimeoutMs: 500,
      });
      seedProfileProvider(config);
      const scenario = EVAL_SCENARIOS[0];
      assert.ok(scenario !== undefined);
      const world = await scenario.setup({ taskId: 'eval-code-edit-timeout' });
      const record = await executeRun({
        scenario,
        repeat: 1,
        taskId: 'eval-code-edit-timeout',
        modelId: 'mock-model',
        projectDir: world.projectDir,
        config,
      });
      assert.equal(record.outcome, 'timeout');
    } finally {
      await mock.close();
    }
  });
});

async function shaOf(content: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
