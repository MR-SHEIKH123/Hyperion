/**
 * The pause/resume contract, exercised against simulated provider failures.
 *
 * This is deliverable 4, and the assertions are written against the promises the
 * spec makes to the user rather than against the implementation:
 *
 *   - a provider failure pauses; it never throws out of `sendMessage`, never
 *     truncates history, and never discards the partial reply
 *   - nothing retries into the same broken provider once it has been judged
 *     unhealthy — the request count stops growing
 *   - a failover to a *different* provider auto-resumes, emitting `paused`
 *     immediately followed by `resumed`
 *   - a manual provider switch on a paused run resumes it and keeps the earlier
 *     partial text in the same message
 *   - only one generation may be in flight app-wide
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupHome, freshDb, startMockProvider } from './helpers.ts';
import type { MockProvider } from './helpers.ts';
import type { SseSink } from '../src/orchestrator/sse.ts';

// Imported after helpers.ts has set the environment.
const { SseStream } = await import('../src/orchestrator/sse.ts');
const { sendMessage, switchAndResume } = await import('../src/orchestrator/chat.ts');
const { createProvider } = await import('../src/providers/repository.ts');
const { resetAllHealth } = await import('../src/providers/health.ts');
const { latestRunForChat, listPausedRuns, reconcileOrphanedRuns } = await import(
  '../src/orchestrator/runState.ts'
);
const { listMessages } = await import('../src/db/chats.ts');
const { acquire, isBusy, resetLock } = await import('../src/orchestrator/lock.ts');
const { summarizeUsage } = await import('../src/db/usage.ts');
const { AppError } = await import('../src/util/errors.ts');

const MODEL = 'mock-model';

// --- SSE capture -----------------------------------------------------------

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Captures raw SSE bytes so the tests assert on the wire format the frontend
 * actually parses, not on an internal event array.
 */
class FakeSink implements SseSink {
  chunks: string[] = [];
  writableEnded = false;
  headersSent = false;
  headers: Record<string, string> = {};
  #closers: (() => void)[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): void {
    this.writableEnded = true;
  }

  setHeader(name: string, value: string): unknown {
    this.headers[name] = value;
    return this;
  }

  flushHeaders(): void {}

  on(_event: 'close', listener: () => void): unknown {
    this.#closers.push(listener);
    return this;
  }

  /** Simulates the browser disconnecting. */
  hangUp(): void {
    for (const close of this.#closers) close();
  }

  frames(): Frame[] {
    const out: Frame[] = [];
    for (const block of this.chunks.join('').split('\n\n')) {
      if (block.trim() === '' || block.startsWith(':')) continue;
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      out.push({ event, data: JSON.parse(data.join('\n') || '{}') as Record<string, unknown> });
    }
    return out;
  }

  names(): string[] {
    return this.frames().map((frame) => frame.event);
  }

  first(event: string): Frame | undefined {
    return this.frames().find((frame) => frame.event === event);
  }

  text(): string {
    return this.frames()
      .filter((frame) => frame.event === 'token')
      .map((frame) => String(frame.data.text ?? ''))
      .join('');
  }
}

function newStream(): { sse: InstanceType<typeof SseStream>; sink: FakeSink } {
  const sink = new FakeSink();
  return { sse: new SseStream(sink), sink };
}

// --- fixtures --------------------------------------------------------------

let alpha: MockProvider;
let beta: MockProvider;

before(async () => {
  alpha = await startMockProvider();
  beta = await startMockProvider();
});

beforeEach(async () => {
  await freshDb();
  resetAllHealth();
  resetLock();
  alpha.behave({ models: [MODEL], tokens: ['Hello', ' world'], failStatus: undefined, truncateAfter: undefined });
  beta.behave({ models: [MODEL], tokens: ['Beta'], failStatus: undefined, truncateAfter: undefined });
});

after(async () => {
  await alpha.close();
  await beta.close();
  await cleanupHome();
});

function useAlpha(enabled = true): string {
  const provider = createProvider({ name: 'Alpha', type: 'remote', baseUrl: alpha.baseUrl, enabled });
  return provider.id;
}

function useBeta(enabled = false): string {
  const provider = createProvider({ name: 'Beta', type: 'remote', baseUrl: beta.baseUrl, enabled });
  return provider.id;
}

// --- happy path ------------------------------------------------------------

test('a successful exchange streams tokens, completes the run, and logs usage', async () => {
  useAlpha();
  const { sse, sink } = newStream();

  const result = await sendMessage(
    { chatId: 'chat-ok', tool: 'chat', modelId: MODEL, prompt: 'hi' },
    sse,
  );

  assert.equal(result.state, 'complete');
  assert.equal(result.content, 'Hello world');
  assert.equal(sink.text(), 'Hello world');
  assert.deepEqual(sink.names().slice(0, 2), ['open', 'token']);
  assert.ok(sink.names().includes('done'));

  const run = latestRunForChat('chat-ok');
  assert.equal(run?.state, 'complete');

  const messages = listMessages('chat-ok');
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, 'user');
  assert.equal(messages[1]?.status, 'complete');
  assert.equal(messages[1]?.tokensOut, 22);

  const usage = summarizeUsage({});
  assert.equal(usage.totals.requests, 1);
  assert.equal(usage.totals.tokensIn, 11);
  // No price row is configured. The priced total is 0 because nothing priced was
  // spent — but the request is counted as unpriced so the dashboard can say
  // "cost unknown" rather than presenting 0 as the truth.
  assert.equal(usage.totals.costUsd, 0);
  assert.equal(usage.totals.unpricedRequests, 1);
  assert.equal(usage.hasUnpriced, true);
});

// --- failure pauses --------------------------------------------------------

test('a dead provider with no alternative pauses the run instead of throwing', async () => {
  useAlpha();
  alpha.behave({ failStatus: 500 });
  const { sse, sink } = newStream();

  const result = await sendMessage(
    { chatId: 'chat-dead', tool: 'chat', modelId: MODEL, prompt: 'are you there?' },
    sse,
  );

  assert.equal(result.state, 'paused');

  const paused = sink.first('paused');
  assert.ok(paused, 'a paused event must be emitted');
  assert.equal(paused.data.reason, 'no_healthy_provider');
  assert.ok(String(paused.data.message).length > 0, 'the pause must carry a readable reason');
  // Pausing is a state, not a transport error: no `error` frame is sent.
  assert.ok(!sink.names().includes('error'));

  const run = latestRunForChat('chat-dead');
  assert.equal(run?.state, 'paused');
  assert.equal(run?.pauseReason, 'no_healthy_provider');

  // History is completely intact.
  const messages = listMessages('chat-dead');
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.content, 'are you there?');
  assert.equal(messages[0]?.status, 'complete');
  assert.equal(messages[1]?.status, 'paused');

  assert.equal(listPausedRuns('chat-dead').length, 1);
});

test('a paused run does not retry into the same broken provider', async () => {
  useAlpha();
  alpha.behave({ failStatus: 500 });
  // streamCalls accumulates for the lifetime of the mock server, so measure a
  // delta rather than an absolute count.
  const baseline = alpha.streamCalls.length;
  const { sse } = newStream();

  await sendMessage({ chatId: 'chat-noretry', tool: 'chat', modelId: MODEL, prompt: 'x' }, sse);

  // Two attempts is the *cost of establishing* the 2-failure health threshold,
  // and both happen before any output. What must never happen is a third.
  const afterPause = alpha.streamCalls.length;
  assert.equal(afterPause - baseline, 2);

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(alpha.streamCalls.length, afterPause, 'nothing may retry without the user asking');
});

test('a failure after the first token keeps the partial reply and pauses', async () => {
  useAlpha();
  useBeta(); // a healthy alternative exists, and must still NOT be used
  alpha.behave({ tokens: ['Hello', ' world'], truncateAfter: 1 });
  const { sse, sink } = newStream();

  const result = await sendMessage(
    { chatId: 'chat-partial', tool: 'chat', modelId: MODEL, prompt: 'go' },
    sse,
  );

  assert.equal(result.state, 'paused');
  assert.equal(result.content, 'Hello');
  assert.equal(sink.text(), 'Hello');

  const paused = sink.first('paused');
  assert.equal(paused?.data.partialContent, 'Hello');

  // Silently restarting elsewhere would duplicate text the user has read.
  assert.ok(!sink.names().includes('resumed'));
  assert.equal(beta.streamCalls.length, 0);

  const messages = listMessages('chat-partial');
  assert.equal(messages[1]?.content, 'Hello');
  assert.equal(messages[1]?.status, 'paused');
  assert.ok(messages[1]?.errorMessage);
});

// --- failover auto-resume --------------------------------------------------

test('failover to a different provider pauses then auto-resumes in one call', async () => {
  useAlpha();
  useBeta();
  alpha.behave({ failStatus: 500 });
  const { sse, sink } = newStream();

  const result = await sendMessage(
    { chatId: 'chat-failover', tool: 'chat', modelId: MODEL, prompt: 'hello?' },
    sse,
  );

  assert.equal(result.state, 'complete');
  assert.equal(result.content, 'Beta');

  const names = sink.names();
  const pausedAt = names.indexOf('paused');
  const resumedAt = names.indexOf('resumed');
  assert.ok(pausedAt >= 0, 'the interruption is reported honestly');
  assert.ok(resumedAt > pausedAt, 'and is immediately followed by resumed');
  assert.ok(names.indexOf('token') > resumedAt, 'output only starts after the switch');

  assert.equal(sink.first('resumed')?.data.providerName, 'Beta');

  // The failed provider was evicted and the replacement took over as active.
  const { getActiveProvider } = await import('../src/providers/repository.ts');
  assert.equal(getActiveProvider()?.name, 'Beta');

  const run = latestRunForChat('chat-failover');
  assert.equal(run?.state, 'complete');
  assert.equal(run?.providerName, 'Beta');
});

// --- manual switch and resume ---------------------------------------------

test('a manual provider switch resumes a paused run and keeps the partial text', async () => {
  useAlpha();
  const betaId = useBeta();
  // Truncating mid-output pauses without failing over, which is the state a
  // manual switch is meant to rescue.
  alpha.behave({ tokens: ['Hello', ' world'], truncateAfter: 1 });

  const first = newStream();
  const paused = await sendMessage(
    { chatId: 'chat-switch', tool: 'chat', modelId: MODEL, prompt: 'continue please' },
    first.sse,
  );
  assert.equal(paused.state, 'paused');

  const second = newStream();
  const resumed = await switchAndResume({ runId: paused.runId, providerId: betaId }, second.sse);

  assert.equal(resumed.state, 'complete');
  assert.equal(resumed.messageId, paused.messageId, 'the reply continues in the same message');
  // 'Hello' survived the truncated Alpha attempt; Beta's output is appended to
  // it rather than replacing it, so nothing the user already read disappears.
  assert.equal(resumed.content, 'HelloBeta', 'the new output is appended to what survived');


  const run = latestRunForChat('chat-switch');
  assert.equal(run?.state, 'complete');
  assert.equal(run?.attempt, 2);

  const messages = listMessages('chat-switch');
  assert.equal(messages.length, 2, 'no duplicate assistant bubble is created');
  assert.equal(messages[1]?.status, 'complete');
  assert.equal(messages[1]?.providerName, 'Beta');
});

test('a failed manual switch leaves the run paused rather than falling back', async () => {
  useAlpha();
  const betaId = useBeta();
  // Every configured provider is broken, so there is nowhere to fall back to.
  alpha.behave({ failStatus: 500 });
  beta.behave({ failStatus: 503 });

  const first = newStream();
  const paused = await sendMessage(
    { chatId: 'chat-badswitch', tool: 'chat', modelId: MODEL, prompt: 'x' },
    first.sse,
  );
  assert.equal(paused.state, 'paused');

  const second = newStream();
  const still = await switchAndResume({ runId: paused.runId, providerId: betaId }, second.sse);

  assert.equal(still.state, 'paused');
  const run = latestRunForChat('chat-badswitch');
  assert.equal(run?.state, 'paused');
  assert.ok(second.sink.first('paused'), 'the frontend is told it is still paused');
});

test('resuming a run that is not paused is refused', async () => {
  useAlpha();
  const { sse } = newStream();
  const done = await sendMessage(
    { chatId: 'chat-notpaused', tool: 'chat', modelId: MODEL, prompt: 'hi' },
    sse,
  );

  await assert.rejects(
    () => switchAndResume({ runId: done.runId }, newStream().sse),
    (error: unknown) => error instanceof AppError && error.code === 'run_not_paused',
  );
});

// --- capability mismatch ---------------------------------------------------

test('a model no configured provider offers fails fast without any upstream call', async () => {
  useAlpha();
  const before = alpha.streamCalls.length;
  const { sse, sink } = newStream();

  const result = await sendMessage(
    { chatId: 'chat-nomodel', tool: 'chat', modelId: 'deepseek-r1', prompt: 'hi' },
    sse,
  );

  assert.equal(result.state, 'paused');
  assert.equal(alpha.streamCalls.length, before, 'a capability miss must cost zero requests');
  assert.equal(sink.first('paused')?.data.reason, 'capability_mismatch');
  assert.equal(sink.first('paused')?.data.retryable, false);
});

test('a capability switch lifts its own pause instead of leaving the banner stuck', async () => {
  // Alpha is active but only knows 'mock-model'; Beta is the standby that has
  // the requested one. Priming both caches matters: the capability check is
  // cache-only, and an empty cache means "might work", which would send the
  // request to Alpha instead of switching.
  useAlpha();
  useBeta();
  alpha.behave({ models: [MODEL] });
  beta.behave({ models: [MODEL, 'special-model'], tokens: ['Beta'] });
  const { ensureModelsCached } = await import('../src/providers/registry.ts');
  const { listProviders } = await import('../src/providers/repository.ts');
  for (const provider of listProviders()) await ensureModelsCached(provider);

  const before = alpha.streamCalls.length;
  const { sse, sink } = newStream();

  const result = await sendMessage(
    { chatId: 'chat-capswitch', tool: 'chat', modelId: 'special-model', prompt: 'hi' },
    sse,
  );

  assert.equal(result.state, 'complete');
  assert.equal(result.content, 'Beta');
  assert.equal(alpha.streamCalls.length, before, 'the mismatch is still decided from cache');

  // The regression: a capability mismatch is settled during *selection*, so the
  // switch is announced before the first `provider` event. When `resumed` was
  // emitted only as the alternative to `open`, this pause was never lifted and
  // the frontend's paused banner stayed up through a successful reply. Health
  // failover, which switches after `open`, was the only path that worked.
  const names = sink.names();
  const pausedAt = names.indexOf('paused');
  const openAt = names.indexOf('open');
  const resumedAt = names.indexOf('resumed');
  assert.ok(pausedAt >= 0, 'the switch is disclosed as a pause');
  assert.equal(sink.first('paused')?.data.reason, 'capability_mismatch');
  assert.ok(openAt > pausedAt, 'the replacement provider still announces itself');
  assert.ok(resumedAt >= 0, 'and the pause must be lifted');
  assert.ok(resumedAt > openAt, 'resumed follows open rather than replacing it');
  assert.ok(names.indexOf('token') > resumedAt, 'output only starts once resumed is out');

  assert.equal(sink.first('resumed')?.data.providerName, 'Beta');

  const run = latestRunForChat('chat-capswitch');
  assert.equal(run?.state, 'complete');
  assert.equal(run?.providerName, 'Beta');
  assert.equal(listPausedRuns('chat-capswitch').length, 0, 'nothing is left parked');
});


// --- crash recovery --------------------------------------------------------

test('a run left streaming by a restart is reconciled to paused, not lost', async () => {
  useAlpha();
  alpha.behave({ hang: true });

  const { sse } = newStream();
  const pending = sendMessage({ chatId: 'chat-crash', tool: 'chat', modelId: MODEL, prompt: 'hi' }, sse);
  // Let the run row reach 'running' before pretending the process died.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const reconciled = reconcileOrphanedRuns();
  assert.ok(reconciled >= 1);
  const run = latestRunForChat('chat-crash');
  assert.equal(run?.state, 'paused');
  assert.ok(String(run?.errorMessage).includes('restarted'));

  // The in-flight request eventually times out; it must not throw unhandled.
  const settled = await pending;
  assert.equal(settled.state, 'paused');
});

// --- single active job -----------------------------------------------------

test('only one generation may run at a time', async () => {
  const held = await acquire({ tool: 'chat', mode: 'reject' });
  assert.equal(isBusy(), true);

  await assert.rejects(
    () => acquire({ tool: 'code', mode: 'reject' }),
    (error: unknown) => error instanceof AppError && error.code === 'busy',
  );

  held.release();
  assert.equal(isBusy(), false);

  // Releasing twice must not corrupt the lock for the next job.
  held.release();
  const next = await acquire({ tool: 'design', mode: 'reject' });
  assert.equal(next.id !== held.id, true);
  next.release();
});
