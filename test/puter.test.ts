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
const { adapterFor, openAiAdapter, puterAdapter } = await import('../src/providers/adapters.ts');
const { stream } = await import('../src/providers/router.ts');
const { cooldownFor, resetAllCooldowns } = await import('../src/providers/cooldowns.ts');
const { puterAdvisory, puterCatalogueUrls, PUTER_CATALOGUE_URL, PUTER_DEFAULT_BASE_URL } =
  await import('../src/providers/puter.ts');
const { getModels } = await import('../src/providers/registry.ts');
const { resetAllHealth } = await import('../src/providers/health.ts');
const { tryDecrypt } = await import('../src/security/keystore.ts');
const { normalizeBaseUrl } = await import('../src/providers/repository.ts');

let mock: MockProvider;
let base: string;
let server: Server;

/** A Puter-shaped token: not an `sk-` key, and short-lived by nature. */
const TOKEN = 'eyJhbGciOi-token-do-not-log-me-9f3a';

/**
 * A base URL with Puter's path shape, aimed at the mock server.
 *
 * The catalogue URL is derived from the base URL, so a test that wants the
 * catalogue path has to look like Puter. Everything else about the mock is the
 * same socket.
 */
const puterBaseUrl = (): string => `${mock.baseUrl.replace(/\/v1$/, '')}/puterai/openai/v1`;

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

test('the advisory states the plan requirement and the catalogue, not just the credential', () => {
  const advisory = puterAdvisory();
  assert.equal(advisory.defaultBaseUrl, PUTER_DEFAULT_BASE_URL);
  assert.equal(advisory.credential, 'auth_token');
  assert.equal(advisory.egress, 'remote');
  // Machine-readable, because a form that warned only *after* the first failed
  // request would be describing the plan requirement in prose nobody read yet.
  assert.equal(advisory.requiresPaidPlan, true);
  assert.equal(advisory.catalogueUrl, PUTER_CATALOGUE_URL);
  // The note answers "what happens when it stops working" — the question no other
  // provider type raises — without asserting the thing Puter does not do: expiry
  // is a choice in the create dialog, not a property of every token.
  assert.match(advisory.note, /revoked/);
  assert.match(advisory.note, /Never, 7, 30 or 90 days/);
  assert.match(advisory.note, /requires a\s+paid Puter plan|requires a paid Puter plan/i);
  assert.match(advisory.note, /subscription_required/);
  assert.match(advisory.note, /never\s+returned by any endpoint/);
  // And it says what the token cannot do, which is the reassuring half: a minted
  // access token is refused by Puter's account-management endpoints.
  assert.match(advisory.note, /2FA/);
});

test('the catalogue URL is derived from the base URL, or absent when it does not apply', () => {
  // Derived rather than fixed, so a self-hosted Puter or a path-prefixed
  // deployment is read at its own origin.
  assert.deepEqual(puterCatalogueUrls(PUTER_DEFAULT_BASE_URL), {
    details: 'https://api.puter.com/puterai/chat/models/details',
    summary: 'https://api.puter.com/puterai/chat/models',
  });
  assert.deepEqual(puterCatalogueUrls('https://api.puter.com/puterai/openai/v1/')?.details, PUTER_CATALOGUE_URL);
  assert.deepEqual(puterCatalogueUrls('http://127.0.0.1:8080/puterai/openai/v1')?.summary, 'http://127.0.0.1:8080/puterai/chat/models');

  // A compatibility proxy has no such shape. It serves an OpenAI surface, so the
  // ordinary listing is the correct one — not a catalogue path invented onto it.
  assert.equal(puterCatalogueUrls('http://127.0.0.1:11434/v1'), null);
  assert.equal(puterCatalogueUrls('https://openrouter.ai/api/v1'), null);
});

test('models come from Puter\'s catalogue, with the context window it publishes', async () => {
  mock.behave({
    models: ['should-not-be-used'],
    catalogue: [
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context: 200_000 },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', context: 400_000 },
      { id: 'moonshotai/kimi-k2.6' },
    ],
  });
  const provider = createProvider({
    name: 'Puter',
    type: 'puter',
    baseUrl: puterBaseUrl(),
    apiKey: TOKEN,
    enabled: true,
  });

  const models = await getModels(provider, { force: true });
  assert.deepEqual(
    models.map((model) => model.id),
    ['claude-sonnet-5', 'gpt-5.4-nano', 'moonshotai/kimi-k2.6'],
    'the catalogue is the model list, not the OpenAI-shaped /models route',
  );
  // `context`, which is Puter's spelling, becomes the context window every other
  // gateway calls `context_length`. This is what keeps 1.28's ceiling a
  // measurement for a Puter model rather than the assumed default.
  assert.equal(models[0]?.contextLength, 200_000);
  assert.equal(models[0]?.label, 'Claude Sonnet 5');
  assert.equal(models[0]?.ownedBy, 'mock', 'the vendor behind the model is reported');
  assert.equal(models[2]?.contextLength, undefined, 'a model with no published window stays unknown');

  // And the cache is what the ceiling reads, so the window survives the request.
  assert.deepEqual(provider.models, null, 'the record in hand is pre-refresh');
});

test('a failing rich catalogue falls back to the documented summary endpoint', async () => {
  mock.behave({
    catalogue: [{ id: 'gpt-5.4-nano' }, { id: 'claude-sonnet-5' }],
    catalogueFailStatus: 500,
  });
  const provider = createProvider({
    name: 'Puter',
    type: 'puter',
    baseUrl: puterBaseUrl(),
    apiKey: TOKEN,
    enabled: true,
  });

  // The details endpoint answers 500; the summary one is then tried. The summary
  // route returns `{ models: [ids] }`, so the ids arrive without labels or
  // windows — which is exactly what the fallback can promise.
  const models = await getModels(provider, { force: true });
  assert.deepEqual(
    models.map((model) => model.id),
    ['gpt-5.4-nano', 'claude-sonnet-5'],
  );
  assert.equal(models[0]?.contextLength, undefined);
});

test('a base URL that is not Puter\'s shape keeps the ordinary OpenAI listing', async () => {
  mock.behave({ models: ['proxy-model'] });
  // A provider pointed at a compatibility proxy: same credential, ordinary
  // protocol, and no catalogue path invented onto a URL that does not have one.
  const provider = createProvider({
    name: 'Puter via proxy',
    type: 'puter',
    baseUrl: mock.baseUrl,
    apiKey: TOKEN,
    enabled: true,
  });

  const models = await getModels(provider, { force: true });
  assert.deepEqual(
    models.map((model) => model.id),
    ['proxy-model'],
  );
  assert.ok(mock.modelCalls > 0, 'the proxy\'s /models route was the one called');
});

test('the advisory is served, so a settings screen need not hard-code the URL', async () => {
  const body = (await (await fetch(`${base}/api/providers/puter/advisory`)).json()) as {
    defaultBaseUrl: string;
    credential: string;
    catalogueUrl: string;
    requiresPaidPlan: boolean;
    note: string;
  };
  assert.equal(body.defaultBaseUrl, PUTER_DEFAULT_BASE_URL);
  assert.equal(body.credential, 'auth_token');
  // Asserted over the wire, not just on the function: the plan requirement and the
  // catalogue are what a form has to be able to say, and a field that never
  // survives serialization would be missing exactly where it is needed.
  assert.equal(body.catalogueUrl, PUTER_CATALOGUE_URL);
  assert.equal(body.requiresPaidPlan, true);
  assert.match(body.note, /paid Puter plan/);
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

  // The *protocol* is the stock one, and that is now asserted as object identity
  // rather than by naming a switch: `stream` is the very function the OpenAI
  // adapter uses, and only model listing differs.
  assert.equal(adapterFor(provider).kind, 'puter');
  assert.equal(puterAdapter.stream, openAiAdapter.stream);

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

test('a rejected token is named as a token, not as an API key', async () => {
  mock.behave({ models: ['mock-model'], failStatus: 401 });
  const provider = createProvider({
    name: 'Puter',
    type: 'puter',
    baseUrl: mock.baseUrl,
    apiKey: TOKEN,
    enabled: true,
  });

  await assert.rejects(
    async () => {
      for await (const _ of stream({ modelId: 'mock-model', messages: [] })) {
        // no output expected
      }
    },
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /auth token/);
      assert.match(message, /expired or been revoked/);
      assert.doesNotMatch(message, /API key/, 'a Puter user has no API key to go looking for');
      return true;
    },
  );
});

test('a free-plan 402 says which 402 it is, and does not invite a retry', async () => {
  // Puter answers 402 for two unrelated conditions. The code in the body is the
  // difference between "upgrade your plan" and "add credit", and it reaches the
  // user as a message instead of a bare status.
  mock.behave({
    models: ['mock-model'],
    failStatus: 402,
    failBody: JSON.stringify({ error: { code: 'subscription_required', message: 'paid plan required' } }),
  });
  const provider = createProvider({
    name: 'Free plan',
    type: 'puter',
    baseUrl: mock.baseUrl,
    apiKey: TOKEN,
    enabled: true,
  });

  await assert.rejects(
    async () => {
      for await (const _ of stream({ modelId: 'mock-model', messages: [] })) {
        // no output expected
      }
    },
    (error: unknown) => {
      assert.match((error as Error).message, /paid plan/);
      assert.equal((error as { details?: Record<string, unknown> }).details?.['providerCode'], 'subscription_required');
      // Non-retryable: nothing about the next request changes the plan.
      assert.equal((error as { retryable?: boolean }).retryable, false);
      // And the provider is cooled down under 1.36's payment class, so a free
      // account is not hammering an endpoint that will refuse it every time.
      assert.equal(cooldownFor(provider.id)?.failureClass, 'payment');
      return true;
    },
  );

  // The same status with the other code is a different sentence.
  mock.behave({
    models: ['mock-model'],
    failStatus: 402,
    failBody: JSON.stringify({ error: { code: 'insufficient_funds' } }),
  });
  const second = createProvider({
    name: 'Spent',
    type: 'puter',
    baseUrl: mock.baseUrl,
    apiKey: TOKEN,
    enabled: true,
  });
  await assert.rejects(
    async () => {
      for await (const _ of stream({ modelId: 'mock-model', messages: [] })) {
        // no output expected
      }
    },
    (error: unknown) => {
      assert.match((error as Error).message, /usage credit is spent/);
      return true;
    },
  );
  assert.equal(cooldownFor(second.id)?.failureClass, 'payment');
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
