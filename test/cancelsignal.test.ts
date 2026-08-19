/**
 * The composite stop signal on AgentContext.
 *
 * `ctx.signal` used to be `sse.signal` verbatim, which fires only when the
 * browser goes away. Cancelling a run through it would therefore have meant
 * closing the stream that still has to deliver the `stopped` frame and whatever
 * partial work the agent managed — the channel would die before the answer got
 * out.
 *
 * So a run may now be given a second, independent reason to stop. What these
 * tests protect is that adding it did not quietly cost anything: a disconnect
 * must still abort exactly as before, and a context with nothing to cancel must
 * behave identically to the old code.
 */

import assert from 'node:assert/strict';
import test, { after, beforeEach, describe } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';
import type { SseSink } from '../src/orchestrator/sse.ts';

const { SseStream } = await import('../src/orchestrator/sse.ts');
const { createAgentContext } = await import('../src/orchestrator/agentContext.ts');

/**
 * The real SseStream registers a `close` listener on its sink, which is how a
 * browser disconnect reaches `sse.signal`. Capturing that listener is the only
 * way to simulate a disconnect without a socket.
 */
class ClosableSink implements SseSink {
  #closeHandlers: (() => void)[] = [];
  writableEnded = false;
  headersSent = false;
  write(): boolean {
    return true;
  }
  end(): void {
    this.writableEnded = true;
  }
  setHeader(): unknown {
    return this;
  }
  flushHeaders(): void {}
  on(event: string, handler: () => void): unknown {
    if (event === 'close') this.#closeHandlers.push(handler);
    return this;
  }
  /** Pretends the browser went away. */
  disconnect(): void {
    for (const handler of this.#closeHandlers) handler();
  }
}

function newContext(cancelSignal?: AbortSignal) {
  const sink = new ClosableSink();
  const sse = new SseStream(sink);
  const ctx = createAgentContext({
    tool: 'code',
    chatId: 'chat-cancel',
    modelId: 'mock-model',
    sse,
    ...(cancelSignal === undefined ? {} : { cancelSignal }),
  });
  return { ctx, sse, sink };
}

beforeEach(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

describe('giving a run a second reason to stop', () => {
  test('with nothing to cancel, ctx.signal is the disconnect signal itself', () => {
    const { ctx, sse } = newContext();
    // Not merely equivalent — the same object. A run that cannot be cancelled
    // should not pay for a wrapper, and identity is the cheapest proof that the
    // old behaviour is untouched.
    assert.equal(ctx.signal, sse.signal);
  });

  test('a disconnect still aborts when a cancel signal is also present', () => {
    const controller = new AbortController();
    const { ctx, sink } = newContext(controller.signal);

    assert.equal(ctx.signal.aborted, false);
    sink.disconnect();

    // The regression this guards: combining the two must not cost the original
    // disconnect abort, which is what stops an in-flight provider request when
    // the user closes the tab.
    assert.equal(ctx.signal.aborted, true);
  });

  test('cancelling aborts the work without touching the stream', () => {
    const controller = new AbortController();
    const { ctx, sse, sink } = newContext(controller.signal);

    controller.abort();

    assert.equal(ctx.signal.aborted, true);
    // The whole point. The stream is still open and still writable, so the
    // caller can go on to emit `stopped` and flush partial results to a client
    // that is still listening.
    assert.equal(sse.signal.aborted, false);
    assert.equal(sink.writableEnded, false);
  });

  test('a signal that was already aborted is respected immediately', () => {
    // A cancel that lands between claiming the run and building the context
    // must not start work that nobody is waiting for.
    const { ctx } = newContext(AbortSignal.abort());
    assert.equal(ctx.signal.aborted, true);
  });

  test('ctx.signal reflects a cancellation that arrives after it was first read', () => {
    const controller = new AbortController();
    const { ctx } = newContext(controller.signal);

    const captured = ctx.signal;
    controller.abort();

    // An agent that stores ctx.signal once — as any long-running loop will —
    // must still observe the abort. A getter returning a fresh object per call
    // would break this and leave the stored copy permanently unaborted.
    assert.equal(captured.aborted, true);
    assert.equal(ctx.signal.aborted, true);
  });
});
