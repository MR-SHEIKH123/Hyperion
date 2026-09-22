/**
 * Every list route takes its `limit` from the same rule.
 *
 * A `limit` is the one query value that reaches SQL directly, and until these
 * tests existed only two of the nine routes that take one validated it. The
 * others handed whatever arrived straight to `LIMIT ?`, which has two failure
 * modes that a client cannot tell apart from a server fault:
 *
 *   `LIMIT 2.5`  -> SQLite raises "datatype mismatch", surfacing as a 500
 *                   `internal_error` naming the driver, not the field
 *   `LIMIT -1`   -> SQLite reads it as **no limit at all**, so a caller asking
 *                   for "-1 rows" is handed the whole table
 *
 * A limit is therefore a positive whole number no greater than the route's own
 * maximum, and anything else is a 400 naming the field and the bound. That is
 * the contract `/api/activity` and `/api/chat/:id/messages` already kept; the
 * point of this file is that the other seven keep it too, and that adding a
 * list route without one fails here rather than in production.
 *
 * The suite drives the real app over HTTP rather than calling the helpers,
 * because the failure being pinned is a status code: a unit test of the parser
 * would pass while the route went on ignoring it.
 */

import './helpers.ts';

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

const { appendMessage, createChat } = await import('../src/db/chats.ts');
const { createApp } = await import('../src/http/app.ts');
const { createScheduledTask } = await import('../src/services/cowork/scheduledTasks.ts');

let server: http.Server;
let base: string;
let taskId: string;

before(async () => {
  await freshDb();

  createChat({ id: 'chat-list', tool: 'chat', title: 'A chat' });
  for (let index = 1; index <= 3; index += 1) {
    appendMessage({ chatId: 'chat-list', role: 'user', content: `message ${index}` });
  }

  taskId = createScheduledTask({
    name: 'Probe',
    prompt: 'Say something.',
    schedule: 'daily:03:00',
    modelId: 'mock-model',
  }).id;

  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

interface ListRoute {
  /** The route, with `{limit}` in place of the value under test. */
  path: string;
  /** The route's documented maximum. */
  max: number;
}

const ROUTES: ListRoute[] = [
  { path: '/api/chat?limit={limit}', max: 500 },
  { path: '/api/chat/chat-list?limit={limit}', max: 500 },
  { path: '/api/chat/chat-list/messages?limit={limit}', max: 500 },
  { path: '/api/storage/assets?limit={limit}', max: 1000 },
  { path: '/api/storage/cleanup/log?limit={limit}', max: 500 },
  { path: '/api/errors?limit={limit}', max: 500 },
  { path: '/api/design/assets/approved?limit={limit}', max: 500 },
  { path: '/api/memory?limit={limit}', max: 200 },
  { path: '/api/cowork/scheduled-tasks/{task}/history?limit={limit}', max: 500 },
];

function url(route: ListRoute, limit: string): string {
  return `${base}${route.path.replace('{limit}', limit).replace('{task}', taskId)}`;
}

interface Refusal {
  error: { code: string; message: string; details?: { field?: string } };
}

describe('a limit that is not a positive whole number within the route bound', () => {
  test('a fractional limit is a 400 naming the field, not a 500 naming the driver', async () => {
    for (const route of ROUTES) {
      const response = await fetch(url(route, '1.5'));
      const payload = (await response.json()) as Refusal;

      assert.equal(response.status, 400, `${route.path} accepted limit=1.5`);
      assert.equal(payload.error.code, 'bad_request', `${route.path} was not a bad_request`);
      assert.equal(payload.error.details?.field, 'limit', `${route.path} blamed another field`);
    }
  });

  test('a limit above the route maximum is refused, naming the bound', async () => {
    for (const route of ROUTES) {
      const response = await fetch(url(route, String(route.max + 1)));
      const payload = (await response.json()) as Refusal;

      assert.equal(response.status, 400, `${route.path} accepted limit=${route.max + 1}`);
      assert.equal(payload.error.details?.field, 'limit');
      assert.match(
        payload.error.message,
        new RegExp(String(route.max)),
        `${route.path} did not say what the maximum is`,
      );
    }
  });

  test('a zero or negative limit is refused, because SQLite reads -1 as no limit', async () => {
    for (const route of ROUTES) {
      for (const limit of ['0', '-1']) {
        const response = await fetch(url(route, limit));
        const payload = (await response.json()) as Refusal;

        assert.equal(response.status, 400, `${route.path} accepted limit=${limit}`);
        assert.equal(payload.error.code, 'bad_request');
        assert.equal(payload.error.details?.field, 'limit');
      }
    }
  });

  test('junk is refused as a number rather than reaching SQL', async () => {
    for (const route of ROUTES) {
      const response = await fetch(url(route, 'lots'));
      const payload = (await response.json()) as Refusal;

      assert.equal(response.status, 400, `${route.path} accepted limit=lots`);
      assert.equal(payload.error.details?.field, 'limit');
    }
  });
});

describe('a limit that is valid still works', () => {
  test('the boundary values are accepted', async () => {
    for (const route of ROUTES) {
      for (const limit of ['1', String(route.max)]) {
        const response = await fetch(url(route, limit));

        assert.equal(response.status, 200, `${route.path} refused limit=${limit}`);
      }
    }
  });

  test('an omitted limit falls back to the route default', async () => {
    for (const route of ROUTES) {
      const response = await fetch(url(route, '').replace(/[?&]limit=$/, ''));

      assert.equal(response.status, 200, `${route.path} refused a defaulted limit`);
    }
  });
});

describe('an offset is a whole number of zero or more', () => {
  test('a fractional offset is a 400 rather than a driver error', async () => {
    const response = await fetch(`${base}/api/storage/assets?offset=1.5`);
    const payload = (await response.json()) as Refusal;

    assert.equal(response.status, 400);
    assert.equal(payload.error.code, 'bad_request');
    assert.equal(payload.error.details?.field, 'offset');
  });

  test('a negative offset is a 400 and zero is accepted', async () => {
    const refused = await fetch(`${base}/api/storage/assets?offset=-1`);
    assert.equal(refused.status, 400);

    const zero = await fetch(`${base}/api/storage/assets?offset=0&limit=5`);
    const listing = (await zero.json()) as { offset: number };

    assert.equal(zero.status, 200);
    assert.equal(listing.offset, 0);
  });
});
