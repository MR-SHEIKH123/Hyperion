/**
 * The busy refusal that happens *before* a stream opens.
 *
 * `assertNotBusy` was written twice — byte-identical copies, one in the chat
 * router and one in the agent router — and each copy was reachable only from its
 * own routes. It now lives in `orchestrator/lock.ts`, which owns the lock and the
 * job a refusal names, and takes the mode as a parameter the way `acquire` does.
 * This file is what keeps the move honest: the two behaviours the parameter
 * decides, asserted through the mounted routes rather than through the helper, so
 * a call site that stopped passing the setting would fail here.
 *
 * The response type is the point of the pre-check, not a detail: `acquire` would
 * raise the same refusal a moment later, but by then the response is
 * `text/event-stream` and a client that asked for JSON has to dig the failure out
 * of a 200. So the reject case asserts the content type as hard as the status.
 */
import './helpers.ts';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import type { Server } from 'node:http';
import type { AgentModule } from '../src/types/core.ts';

import { cleanupHome, freshDb } from './helpers.ts';

const { createApp } = await import('../src/http/app.ts');
const { registerAgent, resetModules } = await import('../src/orchestrator/agents.ts');
const { acquire, queueDepth, resetLock } = await import('../src/orchestrator/lock.ts');
const { setSetting } = await import('../src/db/settings.ts');

let server: Server;
let base: string;

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

beforeEach(() => {
  resetModules();
  resetLock();
  setSetting('concurrency_mode', 'reject');
});

/** Wait for a condition, bounded — the abort propagates asynchronously. */
async function waitFor(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('the condition never became true');
}

/** Bodies the two routes accept, so the lock is the only thing that can refuse. */
function post(
  route: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

interface ErrorEnvelope {
  error: { code: string; retryable: boolean; details?: { jobId?: unknown } };
}

describe('the busy guard before a stream opens', () => {
  test('reject mode answers a JSON 409 on both routes that own the check', async () => {
    let ran = false;
    const idle: AgentModule = {
      runTask: () => {
        ran = true;
        return Promise.resolve({ ok: true, summary: 'never runs while another job holds the lock' });
      },
    };
    registerAgent('cowork', idle);

    const held = await acquire({ tool: 'chat', label: 'holder' });
    try {
      // The agent route — the copy that used to live in `http/agents.ts`.
      const agent = await post('/api/cowork/run-task', {
        chatId: 'busy-chat',
        modelId: 'busy-model',
        prompt: 'hello',
      });
      assert.equal(agent.status, 409);
      assert.match(
        agent.headers.get('content-type') ?? '',
        /application\/json/,
        'the client asked for a stream and must get JSON while it still can',
      );
      const envelope = (await agent.json()) as ErrorEnvelope;
      assert.equal(envelope.error.code, 'busy');
      assert.equal(envelope.error.retryable, true);
      // The refusal names the job in the way, which is what makes it actionable.
      assert.equal(envelope.error.details?.jobId, held.id);
      assert.equal(ran, false, 'the agent was started despite the lock being held');

      // The chat route — the copy that used to live in `http/chat.ts`.
      const chat = await post('/api/chat/stream', {
        chatId: 'busy-chat',
        tool: 'chat',
        modelId: 'busy-model',
        prompt: 'hello',
      });
      assert.equal(chat.status, 409);
      assert.match(chat.headers.get('content-type') ?? '', /application\/json/);
      assert.equal(((await chat.json()) as ErrorEnvelope).error.code, 'busy');
    } finally {
      held.release();
    }
  });

  test('queue mode opens the stream and gives the queue its place back when abandoned', async () => {
    setSetting('concurrency_mode', 'queue');
    let ran = false;
    registerAgent('cowork', {
      runTask: () => {
        ran = true;
        return Promise.resolve({ ok: true, summary: 'ran' });
      },
    });

    const held = await acquire({ tool: 'chat', label: 'holder' });
    try {
      const controller = new AbortController();
      const response = await post(
        '/api/cowork/run-task',
        { chatId: 'busy-chat', modelId: 'busy-model', prompt: 'hello' },
        controller.signal,
      );

      // Not refused: the stream is open and the request is waiting inside the lock.
      // The mode reaches `assertNotBusy` from the setting, so a call site that
      // passed `'reject'` literally would fail exactly here.
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      assert.equal(ran, false, 'a queued run must not start before it holds the lock');
      assert.equal(queueDepth(), 1, 'the request should be waiting its turn');

      // Abandoning it must take the waiter out of the queue, not leave a dead
      // entry behind that a later job would wait for.
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
      await waitFor(() => queueDepth() === 0);
      assert.equal(ran, false);
    } finally {
      held.release();
      setSetting('concurrency_mode', 'reject');
    }
  });
});
