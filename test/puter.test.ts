/**
 * Puter as a provider type (Prompt 1 addendum 1.38).
 *
 * The type exists for one reason — the credential is an expiring session token
 * rather than a vendor API key — so the tests are about the three things that
 * difference implies, plus the promise that nothing else changed:
 *
 *   1. **The protocol is the stock one.** A Puter provider streams through the
 *      OpenAI adapter and sends its token as a bearer token, with no branch of
 *      its own in the adapter. Asserted against a real socket, because "it reuses
 *      openAiAdapter" is a claim about behaviour, not about a switch statement.
 *   2. **The credential is a credential.** Stored encrypted, hinted by its last
 *      four characters, and absent from every read path — including the case a
 *      vendor-key assumption would break: a token that does not start with `sk-`.
 *   3. **An expired token behaves like a dead key.** A 401 is an authentication
 *      failure, so 1.36's table pauses the provider for the hour instead of
 *      retrying the same dead credential on every request. That is the whole
 *      point of typing it separately, and it is asserted through the cooldown
 *      module rather than by reading the code.
 */
import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';

import { cleanupHome, freshDb, startMockProvider } from './helpers.ts';
import type { MockProvider } from './helpers.ts';

import type { Server } from 'node:http';

// Imported after helpers.ts has set the environment.
const { createProvider, toPublic, enableProvider } = await import('../src/providers/repository.ts');
const { egressClassFor, isEgress } = await import('../src/services/safety/outbound.ts');
const { adapterFor } = await import('../src/providers/adapters.ts');
const { stream } = await import('../src/providers/router.ts');
const { cooldownFor, resetAllCooldowns } = await import('../src/providers/cooldowns.ts');
const { puterAdvisory, PUTER_DEFAULT_BASE_URL } = await import('../src/providers/puter.ts');
const { resetAllHealth } = await import('../src/providers/health.ts');
const { tryDecrypt } = await import('../src/security/keystore.ts');
const { normalizeBaseUrl } = await import('../src/providers/repository.ts');

let mock: MockProvider;
let base: string;
let server: Server;

/** A Puter-shaped token: not an `sk-` key, and short-lived by nature. */
const TOKEN = 'eyJhbGciOi-token-do-not-log-me-9f3a';

before(async () => {
  mock = await startMockProvider();
  const { createApp } = await import('../src/http/app.ts');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no app port');
  base = `http://127.0.0.1:${String(address.port)}`;
});

beforeEach(async () => {
  await freshDb();
  resetAllHealth();
  resetAllCooldowns();
  mock.behave({ models: ['mock-model'], tokens: ['Hello'], failStatus: undefined });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mock.close();
  await cleanupHome();
});

test('the advisory says where the token comes from, and that the type is remote', () => {
  const advisory = puterAdvisory();
  assert.equal(advisory.defaultBaseUrl, PUTER_DEFAULT_BASE_URL);
  assert.equal(advisory.credential, 'auth_token');
  assert.equal(advisory.egress, 'remote');
  // The note has to answer "what happens when it stops working", because that is
  // the question no other provider type raises.
  assert.match(advisory.note, /expires/i);
  assert.match(advisory.note, /paste a fresh/);
  assert.match(advisory.note, /never\s+returned by any endpoint/);
});

test('the advisory is served, so a settings screen need not hard-code the URL', async () => {
  const body = (await (await fetch(`${base}/api/providers/puter/advisory`)).json()) as {
    defaultBaseUrl: string;
    credential: string;
  };
  assert.equal(body.defaultBaseUrl, PUTER_DEFAULT_BASE_URL);
  assert.equal(body.credential, 'auth_token');
});

test('a bare Puter host is stored as typed, never rewritten into a wrong API', () => {
  // `remote` gets `/v1` appended because that is the OpenAI convention a bare
  // host is missing. Puter's OpenAI surface is *not* at `/v1`, so the same
  // helpfulness here would produce `https://api.puter.com/v1`, a URL that
  // answers nothing — worse than the unhelpful stored value, because it looks
  // deliberate. The advisory supplies the real path for a form to pre-fill.
  assert.equal(normalizeBaseUrl('https://api.puter.com', 'remote'), 'https://api.puter.com/v1');
  assert.equal(normalizeBaseUrl('https://api.puter.com', 'puter'), 'https://api.puter.com');
  assert.equal(
    normalizeBaseUrl(PUTER_DEFAULT_BASE_URL, 'puter'),
    'https://api.puter.com/puterai/openai/v1',
  );
});

test('a puter provider is remote by type, whatever URL it is given', () => {
  // Remote *by type*, never derived from the URL: a hosted service registered
  // against a loopback address (a tunnel, a local relay) is still egress, and
  // understating that is the one direction this classification refuses to fail in.
  assert.equal(egressClassFor({ type: 'puter', baseUrl: PUTER_DEFAULT_BASE_URL }), 'remote');
  assert.equal(egressClassFor({ type: 'puter', baseUrl: 'http://127.0.0.1:11434' }), 'remote');
  assert.equal(isEgress({ type: 'puter', baseUrl: 'http://127.0.0.1:9' }), true);
});

test('the credential is stored encrypted, hinted, and never returned', async () => {
  const provider = createProvider({
    name: 'Puter',
    type: 'puter',
    baseUrl: mock.baseUrl,
    apiKey: TOKEN,
    enabled: true,
  });

  // Encrypted at rest: the stored value is not the token, and decrypting it is a
  // server-side act.
  assert.ok(provider.apiKeyEnc);
  assert.ok(!provider.apiKeyEnc.includes(TOKEN));
  assert.equal(tryDecrypt(provider.apiKeyEnc), TOKEN);

  // The hint is the last four characters of whatever was pasted — no `sk-`
  // assumption, which matters here because a Puter token has no prefix.
  assert.equal(provider.apiKeyHint, TOKEN.slice(-4));

  const publicShape = toPublic(provider);
  assert.equal(publicShape.hasKey, true);
  assert.ok(!JSON.stringify(publicShape).includes(TOKEN));

  const listed = await fetch(`${base}/api/providers`);
  const text = await listed.text();
  assert.ok(!text.includes(TOKEN), 'the token must not reach the client');
  assert.ok(text.includes('"type":"puter"'));
});

test('a puter provider streams through the stock OpenAI path, token included', async () => {
  const provider = createProvider({
    name: 'Puter',
    type: 'puter',
    baseUrl: mock.baseUrl,
    apiKey: TOKEN,
  });
  enableProvider(provider.id);

  assert.equal(adapterFor(provider).kind, 'openai');

  const tokens: string[] = [];
  for await (const event of stream({ modelId: 'mock-model', messages: [{ role: 'user', content: 'hi' }] })) {
    if (event.type === 'token') tokens.push(event.text);
  }
  assert.deepEqual(tokens, ['Hello']);

  assert.ok(mock.streamCalls.length > 0, 'the provider was called');
  // The token travels as a bearer token, where an API key would — asserted from
  // the wire, because a credential that never leaves the process looks identical
  // to one that is sent when all you read is the response.
  assert.equal(mock.lastAuthorization, `Bearer ${TOKEN}`);
});

test('an expired token is paused as an authentication failure, not retried', async () => {
  mock.behave({ models: ['mock-model'], failStatus: 401 });
  const provider = createProvider({
    name: 'Expired',
    type: 'puter',
    baseUrl: mock.baseUrl,
    apiKey: TOKEN,
    enabled: true,
  });

  await assert.rejects(async () => {
    for await (const _ of stream({ modelId: 'mock-model', messages: [] })) {
      // no output expected
    }
  });

  // 1.36's table, reached by 1.38's announcement: the class is `auth` and the
  // provider is left alone for the hour. Retrying a dead token on every request
  // is precisely the behaviour the two items exist to prevent.
  const cooldown = cooldownFor(provider.id);
  assert.equal(cooldown?.failureClass, 'auth');
  assert.equal(cooldown?.ms, 60 * 60_000);
});
