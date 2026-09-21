/**
 * Cache and reasoning accounting (the `cacheHitRate` half of 1.28).
 *
 * `usage_log` has carried `cache_read_tokens`, `cache_write_tokens` and
 * `reasoning_tokens` since migration `017`, and until now nothing wrote or read
 * them: the columns existed, the numbers did not. This file pins the three
 * decisions that make the numbers mean something.
 *
 *   1. **Said nothing is not zero.** A provider that does not report cache
 *      accounting leaves the columns NULL, and the rollup answers `null` — never
 *      `0` — because "0% cached" and "nobody measured" are different facts and
 *      only one of them is a measurement.
 *   2. **`cacheReadTokens` is not folded into `tokensIn`.** On gateways where
 *      `prompt_tokens` includes the cached part, adding it would double-count the
 *      prompt and inflate the priced input. The rate is derived from the parts
 *      instead, so its error is one-directional and the code says which way.
 *   3. **The adapter reads what each provider actually sends.** The
 *      OpenAI-compatible `prompt_tokens_details.cached_tokens` /
 *      `completion_tokens_details.reasoning_tokens`, and the Anthropic-shaped
 *      `cache_read_input_tokens` / `cache_creation_input_tokens` that the
 *      Responses adapter receives. A gateway that sends nothing gets nothing
 *      written, not a zero.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

const { recordUsage, summarizeUsage } = await import('../src/db/usage.ts');
const openDatabaseModule = await import('../src/db/adapter.ts');
const { openAiAdapter, openCodexAdapter } = await import('../src/providers/adapters.ts');

before(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

/**
 * The raw row, read through the harness's own live handle.
 *
 * Reading it raw rather than through a public reader is the point: the question
 * is what actually landed in the column, and every reader in the codebase folds
 * absent into a number the moment it aggregates.
 */
function rawRow(): {
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
} {
  const { getDb } = openDatabaseModule;
  const row = getDb()
    .prepare(
      `SELECT tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, reasoning_tokens
         FROM usage_log ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get() as never;
  return row as never;
}

/** A fake provider stream, so the adapters are driven the way a real one drives them. */
function streamOf(chunks: string[]): Response {
  return new Response(chunks.join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}

type AnyAdapter = typeof import('../src/providers/adapters.ts')['openAiAdapter'];

async function collect(adapter: AnyAdapter, request: Record<string, unknown>): Promise<Record<string, number>> {
  const usage: Record<string, number> = {};
  for await (const chunk of adapter.stream(provider, request as never)) {
    if (chunk.type === 'usage') Object.assign(usage, chunk.usage);
  }
  return usage;
}

/**
 * The provider shape the adapters actually read.
 *
 * `zdr` is spelled out because the adapter asks it for the request flag —
 * `Pick<ProviderRecord, 'type' | 'zdr' | 'baseUrl'>` — and a `as never` cast hid
 * that until this file ran.
 */
const provider = {
  id: 'p1',
  name: 'Test Provider',
  type: 'remote',
  baseUrl: 'https://api.example.test/v1',
  apiKeyEnc: null,
  apiKeyHint: null,
  enabled: true,
  priority: 1,
  zdr: {
    support: 'unknown',
    requestFlag: null,
    confirmedAt: null,
    confirmedNote: null,
  },
  maxContextTokens: null,
  egressProxy: null,
  createdAt: 1,
  updatedAt: 1,
} as never;

describe('the columns are written, and silence stays silence', () => {
  test('stores reported cache and reasoning counts as reported', () => {
    recordUsage({
      tool: 'chat',
      modelId: 'model-a',
      tokensIn: 1_000,
      tokensOut: 200,
      cacheReadTokens: 800,
      cacheWriteTokens: 64,
      reasoningTokens: 120,
      status: 'ok',
    });

    const row = rawRow();
    assert.equal(row.tokens_in, 1_000, 'the cached part is not added on top');
    assert.equal(row.cache_read_tokens, 800);
    assert.equal(row.cache_write_tokens, 64);
    assert.equal(row.reasoning_tokens, 120);
  });

  test('leaves the columns NULL when the provider said nothing', () => {
    recordUsage({ tool: 'chat', modelId: 'model-a', tokensIn: 500, tokensOut: 50, status: 'ok' });

    const row = rawRow();
    assert.equal(row.cache_read_tokens, null);
    assert.equal(row.cache_write_tokens, null);
    assert.equal(row.reasoning_tokens, null);

    // And the rollup across a range that contains both rows reports the numbers
    // it has, without inventing zeroes from the row that had none.
    const summary = summarizeUsage({ tool: 'chat' });
    assert.equal(summary.totals.cacheReadTokens, 800);
    assert.equal(summary.totals.rowsWithCacheReporting, 1, 'only one row measured it');
  });

  test('a reported zero is a measurement, and survives as one', () => {
    recordUsage({
      tool: 'playground',
      modelId: 'model-a',
      tokensIn: 400,
      tokensOut: 40,
      cacheReadTokens: 0,
      status: 'ok',
    });

    const row = rawRow();
    assert.equal(row.cache_read_tokens, 0, 'zero is written, not folded into NULL');

    const summary = summarizeUsage({ tool: 'playground' });
    assert.equal(summary.totals.cacheReadTokens, 0);
    assert.equal(summary.totals.cacheHitRate, 0, 'a measured zero is 0%, which is a real answer');
    assert.equal(summary.totals.rowsWithCacheReporting, 1);
  });
});

describe('the cache hit rate', () => {
  test('is null when nothing reported cache reads, never 0%', () => {
    recordUsage({ tool: 'code', modelId: 'model-a', tokensIn: 900, tokensOut: 90, status: 'ok' });

    const summary = summarizeUsage({ tool: 'code' });
    assert.equal(summary.totals.cacheReadTokens, null);
    assert.equal(summary.totals.cacheHitRate, null);
    assert.equal(summary.totals.rowsWithCacheReporting, 0);
  });

  test('is the reported share of prompt tokens, and never above 1', () => {
    recordUsage({
      tool: 'cowork',
      modelId: 'model-a',
      tokensIn: 2_000,
      tokensOut: 100,
      cacheReadTokens: 1_500,
      status: 'ok',
    });
    const summary = summarizeUsage({ tool: 'cowork' });
    assert.equal(summary.totals.cacheHitRate, 0.75);

    // `tokensIn` is the reported prompt count, so a gateway whose cached figure
    // were the *whole* prompt including uncached would still not produce >100%.
    const totals = summary.byTool[0];
    assert.ok(totals);
    assert.ok(totals.cacheHitRate !== null && totals.cacheHitRate <= 1);
  });

  test('never reports a share above 100%, even from a mismatched convention', () => {
    // A gateway that reports `cached_tokens` *beside* a prompt count that is only
    // the uncached remainder produces cached > prompt. The raw numbers are kept —
    // they are what was reported — but "106% of the prompt was cached" is not a
    // fact about anything, so the derived share is capped at all of it.
    recordUsage({
      tool: 'design',
      modelId: 'model-a',
      tokensIn: 100,
      tokensOut: 10,
      cacheReadTokens: 250,
      status: 'ok',
    });

    const bucket = summarizeUsage({ tool: 'design' }).totals;
    assert.equal(bucket.cacheReadTokens, 250, 'the reported figure is preserved as reported');
    assert.equal(bucket.cacheHitRate, 1);
  });

  test('travels with every bucket, so a group is as honest as the total', () => {
    const summary = summarizeUsage({});
    const chat = summary.byTool.find((bucket) => bucket.key === 'chat');
    assert.ok(chat);
    assert.equal(chat.cacheReadTokens, 800);
    assert.equal(chat.rowsWithCacheReporting, 1);
    // 800 / (1000 + 500): both chat rows count in the denominator, but only one
    // reported a cache figure — the rate is a floor on this data, by design.
    assert.equal(chat.cacheHitRate, 800 / 1_500);
    assert.equal(summary.byTool.find((bucket) => bucket.key === 'playground')?.cacheHitRate, 0);
    assert.equal(summary.byTool.find((bucket) => bucket.key === 'code')?.cacheHitRate, null);
  });
});

describe('the adapters read what each provider sends', () => {
  test('OpenAI-compatible frames: cached prompt tokens and reasoning tokens', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50,' +
        '"prompt_tokens_details":{"cached_tokens":768},"completion_tokens_details":{"reasoning_tokens":30}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(streamOf(frames))) as never;
    try {
      const usage = await collect(openAiAdapter, {
        modelId: 'model-a',
        messages: [{ role: 'user', content: 'hello' }],
      });
      assert.equal(usage.tokensIn, 1_000);
      assert.equal(usage.cacheReadTokens, 768);
      assert.equal(usage.reasoningTokens, 30);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('OpenAI-compatible frames without the details blocks report nothing', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50}}\n\n',
      'data: [DONE]\n\n',
    ];
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(streamOf(frames))) as never;
    try {
      const usage = await collect(openAiAdapter, {
        modelId: 'model-a',
        messages: [{ role: 'user', content: 'hello' }],
      });
      assert.equal(usage.tokensIn, 1_000);
      assert.ok(!('cacheReadTokens' in usage), 'not reported, so not present — not a zero');
      assert.ok(!('reasoningTokens' in usage));
    } finally {
      globalThis.fetch = original;
    }
  });

  test('a gateway that reports a zero is recorded as having reported it', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":600,"completion_tokens":20,' +
        '"prompt_tokens_details":{"cached_tokens":0}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(streamOf(frames))) as never;
    try {
      const usage = await collect(openAiAdapter, {
        modelId: 'model-a',
        messages: [{ role: 'user', content: 'hello' }],
      });
      // Present-and-zero, which is a measurement: the difference between this
      // and the frame above is the whole reason the field is optional rather
      // than defaulted.
      assert.equal(usage.cacheReadTokens, 0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('Responses frames carry the Anthropic-shaped cache pair', async () => {
    const frames = [
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1200,"output_tokens":80,' +
        '"cache_read_input_tokens":1024,"cache_creation_input_tokens":128}}}\n\n',
    ];
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(streamOf(frames))) as never;
    try {
      const usage = await collect(openCodexAdapter, {
        modelId: 'model-a',
        messages: [{ role: 'user', content: 'hello' }],
      });
      assert.equal(usage.tokensIn, 1_200, 'input_tokens is taken literally, not summed with the cache fields');
      assert.equal(usage.cacheReadTokens, 1_024);
      assert.equal(usage.cacheWriteTokens, 128);
    } finally {
      globalThis.fetch = original;
    }
  });
});
