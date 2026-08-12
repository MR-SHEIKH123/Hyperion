/**
 * The two questions a dashboard asks: what is going on, and what has happened.
 *
 * Both endpoints are aggregations, which is exactly where a unit test proves the
 * least — the merge, the ordering and the verdict rules only exist once the
 * pieces are combined, so everything here goes over a socket against a real app
 * with rows written by the real writers.
 *
 * The feed assertions care as much about what is *absent*. `GET /api/errors`
 * already serves raw records, so a stack trace appearing here would mean the
 * feed had quietly become a second debug console.
 *
 * `GET /api/health` is covered too, because it moved out of `app.ts` into a
 * router when `/summary` was added, and a liveness probe that changed shape
 * during a refactor is precisely the break nothing else would notice.
 */

import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

import type { Server } from 'node:http';

const { createApp } = await import('../src/http/app.ts');
const { getDb } = await import('../src/db/adapter.ts');
const { finishTaskRun, startTaskRun } = await import('../src/db/taskRuns.ts');
const { createScheduledTask, finishRun, startRun } = await import(
  '../src/services/cowork/scheduledTasks.ts'
);
const { createProvider, deleteProvider, enableProvider, listProviders, recordHealth } =
  await import('../src/providers/repository.ts');
const { createChat } = await import('../src/db/chats.ts');
const { logError } = await import('../src/db/errorLog.ts');

let server: Server;
let base: string;

/** Fixed and safely in the past, so nothing collides with a live timestamp. */
const BASE = 1_700_000_000_000;

interface ActivityEntryJson {
  id: string;
  kind: string;
  timestamp: number;
  status: string;
  title: string;
  detail: string | null;
  link: { kind: string; chatId?: string; key?: string; version?: number } | null;
}

interface ActivityPageJson {
  entries: ActivityEntryJson[];
  nextBefore: number | null;
}

interface SummaryJson {
  status: string;
  uptimeSec: number;
  checkedAt: number;
  components: {
    providers: {
      status: string;
      detail: string;
      total: number;
      active: { id: string; name: string; health: string } | null;
      failoverCandidates: number;
      healthy: number;
      unhealthy: number;
      unknown: number;
    };
    mcp: { status: string; detail: string; managed: boolean; total: number };
    errors: { status: string; detail: string; count: number; windowMs: number };
  };
}


before(async () => {
  await freshDb();

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

/**
 * Write a task run through the real writer, then pin its start time.
 *
 * `startTaskRun` stamps its own clock, and rows written in the same millisecond
 * would order arbitrarily — an ordering test that passed or failed on machine
 * speed is worse than none. The row is otherwise exactly what production writes.
 */
function seedTaskRun(options: {
  runId: string;
  tool: 'code' | 'cowork' | 'design';
  startedAt: number;
  chatId?: string;
  finish?: {
    state: 'complete' | 'error' | 'paused';
    pauseReason?: string;
    code?: string;
    message?: string;
  };
}): void {
  startTaskRun({
    runId: options.runId,
    taskId: `task-${options.runId}`,
    tool: options.tool,
    chatId: options.chatId,
  });

  if (options.finish) {
    finishTaskRun(options.runId, options.finish.state, {
      pauseReason: options.finish.pauseReason,
      code: options.finish.code,
      message: options.finish.message,
    });
  }

  getDb()
    .prepare('UPDATE task_runs SET started_at = ? WHERE run_id = ?')
    .run(options.startedAt, options.runId);
}

async function feed(query = ''): Promise<ActivityPageJson & { statusCode: number }> {
  const res = await fetch(`${base}/api/activity${query}`);
  const body = (await res.json()) as ActivityPageJson;
  return { ...body, statusCode: res.status };
}

function entryById(page: ActivityPageJson, id: string): ActivityEntryJson {
  const found = page.entries.find((entry) => entry.id === id);
  assert.ok(found, `expected an entry with id ${id}`);
  return found;
}

describe('GET /api/activity — what the app has been doing, in sentences', () => {
  let taskId: string;
  let chatId: string;

  before(() => {
    // A real chat row, not an invented id: `task_runs.chat_id` is a foreign key
    // into `chats` and this database enforces them, so a made-up id is rejected
    // outright rather than producing the dangling link the test wants to check.
    chatId = createChat({ tool: 'code', title: 'Refactor the parser' }).id;

    // Interleaved on purpose: if either source were appended after the other
    // rather than merged, this ordering is what would expose it.
    seedTaskRun({
      runId: 'run-code-done',
      tool: 'code',
      startedAt: BASE + 1000,
      chatId,
      finish: { state: 'complete' },
    });
    seedTaskRun({
      runId: 'run-design-failed',
      tool: 'design',
      startedAt: BASE + 3000,
      finish: { state: 'error', code: 'internal_error', message: 'the renderer ran out of memory' },
    });
    seedTaskRun({
      runId: 'run-cowork-paused',
      tool: 'cowork',
      startedAt: BASE + 5000,
      finish: { state: 'paused', pauseReason: 'waiting for your approval' },
    });
    seedTaskRun({ runId: 'run-code-running', tool: 'code', startedAt: BASE + 7000 });

    const task = createScheduledTask({
      name: 'Morning briefing',
      prompt: 'summarise the news',
      schedule: 'daily:07:00',
      modelId: 'mock-model',
    });
    taskId = task.id;

    const ok = startRun(taskId, BASE + 2000);
    finishRun(ok, taskId, {
      status: 'success',
      summary: 'Wrote up 6 stories.',
      artifact: { key: 'briefing.md', version: 3 },
    });

    const skipped = startRun(taskId, BASE + 4000);
    finishRun(skipped, taskId, {
      status: 'skipped',
      summary: 'Skipped: the app was busy with another job.',
    });

    const failed = startRun(taskId, BASE + 6000);
    finishRun(failed, taskId, {
      status: 'failed',
      error: { code: 'provider_unavailable', message: 'no provider could be reached' },
    });
  });

  test('merges interactive and scheduled runs into one newest-first list', async () => {
    const page = await feed('?limit=200');
    assert.equal(page.statusCode, 200);

    const seeded = page.entries.filter((entry) => entry.timestamp >= BASE);
    assert.deepEqual(
      seeded.map((entry) => entry.timestamp),
      [
        BASE + 7000,
        BASE + 6000,
        BASE + 5000,
        BASE + 4000,
        BASE + 3000,
        BASE + 2000,
        BASE + 1000,
      ],
      'the two sources were not interleaved by time',
    );

    assert.deepEqual(
      [...new Set(seeded.map((entry) => entry.kind))].sort(),
      ['scheduled-task', 'task'],
      'both sources should be represented',
    );
  });

  test('a finished task reads as a sentence and links to its chat', async () => {
    const entry = entryById(await feed('?limit=200'), 'task:run-code-done');

    assert.equal(entry.kind, 'task');
    assert.equal(entry.status, 'success');
    assert.equal(entry.title, 'Code task finished');
    assert.deepEqual(entry.link, { kind: 'chat', chatId });

    assert.equal(entry.detail, null, 'a run that simply worked has nothing to explain');
  });

  test('a failed run explains itself and a paused one says what it is waiting for', async () => {
    const page = await feed('?limit=200');

    const failed = entryById(page, 'task:run-design-failed');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.title, 'Design task failed');
    assert.equal(failed.detail, 'the renderer ran out of memory');

    const paused = entryById(page, 'task:run-cowork-paused');
    assert.equal(paused.status, 'paused');
    assert.equal(paused.title, 'Cowork task paused');
    assert.equal(paused.detail, 'waiting for your approval');

    const running = entryById(page, 'task:run-code-running');
    assert.equal(running.status, 'running');
    assert.equal(running.title, 'Code task is still running');
  });

  test('a scheduled run names its task and links to the artifact it produced', async () => {
    const page = await feed('?limit=200');
    const entry = page.entries.find(
      (candidate) => candidate.kind === 'scheduled-task' && candidate.timestamp === BASE + 2000,
    );
    assert.ok(entry);

    assert.equal(entry.status, 'success');
    assert.equal(entry.title, 'Scheduled task "Morning briefing" finished');
    assert.equal(entry.detail, 'Wrote up 6 stories.');
    assert.deepEqual(entry.link, { kind: 'artifact', key: 'briefing.md', version: 3 });
  });

  test('a skipped run is an entry of its own, not an absence', async () => {
    const page = await feed('?limit=200');
    const entry = page.entries.find((candidate) => candidate.timestamp === BASE + 4000);
    assert.ok(entry);

    // The whole reason `skipped` is a stored status rather than a missing row:
    // "it came due and could not run" must be distinguishable from silence.
    assert.equal(entry.status, 'skipped');
    assert.equal(entry.title, 'Scheduled task "Morning briefing" was skipped');
    assert.equal(entry.detail, 'Skipped: the app was busy with another job.');
  });

  test('the feed is a summary, not the debug console', async () => {
    const res = await fetch(`${base}/api/activity?limit=200`);
    const raw = await res.text();

    assert.equal(raw.includes('    at '), false, 'a stack frame reached the feed');
    assert.equal(
      raw.includes('stack_trace'),
      false,
      'the feed should not carry debug-console fields',
    );
    // The human-readable failure reason does belong here; the machine code does
    // not, because nothing in the feed is meant to be branched on by error code.
    assert.equal(raw.includes('no provider could be reached'), true);
    assert.equal(raw.includes('provider_unavailable'), false);
  });

  test('paging with nextBefore walks the feed without repeating or losing an entry', async () => {
    const seen: string[] = [];
    let cursor: number | null = null;

    for (let page = 0; page < 10; page++) {
      const query: string = cursor === null ? '?limit=2' : `?limit=2&before=${cursor}`;
      const result: ActivityPageJson & { statusCode: number } = await feed(query);
      assert.equal(result.statusCode, 200);
      assert.ok(result.entries.length <= 2, 'limit was not honoured');

      seen.push(...result.entries.map((entry) => entry.id));
      cursor = result.nextBefore;
      if (cursor === null) break;
    }

    assert.equal(cursor, null, 'paging never reached the end');
    assert.equal(seen.length, 7, 'the walk did not cover every seeded entry exactly once');
    assert.equal(new Set(seen).size, seen.length, 'an entry appeared on two pages');
  });

  test('a full page offers a cursor and the last page does not', async () => {
    const full = await feed('?limit=2');
    assert.equal(full.entries.length, 2);
    assert.equal(full.nextBefore, full.entries[1]?.timestamp);

    const everything = await feed('?limit=200');
    assert.equal(
      everything.nextBefore,
      null,
      'a short page means the end, and a cursor there would loop forever',
    );
  });

  test('before is exclusive, so a page never repeats the entry it ended on', async () => {
    const page = await feed(`?limit=200&before=${BASE + 4000}`);
    const timestamps = page.entries.filter((e) => e.timestamp >= BASE).map((e) => e.timestamp);

    assert.equal(timestamps.includes(BASE + 4000), false, 'the cursor row came back again');
    assert.deepEqual(timestamps, [BASE + 3000, BASE + 2000, BASE + 1000]);
  });

  test('a limit outside the allowed range is refused, naming the field', async () => {
    for (const bad of ['0', '-5', '201', '1.5']) {
      const res = await fetch(`${base}/api/activity?limit=${bad}`);
      const body = (await res.json()) as { error: { code: string; details?: { field?: string } } };

      assert.equal(res.status, 400, `limit=${bad} should be refused`);
      assert.equal(body.error.code, 'bad_request');
      assert.equal(body.error.details?.field, 'limit');
    }
  });

  test('a non-numeric limit is refused rather than silently ignored', async () => {
    const res = await fetch(`${base}/api/activity?limit=lots`);
    const body = (await res.json()) as { error: { code: string; details?: { field?: string } } };

    assert.equal(res.status, 400);
    assert.equal(body.error.details?.field, 'limit');
  });

  test('a negative cursor is refused, naming the field', async () => {
    const res = await fetch(`${base}/api/activity?before=-1`);
    const body = (await res.json()) as { error: { code: string; details?: { field?: string } } };

    assert.equal(res.status, 400);
    assert.equal(body.error.details?.field, 'before');
  });
});

/**
 * The provider cases below are written around a model that the plural in
 * `listProviders()` hides: `enabled` is a single *active* flag guarded by a
 * partial unique index, so exactly one provider can be enabled at a time and
 * `createProvider` defaults it to off. An earlier version of these tests assumed
 * a set of enabled providers and passed only by accident — the real question is
 * whether the one active provider works and whether anything can take over.
 */
describe('GET /api/health/summary — one verdict over the moving parts', () => {
  function clearProviders(): void {
    for (const provider of listProviders()) deleteProvider(provider.id);
  }

  async function summary(): Promise<SummaryJson & { statusCode: number }> {
    const res = await fetch(`${base}/api/health/summary`);
    const body = (await res.json()) as SummaryJson;
    return { ...body, statusCode: res.status };
  }

  before(() => {
    clearProviders();
  });

  after(() => {
    clearProviders();
  });

  test('an install with no providers is degraded, not broken', async () => {
    clearProviders();
    const result = await summary();

    assert.equal(result.statusCode, 200);
    assert.equal(result.components.providers.status, 'degraded');
    assert.equal(result.status, 'degraded');
    assert.match(result.components.providers.detail, /No provider is configured/);
  });

  test('providers that exist but none active is degraded, not an outage', async () => {
    clearProviders();
    createProvider({ name: 'standby', type: 'remote', baseUrl: 'https://api.example.com/v1' });

    const result = await summary();

    // `createProvider` leaves a provider disabled unless asked otherwise, so
    // this is the state right after adding one. Nothing is broken — the user
    // simply has not chosen yet, which is a prompt rather than a fault.
    assert.equal(result.components.providers.total, 1);
    assert.equal(result.components.providers.active, null);
    assert.equal(result.components.providers.status, 'degraded');
    assert.match(result.components.providers.detail, /none is active/);
  });

  test('an active provider that has never been tried does not count as a failure', async () => {
    clearProviders();
    createProvider({
      name: 'fresh',
      type: 'remote',
      baseUrl: 'https://api.example.com/v1',
      enabled: true,
    });

    const result = await summary();

    // Everything is `unknown` until something is actually sent. A dashboard that
    // showed red before the user had done anything would train them to ignore it.
    assert.equal(result.components.providers.unknown, 1);
    assert.equal(result.components.providers.active?.health, 'unknown');
    assert.equal(result.components.providers.status, 'ok');
    assert.equal(result.status, 'ok');
  });

  test('a healthy active provider reports ok and names itself', async () => {
    clearProviders();
    const provider = createProvider({
      name: 'working',
      type: 'remote',
      baseUrl: 'https://api.example.com/v1',
      enabled: true,
    });
    recordHealth(provider.id, 'healthy');

    const result = await summary();
    assert.equal(result.components.providers.status, 'ok');
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.components.providers.active, {
      id: provider.id,
      name: 'working',
      health: 'healthy',
    });
  });

  test('a dead active provider with somewhere to fail over to is degraded', async () => {
    clearProviders();
    const dead = createProvider({
      name: 'dead',
      type: 'remote',
      baseUrl: 'https://dead.example.com/v1',
      enabled: true,
    });
    const standby = createProvider({
      name: 'standby',
      type: 'remote',
      baseUrl: 'https://standby.example.com/v1',
    });
    recordHealth(dead.id, 'unhealthy', { message: 'connection refused' });
    recordHealth(standby.id, 'healthy');

    const result = await summary();

    // The standby is *disabled*, and that is precisely the point:
    // `listFailoverCandidates` ignores `enabled`, so a provider on standby is
    // still a route out and the app is not down.
    assert.equal(result.components.providers.unhealthy, 1);
    assert.equal(result.components.providers.failoverCandidates, 1);
    assert.equal(result.components.providers.status, 'degraded');
    assert.equal(result.status, 'degraded');
    assert.match(result.components.providers.detail, /can take over/);
  });

  test('a dead active provider with no candidate left is the one condition that is an error', async () => {
    clearProviders();
    const first = createProvider({
      name: 'one',
      type: 'remote',
      baseUrl: 'https://one.example.com/v1',
      enabled: true,
    });
    const second = createProvider({
      name: 'two',
      type: 'remote',
      baseUrl: 'https://two.example.com/v1',
    });
    recordHealth(first.id, 'unhealthy', { message: 'connection refused' });
    recordHealth(second.id, 'unhealthy', { message: 'connection refused' });

    const result = await summary();
    assert.equal(result.components.providers.failoverCandidates, 0);
    assert.equal(result.components.providers.status, 'error');
    assert.equal(result.status, 'error', 'nothing can serve a request, which is an outage');
    assert.match(result.components.providers.detail, /no other provider to fail over to/);
  });

  test('enabling a second provider moves the verdict with the active flag', async () => {
    clearProviders();
    const dead = createProvider({
      name: 'dead',
      type: 'remote',
      baseUrl: 'https://dead.example.com/v1',
      enabled: true,
    });
    const alive = createProvider({
      name: 'alive',
      type: 'remote',
      baseUrl: 'https://alive.example.com/v1',
    });
    recordHealth(dead.id, 'unhealthy', { message: 'connection refused' });
    recordHealth(alive.id, 'healthy');

    assert.equal((await summary()).components.providers.status, 'degraded');

    // `enableProvider` puts the previous one on standby in the same transaction,
    // so the summary must follow the flag rather than the fleet.
    enableProvider(alive.id);

    const result = await summary();
    assert.equal(result.components.providers.active?.name, 'alive');
    assert.equal(result.components.providers.status, 'ok');
    assert.equal(result.status, 'ok');
  });


  test('no MCP supervisor is a supported configuration, not a fault', async () => {
    const result = await summary();

    assert.equal(result.components.mcp.managed, false);
    assert.equal(result.components.mcp.status, 'ok');
    assert.match(result.components.mcp.detail, /No MCP supervisor/);
  });

  test('uptime and a checked-at stamp come back with the verdict', async () => {
    const result = await summary();

    assert.equal(typeof result.uptimeSec, 'number');
    assert.ok(result.uptimeSec >= 0);
    assert.ok(result.checkedAt > BASE, 'checkedAt should be a live timestamp');
  });

  // Last, deliberately: it writes to error_log, and the assertions above about
  // an `ok` verdict would start failing once a row exists in the window.
  test('a recent server error shows in the summary without taking the app red', async () => {
    clearProviders();
    const provider = createProvider({
      name: 'fine',
      type: 'remote',
      baseUrl: 'https://fine.example.com/v1',
      enabled: true,
    });
    recordHealth(provider.id, 'healthy');


    const quiet = await summary();
    assert.equal(quiet.components.errors.count, 0);
    assert.equal(quiet.components.errors.status, 'ok');
    assert.equal(quiet.status, 'ok');

    logError({
      timestamp: Date.now(),
      severity: 'error',
      error_message: 'something blew up a minute ago',
    });

    const noisy = await summary();
    assert.equal(noisy.components.errors.count, 1);
    assert.equal(noisy.components.errors.status, 'degraded');
    assert.equal(
      noisy.status,
      'degraded',
      'a past failure is history, so it should not claim the app is down now',
    );
  });

  test('an error older than the window is not counted', async () => {
    logError({
      timestamp: Date.now() - 2 * 60 * 60 * 1000,
      severity: 'error',
      error_message: 'ancient history',
    });

    const result = await summary();
    assert.equal(
      result.components.errors.count,
      1,
      'the two-hour-old row should fall outside the one-hour window',
    );
    assert.equal(result.components.errors.windowMs, 60 * 60 * 1000);
  });
});

describe('GET /api/health — the liveness probe survived being moved', () => {
  test('still answers with the same shape a supervisor polls for', async () => {
    const res = await fetch(`${base}/api/health`);
    const body = (await res.json()) as {
      ok: boolean;
      name: string;
      uptimeSec: number;
      loopback: boolean;
    };

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.name, 'hyperion');
    assert.equal(typeof body.uptimeSec, 'number');
    assert.equal(body.loopback, true);
  });

  test('an unknown path under the health mount is still a 404', async () => {
    const res = await fetch(`${base}/api/health/nonsense`);
    assert.equal(res.status, 404);
  });
});
