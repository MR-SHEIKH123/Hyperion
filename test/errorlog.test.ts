/**
 * What a server failure leaves behind on disk.
 *
 * stderr is rotated away and cannot be read from inside the app, so a 500 that
 * only reaches the log is a failure the user can never ask about afterwards.
 * `error_log` is the durable copy, and `GET /api/errors` is how the debug
 * console reads it back.
 *
 * The interesting assertions are about what is *absent*. A request body is
 * exactly where a pasted API key lives, and every row here is reachable over
 * HTTP, so the body's values must never be written while its keys still are —
 * knowing the call carried an `apiKey` field is what makes a failure
 * diagnosable, knowing what the key was adds nothing and costs everything.
 *
 * Two servers, because one app cannot provide both halves. The failing app is
 * assembled from the real `express.json()` and the real `errorHandler`, since a
 * hand-written "already sanitized" payload would only prove that the string I
 * invented contains what I put in it. The request has to travel over a socket
 * with genuine headers for `sanitizeRequestContext` to be the thing under test.
 */

import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import express from 'express';

import { cleanupHome, freshDb } from './helpers.ts';

import type { Server } from 'node:http';

const { countErrors, logError, queryErrorLog } = await import('../src/db/errorLog.ts');
const { AppError } = await import('../src/util/errors.ts');
const { errorHandler } = await import('../src/http/errors.ts');
const { createApp } = await import('../src/http/app.ts');

/** The real app, for reading the log back. */
let api: Server;
let apiBase: string;

/** A minimal app whose only job is to fail, for writing to it. */
let failing: Server;
let failingBase: string;

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo from listen(0)');
  }
  return { server, base: `http://127.0.0.1:${address.port}` };
}

before(async () => {
  await freshDb();

  const failApp = express();
  failApp.use(express.json());
  failApp.post('/boom', (_req, _res, next) => {
    next(new AppError('internal_error', 'the widget exploded'));
  });
  failApp.post('/refuse', (_req, _res, next) => {
    next(new AppError('bad_request', 'prompt is required.', { details: { field: 'prompt' } }));
  });
  failApp.use(errorHandler);

  ({ server: api, base: apiBase } = await listen(createApp()));
  ({ server: failing, base: failingBase } = await listen(failApp));
});

after(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await new Promise<void>((resolve) => failing.close(() => resolve()));
  await cleanupHome();
});

/** The most recent row, which is the one the test just caused. */
function newest() {
  const [entry] = queryErrorLog({ limit: 1 });
  assert.ok(entry, 'expected an error_log row');
  return entry;
}

describe('a server failure is recorded where it can be read again', () => {
  test('a 500 is logged with its code, endpoint, method, status and stack', async () => {
    const before = countErrors({});

    const res = await fetch(`${failingBase}/boom`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    assert.equal(res.status, 500);

    assert.equal(countErrors({}), before + 1, 'the 500 was not recorded');

    const entry = newest();
    assert.equal(entry.severity, 'error');
    assert.equal(entry.endpoint, '/boom');
    assert.equal(entry.method, 'POST');
    assert.equal(entry.status, 500);
    assert.equal(entry.error_code, 'internal_error');
    assert.equal(entry.error_message, 'the widget exploded');
    assert.match(
      entry.stack_trace ?? '',
      /at /,
      'the stack is the whole point of keeping a server-side copy',
    );
  });

  test('the stack stays on the server and never reaches the client', async () => {
    const res = await fetch(`${failingBase}/boom`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const raw = await res.text();

    assert.equal(res.status, 500);
    assert.equal(raw.includes('    at '), false, 'a stack frame was sent to the client');
    assert.equal(raw.includes('errorlog.test'), false, 'a source path was sent to the client');
    // And the row written for that same request does have it, so this is a
    // deliberate split rather than the stack simply not being captured.
    assert.match(newest().stack_trace ?? '', /at /);
  });

  test('a 4xx is not logged, because the client is what went wrong', async () => {
    const before = countErrors({});

    const res = await fetch(`${failingBase}/refuse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 400);

    assert.equal(
      countErrors({}),
      before,
      'validation failures would drown the real faults in noise',
    );
  });

  test('an unhandled route is a 404 and likewise leaves no row', async () => {
    const before = countErrors({});
    const res = await fetch(`${apiBase}/api/definitely-not-a-route`);
    assert.equal(res.status, 404);
    assert.equal(countErrors({}), before);
  });
});

describe('what a logged request reveals about itself', () => {
  test('body keys are kept and body values are not', async () => {
    const secret = 'sk-proj-PASTED-INTO-THE-BODY';

    await fetch(`${failingBase}/boom`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: secret, prompt: 'refactor the parser', chatId: 'c-1' }),
    });

    const context = newest().request_context ?? '';
    const parsed = JSON.parse(context) as { bodyKeys?: string[] };

    assert.deepEqual(
      parsed.bodyKeys,
      ['apiKey', 'prompt', 'chatId'],
      'without the field names the failure is not diagnosable',
    );
    assert.equal(context.includes(secret), false, 'a pasted key was written to the log');
    assert.equal(
      context.includes('refactor the parser'),
      false,
      'a body value reached the log; today it is a prompt, tomorrow it is a credential',
    );
  });

  test('credential-bearing headers are dropped and diagnostic ones survive', async () => {
    const bearer = 'Bearer sk-live-AUTHORIZATION-HEADER';

    await fetch(`${failingBase}/boom`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: bearer,
        'x-api-key': 'sk-live-X-API-KEY-HEADER',
        'user-agent': 'hyperion-test',
      },
      body: '{}',
    });

    const context = newest().request_context ?? '';
    const parsed = JSON.parse(context) as { headers?: Record<string, string> };

    assert.equal(parsed.headers?.authorization, undefined, 'the authorization header was kept');
    assert.equal(parsed.headers?.['x-api-key'], undefined, 'the x-api-key header was kept');
    assert.equal(context.includes('AUTHORIZATION-HEADER'), false);
    assert.equal(context.includes('X-API-KEY-HEADER'), false);

    // Stripping by name is only worth doing if it leaves something behind.
    assert.equal(parsed.headers?.['user-agent'], 'hyperion-test');
    assert.equal(parsed.headers?.['content-type'], 'application/json');
  });

  test('a credential in the query string is redacted rather than stored', async () => {
    // Query values are kept — they are half of what identifies a call — so this
    // is where `redactSecrets` earns its place as the second line of defence.
    await fetch(`${failingBase}/boom?project=parser&token=sk-QUERYSTRINGSECRET123`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    const context = newest().request_context ?? '';
    assert.equal(context.includes('QUERYSTRINGSECRET123'), false, 'the query carried a key');
    assert.match(context, /redacted/, 'it should be masked, not silently dropped');
    assert.match(context, /parser/, 'an ordinary query value is diagnostic and should remain');
  });
});

describe('GET /api/errors', () => {
  const marker = `probe-${Date.now()}`;
  const base = Date.now() - 60_000;

  before(() => {
    logError({ timestamp: base, severity: 'error', error_message: `${marker}-oldest` });
    logError({ timestamp: base + 1000, severity: 'warning', error_message: `${marker}-middle` });
    logError({ timestamp: base + 2000, severity: 'error', error_message: `${marker}-newest` });
  });

  /** The seeded rows only, in the order the endpoint returned them. */
  async function probe(query: string): Promise<{ messages: string[]; total: number; status: number }> {
    const res = await fetch(`${apiBase}/api/errors${query}`);
    const body = (await res.json()) as {
      entries: { error_message: string; severity: string; timestamp: number }[];
      total: number;
    };
    return {
      status: res.status,
      total: body.total,
      messages: body.entries
        .map((entry) => entry.error_message)
        .filter((message) => message.startsWith(marker)),
    };
  }

  test('returns entries newest first', async () => {
    const { status, messages } = await probe('?limit=200');
    assert.equal(status, 200);
    assert.deepEqual(messages, [`${marker}-newest`, `${marker}-middle`, `${marker}-oldest`]);
  });

  test('severity narrows the entries', async () => {
    const { status, messages } = await probe('?severity=warning&limit=200');
    assert.equal(status, 200);
    assert.deepEqual(messages, [`${marker}-middle`]);
  });

  test('since excludes anything older than the bound', async () => {
    const { messages } = await probe(`?since=${base + 1000}&limit=200`);
    assert.deepEqual(messages, [`${marker}-newest`, `${marker}-middle`]);
  });

  test('total counts every matching row, so limit can be a page size', async () => {
    const res = await fetch(`${apiBase}/api/errors?limit=1`);
    const body = (await res.json()) as { entries: unknown[]; total: number };

    assert.equal(body.entries.length, 1);
    assert.equal(
      body.total,
      countErrors({}),
      'a total that respected limit would always equal the page size and say nothing',
    );
    assert.ok(body.total > 1, 'the fixture wrote more rows than this page holds');
  });

  test('total honours the same filters as the entries', async () => {
    const res = await fetch(`${apiBase}/api/errors?severity=warning&limit=1`);
    const body = (await res.json()) as { total: number };
    assert.equal(body.total, countErrors({ severity: 'warning' }));
    assert.notEqual(body.total, countErrors({}), 'the filter was ignored by the count');
  });

  test('a severity outside the vocabulary is refused, naming the field', async () => {
    const res = await fetch(`${apiBase}/api/errors?severity=critical`);
    const body = (await res.json()) as {
      error: { code: string; details?: { field?: string } };
    };

    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'bad_request');
    assert.equal(
      body.error.details?.field,
      'severity',
      'the UI puts the message next to the offending control, so it needs the name',
    );
  });

  test('refusing a bad query does not itself write an error row', async () => {
    const before = countErrors({});
    await fetch(`${apiBase}/api/errors?severity=critical`);
    assert.equal(countErrors({}), before);
  });
});
