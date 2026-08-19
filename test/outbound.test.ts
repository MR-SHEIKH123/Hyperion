/**
 * The outbound data safety layer (Part 1.23).
 *
 * The guarantees asserted here are the ones a user would state:
 *
 *   - the check is off until switched on, and switching it on does not change
 *     what a local provider is allowed to receive
 *   - a remote send carrying credential-shaped text is refused with a code the
 *     UI can branch on, and the refusal names *what* was found without ever
 *     quoting it
 *   - a refusal leaves the conversation exactly as it was, so acknowledging and
 *     resending stores the prompt once rather than twice
 *   - spend is attributable to where the bytes actually went, including for rows
 *     whose provider no longer exists
 *
 * The HTTP half boots the real app, because two of these cases are route-order
 * and error-envelope behaviour that no module-level call can reach.
 */

import assert from 'node:assert/strict';
import test, { after, before, beforeEach, describe } from 'node:test';

import { cleanupHome, freshDb, startMockProvider } from './helpers.ts';
import type { MockProvider } from './helpers.ts';
import type { SseSink } from '../src/orchestrator/sse.ts';

import type { Server } from 'node:http';

const { findSensitive, containsSensitive, looksRedacted } = await import('../src/util/redact.ts');
const { assertOutboundSafe, classifyProviderType, describeKinds, isEgress, scanForSensitive } =
  await import('../src/services/safety/outbound.ts');
const { recordUsage, summarizeExposure, summarizeUsage } = await import('../src/db/usage.ts');
const { REDACTION_CHECK_KEY, redactionCheckEnabled, setSetting } = await import(
  '../src/db/settings.ts'
);
const { createProvider, deleteProvider } = await import('../src/providers/repository.ts');
const { sendMessage } = await import('../src/orchestrator/chat.ts');
const { SseStream } = await import('../src/orchestrator/sse.ts');
const { listMessages } = await import('../src/db/chats.ts');
const { AppError } = await import('../src/util/errors.ts');

const MODEL = 'mock-model';

/** A string that trips `vendor_prefixed_key`, assembled so it is not itself a literal key. */
const FAKE_KEY = `sk-${'A1b2C3d4E5f6G7h8'}`;

// --- SSE capture -----------------------------------------------------------

class FakeSink implements SseSink {
  chunks: string[] = [];
  writableEnded = false;
  headersSent = false;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): void {
    this.writableEnded = true;
  }
  setHeader(): unknown {
    return this;
  }
  flushHeaders(): void {}
  on(): unknown {
    return this;
  }
  raw(): string {
    return this.chunks.join('');
  }
}

function newStream(): InstanceType<typeof SseStream> {
  return new SseStream(new FakeSink());
}

// --- fixtures --------------------------------------------------------------

let mock: MockProvider;

before(async () => {
  mock = await startMockProvider();
});

beforeEach(async () => {
  await freshDb();
});

after(async () => {
  await mock.close();
  await cleanupHome();
});

// --- detection -------------------------------------------------------------

describe('finding credential-shaped text', () => {
  test('a finding reports its rule and offset but never the matched text', () => {
    const text = `here is my key: ${FAKE_KEY} — use it`;
    const findings = findSensitive(text);

    assert.equal(findings.length, 1);
    const finding = findings[0];
    assert.ok(finding);
    assert.equal(finding.kind, 'vendor_prefixed_key');
    // The offset must actually point at the key, or the UI would highlight the
    // wrong span.
    assert.equal(text.slice(finding.index, finding.index + finding.length), FAKE_KEY);
    // The finding is offsets and a rule name — no field carries the secret.
    assert.deepEqual(Object.keys(finding).sort(), ['index', 'kind', 'length'].sort());
  });

  test('ordinary prose produces no findings', () => {
    assert.deepEqual(findSensitive('Summarise the second paragraph of this document.'), []);
    assert.equal(containsSensitive('Summarise the second paragraph of this document.'), false);
  });

  test('a repeated key is reported once per occurrence', () => {
    // Regex state bleeding between calls (a shared `lastIndex` on a /g pattern)
    // shows up here as a missing second hit.
    const findings = findSensitive(`${FAKE_KEY} and again ${FAKE_KEY}`);
    assert.equal(findings.length, 2);
    assert.ok(findings[0] && findings[1]);
    assert.ok(findings[1].index > findings[0].index);
  });

  test('scanning the same text twice gives the same answer', () => {
    const text = `token: ${FAKE_KEY}`;
    assert.deepEqual(findSensitive(text), findSensitive(text));
  });

  test('findings are ordered by position, whichever rule matched', () => {
    const text = `password=hunter2xyz then ${FAKE_KEY}`;
    const findings = findSensitive(text);
    assert.ok(findings.length >= 2);
    for (let i = 1; i < findings.length; i += 1) {
      const previous = findings[i - 1];
      const current = findings[i];
      assert.ok(previous && current);
      assert.ok(current.index >= previous.index);
    }
  });

  test('looksRedacted is not a "contains a secret" predicate', () => {
    // The inverse reading is the trap this asserts against: reaching for
    // looksRedacted as the outbound check would wave through every payload that
    // actually carries a key.
    assert.equal(looksRedacted('nothing to see here'), true);
    assert.equal(looksRedacted(`key ${FAKE_KEY}`), false);
    // ...which is the opposite polarity to the detector.
    assert.equal(containsSensitive('nothing to see here'), false);
    assert.equal(containsSensitive(`key ${FAKE_KEY}`), true);
  });
});

// --- classification --------------------------------------------------------

describe('classifying where a request goes', () => {
  test('colibri is local and opencodex is remote', () => {
    // Both are the counter-intuitive ones: colibri sounds hosted and opencodex
    // sounds self-hosted, and both readings are wrong.
    assert.equal(classifyProviderType('colibri'), 'local');
    assert.equal(classifyProviderType('local'), 'local');
    assert.equal(classifyProviderType('opencodex'), 'remote');
    assert.equal(classifyProviderType('remote'), 'remote');
  });

  test('an absent type is unknown rather than assumed safe', () => {
    assert.equal(classifyProviderType(null), 'unknown');
    assert.equal(classifyProviderType(undefined), 'unknown');
    assert.equal(isEgress(null), false);
  });

  test('describeKinds names every rule it is given', () => {
    assert.match(describeKinds(['vendor_prefixed_key']), /vendor prefix/);
    const both = describeKinds(['vendor_prefixed_key', 'named_secret_field']);
    assert.match(both, /vendor prefix/);
    assert.match(both, / and /);
  });
});

// --- the gate --------------------------------------------------------------

describe('the outbound gate', () => {
  const dirty = [{ role: 'user' as const, content: `use ${FAKE_KEY} please` }];

  test('does nothing at all while the check is switched off', () => {
    const report = assertOutboundSafe({ messages: dirty, providerType: 'remote', enabled: false });
    assert.equal(report, null);
  });

  test('does not warn about a payload that never leaves the machine', () => {
    assert.equal(
      assertOutboundSafe({ messages: dirty, providerType: 'local', enabled: true }),
      null,
    );
    assert.equal(
      assertOutboundSafe({ messages: dirty, providerType: 'colibri', enabled: true }),
      null,
    );
  });

  test('refuses a remote send and says which rule matched', () => {
    try {
      assertOutboundSafe({ messages: dirty, providerType: 'remote', enabled: true });
      assert.fail('expected the gate to refuse');
    } catch (error) {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'redaction_flagged');
      assert.equal(error.status, 409);
      // Resending the identical body cannot succeed, so nothing should retry it.
      assert.equal(error.retryable, false);
      assert.deepEqual(error.details?.kinds, ['vendor_prefixed_key']);
      assert.equal(error.details?.providerClass, 'remote');
    }
  });

  test('the refusal never quotes the text it objected to', () => {
    try {
      assertOutboundSafe({ messages: dirty, providerType: 'remote', enabled: true });
      assert.fail('expected the gate to refuse');
    } catch (error) {
      assert.ok(error instanceof AppError);
      // Serialized exactly as the HTTP layer would send it.
      const wire = JSON.stringify(error.toJSON());
      assert.equal(wire.includes(FAKE_KEY), false);
      assert.equal(wire.includes('A1b2C3d4E5f6G7h8'), false);
    }
  });

  test('an acknowledged send goes through, and still reports what was found', () => {
    const report = assertOutboundSafe({
      messages: dirty,
      providerType: 'remote',
      acknowledged: true,
      enabled: true,
    });
    assert.ok(report);
    assert.equal(report.flagged, true);
    assert.deepEqual(report.kinds, ['vendor_prefixed_key']);
  });

  test('a clean remote payload returns an unflagged report, not null', () => {
    const report = assertOutboundSafe({
      messages: [{ role: 'user', content: 'What time is it in Dhaka?' }],
      providerType: 'remote',
      enabled: true,
    });
    assert.ok(report);
    assert.equal(report.flagged, false);
    assert.deepEqual(report.hits, []);
  });

  test('a hit names the turn it came from', () => {
    const report = scanForSensitive([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: `here: ${FAKE_KEY}` },
    ]);
    assert.equal(report.hits.length, 1);
    assert.equal(report.hits[0]?.messageIndex, 1);
    assert.equal(report.hits[0]?.role, 'user');
  });
});

// --- the setting -----------------------------------------------------------

describe('the redaction-check setting', () => {
  test('defaults to off', () => {
    assert.equal(redactionCheckEnabled(), false);
  });

  test('round-trips', () => {
    setSetting(REDACTION_CHECK_KEY, true);
    assert.equal(redactionCheckEnabled(), true);
    setSetting(REDACTION_CHECK_KEY, false);
    assert.equal(redactionCheckEnabled(), false);
  });
});

// --- exposure accounting ---------------------------------------------------

describe('attributing spend to where it went', () => {
  function log(providerType: 'remote' | 'local' | 'colibri' | 'opencodex' | null, tokens: number) {
    recordUsage({
      tool: 'chat',
      modelId: MODEL,
      providerId: null,
      providerType,
      tokensIn: tokens,
      tokensOut: tokens,
      status: 'ok',
    });
  }

  test('remote and local traffic are counted separately', () => {
    log('remote', 10);
    log('opencodex', 5);
    log('local', 100);

    const summary = summarizeExposure();
    const remote = summary.byClass.find((bucket) => bucket.key === 'remote');
    const local = summary.byClass.find((bucket) => bucket.key === 'local');

    assert.equal(remote?.requests, 2);
    assert.equal(remote?.tokensIn, 15);
    assert.equal(local?.requests, 1);
    assert.equal(local?.tokensIn, 100);
    // Both provider types that fold into `remote` are named, so the user can see
    // why a row landed there.
    assert.deepEqual(remote?.providerTypes, ['opencodex', 'remote']);
    assert.equal(summary.hasUnclassified, false);
  });

  test('a row with no provider type gets its own bucket and is never folded away', () => {
    log(null, 7);

    const summary = summarizeExposure();
    const unknown = summary.byClass.find((bucket) => bucket.key === 'unknown');

    assert.equal(unknown?.requests, 1);
    assert.equal(summary.hasUnclassified, true);
    // Understating exposure is the one error this feature must not make, so an
    // unclassifiable row must not appear as local.
    assert.equal(
      summary.byClass.find((bucket) => bucket.key === 'local'),
      undefined,
    );
  });

  test('a NULL provider type is accepted rather than discarded', () => {
    // Migration 013 leaves the column nullable on purpose: recordUsage swallows
    // its own failures, so a NOT NULL column would drop the spend row silently
    // and reopen the cap-bypass hole.
    log(null, 3);
    assert.equal(summarizeUsage().totals.requests, 1);
  });

  test('the exposure total matches the plain usage total', () => {
    log('remote', 4);
    log('local', 6);
    log(null, 1);

    assert.equal(summarizeExposure().totals.requests, summarizeUsage().totals.requests);
    assert.equal(summarizeExposure().totals.tokensIn, summarizeUsage().totals.tokensIn);
  });

  test('deleting a provider does not erase the record of what it sent', () => {
    const provider = createProvider({
      name: 'gone-remote',
      type: 'remote',
      baseUrl: 'https://example.invalid',
      apiKey: null,
      enabled: false,
    });
    recordUsage({
      tool: 'chat',
      modelId: MODEL,
      providerId: provider.id,
      providerType: 'remote',
      tokensIn: 20,
      tokensOut: 20,
      status: 'ok',
    });
    deleteProvider(provider.id);

    // The type was stamped at write time, so history does not change
    // retroactively when the provider row goes away.
    const remote = summarizeExposure().byClass.find((bucket) => bucket.key === 'remote');
    assert.equal(remote?.requests, 1);
    assert.equal(remote?.tokensIn, 20);
  });
});

// --- the chat path ---------------------------------------------------------

describe('sending a flagged message through chat', () => {
  test('a refused send leaves the conversation untouched', async () => {
    createProvider({
      name: 'remote-one',
      type: 'remote',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      enabled: true,
    });
    setSetting(REDACTION_CHECK_KEY, true);

    const chatId = 'chat-refused';
    await assert.rejects(
      sendMessage({ chatId, tool: 'chat', modelId: MODEL, prompt: `key ${FAKE_KEY}` }, newStream()),
      (error: unknown) => error instanceof AppError && error.code === 'redaction_flagged',
    );

    // Nothing persisted, and nothing sent: the user's next move is to edit or to
    // acknowledge, and either way they should not find a half-written turn.
    assert.deepEqual(listMessages(chatId), []);
    assert.equal(mock.streamCalls.length, 0);
  });

  test('acknowledging stores the prompt exactly once', async () => {
    createProvider({
      name: 'remote-two',
      type: 'remote',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      enabled: true,
    });
    setSetting(REDACTION_CHECK_KEY, true);

    const chatId = 'chat-acked';
    const prompt = `key ${FAKE_KEY}`;

    await assert.rejects(
      sendMessage({ chatId, tool: 'chat', modelId: MODEL, prompt }, newStream()),
      (error: unknown) => error instanceof AppError && error.code === 'redaction_flagged',
    );
    const result = await sendMessage(
      { chatId, tool: 'chat', modelId: MODEL, prompt, acknowledgeSensitive: true },
      newStream(),
    );

    assert.equal(result.state, 'complete');
    // One user turn, not two. This is the whole reason the gate runs before the
    // message is appended.
    const users = listMessages(chatId).filter((message) => message.role === 'user');
    assert.equal(users.length, 1);
    assert.equal(users[0]?.content, prompt);
  });

  test('a local provider receives the same text without complaint', async () => {
    // `colibri` rather than `local` on purpose. Both classify as local egress,
    // but `adapterFor` sends `local` to the ollama adapter (POST /api/chat,
    // JSONL) while `startMockProvider` only serves OpenAI chat-completions — so
    // a `local` provider here pauses on an unreachable route and the run would
    // never reach the gate, making the test pass or fail for the wrong reason.
    createProvider({
      name: 'colibri-one',
      type: 'colibri',
      baseUrl: mock.baseUrl,
      apiKey: null,
      enabled: true,
    });
    setSetting(REDACTION_CHECK_KEY, true);

    const result = await sendMessage(
      { chatId: 'chat-local', tool: 'chat', modelId: MODEL, prompt: `key ${FAKE_KEY}` },
      newStream(),
    );
    // Switching the check on must not change what a local model may be told.
    assert.equal(result.state, 'complete');
    assert.equal(listMessages('chat-local').filter((m) => m.role === 'user').length, 1);
  });

  test('the usage row records the provider type that served the turn', async () => {
    createProvider({
      name: 'remote-three',
      type: 'remote',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      enabled: true,
    });

    await sendMessage(
      { chatId: 'chat-typed', tool: 'chat', modelId: MODEL, prompt: 'hello' },
      newStream(),
    );

    const summary = summarizeExposure();
    assert.equal(summary.byClass.find((bucket) => bucket.key === 'remote')?.requests, 1);
    assert.equal(summary.hasUnclassified, false);
  });
});

// --- HTTP ------------------------------------------------------------------

describe('the outbound safety endpoints', () => {
  let server: Server;
  let base: string;

  before(async () => {
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
  });

  test('GET /api/providers/active is not swallowed by the /:id route', async () => {
    createProvider({
      name: 'active-remote',
      type: 'remote',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      enabled: true,
    });

    const res = await fetch(`${base}/api/providers/active`);
    const payload = (await res.json()) as {
      provider: { type: string; hasKey: boolean; apiKeyEnc?: unknown } | null;
      egress: string;
    };

    // Registered below `/:id` this was a 404 reading "No provider with id
    // \"active\"", which is the regression this asserts against.
    assert.equal(res.status, 200);
    assert.equal(payload.provider?.type, 'remote');
    assert.equal(payload.egress, 'remote');
    // The public serializer is still doing its job on this new route.
    assert.equal('apiKeyEnc' in (payload.provider ?? {}), false);
  });

  test('with nothing enabled, active is a 200 saying so', async () => {
    const res = await fetch(`${base}/api/providers/active`);
    const payload = (await res.json()) as { provider: unknown; egress: string };

    assert.equal(res.status, 200);
    assert.equal(payload.provider, null);
    assert.equal(payload.egress, 'unknown');
  });

  test('the redaction-check setting round-trips over HTTP and defaults off', async () => {
    const before = await fetch(`${base}/api/settings/redaction-check`);
    assert.equal(((await before.json()) as { enabled: boolean }).enabled, false);

    const put = await fetch(`${base}/api/settings/redaction-check`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(put.status, 200);
    assert.equal(((await put.json()) as { enabled: boolean }).enabled, true);

    const after = await fetch(`${base}/api/settings/redaction-check`);
    assert.equal(((await after.json()) as { enabled: boolean }).enabled, true);
  });

  test('PUT /api/settings/redaction-check without a body field is a 400 naming it', async () => {
    const res = await fetch(`${base}/api/settings/redaction-check`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const payload = (await res.json()) as { error: { code: string; details?: { field?: string } } };

    assert.equal(res.status, 400);
    assert.equal(payload.error.code, 'bad_request');
    assert.equal(payload.error.details?.field, 'enabled');
  });

  test('GET /api/usage/exposure-summary answers on an empty log', async () => {
    const res = await fetch(`${base}/api/usage/exposure-summary`);
    const payload = (await res.json()) as {
      byClass: unknown[];
      totals: { requests: number };
      hasUnclassified: boolean;
    };

    assert.equal(res.status, 200);
    assert.deepEqual(payload.byClass, []);
    assert.equal(payload.totals.requests, 0);
    assert.equal(payload.hasUnclassified, false);
  });

  test('on the streaming route the refusal arrives as an SSE frame under HTTP 200', async () => {
    createProvider({
      name: 'stream-remote',
      type: 'remote',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      enabled: true,
    });
    setSetting(REDACTION_CHECK_KEY, true);

    const chatId = 'chat-stream-refused';
    // `streamCalls` accumulates for the lifetime of the mock, which outlives
    // freshDb(), so "nothing was sent" is a comparison rather than a zero.
    const sentBefore = mock.streamCalls.length;
    const res = await fetch(`${base}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, tool: 'chat', modelId: MODEL, prompt: `key ${FAKE_KEY}` }),
    });
    const raw = await res.text();

    // Not a 409. The stream's status line is written before the orchestrator
    // runs, so the refusal can only come back inside the body. Documented in
    // API.md §20.6 and CONTRACTS.md; asserted here because the module-level
    // tests see the thrown AppError and so cannot observe what the socket does.
    assert.equal(res.status, 200);
    assert.match(raw, /event: error/);
    assert.match(raw, /"code":"redaction_flagged"/);

    // The frame carries only what sendError puts on the wire, so the hit spans
    // are absent. Asserted so that widening sendError to spread `details` shows
    // up here as a deliberate decision rather than an accident.
    assert.equal(raw.includes('"hits"'), false);
    assert.equal(raw.includes('"kinds"'), false);

    // The whole point of the refusal: the offending text never leaves, and it is
    // not echoed back in the error either.
    assert.equal(raw.includes(FAKE_KEY), false);
    assert.equal(mock.streamCalls.length, sentBefore);
    assert.deepEqual(listMessages(chatId), []);
  });
});
