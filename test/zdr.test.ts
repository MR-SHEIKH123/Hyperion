/**
 * Zero data retention (Part 1.26).
 *
 * The guarantees asserted here are the ones a user would state:
 *
 *   - `require` never lets a request reach a provider that has not been recorded
 *     as retaining nothing — including by failover, which is the case a check
 *     placed before dispatch would miss
 *   - a refusal on privacy grounds says so, with its own code and a 403, rather
 *     than presenting as an outage the user should wait out
 *   - a refusal leaves the conversation exactly as it was
 *   - `prefer` never blocks work, and every request it lets through under protest
 *     is recorded as having fallen short
 *   - local work is untouched by any of it
 *   - "confirmed" appears only where the user said so, never inferred
 *   - the opt-in flag reaches the wire for a remote provider and never for a local
 *     one, and can never displace the credential
 *   - an existing install migrates to no policy, unknown providers, and its old
 *     usage rows intact in a bucket of their own
 *
 * The HTTP half boots the real app: a stream route cannot report a refusal as a
 * status code, and only a live socket shows what it does instead.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before, beforeEach, describe } from 'node:test';

import { cleanupHome, freshDb, startMockProvider } from './helpers.ts';
import type { MockProvider } from './helpers.ts';
import type { SseSink } from '../src/orchestrator/sse.ts';
import type { CompletionRequest, ProviderRecord, ProviderType, ZdrSupport } from '../src/types/core.ts';

import type { Server } from 'node:http';

const { isZdrEligible, orderByZdr, zdrFlagFor, zdrPreferenceUnmet, zdrStatusFor } = await import(
  '../src/services/safety/zdr.ts'
);
const { ZDR_REQUIREMENT_KEY, setSetting, zdrRequirement } = await import('../src/db/settings.ts');
const { createProvider, findProvider, setProviderZdr, toPublic } = await import(
  '../src/providers/repository.ts'
);
const { openAiAdapter, openCodexAdapter } = await import('../src/providers/adapters.ts');
const { recordUsage, summarizeExposure, summarizeUsage } = await import('../src/db/usage.ts');
const { sendMessage } = await import('../src/orchestrator/chat.ts');
const { SseStream } = await import('../src/orchestrator/sse.ts');
const { listMessages } = await import('../src/db/chats.ts');
const { AppError } = await import('../src/util/errors.ts');
const { DEFAULT_PROVIDER_ZDR } = await import('../src/types/core.ts');
const { getDb } = await import('../src/db/adapter.ts');

const MODEL = 'mock-model';

/** Trips `vendor_prefixed_key`, assembled so this file contains no literal key. */
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

/**
 * A provider shape for the pure functions, with no database row behind it.
 *
 * The URL matters, because the egress class is derived from the type *and* the
 * address it will be called at: a `local` or `colibri` provider is only local if
 * that address is this machine, so a subject that is meant to be local is given
 * a loopback URL and one that is meant to be remote is not. (The case where a
 * local-typed provider points elsewhere is `test/egressclass.test.ts`.)
 */
function subject(
  type: ProviderType,
  support: ZdrSupport,
  extra: Partial<ProviderRecord['zdr']> = {},
  baseUrl = type === 'local' || type === 'colibri'
    ? 'http://127.0.0.1:11434/v1'
    : 'https://provider.test/v1',
) {
  return { type, zdr: { ...DEFAULT_PROVIDER_ZDR, support, ...extra }, baseUrl };
}

/** Records the headers and body of every request, then answers it plausibly. */
interface CaptureServer {
  baseUrl: string;
  calls: { path: string; headers: Record<string, string>; body: Record<string, unknown> }[];
  close(): Promise<void>;
}

/**
 * A server that reports what it was *sent*, which `startMockProvider` cannot:
 * it records bodies but not headers, and it serves no `/responses` route, so the
 * opencodex path has nowhere to land. Both are needed here, because "the flag
 * reached the wire" is a claim about the request, not about the reply.
 */
async function startCaptureServer(): Promise<CaptureServer> {
  const calls: CaptureServer['calls'] = [];

  const server = http.createServer((req, res) => {
    const path = req.url ?? '';

    if (path.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: MODEL }] }));
      return;
    }

    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[name.toLowerCase()] = value;
      }
      calls.push({ path, headers, body: JSON.parse(raw || '{}') as Record<string, unknown> });

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (path.endsWith('/responses')) {
        res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: { usage: { input_tokens: 1, output_tokens: 1 } },
          })}\n\n`,
        );
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' }, index: 0 }] })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          })}\n\n`,
        );
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('capture server failed to bind');

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function drain(stream: AsyncGenerator<unknown, void, unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // The reply is irrelevant here; the request is what is under test.
  }
}

function request(): CompletionRequest {
  return { modelId: MODEL, messages: [{ role: 'user', content: 'hello' }] };
}

/** The assistant turn of a finished exchange, for provider attribution. */
function assistantTurn(chatId: string) {
  return listMessages(chatId).find((message) => message.role === 'assistant');
}

let mock: MockProvider;
let failing: MockProvider;
let wrongModel: MockProvider;

before(async () => {
  mock = await startMockProvider();
  failing = await startMockProvider({ failStatus: 500 });
  wrongModel = await startMockProvider({ models: ['some-other-model'] });
});

beforeEach(async () => {
  await freshDb();
});

after(async () => {
  await mock.close();
  await failing.close();
  await wrongModel.close();
  await cleanupHome();
});

// --- the status table ------------------------------------------------------

describe('the ZDR status of a provider', () => {
  test('a local provider is local_no_egress whatever has been recorded about it', () => {
    // Both local types, and both regardless of `support`: retention by a third
    // party is not a question that arises for bytes that never left.
    assert.equal(zdrStatusFor(subject('local', 'unknown')), 'local_no_egress');
    assert.equal(zdrStatusFor(subject('colibri', 'not_supported')), 'local_no_egress');
    assert.equal(isZdrEligible(subject('local', 'unknown'), 'require'), true);
    assert.equal(isZdrEligible(subject('colibri', 'not_supported'), 'require'), true);
  });

  test('a remote provider with nothing recorded is zdr_unknown and ineligible', () => {
    // The default state of every provider on a fresh install, and the reason
    // `require` is unusable until the user records something.
    assert.equal(zdrStatusFor(subject('remote', 'unknown')), 'zdr_unknown');
    assert.equal(isZdrEligible(subject('remote', 'unknown'), 'require'), false);
  });

  test('supported_default is zdr_requested, not zdr_confirmed', () => {
    // The ceiling for anything Hyperion concludes on its own. A vendor saying it
    // retains nothing is not the user attesting that they checked.
    assert.equal(zdrStatusFor(subject('remote', 'supported_default')), 'zdr_requested');
  });

  test('an explicit confirmation, and only that, produces zdr_confirmed', () => {
    const confirmed = subject('remote', 'supported_default', { confirmedAt: 1_700_000_000_000 });
    assert.equal(zdrStatusFor(confirmed), 'zdr_confirmed');
  });

  test('opt-in counts only once the flag is actually usable', () => {
    // A recorded intent that would send nothing must not report as a request that
    // was made. Both halves of the flag are required.
    assert.equal(zdrStatusFor(subject('remote', 'supported_opt_in')), 'zdr_not_applied');
    assert.equal(
      zdrStatusFor(subject('remote', 'supported_opt_in', { requestFlag: { location: 'header', key: 'X-Zdr', value: '  ' } })),
      'zdr_not_applied',
    );
    assert.equal(
      zdrStatusFor(subject('remote', 'supported_opt_in', { requestFlag: { location: 'header', key: 'X-Zdr', value: 'true' } })),
      'zdr_requested',
    );
  });

  test('not_supported is standard_retention and not_applicable is zdr_not_applied', () => {
    // `not_applicable` is deliberately not treated as a promise: it says the
    // question does not arise, which is not the same as an answer.
    assert.equal(zdrStatusFor(subject('remote', 'not_supported')), 'standard_retention');
    assert.equal(zdrStatusFor(subject('remote', 'not_applicable')), 'zdr_not_applied');
    assert.equal(isZdrEligible(subject('remote', 'not_applicable'), 'require'), false);
  });

  test('an unclassifiable provider type is egress_unknown and fails closed', () => {
    // A build that does not recognise a type cannot say whether the bytes leave,
    // and "we do not know" is not evidence of safety — even paired with the
    // strongest possible support value.
    const alien = subject('quantum-link' as ProviderType, 'supported_default');
    assert.equal(zdrStatusFor(alien), 'egress_unknown');
    assert.equal(isZdrEligible(alien, 'require'), false);
    assert.equal(isZdrEligible(alien, 'prefer'), false);
    // `off` is not a policy, so nothing is ineligible under it.
    assert.equal(isZdrEligible(alien, 'off'), true);
  });
});

describe('applying the policy to a candidate list', () => {
  const eligible = subject('remote', 'supported_default');
  const barred = subject('remote', 'not_supported');

  test('off returns the list unchanged', () => {
    assert.deepEqual(orderByZdr([barred, eligible], 'off'), [barred, eligible]);
  });

  test('require removes the ineligible, leaving an empty list when it must', () => {
    assert.deepEqual(orderByZdr([barred, eligible], 'require'), [eligible]);
    assert.deepEqual(orderByZdr([barred], 'require'), []);
  });

  test('prefer keeps everything but moves the ineligible to the back', () => {
    // Sorting rather than filtering is what stops a preference from silently
    // becoming a prohibition when nothing eligible is configured.
    assert.deepEqual(orderByZdr([barred, eligible], 'prefer'), [eligible, barred]);
    assert.deepEqual(orderByZdr([barred], 'prefer'), [barred]);
  });

  test('prefer preserves the incoming order within each group', () => {
    // The incoming order already encodes health and priority, so a stable
    // partition is the only thing that does not throw that away.
    const first = subject('remote', 'not_supported');
    const second = subject('remote', 'unknown');
    assert.deepEqual(orderByZdr([first, second, eligible], 'prefer'), [eligible, first, second]);
  });

  test('a shortfall is only reported against a prefer policy', () => {
    assert.equal(zdrPreferenceUnmet('standard_retention', 'prefer'), true);
    assert.equal(zdrPreferenceUnmet('zdr_requested', 'prefer'), false);
    // `require` refuses instead of proceeding, and `off` asked for nothing.
    assert.equal(zdrPreferenceUnmet('standard_retention', 'require'), false);
    assert.equal(zdrPreferenceUnmet('standard_retention', 'off'), false);
    assert.equal(zdrPreferenceUnmet(null, 'prefer'), false);
  });
});

// --- recording the facts ---------------------------------------------------

describe('recording what a provider does with a request', () => {
  function remote(name: string) {
    return createProvider({ name, type: 'remote', baseUrl: 'https://example.invalid', apiKey: null });
  }

  test('a new provider starts with nothing recorded', () => {
    const provider = remote('fresh');
    assert.equal(provider.zdr.support, 'unknown');
    assert.equal(provider.zdr.requestFlag, null);
    assert.equal(provider.zdr.confirmedAt, null);
    assert.equal(provider.zdr.confirmedNote, null);
  });

  test('confirming is an explicit act, and retracting clears the note with it', () => {
    const provider = remote('attested');

    const recorded = setProviderZdr(provider.id, { support: 'supported_default' });
    assert.equal(recorded.zdr.confirmedAt, null, 'recording support must not confirm anything');
    assert.equal(zdrStatusFor(recorded), 'zdr_requested');

    const confirmed = setProviderZdr(provider.id, {
      support: 'supported_default',
      confirmed: true,
      note: 'checked the DPA on 2026-08-01',
    });
    assert.ok(confirmed.zdr.confirmedAt !== null);
    assert.equal(confirmed.zdr.confirmedNote, 'checked the DPA on 2026-08-01');
    assert.equal(zdrStatusFor(confirmed), 'zdr_confirmed');

    const retracted = setProviderZdr(provider.id, { support: 'supported_default', confirmed: false });
    // A note without a date is an assertion with nothing behind it, and it would
    // still be displayed — so retracting has to take both.
    assert.equal(retracted.zdr.confirmedAt, null);
    assert.equal(retracted.zdr.confirmedNote, null);
    assert.equal(zdrStatusFor(retracted), 'zdr_requested');
  });

  test('omitting confirmed leaves an existing attestation alone', () => {
    const provider = remote('kept');
    setProviderZdr(provider.id, { support: 'supported_default', confirmed: true, note: 'verified' });

    const edited = setProviderZdr(provider.id, { support: 'supported_opt_in' });
    assert.ok(edited.zdr.confirmedAt !== null, 'a support edit must not silently retract a confirmation');
    assert.equal(edited.zdr.confirmedNote, 'verified');
  });

  test('a flag value that looks like a credential is refused without being echoed', () => {
    const provider = remote('leaky');

    let thrown: unknown;
    try {
      setProviderZdr(provider.id, {
        support: 'supported_opt_in',
        requestFlag: { location: 'header', key: 'X-Zdr', value: FAKE_KEY },
      });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof AppError);
    assert.equal(thrown.code, 'bad_request');
    // The field is returned in plaintext by `toPublic`, so an error that quoted it
    // would publish the very thing being refused.
    assert.doesNotMatch(thrown.message, new RegExp(FAKE_KEY));
    assert.doesNotMatch(JSON.stringify(thrown.toJSON()), new RegExp(FAKE_KEY));
    // It still says which rule matched, or the user cannot tell what to change.
    assert.deepEqual(thrown.details?.kinds, ['vendor_prefixed_key']);
    // Nothing was written.
    assert.equal(findProvider(provider.id)?.zdr.requestFlag, null);
  });

  test('a flag round-trips to the frontend in plaintext, on purpose', () => {
    const provider = remote('flagged');
    const saved = setProviderZdr(provider.id, {
      support: 'supported_opt_in',
      requestFlag: { location: 'header', key: 'X-Data-Retention', value: 'none' },
    });

    // A field the user maintains by hand is unverifiable if it cannot be read
    // back. This is the one exception to `toPublic`'s no-secrets rule, and it is
    // safe because the write path rejects anything credential-shaped.
    assert.deepEqual(toPublic(saved).zdr.requestFlag, {
      location: 'header',
      key: 'X-Data-Retention',
      value: 'none',
    });
    // And it is still the case that no key material rides along.
    assert.equal('apiKeyEnc' in toPublic(saved), false);
  });

  test('clearing the flag reverts an opt-in provider to zdr_not_applied', () => {
    const provider = remote('cleared');
    setProviderZdr(provider.id, {
      support: 'supported_opt_in',
      requestFlag: { location: 'body', key: 'zdr', value: 'true' },
    });
    const cleared = setProviderZdr(provider.id, { support: 'supported_opt_in', requestFlag: null });

    assert.equal(cleared.zdr.requestFlag, null);
    assert.equal(zdrStatusFor(cleared), 'zdr_not_applied');
  });
});

// --- the wire --------------------------------------------------------------

describe('the opt-in flag on the wire', () => {
  let capture: CaptureServer;

  before(async () => {
    capture = await startCaptureServer();
  });

  after(async () => {
    await capture.close();
  });

  function flagged(name: string, type: ProviderType, location: 'header' | 'body', apiKey: string | null = null) {
    const provider = createProvider({ name, type, baseUrl: capture.baseUrl, apiKey });
    return setProviderZdr(provider.id, {
      support: 'supported_opt_in',
      requestFlag: { location, key: location === 'header' ? 'X-Data-Retention' : 'store', value: 'none' },
    });
  }

  test('a header flag reaches a remote provider', async () => {
    const provider = flagged('wire-remote', 'remote', 'header');
    const before = capture.calls.length;

    await drain(openAiAdapter.stream(provider, request()));

    const call = capture.calls[before];
    assert.ok(call);
    assert.equal(call.headers['x-data-retention'], 'none');
  });

  test('a body flag reaches a remote provider', async () => {
    const provider = flagged('wire-body', 'remote', 'body');
    const before = capture.calls.length;

    await drain(openAiAdapter.stream(provider, request()));

    const call = capture.calls[before];
    assert.ok(call);
    assert.equal(call.body.store, 'none');
    // The protocol fields must survive the merge.
    assert.equal(call.body.model, MODEL);
    assert.equal(call.body.stream, true);
  });

  test('the flag reaches opencodex, which is remote despite the name', async () => {
    const provider = flagged('wire-opencodex', 'opencodex', 'header');
    const before = capture.calls.length;

    await drain(openCodexAdapter.stream(provider, request()));

    const call = capture.calls[before];
    assert.ok(call);
    assert.match(call.path, /\/responses$/);
    assert.equal(call.headers['x-data-retention'], 'none');
  });

  test('the flag never reaches a local Colibrì served by the same adapter', async () => {
    // The gate is on egress class, not on the adapter. `openAiAdapter` serves both
    // `remote` and the local `colibri`, so keying off the adapter would send a
    // retention header to a runtime that has no retention policy.
    const provider = flagged('wire-colibri', 'colibri', 'header');
    const before = capture.calls.length;

    await drain(openAiAdapter.stream(provider, request()));

    const call = capture.calls[before];
    assert.ok(call);
    assert.equal(call.headers['x-data-retention'], undefined);
    assert.equal(zdrFlagFor(provider), null);
  });

  test('nothing is sent for a provider that needs no flag', async () => {
    const provider = createProvider({
      name: 'wire-default',
      type: 'remote',
      baseUrl: capture.baseUrl,
      apiKey: null,
    });
    const recorded = setProviderZdr(provider.id, { support: 'supported_default' });

    assert.equal(zdrFlagFor(recorded), null);
    const before = capture.calls.length;
    await drain(openAiAdapter.stream(recorded, request()));
    assert.deepEqual(Object.keys(capture.calls[before]?.body ?? {}).includes('store'), false);
  });

  test('a flag named Authorization cannot displace the credential', async () => {
    // Silently prevented rather than rejected on write: a header name is only
    // knowably harmful in the context it is used, and replacing the key with the
    // string "none" would present as an auth failure with no visible cause.
    const provider = flagged('wire-collide', 'remote', 'header', 'secret-key');
    const overriding = setProviderZdr(provider.id, {
      support: 'supported_opt_in',
      requestFlag: { location: 'header', key: 'Authorization', value: 'none' },
    });

    const before = capture.calls.length;
    await drain(openAiAdapter.stream(overriding, request()));

    assert.equal(capture.calls[before]?.headers.authorization, 'Bearer secret-key');
  });
});

// --- routing ---------------------------------------------------------------

describe('routing under require', () => {
  test('a request to an ineligible provider is refused before anything is written', async () => {
    createProvider({ name: 'unknown-remote', type: 'remote', baseUrl: mock.baseUrl, apiKey: 'k', enabled: true });
    setSetting(ZDR_REQUIREMENT_KEY, 'require');

    const chatId = 'chat-zdr-refused';
    const sentBefore = mock.streamCalls.length;

    let thrown: unknown;
    try {
      await sendMessage({ chatId, tool: 'chat', modelId: MODEL, prompt: 'hello' }, newStream());
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof AppError);
    assert.equal(thrown.code, 'zdr_requirement_unmet');
    // 403, not 409: no edit to the payload can resolve this, so it is not a
    // conflict the caller can fix by resending.
    assert.equal(thrown.status, 403);
    assert.equal(thrown.retryable, false);
    // The message has to say why a fresh install refuses everything, or correct
    // fail-closed behaviour reads as a bug.
    assert.match(thrown.message, /unknown/);

    // Nothing persisted and nothing sent: the transcript is exactly as it was.
    assert.deepEqual(listMessages(chatId), []);
    assert.equal(mock.streamCalls.length, sentBefore);
  });

  test('the refusal names the policy rather than blaming the model', async () => {
    const provider = createProvider({
      name: 'retaining-remote',
      type: 'remote',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      enabled: true,
    });
    setProviderZdr(provider.id, { support: 'not_supported' });
    setSetting(ZDR_REQUIREMENT_KEY, 'require');

    await assert.rejects(
      sendMessage({ chatId: 'chat-zdr-retaining', tool: 'chat', modelId: MODEL, prompt: 'hi' }, newStream()),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'zdr_requirement_unmet' &&
        /standard_retention/.test(JSON.stringify(error.details ?? {})),
    );
  });

  test('an eligible provider serves the request normally', async () => {
    const provider = createProvider({
      name: 'zdr-remote',
      type: 'remote',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      enabled: true,
    });
    setProviderZdr(provider.id, { support: 'supported_default' });
    setSetting(ZDR_REQUIREMENT_KEY, 'require');

    const result = await sendMessage(
      { chatId: 'chat-zdr-ok', tool: 'chat', modelId: MODEL, prompt: 'hello' },
      newStream(),
    );

    assert.equal(result.state, 'complete');
    const bucket = summarizeExposure().byZdrStatus.find((entry) => entry.key === 'zdr_requested');
    assert.equal(bucket?.requests, 1);
    assert.deepEqual(bucket?.requirements, ['require']);
  });

  test('failover never lands on an ineligible provider', async () => {
    // The case a gate placed before dispatch cannot see. The first provider is
    // eligible, so the request is allowed to start; it then fails, and the only
    // alternative is one the policy bars.
    const first = createProvider({
      name: 'eligible-but-down',
      type: 'remote',
      baseUrl: failing.baseUrl,
      apiKey: 'k',
      enabled: true,
      priority: 1,
    });
    setProviderZdr(first.id, { support: 'supported_default' });
    createProvider({
      name: 'healthy-but-barred',
      type: 'remote',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      priority: 2,
    });
    setSetting(ZDR_REQUIREMENT_KEY, 'require');

    const chatId = 'chat-zdr-failover';
    const sentBefore = mock.streamCalls.length;

    const result = await sendMessage(
      { chatId, tool: 'chat', modelId: MODEL, prompt: 'hello' },
      newStream(),
    );

    assert.equal(result.state, 'paused');
    // Reported as the privacy refusal it is. `no_healthy_provider` would tell the
    // user to wait for a recovery that will never come.
    assert.equal(assistantTurn(chatId)?.errorCode, 'zdr_requirement_unmet');
    // The barred provider was never sent the payload, which is the whole point.
    assert.equal(mock.streamCalls.length, sentBefore);
  });

  test('failover does land on a second eligible provider', async () => {
    const first = createProvider({
      name: 'down-eligible',
      type: 'remote',
      baseUrl: failing.baseUrl,
      apiKey: 'k',
      enabled: true,
      priority: 1,
    });
    setProviderZdr(first.id, { support: 'supported_default' });
    const second = createProvider({
      name: 'up-eligible',
      type: 'remote',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      priority: 2,
    });
    setProviderZdr(second.id, { support: 'supported_default', confirmed: true, note: 'read the terms' });
    setSetting(ZDR_REQUIREMENT_KEY, 'require');

    const chatId = 'chat-zdr-failover-ok';
    const result = await sendMessage(
      { chatId, tool: 'chat', modelId: MODEL, prompt: 'hello' },
      newStream(),
    );

    assert.equal(result.state, 'complete');
    assert.equal(assistantTurn(chatId)?.providerName, 'up-eligible');
    // Stamped from the provider that actually served the turn, so a confirmed
    // second provider is not reported as the unconfirmed first one.
    assert.equal(summarizeExposure().byZdrStatus[0]?.key, 'zdr_confirmed');
  });

  test('a local provider is unaffected by the strictest policy', async () => {
    // `colibri` rather than `local`: both classify as local egress, but `local`
    // routes to the ollama adapter, which the mock does not serve — so the run
    // would fail for an unrelated reason.
    createProvider({ name: 'colibri-zdr', type: 'colibri', baseUrl: mock.baseUrl, apiKey: null, enabled: true });
    setSetting(ZDR_REQUIREMENT_KEY, 'require');

    const result = await sendMessage(
      { chatId: 'chat-zdr-local', tool: 'chat', modelId: MODEL, prompt: 'hello' },
      newStream(),
    );

    assert.equal(result.state, 'complete');
    const summary = summarizeExposure();
    assert.equal(summary.byZdrStatus.find((entry) => entry.key === 'local_no_egress')?.requests, 1);
    assert.equal(summary.hasPreferenceUnmet, false);
  });
});

describe('routing under prefer', () => {
  test('an eligible provider wins over a higher-priority ineligible one', async () => {
    // Exercised through the capability path, because that is where a candidate
    // list is consulted: the active provider does not offer the model, so the
    // router has to choose, and `prefer` is what decides the order.
    createProvider({
      name: 'no-such-model',
      type: 'remote',
      baseUrl: wrongModel.baseUrl,
      apiKey: 'k',
      enabled: true,
      priority: 1,
    });
    createProvider({
      name: 'closer-but-barred',
      type: 'remote',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      priority: 2,
    });
    const clean = createProvider({
      name: 'further-but-clean',
      type: 'remote',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      priority: 3,
    });
    setProviderZdr(clean.id, { support: 'supported_default' });
    setSetting(ZDR_REQUIREMENT_KEY, 'prefer');

    const chatId = 'chat-zdr-prefer';
    const result = await sendMessage(
      { chatId, tool: 'chat', modelId: MODEL, prompt: 'hello' },
      newStream(),
    );

    assert.equal(result.state, 'complete');
    // Priority put the barred provider first; the preference overrode it.
    assert.equal(assistantTurn(chatId)?.providerName, 'further-but-clean');
  });

  test('an ineligible provider is still used when it is the only option, and recorded as such', async () => {
    const provider = createProvider({
      name: 'only-option',
      type: 'remote',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      enabled: true,
    });
    setProviderZdr(provider.id, { support: 'not_supported' });
    setSetting(ZDR_REQUIREMENT_KEY, 'prefer');

    const result = await sendMessage(
      { chatId: 'chat-zdr-prefer-only', tool: 'chat', modelId: MODEL, prompt: 'hello' },
      newStream(),
    );

    // A preference must never become a prohibition: having no option at all is
    // worse than having an imperfect one.
    assert.equal(result.state, 'complete');

    const summary = summarizeExposure();
    const bucket = summary.byZdrStatus.find((entry) => entry.key === 'standard_retention');
    assert.equal(bucket?.requests, 1);
    // The compensating control for the residual gap `prefer` keeps by design: the
    // policy could not prevent this, so the record has to be able to say it happened.
    assert.equal(bucket?.preferenceUnmet, true);
    assert.equal(summary.hasPreferenceUnmet, true);
  });

  test('the same status under no policy is not reported as a shortfall', async () => {
    const provider = createProvider({
      name: 'no-policy',
      type: 'remote',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      enabled: true,
    });
    setProviderZdr(provider.id, { support: 'not_supported' });

    await sendMessage(
      { chatId: 'chat-zdr-off', tool: 'chat', modelId: MODEL, prompt: 'hello' },
      newStream(),
    );

    const summary = summarizeExposure();
    assert.equal(summary.byZdrStatus.find((entry) => entry.key === 'standard_retention')?.requests, 1);
    assert.equal(summary.hasPreferenceUnmet, false, 'nothing was promised, so nothing fell short');
  });
});

// --- the record ------------------------------------------------------------

describe('what the usage log remembers', () => {
  test('a pre-1.26 row keeps its own bucket rather than being guessed at', () => {
    // Migration 016 backfills nothing: no policy was in force when these rows were
    // written, and inventing one retroactively would put a claim in the log that
    // nobody ever made.
    recordUsage({ tool: 'chat', modelId: MODEL, providerType: 'remote', tokensIn: 5, tokensOut: 5 });

    const summary = summarizeExposure();
    assert.equal(summary.byZdrStatus.length, 1);
    assert.equal(summary.byZdrStatus[0]?.key, 'unrecorded');
    assert.deepEqual(summary.byZdrStatus[0]?.requirements, []);
    // The spend itself is untouched, which is the reason those columns are nullable.
    assert.equal(summarizeUsage().totals.requests, 1);
    assert.equal(summarizeUsage().totals.tokensIn, 5);
  });

  test('the status is stamped, so editing a provider afterwards does not rewrite history', () => {
    const provider = createProvider({
      name: 'retyped',
      type: 'remote',
      baseUrl: 'https://example.invalid',
      apiKey: null,
    });
    recordUsage({
      tool: 'chat',
      modelId: MODEL,
      providerId: provider.id,
      providerType: 'remote',
      zdrStatus: 'standard_retention',
      zdrRequirement: 'off',
      tokensIn: 1,
      tokensOut: 1,
    });

    setProviderZdr(provider.id, { support: 'supported_default', confirmed: true });

    // The row still says what applied at the time, not what the settings say now.
    assert.equal(summarizeExposure().byZdrStatus[0]?.key, 'standard_retention');
  });

  test('the filter can select one status, including the unrecorded rows', () => {
    recordUsage({ tool: 'chat', modelId: MODEL, zdrStatus: 'zdr_requested', zdrRequirement: 'require', tokensIn: 1, tokensOut: 1 });
    recordUsage({ tool: 'chat', modelId: MODEL, zdrStatus: 'standard_retention', zdrRequirement: 'off', tokensIn: 2, tokensOut: 2 });
    recordUsage({ tool: 'chat', modelId: MODEL, tokensIn: 4, tokensOut: 4 });

    assert.equal(summarizeExposure({ zdrStatus: 'zdr_requested' }).totals.tokensIn, 1);
    assert.equal(summarizeExposure({ zdrStatus: 'standard_retention' }).totals.tokensIn, 2);
    // `= NULL` is never true in SQL, so this is the case a naive filter loses.
    assert.equal(summarizeExposure({ zdrStatus: 'unrecorded' }).totals.tokensIn, 4);
    assert.equal(summarizeUsage({ zdrStatus: 'unrecorded' }).totals.requests, 1);
  });

  test('one status reached under two policies stays one bucket that names both', () => {
    recordUsage({ tool: 'chat', modelId: MODEL, zdrStatus: 'standard_retention', zdrRequirement: 'off', tokensIn: 1, tokensOut: 0 });
    recordUsage({ tool: 'chat', modelId: MODEL, zdrStatus: 'standard_retention', zdrRequirement: 'prefer', tokensIn: 1, tokensOut: 0 });

    const bucket = summarizeExposure().byZdrStatus.find((entry) => entry.key === 'standard_retention');
    assert.equal(bucket?.requests, 2);
    assert.deepEqual(bucket?.requirements, ['off', 'prefer']);
    // One row fell short, so the bucket does — a bucket that averaged the two
    // would hide the send that broke a promise.
    assert.equal(bucket?.preferenceUnmet, true);
  });

  test('the exposure total still matches the plain usage total', () => {
    recordUsage({ tool: 'chat', modelId: MODEL, providerType: 'remote', zdrStatus: 'zdr_requested', tokensIn: 3, tokensOut: 1 });
    recordUsage({ tool: 'chat', modelId: MODEL, providerType: 'local', zdrStatus: 'local_no_egress', tokensIn: 7, tokensOut: 2 });
    recordUsage({ tool: 'chat', modelId: MODEL, tokensIn: 1, tokensOut: 1 });

    assert.equal(summarizeExposure().totals.requests, summarizeUsage().totals.requests);
    assert.equal(summarizeExposure().totals.tokensIn, summarizeUsage().totals.tokensIn);
  });
});

/**
 * A status written by a build that knew more, then downgraded.
 *
 * Migration 016 omits a `CHECK` precisely so the enum can widen, which makes this
 * reachable rather than hypothetical. Every assertion here failed before the guards
 * in `summarizeZdr` were changed from discarding a stored value to classifying it.
 */
describe('a stored status this build does not recognise', () => {
  /** Raw SQL, because `recordUsage` only accepts a `ZdrStatus`. */
  function rawRow(status: string | null, requirement: string | null, tokensIn: number): void {
    getDb()
      .prepare(
        `INSERT INTO usage_log (tool, model_id, provider_name, provider_type, zdr_status,
                                zdr_requirement, tokens_in, tokens_out, cost_usd, status, created_at)
         VALUES ('chat', 'm', 'p', 'remote', ?, ?, ?, 1, NULL, 'ok', ?)`,
      )
      .run(status, requirement, tokensIn, Date.now());
  }

  test('it is reported as itself, never folded into unrecorded', () => {
    rawRow('zdr_sealed_enclave', 'require', 100);
    rawRow(null, null, 5);

    const summary = summarizeExposure();
    // `unrecorded` asserts "no policy was recorded when this row was written".
    // Saying that about a row that recorded one understates what happened.
    assert.equal(summary.byZdrStatus.find((entry) => entry.key === 'unrecorded')?.requests, 1);
    assert.equal(summary.byZdrStatus.find((entry) => entry.key === 'zdr_sealed_enclave')?.requests, 1);
  });

  test('the grouping and the filter agree about the same rows', () => {
    rawRow('zdr_sealed_enclave', 'require', 100);
    rawRow(null, null, 5);

    // Two views of one dataset contradicting each other is worse than either being
    // wrong on its own, because neither can be trusted afterwards.
    const bucket = summarizeExposure().byZdrStatus.find((entry) => entry.key === 'unrecorded');
    const filtered = summarizeExposure({ zdrStatus: 'unrecorded' });
    assert.equal(bucket?.requests, filtered.totals.requests);
    assert.equal(bucket?.tokensIn, filtered.totals.tokensIn);
  });

  test('it is selectable by its own key, so the rows are reachable', () => {
    rawRow('zdr_sealed_enclave', 'require', 100);

    const filtered = summarizeExposure({ zdrStatus: 'zdr_sealed_enclave' });
    assert.equal(filtered.totals.requests, 1);
    assert.equal(filtered.totals.tokensIn, 100);
  });

  test('under prefer it counts as a shortfall rather than as satisfied', () => {
    rawRow('zdr_sealed_enclave', 'prefer', 100);

    // Failing open here would claim the user's policy was met by something this
    // build cannot even name.
    const summary = summarizeExposure();
    assert.equal(summary.byZdrStatus.find((entry) => entry.key === 'zdr_sealed_enclave')?.preferenceUnmet, true);
    assert.equal(summary.hasPreferenceUnmet, true);
  });

  test('an unrecognised requirement stays visible instead of vanishing', () => {
    rawRow('zdr_requested', 'mandatory', 10);

    // A bucket that dropped the requirement would claim no policy was in force
    // while the row plainly records one.
    assert.deepEqual(
      summarizeExposure().byZdrStatus.find((entry) => entry.key === 'zdr_requested')?.requirements,
      ['mandatory'],
    );
  });

  test('the unrecorded bucket never claims a requirement it does not have', () => {
    rawRow('zdr_sealed_enclave', 'require', 100);
    rawRow(null, null, 5);

    assert.deepEqual(
      summarizeExposure().byZdrStatus.find((entry) => entry.key === 'unrecorded')?.requirements,
      [],
    );
  });

  test('reconciliation holds across both groupings regardless', () => {
    rawRow('zdr_sealed_enclave', 'require', 100);
    rawRow(null, null, 5);
    rawRow('zdr_requested', 'require', 10);

    const summary = summarizeExposure();
    const sumOf = (field: 'requests' | 'tokensIn') =>
      summary.byZdrStatus.reduce((total, bucket) => total + bucket[field], 0);

    assert.equal(sumOf('requests'), summarizeUsage().totals.requests);
    assert.equal(sumOf('tokensIn'), summarizeUsage().totals.tokensIn);
    assert.equal(sumOf('tokensIn'), summary.byClass.reduce((total, b) => total + b.tokensIn, 0));
  });
});

describe('the migration on an existing install', () => {
  test('nothing is required until the user asks for it', () => {
    assert.equal(zdrRequirement(), 'off');
  });

  test('an unrecognised stored policy reads as off rather than failing every send', () => {
    // Hand-edited rows exist. This value is consulted on the request path, so a
    // bad one must not be able to make the app unusable.
    setSetting(ZDR_REQUIREMENT_KEY, 'REQUIRED!!');
    assert.equal(zdrRequirement(), 'off');
  });

  test('existing providers read as unknown, not as safe', () => {
    const provider = createProvider({
      name: 'pre-existing',
      type: 'remote',
      baseUrl: 'https://example.invalid',
      apiKey: null,
    });
    assert.equal(findProvider(provider.id)?.zdr.support, 'unknown');
    assert.equal(toPublic(provider).zdr.support, 'unknown');
  });
});

// --- HTTP ------------------------------------------------------------------

describe('the ZDR endpoints', () => {
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

  async function putJson(path: string, payload: unknown): Promise<Response> {
    return await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  test('the policy round-trips and defaults off', async () => {
    const before = await fetch(`${base}/api/settings/zdr`);
    const initial = (await before.json()) as { requirement: string; allowed: string[]; enforced: string };
    assert.equal(initial.requirement, 'off');
    assert.deepEqual(initial.allowed, ['off', 'prefer', 'require']);
    // Names where the enforcement lives, so nobody goes looking for a firewall.
    assert.equal(initial.enforced, 'provider_selection');

    const put = await putJson('/api/settings/zdr', { requirement: 'require' });
    assert.equal(put.status, 200);
    assert.equal(((await put.json()) as { requirement: string }).requirement, 'require');

    const after = await fetch(`${base}/api/settings/zdr`);
    assert.equal(((await after.json()) as { requirement: string }).requirement, 'require');
  });

  test('an unrecognised requirement is a 400 naming the field, never a silent off', async () => {
    const res = await putJson('/api/settings/zdr', { requirement: 'mandatory' });
    const payload = (await res.json()) as { error: { code: string; details?: { field?: string } } };

    assert.equal(res.status, 400);
    assert.equal(payload.error.code, 'bad_request');
    assert.equal(payload.error.details?.field, 'requirement');
    // Storing it would have read back as `off`, switching the policy off while the
    // UI showed what was typed.
    assert.equal(zdrRequirement(), 'off');
  });

  test('a missing requirement is a 400 rather than a no-op 200', async () => {
    const res = await putJson('/api/settings/zdr', {});
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { details?: { field?: string } } }).error.details?.field, 'requirement');
  });

  test('the provider subroute records support, the flag and a confirmation', async () => {
    const provider = createProvider({
      name: 'http-zdr',
      type: 'remote',
      baseUrl: 'https://example.invalid',
      apiKey: null,
    });

    const res = await putJson(`/api/providers/${provider.id}/zdr`, {
      support: 'supported_opt_in',
      requestFlag: { location: 'header', key: 'X-Retention', value: 'none' },
      confirmed: true,
      note: 'checked',
    });
    const payload = (await res.json()) as {
      provider: { zdr: { support: string; requestFlag: unknown; confirmedAt: number | null; confirmedNote: string | null } };
    };

    assert.equal(res.status, 200);
    assert.equal(payload.provider.zdr.support, 'supported_opt_in');
    assert.deepEqual(payload.provider.zdr.requestFlag, { location: 'header', key: 'X-Retention', value: 'none' });
    assert.ok(payload.provider.zdr.confirmedAt !== null);
    assert.equal(payload.provider.zdr.confirmedNote, 'checked');
  });

  test('an unknown support value is refused with the allowed set', async () => {
    const provider = createProvider({
      name: 'http-zdr-bad',
      type: 'remote',
      baseUrl: 'https://example.invalid',
      apiKey: null,
    });

    const res = await putJson(`/api/providers/${provider.id}/zdr`, { support: 'probably_fine' });
    const payload = (await res.json()) as { error: { code: string; details?: { field?: string } } };

    assert.equal(res.status, 400);
    assert.equal(payload.error.details?.field, 'support');
  });

  test('a credential in the flag value is refused and never echoed over the wire', async () => {
    const provider = createProvider({
      name: 'http-zdr-leaky',
      type: 'remote',
      baseUrl: 'https://example.invalid',
      apiKey: null,
    });

    const res = await putJson(`/api/providers/${provider.id}/zdr`, {
      support: 'supported_opt_in',
      requestFlag: { location: 'header', key: 'X-Retention', value: FAKE_KEY },
    });
    const raw = await res.text();

    assert.equal(res.status, 400);
    assert.equal(raw.includes(FAKE_KEY), false, 'the response must not quote the value it refused');
  });

  test('the active provider carries its status and the policy in force', async () => {
    const provider = createProvider({
      name: 'http-active-zdr',
      type: 'remote',
      baseUrl: 'https://example.invalid',
      apiKey: 'k',
      enabled: true,
    });
    setProviderZdr(provider.id, { support: 'supported_default' });
    setSetting(ZDR_REQUIREMENT_KEY, 'prefer');

    const res = await fetch(`${base}/api/providers/active`);
    const payload = (await res.json()) as { zdr: { status: string | null; requirement: string } };

    // Served here so there is one definition of what a set of recorded facts
    // amounts to; a frontend that computed it would go stale silently.
    assert.equal(res.status, 200);
    assert.equal(payload.zdr.status, 'zdr_requested');
    assert.equal(payload.zdr.requirement, 'prefer');
  });

  test('with nothing enabled the status is null rather than an invented unknown', async () => {
    const res = await fetch(`${base}/api/providers/active`);
    const payload = (await res.json()) as { provider: unknown; zdr: { status: string | null; requirement: string } };

    assert.equal(payload.provider, null);
    assert.equal(payload.zdr.status, null);
    assert.equal(payload.zdr.requirement, 'off');
  });

  test('the exposure summary filters by status and rejects an unknown one', async () => {
    recordUsage({ tool: 'chat', modelId: MODEL, zdrStatus: 'standard_retention', zdrRequirement: 'prefer', tokensIn: 9, tokensOut: 1 });
    recordUsage({ tool: 'chat', modelId: MODEL, zdrStatus: 'zdr_requested', zdrRequirement: 'prefer', tokensIn: 2, tokensOut: 1 });

    const filtered = await fetch(`${base}/api/usage/exposure-summary?zdrStatus=standard_retention`);
    const payload = (await filtered.json()) as {
      totals: { tokensIn: number };
      byZdrStatus: { key: string; preferenceUnmet: boolean }[];
      hasPreferenceUnmet: boolean;
    };
    assert.equal(filtered.status, 200);
    assert.equal(payload.totals.tokensIn, 9);
    assert.equal(payload.byZdrStatus[0]?.key, 'standard_retention');
    assert.equal(payload.hasPreferenceUnmet, true);

    // An unrecognised status would otherwise return an empty summary, which reads
    // exactly like "you have no remote traffic" — the most dangerous wrong answer
    // this endpoint can give.
    const bogus = await fetch(`${base}/api/usage/exposure-summary?zdrStatus=probably_fine`);
    assert.equal(bogus.status, 400);
  });

  test('a status present in the log is filterable even when this build cannot name it', async () => {
    // The two rules pull opposite ways: a typo must 400, but a status a newer build
    // stamped is real data and its rows have to stay reachable. Rejecting it left
    // those rows visible in the summary yet impossible to select.
    getDb()
      .prepare(
        `INSERT INTO usage_log (tool, model_id, provider_name, provider_type, zdr_status,
                                zdr_requirement, tokens_in, tokens_out, cost_usd, status, created_at)
         VALUES ('chat', 'm', 'p', 'remote', 'zdr_sealed_enclave', 'require', 42, 1, NULL, 'ok', ?)`,
      )
      .run(Date.now());

    const res = await fetch(`${base}/api/usage/exposure-summary?zdrStatus=zdr_sealed_enclave`);
    const payload = (await res.json()) as { totals: { requests: number; tokensIn: number } };

    assert.equal(res.status, 200);
    assert.equal(payload.totals.requests, 1);
    assert.equal(payload.totals.tokensIn, 42);

    // A typo is still a 400, and the error names the field.
    const typo = await fetch(`${base}/api/usage/exposure-summary?zdrStatus=zdr_sealed_enclav`);
    const error = (await typo.json()) as { error: { details?: { field?: string } } };
    assert.equal(typo.status, 400);
    assert.equal(error.error.details?.field, 'zdrStatus');
  });

  test('on the streaming route the refusal arrives as an SSE frame under HTTP 200', async () => {
    createProvider({
      name: 'stream-zdr',
      type: 'remote',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      enabled: true,
    });
    setSetting(ZDR_REQUIREMENT_KEY, 'require');

    const sentBefore = mock.streamCalls.length;
    const res = await fetch(`${base}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'chat-zdr-stream', tool: 'chat', modelId: MODEL, prompt: 'hello' }),
    });
    const raw = await res.text();

    // Not a 403 on the wire: the stream's status line is written before the
    // orchestrator runs, so the refusal can only come back inside the body. Same
    // shape as `redaction_flagged` — see API.md.
    assert.equal(res.status, 200);
    assert.match(raw, /event: error/);
    assert.match(raw, /"code":"zdr_requirement_unmet"/);
    assert.equal(mock.streamCalls.length, sentBefore);
    assert.deepEqual(listMessages('chat-zdr-stream'), []);
  });
});
