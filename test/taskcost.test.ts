/**
 * Per-task cost accounting — Master Plan v4 §6.2.
 *
 * Three separable claims, each of which fails silently on its own:
 *
 *   1. **Spend gets recorded at all.** Before this, only chat runs wrote to
 *      `usage_log`; a Code, Cowork or Design task could spend real money and leave
 *      no trace, so the cost dashboard saw a fraction of the bill and the daily cap
 *      judged autonomous work against a total that omitted it. The seam is
 *      `createAgentContext`, which every task run passes through — so that is what
 *      these tests drive, with the real router against a real mock provider.
 *   2. **Spend is attributed.** `task_id` (migration 017) answers "what did this
 *      task cost"; `run_id` (018) answers "what did this run cost", which is the
 *      unit the activity feed and the task-state route report on. A delegated child
 *      has a task id and no run id, so a task total includes delegated work and a
 *      run total does not — asserted, because it is the kind of thing that is only
 *      ever discovered by being wrong.
 *   3. **Absence is not zero.** A task with nothing recorded reports
 *      `requests: 0` and `costUsd: null`; a task whose spend is unpriced reports
 *      `costUsd: null` with `priced: false`. Neither may render as "$0.00", which is
 *      the rule `usage.ts` has always kept ("unpriced is not free") and the one a
 *      zero in a cost field would quietly break.
 *
 * The mock provider reports 11 prompt / 22 completion tokens per request, so the
 * arithmetic below is that multiplied by the number of requests logged.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach, describe } from 'node:test';

import type { Server } from 'node:http';

import { cleanupHome, freshDb, startMockProvider } from './helpers.ts';

import type { MockProvider } from './helpers.ts';

const { createApp } = await import('../src/http/app.ts');
const { createProvider } = await import('../src/providers/repository.ts');
const { findPrice, setPrice } = await import('../src/db/usage.ts');
const { createAgentContext } = await import('../src/orchestrator/agentContext.ts');
const { recordUsage, taskUsage, usageByRun } = await import('../src/db/usage.ts');
const { createChat } = await import('../src/db/chats.ts');
const { startTaskRun, finishTaskRun, updateTaskRunState } = await import('../src/db/taskRuns.ts');
const { getDb } = await import('../src/db/adapter.ts');

let server: Server;
let base: string;
let mock: MockProvider;
let provider: { id: string };

before(async () => {
  await freshDb();
  mock = await startMockProvider({ models: ['mock-model'], tokens: ['hello'] });
  provider = createProvider({ name: 'Mock', type: 'remote', baseUrl: mock.baseUrl, enabled: true });

  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo from listen(0)');
  }
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mock.close();
  await cleanupHome();
});

beforeEach(() => {
  mock.behave({ models: ['mock-model'], tokens: ['hello'], failStatus: undefined, failFirst: undefined });
});

/** A stream object the context can emit into without a real response. */
function fakeSse(): Parameters<typeof createAgentContext>[0]['sse'] {
  return {
    signal: new AbortController().signal,
    emit: () => {},
    sendError: () => {},
    close: () => {},
  } as unknown as Parameters<typeof createAgentContext>[0]['sse'];
}

interface SeedOptions {
  taskId: string;
  runId?: string;
  chatId?: string;
  tool?: 'code' | 'cowork' | 'design';
  modelId?: string;
}

/** A context built the way a run-task route builds one. */
function contextFor(options: SeedOptions) {
  return createAgentContext({
    tool: options.tool ?? 'code',
    chatId: options.chatId ?? `chat-${options.taskId}`,
    modelId: options.modelId ?? 'mock-model',
    sse: fakeSse(),
    taskId: options.taskId,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
  });
}

/** Make one provider request through the context, consuming the stream. */
async function makeRequest(ctx: ReturnType<typeof createAgentContext>, prompt = 'hi'): Promise<void> {
  for await (const _chunk of ctx.llm.stream({
    modelId: 'mock-model',
    messages: [{ role: 'user', content: prompt }],
  })) {
    // Consuming the stream is what drives the request; the chunks are not the
    // subject of these assertions.
  }
}

function rowsFor(taskId: string): {
  task_id: string | null;
  run_id: string | null;
  tool: string;
  provider_name: string | null;
  provider_type: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  status: string;
  chat_id: string | null;
}[] {
  return getDb()
    .prepare(
      `SELECT task_id, run_id, tool, provider_name, provider_type, tokens_in, tokens_out,
              cost_usd, status, chat_id
         FROM usage_log WHERE task_id = ? ORDER BY id`,
    )
    .all(taskId) as never;
}

describe('a task run records what it spent', () => {
  test('one row per provider request, attributed to the task and the run', async () => {
    // Priced first, so the same case covers "the row exists" and "the row is
    // costed": a row with no cost is indistinguishable from an unpriced model.
    setPrice({ modelId: 'mock-model', providerId: null, inputPer1mUsd: 1, outputPer1mUsd: 2 });

    const ctx = contextFor({ taskId: 'cost-task-1', runId: 'cost-run-1' });
    await makeRequest(ctx);
    await makeRequest(ctx, 'again');

    const rows = rowsFor('cost-task-1');
    assert.equal(rows.length, 2, 'two requests through one context are two rows');
    assert.deepEqual(
      rows.map((row) => [row.task_id, row.run_id]),
      [
        ['cost-task-1', 'cost-run-1'],
        ['cost-task-1', 'cost-run-1'],
      ],
    );
    assert.equal(rows[0]?.tool, 'code');
    assert.equal(rows[0]?.provider_name, 'Mock');
    assert.equal(rows[0]?.provider_type, 'remote');
    assert.equal(rows[0]?.tokens_in, 11);
    assert.equal(rows[0]?.tokens_out, 22);
    // 11 in at $1/1M + 22 out at $2/1M.
    assert.equal(rows[0]?.cost_usd, (11 / 1_000_000) * 1 + (22 / 1_000_000) * 2);
    assert.equal(rows[0]?.status, 'ok');

    const summary = taskUsage('cost-task-1');
    assert.equal(summary.requests, 2);
    assert.equal(summary.runs, 1);
    assert.equal(summary.tokensIn, 22);
    assert.equal(summary.tokensOut, 44);
    assert.equal(summary.priced, true);
    assert.equal(summary.unpricedRequests, 0);
  });

  test('a delegated child adds to the task total without being a run of its own', async () => {
    // A child's context carries the parent's task id and no run id — the loop
    // omits `runId` at depth 1 — so its spend is inside the task's numbers and
    // outside any run's.
    const parent = contextFor({ taskId: 'cost-task-2', runId: 'cost-run-2' });
    await makeRequest(parent);
    const child = contextFor({ taskId: 'cost-task-2', runId: undefined });
    await makeRequest(child, 'delegated');

    const summary = taskUsage('cost-task-2');
    assert.equal(summary.requests, 2, 'the task total includes what it delegated');
    assert.equal(summary.runs, 1, 'only the parent logged under a run id');

    // And the run's own share excludes the child's, which is the distinction the
    // two keys exist for.
    const byRun = usageByRun(['cost-run-2']);
    assert.equal(byRun.get('cost-run-2')?.requests, 1);
    assert.equal(byRun.get('cost-run-2')?.tokensIn, 11);
  });

  test('unpriced spend is recorded with a null cost rather than a zero', () => {
    const taskId = 'cost-task-3';
    recordUsage({
      chatId: null,
      tool: 'cowork',
      modelId: 'no-price-configured',
      providerId: null,
      providerName: 'Mock',
      tokensIn: 100,
      tokensOut: 200,
      taskId,
      runId: 'cost-run-3',
    });

    const summary = taskUsage(taskId);
    assert.equal(summary.requests, 1);
    assert.equal(summary.costUsd, null, 'no price entry means cost is unknown, not free');
    assert.equal(summary.priced, false);
    assert.equal(summary.unpricedRequests, 1);
    // The tokens are still counted: they are facts, whatever the price is.
    assert.equal(summary.tokensIn, 100);
  });

  test('a task with nothing recorded reports nothing, not zero dollars', () => {
    const summary = taskUsage('cost-task-never-ran');

    assert.deepEqual(summary, {
      requests: 0,
      runs: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      priced: false,
      unpricedRequests: 0,
    });
  });

  test('a chat id with no chat behind it keeps the spend instead of losing it', () => {
    // The FK on `usage_log.chat_id` is real, so this insert used to raise and the
    // row was swallowed — spend silently dropped for every caller whose chat id is
    // not guaranteed to exist, which includes the whole agent path. An id that
    // names no row is not a link to anything, so the linkage goes and the money
    // stays on the books.
    const taskId = 'cost-task-4';
    recordUsage({
      chatId: 'chat-that-was-never-created',
      tool: 'code',
      modelId: 'mock-model',
      tokensIn: 5,
      tokensOut: 6,
      taskId,
      runId: 'cost-run-4',
    });

    const rows = rowsFor(taskId);
    assert.equal(rows.length, 1, 'the row must survive a chat id the FK cannot resolve');
    assert.equal(rows[0]?.chat_id, null);

    // And a real chat is still linked, so the fix is not "drop every link".
    const prompt = 'hello';
    const chat = createChat({ title: 'cost', tool: 'chat', modelId: 'mock-model' });
    recordUsage({ chatId: chat.id, tool: 'chat', modelId: 'mock-model', tokensIn: 1, tokensOut: 1 });
    const linked = getDb()
      .prepare<{ chat_id: string | null }>('SELECT chat_id FROM usage_log WHERE tool = ? ORDER BY id DESC LIMIT 1')
      .get('chat');
    assert.equal(linked?.chat_id, chat.id);
  });
});

describe('a global price can be updated rather than shadowed', () => {
  // Found by this suite: `ON CONFLICT(model_id, provider_id)` never fires when
  // `provider_id IS NULL`, because SQLite treats NULLs as distinct. Saving a
  // global price twice inserted a second row, and `findPrice` — which orders by
  // `provider_id IS NULL` and takes one — kept returning the older row, so the
  // user's edit did nothing and the daily spend cap kept using the stale figure.
  test('saving the same global price twice leaves one row, carrying the new value', () => {
    setPrice({ modelId: 'price-upsert-model', providerId: null, inputPer1mUsd: 1, outputPer1mUsd: 1 });
    setPrice({ modelId: 'price-upsert-model', providerId: null, inputPer1mUsd: 9, outputPer1mUsd: 9 });

    const rows = getDb()
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM model_prices WHERE model_id = ? AND provider_id IS NULL')
      .get('price-upsert-model');
    assert.equal(rows?.n, 1, 'a global price is one row per model, whatever the NULL semantics');

    const price = findPrice('price-upsert-model', null);
    assert.equal(price?.inputPer1m, 9, 'the second save must be the price in force');
    assert.equal(price?.outputPer1m, 9);
  });

  test('a provider-specific price is still separate from the global one', () => {
    setPrice({ modelId: 'price-scoped-model', providerId: null, inputPer1mUsd: 1, outputPer1mUsd: 1 });
    // A real provider row: `provider_id` carries a foreign key, so a made-up id
    // would fail the insert rather than exercise the lookup.
    setPrice({ modelId: 'price-scoped-model', providerId: provider.id, inputPer1mUsd: 5, outputPer1mUsd: 5 });

    // The specific row wins for that provider; the global one still answers for
    // every other provider. Collapsing them is the other way this could break.
    assert.equal(findPrice('price-scoped-model', provider.id)?.inputPer1m, 5);
    assert.equal(findPrice('price-scoped-model', 'prov-elsewhere')?.inputPer1m, 1);
  });
});

describe('the task-state route reports the task total', () => {
  test('returns tokens, cost and the honesty flags', async () => {
    setPrice({ modelId: 'mock-model', providerId: null, inputPer1mUsd: 3, outputPer1mUsd: 4 });
    const ctx = contextFor({ taskId: 'cost-task-5', runId: 'cost-run-5' });
    await makeRequest(ctx);

    // A run row has to exist: the route answers with the latest run for the task
    // and refuses a task it has never heard of.
    startTaskRun({ runId: 'cost-run-5', taskId: 'cost-task-5', tool: 'code' });
    finishTaskRun('cost-run-5', 'complete');

    const response = await fetch(`${base}/api/code/tasks/cost-task-5/state`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      run: { runId: string };
      usage: Record<string, unknown>;
    };
    assert.equal(body.run.runId, 'cost-run-5');
    assert.equal(body.usage.requests, 1);
    assert.equal(body.usage.tokensIn, 11);
    assert.equal(body.usage.tokensOut, 22);
    assert.equal(body.usage.costUsd, (11 / 1_000_000) * 3 + (22 / 1_000_000) * 4);
    assert.equal(body.usage.priced, true);
  });

  test('a task with no recorded spend says so rather than costing $0.00', async () => {
    startTaskRun({ runId: 'cost-run-6', taskId: 'cost-task-6', tool: 'code' });
    finishTaskRun('cost-run-6', 'complete');

    const body = (await (await fetch(`${base}/api/code/tasks/cost-task-6/state`)).json()) as {
      usage: { requests: number; costUsd: number | null; priced: boolean };
    };
    assert.equal(body.usage.requests, 0);
    assert.equal(body.usage.costUsd, null);
    assert.equal(body.usage.priced, false);
  });
});

describe('the activity feed carries each run’s own spend', () => {
  test('an entry with logged requests reports them, and one without reports null', async () => {
    setPrice({ modelId: 'mock-model', providerId: null, inputPer1mUsd: 1, outputPer1mUsd: 1 });
    const ctx = contextFor({ taskId: 'cost-task-7', runId: 'cost-run-7' });
    await makeRequest(ctx);

    startTaskRun({ runId: 'cost-run-7', taskId: 'cost-task-7', tool: 'code' });
    finishTaskRun('cost-run-7', 'complete');
    // A second run of the same shape that never reached a provider.
    startTaskRun({ runId: 'cost-run-8', taskId: 'cost-task-8', tool: 'cowork' });
    updateTaskRunState('cost-run-8', 'paused');

    const feed = (await (await fetch(`${base}/api/activity`)).json()) as {
      entries: { id: string; spend: { requests: number; costUsd: number | null } | null }[];
    };

    const spent = feed.entries.find((entry) => entry.id === 'task:cost-run-7');
    assert.ok(spent, 'the run with spend is on the feed');
    assert.equal(spent.spend?.requests, 1);
    assert.equal(spent.spend?.costUsd, (11 / 1_000_000) * 1 + (22 / 1_000_000) * 1);

    const silent = feed.entries.find((entry) => entry.id === 'task:cost-run-8');
    assert.ok(silent, 'the run with no logged requests is still on the feed');
    assert.equal(silent.spend, null, 'nothing recorded is not the same as nothing spent');
  });
});
