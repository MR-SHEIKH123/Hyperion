/**
 * How long the provider requests took (the `duration_ms` half of 1.30).
 *
 * `usage_log.duration_ms` has been written on every row since the log existed and
 * has never been read by anything: three agent-context paths and both chat paths
 * stamp `Date.now() - startedAt`, the column is populated, and no read, document or
 * screen mentioned it. This file pins what its reader now claims, and the claims are
 * the ones an optional measure always needs:
 *
 *   1. **Silence is not zero.** A row that recorded no duration (an older build, a
 *      tool that never called a provider, a caller that did not measure) leaves the
 *      bucket answering `null` with `rowsWithDuration: 0` — never a mean of 0 ms.
 *   2. **A reported zero is a measurement.** `durationMs: 0` is what a sub-millisecond
 *      local reply looks like, and folding it into silence would report the fastest
 *      provider as unmeasured.
 *   3. **Failed attempts are inside the figure.** The mean is over every row that
 *      measured, successes and failures alike, because the endpoint that hangs for a
 *      minute and then dies is the one a user is trying to find.
 *   4. **The mean belongs to its bucket.** `byProvider` divides by the rows in that
 *      provider's bucket, not by the log's rows.
 *   5. **The fold merges counts.** `summarizeExposure` builds its total in JS rather
 *      than SQL, where averaging the per-class means would silently weight a class
 *      with one request like a class with a hundred.
 *
 * The reader is asserted over HTTP too: none of this is a fact about a private
 * function, and the route is where the number reaches a screen.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

import type { Server } from 'node:http';
import type { ProviderType, ToolName } from '../src/types/core.ts';

const { recordUsage, summarizeUsage, summarizeExposure } = await import('../src/db/usage.ts');
const { createProvider } = await import('../src/providers/repository.ts');

let server: Server;
let base: string;
let providerSeq = 0;

before(async () => {
  await freshDb();
  const { createApp } = await import('../src/http/app.ts');
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
  await cleanupHome();
});

/** A real provider row, because a usage row's provider link is resolved against one. */
function newProvider(type: ProviderType = 'remote'): { id: string; name: string } {
  return createProvider({
    name: `Duration ${++providerSeq}`,
    type,
    baseUrl: type === 'local' ? 'http://127.0.0.1:11434' : 'https://duration.example.test/v1',
    apiKey: type === 'local' ? undefined : 'k',
    enabled: true,
  });
}

interface Logged {
  /**
   * The whole provider, not just its id.
   *
   * `byProvider` buckets on `COALESCE(provider_name, provider_id, 'unknown')` — the
   * denormalized name, so a report stays readable after the provider row is deleted
   * — which means a fixture that passed a constant name would file every provider
   * into one bucket and the per-bucket mean would be asserting the constant.
   */
  provider: { id: string; name: string };
  durationMs?: number | null;
  status?: 'ok' | 'error' | 'partial';
  tool?: ToolName;
  modelId?: string;
}

function log(input: Logged): void {
  recordUsage({
    tool: input.tool ?? 'chat',
    modelId: input.modelId ?? 'duration-model',
    providerId: input.provider.id,
    providerName: input.provider.name,
    tokensIn: 10,
    tokensOut: 5,
    status: input.status ?? 'ok',
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
  });
}

describe('the duration a usage bucket reports', () => {
  test('divides by the rows that measured, and a row that measured nothing is not a zero', () => {
    const provider = newProvider();
    log({ provider, durationMs: 100 });
    log({ provider, durationMs: 300 });
    log({ provider }); // a caller that did not measure

    const { totals } = summarizeUsage({ providerId: provider.id });
    assert.equal(totals.requests, 3);
    assert.equal(totals.rowsWithDuration, 2, 'the unmeasured row was counted as a measurement');
    assert.equal(totals.meanDurationMs, 200, 'the mean divided by all three requests');
    assert.equal(totals.slowestDurationMs, 300);
  });

  test('a bucket nobody measured answers null, not a mean of zero', () => {
    const provider = newProvider();
    log({ provider });

    const { totals } = summarizeUsage({ providerId: provider.id });
    assert.equal(totals.rowsWithDuration, 0);
    assert.equal(totals.meanDurationMs, null, 'silence was reported as 0 ms');
    assert.equal(totals.slowestDurationMs, null);
  });

  test('a reported zero is a measurement', () => {
    const provider = newProvider();
    log({ provider, durationMs: 0 });

    const { totals } = summarizeUsage({ providerId: provider.id });
    assert.equal(totals.rowsWithDuration, 1, 'a 0 ms reply was read as silence');
    assert.equal(totals.meanDurationMs, 0);
    assert.equal(totals.slowestDurationMs, 0);
  });

  test('a failed attempt is inside the figure, and that is the number this is for', () => {
    // The decision the read states out loud: excluding failures would report the
    // provider that hangs for a minute and then errors as 40 ms, because only the
    // request that came back would be counted.
    const provider = newProvider();
    log({ provider, status: 'error', durationMs: 60_000 });
    log({ provider, status: 'ok', durationMs: 40 });

    const { totals } = summarizeUsage({ providerId: provider.id });
    assert.equal(totals.requests, 2);
    assert.equal(totals.rowsWithDuration, 2);
    assert.equal(totals.meanDurationMs, 30_020);
    assert.equal(totals.slowestDurationMs, 60_000);
  });

  test('the mean belongs to its bucket, not to the log the bucket was cut from', () => {
    const slow = newProvider();
    const fast = newProvider();
    // `playground` is the one tool no other case in this file logs under, so the
    // unfiltered-looking query below is scoped to these two rows and the total is
    // this test's own arithmetic rather than whatever ran before it.
    log({ provider: slow, durationMs: 5_000, tool: 'playground' });
    log({ provider: fast, durationMs: 100, tool: 'playground' });

    const { byProvider, totals } = summarizeUsage({ tool: 'playground' });
    const slowBucket = byProvider.find((bucket) => bucket.key === slow.name);
    const fastBucket = byProvider.find((bucket) => bucket.key === fast.name);
    assert.equal(slowBucket?.meanDurationMs, 5_000);
    assert.equal(fastBucket?.meanDurationMs, 100);
    assert.equal(slowBucket?.rowsWithDuration, 1);
    // The log-wide total is the count-weighted mean of both, which here is the
    // halfway point only because each measured exactly once.
    assert.equal(totals.meanDurationMs, 2_550);
  });

  test('every dimension the summary cuts carries it', () => {
    const provider = newProvider();
    log({ provider, durationMs: 750, tool: 'code', modelId: 'dimension-model' });

    const { totals, byProvider, byModel, byTool, byDay } = summarizeUsage({ providerId: provider.id });
    assert.equal(totals.meanDurationMs, 750);
    assert.deepEqual(
      [byProvider, byModel, byTool, byDay].map((buckets) => buckets.length),
      [1, 1, 1, 1],
    );
    for (const buckets of [byProvider, byModel, byTool, byDay]) {
      assert.equal(buckets[0]?.meanDurationMs, 750);
      assert.equal(buckets[0]?.rowsWithDuration, 1);
      assert.equal(buckets[0]?.slowestDurationMs, 750);
    }
    assert.equal(byModel[0]?.key, 'dimension-model');
    assert.equal(byTool[0]?.key, 'code');
  });

  test('the exposure total merges counts rather than averaging the class means', () => {
    // Two egress classes with one and three requests: the true mean is
    // (100 + 3×200) / 4 = 175, where averaging the two class means would give 150.
    const local = newProvider('local');
    const remote = newProvider();
    // `design` scopes this to the five rows below, for the same reason
    // `playground` scopes the previous case: the file shares one log.
    const design: ToolName = 'design';
    log({ provider: local, durationMs: 100, tool: design });
    log({ provider: remote, durationMs: 200, tool: design });
    log({ provider: remote, durationMs: 200, tool: design });
    log({ provider: remote, durationMs: 200, tool: design });
    log({ provider: remote, tool: design }); // measured nothing, so it is not in the denominator

    const exposure = summarizeExposure({ tool: design });
    assert.equal(exposure.totals.rowsWithDuration, 4);
    assert.equal(exposure.totals.meanDurationMs, 175, 'the fold averaged the class means');
    assert.equal(exposure.totals.slowestDurationMs, 200);
    assert.equal(
      exposure.byClass.find((bucket) => bucket.key === 'local')?.meanDurationMs,
      100,
    );
    assert.equal(
      exposure.byClass.find((bucket) => bucket.key === 'remote')?.meanDurationMs,
      200,
    );
  });

  test('the routes carry it, because that is where a screen reads it', async () => {
    const provider = newProvider();
    log({ provider, durationMs: 250 });

    const usage = await fetch(`${base}/api/usage?providerId=${provider.id}`);
    assert.equal(usage.status, 200);
    const summary = (await usage.json()) as {
      totals: { meanDurationMs: number | null; rowsWithDuration: number; slowestDurationMs: number | null };
    };
    assert.equal(summary.totals.meanDurationMs, 250);
    assert.equal(summary.totals.rowsWithDuration, 1);
    assert.equal(summary.totals.slowestDurationMs, 250);

    const exposure = await fetch(`${base}/api/usage/exposure-summary?providerId=${provider.id}`);
    assert.equal(exposure.status, 200);
    const exposureSummary = (await exposure.json()) as {
      totals: { meanDurationMs: number | null; rowsWithDuration: number };
    };
    assert.equal(exposureSummary.totals.meanDurationMs, 250);
    assert.equal(exposureSummary.totals.rowsWithDuration, 1);
  });
});
