/**
 * Cowork Pulse (1.30): tier config routes, the `pulse.fetch` tool on the
 * Cowork agent, the free-tier fan-out, the redaction scan, and the keyed-tier
 * framework.
 *
 * No test touches the live web. The four free adapters are pointed at one fake
 * server (the test-only endpoints seam — no route or tool argument reaches
 * it), and the tool-level dispatch test runs on the keyed tier with a
 * registered fixture, which is also what proves the framework: the registry,
 * the plumbing and the audit trail are real; only concrete keyed sources are
 * absent.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { AgentContext, CompletionRequest, StreamChunk, TaskInput } from '../src/types/core.ts';

const { cleanupHome, freshDb } = await import('./helpers.ts');
const { createApp } = await import('../src/http/app.ts');
const { PULSE_TIER_KEY, REDACTION_CHECK_KEY, setSetting } = await import('../src/db/settings.ts');
const { listPulseFetches } = await import('../src/db/pulseFetches.ts');
const { runCoworkTask } = await import('../src/services/cowork/agent.ts');
const {
  fetchPulse,
  formatPulseResult,
  registerKeyedSource,
  unregisterKeyedSource,
} = await import('../src/services/cowork/pulse.ts');

/** Trips `vendor_prefixed_key`, assembled so it is not itself a literal key. */
const FAKE_KEY = `sk-${'A1b2C3d4E5f6G7h8'}`;

// ---------------------------------------------------------------------------
// Fake sources: one server, four paths.
// ---------------------------------------------------------------------------

interface RecordedFetch {
  path: string;
  q: string;
  userAgent: string;
}

const modes = {
  reddit: 'ok' as 'ok' | '500' | 'messy',
  hackernews: 'ok' as 'ok' | '500',
  polymarket: 'array' as 'array' | 'events' | '500',
  github: 'ok' as 'ok' | '403' | 'badjson' | 'huge' | '500',
};

let recorded: RecordedFetch[] = [];
let fakeServer: http.Server;
let fakeBase = '';

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const REDDIT_CHILDREN = [
  { data: { title: 'Reddit: first', permalink: '/r/test/comments/abc/first/', score: 42, created_utc: 1727000000, selftext: 'snippet one' } },
  { data: { title: 'Reddit: second', permalink: '/r/test/comments/def/second/', score: 7, created_utc: 1727000100, selftext: '' } },
];

async function startFakeSources(): Promise<string> {
  fakeServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    recorded.push({
      path: url.pathname,
      q: url.searchParams.get('q') ?? url.searchParams.get('query') ?? '',
      userAgent: String(req.headers['user-agent'] ?? ''),
    });
    if (url.pathname === '/search.json') {
      if (modes.reddit === '500') return json(res, 500, { error: 'boom' });
      const children =
        modes.reddit === 'messy'
          ? [...REDDIT_CHILDREN, { data: { nope: true } }, 'a string child', { data: { title: '   ' } }]
          : REDDIT_CHILDREN;
      return json(res, 200, { data: { children } });
    }
    if (url.pathname === '/api/v1/search') {
      if (modes.hackernews === '500') return json(res, 500, { error: 'boom' });
      return json(res, 200, {
        hits: [
          { title: 'HN: first', url: 'https://example.com/a', points: 100, created_at: '2026-09-20T10:00:00.000Z', objectID: '1' },
          { title: 'HN: no-url', url: null, points: 5, created_at: '2026-09-21T10:00:00.000Z', objectID: '2' },
        ],
      });
    }
    if (url.pathname === '/public-search') {
      if (modes.polymarket === '500') return json(res, 500, { error: 'boom' });
      if (modes.polymarket === 'events') {
        return json(res, 200, { events: [{ question: 'Will Y?', slug: 'will-y', description: 'desc y' }] });
      }
      return json(res, 200, [{ question: 'Will X?', slug: 'will-x', description: 'desc x' }]);
    }
    if (url.pathname === '/search/repositories') {
      if (modes.github === '403') return json(res, 403, { message: 'rate limited' });
      if (modes.github === '500') return json(res, 500, { error: 'boom' });
      if (modes.github === 'badjson') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('not json{{{');
        return;
      }
      if (modes.github === 'huge') {
        const big = 'x'.repeat(2 * 1024 * 1024 + 100);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(big) });
        res.end(big);
        return;
      }
      return json(res, 200, {
        items: [
          {
            full_name: 'octo/a',
            html_url: 'https://github.com/octo/a',
            description: 'repo a',
            stargazers_count: 9,
            pushed_at: '2026-09-22T00:00:00Z',
          },
        ],
      });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
  const address = fakeServer.address();
  if (address === null || typeof address === 'string') throw new Error('expected AddressInfo from fake sources listen');
  return `http://127.0.0.1:${address.port}`;
}

function endpoints(): Record<string, string> {
  return { reddit: fakeBase, hackernews: fakeBase, polymarket: fakeBase, github: fakeBase };
}

// ---------------------------------------------------------------------------
// App server, settings helpers, agent harness.
// ---------------------------------------------------------------------------

let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let base = '';

function setTier(tier: string | null): void {
  setSetting(PULSE_TIER_KEY, tier);
}

function setRedaction(on: boolean): void {
  setSetting(REDACTION_CHECK_KEY, on ? '1' : '0');
}

type StreamPlan = { chunks?: StreamChunk[]; error?: unknown };

function input(): TaskInput {
  return { tool: 'cowork', chatId: 'chat-1', modelId: 'model-1', prompt: 'Research this topic.', mode: 'act' };
}

function token(text: string): StreamChunk {
  return { type: 'token', text };
}

function call(id: string, name: string, args: Record<string, unknown>): StreamChunk {
  return { type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } };
}

function context(plans: StreamPlan[]): {
  ctx: AgentContext;
  requests: CompletionRequest[];
  events: { event: string; data: Record<string, unknown> }[];
} {
  const requests: CompletionRequest[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const ctx = {
    taskId: 'task-pulse-1',
    runId: 'run-pulse-1',
    emit: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
    llm: {
      async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
        requests.push(request);
        const plan = plans.shift() ?? { chunks: [] };
        if (plan.error !== undefined) throw plan.error;
        for (const chunk of plan.chunks ?? []) yield chunk;
      },
      async complete() {
        return { text: '', usage: { tokensIn: 0, tokensOut: 0 } };
      },
    },
    saveArtifactVersion: () => ({ version: 1 }),
    resolvePath: (candidate: string) => `/projects/demo/${candidate}`,
    signal: new AbortController().signal,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as AgentContext;
  return { ctx, requests, events };
}

before(async () => {
  await freshDb();
  fakeBase = await startFakeSources();
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

beforeEach(() => {
  setTier(null);
  setRedaction(false);
  unregisterKeyedSource('fixture');
  unregisterKeyedSource('k1');
  unregisterKeyedSource('k2');
  modes.reddit = 'ok';
  modes.hackernews = 'ok';
  modes.polymarket = 'array';
  modes.github = 'ok';
  recorded = [];
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
  await cleanupHome();
});

describe('pulse config routes', () => {
  it('defaults to the off tier with four free sources and no keyed sources', async () => {
    const res = await fetch(`${base}/api/cowork/pulse/config`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      tier: string;
      freeSources: { id: string; label: string }[];
      keyedSources: unknown[];
    };
    assert.equal(body.tier, 'off');
    assert.deepEqual(
      body.freeSources.map((source) => source.id),
      ['reddit', 'hackernews', 'polymarket', 'github'],
    );
    assert.deepEqual(body.keyedSources, []);
  });

  it('sets the tier and reads it back', async () => {
    for (const tier of ['free', 'keyed', 'off']) {
      const put = await fetch(`${base}/api/cowork/pulse/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      assert.equal(put.status, 200);
      assert.equal(((await put.json()) as { tier: string }).tier, tier);
    }
    const get = await fetch(`${base}/api/cowork/pulse/config`);
    assert.equal(((await get.json()) as { tier: string }).tier, 'off');
  });

  it('rejects a bad tier, an unknown key and an empty body', async () => {
    for (const patch of [{ tier: 'turbo' }, { tier: 'free', bogus: 1 }, {}]) {
      const put = await fetch(`${base}/api/cowork/pulse/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      assert.equal(put.status, 400, JSON.stringify(patch));
    }
  });
});

describe('pulse.fetch on the Cowork agent', () => {
  const deps = {
    listKnowledgeSources: () => [],
    recallForTurn: async () => null,
    findWigolo: () => null,
  } as never;

  function offeredTools(request: CompletionRequest): string[] {
    return (request.tools ?? []).map((tool) => tool.name);
  }

  function systemText(request: CompletionRequest): string {
    return request.messages.find((message) => message.role === 'system')?.content ?? '';
  }

  it('is unoffered when the tier is off, and the prompt says so', async () => {
    setTier('off');
    const run = context([{ chunks: [token('done')] }]);
    await runCoworkTask(input(), run.ctx, { dependencies: deps });
    assert.ok(!offeredTools(run.requests[0] as CompletionRequest).includes('pulse.fetch'));
    assert.match(systemText(run.requests[0] as CompletionRequest), /Pulse status: off/);
  });

  it('is offered on the free tier with its schema, without fetching', async () => {
    setTier('free');
    const run = context([{ chunks: [token('done')] }]);
    await runCoworkTask(input(), run.ctx, { dependencies: deps });
    const first = run.requests[0] as CompletionRequest;
    const schema = (first.tools ?? []).find((tool) => tool.name === 'pulse.fetch');
    assert.ok(schema, 'pulse.fetch not offered');
    assert.deepEqual((schema.parameters.required as string[]).sort(), ['query']);
    assert.match(systemText(first), /Pulse status: free tier/);
    assert.match(systemText(first), /Reddit, Hacker News, Polymarket, GitHub/);
    assert.equal(recorded.length, 0);
  });

  it('is offered on the keyed tier even with nothing registered, and says so', async () => {
    setTier('keyed');
    const run = context([{ chunks: [token('done')] }]);
    await runCoworkTask(input(), run.ctx, { dependencies: deps });
    assert.ok(offeredTools(run.requests[0] as CompletionRequest).includes('pulse.fetch'));
    assert.match(systemText(run.requests[0] as CompletionRequest), /no keyed sources are registered/);
  });

  it('dispatches a call end to end through a registered keyed fixture', async () => {
    setTier('keyed');
    registerKeyedSource({
      id: 'fixture',
      label: 'Fixture',
      fetch: async (query, limit) => [
        { source: 'fixture', title: `Fixture says ${query} (limit ${limit})`, url: null, snippet: null, publishedAt: null, score: null },
      ],
    });
    try {
      const run = context([{ chunks: [call('c1', 'pulse.fetch', { query: 'hello' })] }, { chunks: [token('done')] }]);
      await runCoworkTask(input(), run.ctx, { dependencies: deps });
      const second = run.requests[1] as CompletionRequest;
      assert.ok(second, 'the run never made a second turn');
      const toolText = JSON.stringify(second.messages);
      assert.ok(toolText.includes('Fixture says hello (limit 5)'), toolText);
      const rows = listPulseFetches(1);
      assert.equal(rows[0]?.tier, 'keyed');
      assert.equal(rows[0]?.items[0]?.source, 'fixture');
    } finally {
      unregisterKeyedSource('fixture');
    }
  });
});

describe('free-tier fan-out', () => {
  it('queries all four sources, records the fetch and serves history', async () => {
    setTier('free');
    const result = await fetchPulse({ query: 'test query' }, { endpoints: endpoints() });
    assert.equal(result.tier, 'free');
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.source).sort(),
      ['github', 'hackernews', 'polymarket', 'reddit'],
    );
    assert.ok(result.outcomes.every((outcome) => outcome.ok));
    assert.equal(result.items.length, 6);

    const hnFallback = result.items.find((item) => item.title === 'HN: no-url');
    assert.equal(hnFallback?.url, 'https://news.ycombinator.com/item?id=2');
    const reddit = result.items.find((item) => item.title === 'Reddit: first');
    assert.equal(reddit?.url, `${fakeBase}/r/test/comments/abc/first/`);
    assert.equal(reddit?.score, 42);
    assert.equal(reddit?.snippet, 'snippet one');

    const res = await fetch(`${base}/api/cowork/pulse/fetches?limit=1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { count: number; fetches: { query: string; tier: string; items: unknown[] }[] };
    assert.equal(body.count, 1);
    assert.equal(body.fetches[0]?.query, 'test query');
    assert.equal(body.fetches[0]?.tier, 'free');
    assert.equal(body.fetches[0]?.items.length, 6);
  });

  it('fetches only the requested sources', async () => {
    setTier('free');
    const result = await fetchPulse({ query: 'x', sources: ['github'] }, { endpoints: endpoints() });
    assert.equal(result.items.length, 1);
    assert.deepEqual(
      recorded.map((fetch) => fetch.path),
      ['/search/repositories'],
    );
  });

  it('keeps partial results when one source fails, and names it', async () => {
    setTier('free');
    modes.reddit = '500';
    const result = await fetchPulse({ query: 'x' }, { endpoints: endpoints() });
    assert.equal(result.items.length, 4);
    const reddit = result.outcomes.find((outcome) => outcome.source === 'reddit');
    assert.equal(reddit?.ok, false);
    assert.match(reddit?.error ?? '', /HTTP 500/);
    assert.match(formatPulseResult(result), /Not answered: reddit/);
  });

  it('throws on a total failure but still records it', async () => {
    setTier('free');
    modes.reddit = '500';
    modes.hackernews = '500';
    modes.polymarket = '500';
    modes.github = '500';
    await assert.rejects(fetchPulse({ query: 'x' }, { endpoints: endpoints() }), (error: unknown) => {
      const app = error as Error & { code?: string };
      assert.equal(app.code, 'storage_error');
      assert.match(app.message, /reddit.*hackernews.*polymarket.*github/s);
      return true;
    });
    const rows = listPulseFetches(1);
    assert.equal(rows[0]?.query, 'x');
    assert.deepEqual(rows[0]?.items, []);
    assert.ok((rows[0]?.sources ?? []).every((outcome) => !outcome.ok));
  });

  it('encodes the query identically at every source', async () => {
    setTier('free');
    await fetchPulse({ query: 'a&b c' }, { endpoints: endpoints() });
    assert.equal(recorded.length, 4);
    assert.ok(recorded.every((fetch) => fetch.q === 'a&b c'));
  });

  it('skips malformed items instead of failing the source', async () => {
    setTier('free');
    modes.reddit = 'messy';
    const result = await fetchPulse({ query: 'x', sources: ['reddit'] }, { endpoints: endpoints() });
    assert.equal(result.items.length, 2);
    assert.equal(result.outcomes[0]?.ok, true);
  });

  it('reads the polymarket events envelope as well as the bare array', async () => {
    setTier('free');
    modes.polymarket = 'events';
    const result = await fetchPulse({ query: 'x', sources: ['polymarket'] }, { endpoints: endpoints() });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.title, 'Will Y?');
    assert.equal(result.items[0]?.url, 'https://polymarket.com/event/will-y');
  });

  it('explains a github rate limit in the outcome error', async () => {
    setTier('free');
    modes.github = '403';
    const result = await fetchPulse({ query: 'x' }, { endpoints: endpoints() });
    const github = result.outcomes.find((outcome) => outcome.source === 'github');
    assert.equal(github?.ok, false);
    assert.match(github?.error ?? '', /10 requests\/minute/);
    assert.equal(result.items.length, 5);
  });

  it('fails a source whose body is not JSON', async () => {
    setTier('free');
    modes.github = 'badjson';
    // Single requested source, so a total failure: the per-source error rides
    // on the rejection, and the history row still lands (asserted above).
    await assert.rejects(fetchPulse({ query: 'x', sources: ['github'] }, { endpoints: endpoints() }), /not JSON/);
  });

  it('refuses to buffer an absurd body', async () => {
    setTier('free');
    modes.github = 'huge';
    await assert.rejects(fetchPulse({ query: 'x', sources: ['github'] }, { endpoints: endpoints() }), /refusing to buffer/);
  });

  it('identifies itself to the sources that require a user agent', async () => {
    setTier('free');
    await fetchPulse({ query: 'x' }, { endpoints: endpoints() });
    for (const path of ['/search.json', '/search/repositories']) {
      const entry = recorded.find((candidate) => candidate.path === path);
      assert.equal(entry?.userAgent, 'hyperion-pulse/1.0', path);
    }
  });
});

describe('tier and redaction gates', () => {
  it('refuses when the tier is off, without fetching or recording', async () => {
    setTier('off');
    const before = listPulseFetches(1).length;
    await assert.rejects(fetchPulse({ query: 'x' }, { endpoints: endpoints() }), (error: unknown) => {
      assert.equal((error as Error & { code?: string }).code, 'capability_disabled');
      return true;
    });
    assert.equal(recorded.length, 0);
    assert.equal(listPulseFetches(1).length, before);
  });

  it('refuses the keyed tier with nothing registered', async () => {
    setTier('keyed');
    await assert.rejects(fetchPulse({ query: 'x' }, { endpoints: endpoints() }), (error: unknown) => {
      const app = error as Error & { code?: string };
      assert.equal(app.code, 'capability_disabled');
      assert.match(app.message, /no keyed sources are registered/);
      return true;
    });
  });

  it('treats a corrupt tier as off', async () => {
    setTier('turbo');
    await assert.rejects(fetchPulse({ query: 'x' }, { endpoints: endpoints() }), (error: unknown) => {
      assert.equal((error as Error & { code?: string }).code, 'capability_disabled');
      return true;
    });
    assert.equal(recorded.length, 0);
  });

  it('scans the query under redaction_check_enabled, with no send-anyway', async () => {
    setTier('free');
    setRedaction(true);
    const before = listPulseFetches(100).length;
    await assert.rejects(fetchPulse({ query: `deploy logs for ${FAKE_KEY}` }, { endpoints: endpoints() }), (error: unknown) => {
      const app = error as Error & { code?: string; details?: Record<string, unknown> };
      assert.equal(app.code, 'redaction_flagged');
      assert.match(app.message, /no send-anyway/);
      assert.ok(!app.message.includes('acknowledgeSensitive'));
      assert.deepEqual(app.details?.kinds, ['vendor_prefixed_key']);
      return true;
    });
    assert.equal(recorded.length, 0);
    assert.equal(listPulseFetches(100).length, before);

    // The same query proceeds with the toggle off: the scan is the toggle.
    setRedaction(false);
    const result = await fetchPulse({ query: `deploy logs for ${FAKE_KEY}` }, { endpoints: endpoints() });
    assert.ok(result.items.length > 0);
  });

  it('validates the query, the limit and the source list', async () => {
    setTier('free');
    const ep = { endpoints: endpoints() };
    await assert.rejects(fetchPulse({ query: '   ' }, ep), /must not be empty/);
    await assert.rejects(fetchPulse({ query: 'x'.repeat(301) }, ep), /at most 300/);
    await assert.rejects(fetchPulse({ query: 'x', limit: 0 }, ep), /from 1 to 10/);
    await assert.rejects(fetchPulse({ query: 'x', limit: 11 }, ep), /from 1 to 10/);
    await assert.rejects(fetchPulse({ query: 'x', limit: 1.5 }, ep), /must be an integer/);
    await assert.rejects(fetchPulse({ query: 'x', sources: [] }, ep), /at least one source/);
    await assert.rejects(fetchPulse({ query: 'x', sources: ['nope'] }, ep), (error: unknown) => {
      const app = error as Error & { details?: Record<string, unknown> };
      assert.match(app.message, /Unknown Pulse source/);
      assert.deepEqual((app.details?.allowed as string[]).sort(), ['github', 'hackernews', 'polymarket', 'reddit']);
      return true;
    });
    assert.equal(recorded.length, 0);
  });
});

describe('keyed-tier framework', () => {
  it('validates registrations', async () => {
    assert.throws(() => registerKeyedSource({ id: 'BAD', label: 'x', fetch: async () => [] }), /lowercase/);
    assert.throws(() => registerKeyedSource({ id: 'reddit', label: 'x', fetch: async () => [] }), /collides/);
    assert.throws(() => registerKeyedSource({ id: 'k1', label: '  ', fetch: async () => [] }), /label/);
    registerKeyedSource({ id: 'k1', label: 'K1', fetch: async () => [] });
    try {
      assert.throws(() => registerKeyedSource({ id: 'k1', label: 'K1', fetch: async () => [] }), /already registered/);
    } finally {
      assert.equal(unregisterKeyedSource('k1'), true);
      assert.equal(unregisterKeyedSource('k1'), false);
    }
  });

  it('fans out across registered sources with partial failure', async () => {
    setTier('keyed');
    registerKeyedSource({
      id: 'k1',
      label: 'K1',
      fetch: async (query) => [
        { source: 'k1', title: `k1:${query}`, url: null, snippet: null, publishedAt: null, score: null },
      ],
    });
    registerKeyedSource({
      id: 'k2',
      label: 'K2',
      fetch: async () => {
        throw new Error('k2 is down');
      },
    });
    try {
      const result = await fetchPulse({ query: 'q' });
      assert.equal(result.tier, 'keyed');
      assert.deepEqual(
        result.items.map((item) => item.title),
        ['k1:q'],
      );
      assert.match(formatPulseResult(result), /Not answered: k2 \(k2 is down\)/);

      const single = await fetchPulse({ query: 'q', sources: ['k1'] });
      assert.deepEqual(
        single.outcomes.map((outcome) => outcome.source),
        ['k1'],
      );

      const res = await fetch(`${base}/api/cowork/pulse/config`);
      const body = (await res.json()) as { keyedSources: { id: string }[] };
      assert.deepEqual(
        body.keyedSources.map((source) => source.id).sort(),
        ['k1', 'k2'],
      );
    } finally {
      unregisterKeyedSource('k1');
      unregisterKeyedSource('k2');
    }
  });
});
