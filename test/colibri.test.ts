/**
 * Colibrì — the fourth provider type.
 *
 * The interesting claims are not "a string was added to a union". They are:
 * the database CHECK actually accepts the new type, the OpenAI adapter is
 * reused rather than reimplemented, the performance acknowledgement is enforced
 * by the backend and carries its own caveat text, and — most easily broken —
 * that same acknowledgement does NOT apply to automatic failover, where a
 * Colibrì standby has to be promotable without a human present.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupHome, freshDb, startMockProvider, unusedPort } from './helpers.ts';
import type { MockProvider } from './helpers.ts';

// Imported after helpers.ts has set the environment.
const { createProvider, enableProvider, getActiveProvider, listProviders, findProvider } =
  await import('../src/providers/repository.ts');
const { adapterFor } = await import('../src/providers/adapters.ts');
const { stream } = await import('../src/providers/router.ts');
const { resetAllHealth } = await import('../src/providers/health.ts');
const { isProviderType, PROVIDER_TYPES } = await import('../src/types/core.ts');
const {
  COLIBRI_CAVEAT,
  COLIBRI_DEFAULT_BASE_URL,
  colibriAdvisory,
  probeColibri,
  requireSlowAcknowledgement,
} = await import('../src/providers/colibri.ts');
const { AppError } = await import('../src/util/errors.ts');

let mock: MockProvider;

before(async () => {
  mock = await startMockProvider();
});

beforeEach(async () => {
  await freshDb();
  resetAllHealth();
  mock.behave({ models: ['mock-model'], tokens: ['Hello', ' world'], failStatus: undefined });
});

after(async () => {
  await mock.close();
  await cleanupHome();
});

// --- the type itself -------------------------------------------------------

test('colibri is a recognised provider type', () => {
  assert.equal(isProviderType('colibri'), true);
  assert.ok(PROVIDER_TYPES.includes('colibri'));
  // The guard must still reject nonsense; widening the union is not licence to
  // accept anything.
  assert.equal(isProviderType('colibrì'), false);
  assert.equal(isProviderType('nonsense'), false);
});

test('a colibri provider survives the database type CHECK', () => {
  // Migration 005 rebuilds the providers table to widen the CHECK constraint.
  // If it were missed, or applied to a stale schema, this insert is where it
  // shows up — as a constraint failure rather than a subtle behaviour change.
  const provider = createProvider({
    name: 'Colibrì (local)',
    type: 'colibri',
    baseUrl: COLIBRI_DEFAULT_BASE_URL,
  });

  assert.equal(provider.type, 'colibri');

  const stored = findProvider(provider.id);
  assert.equal(stored?.type, 'colibri');
  assert.equal(stored?.baseUrl, COLIBRI_DEFAULT_BASE_URL);
  // No API key by default: Colibrì is a local process, not a hosted gateway.
  assert.equal(stored?.apiKeyEnc, null);
});

test('colibri reuses the OpenAI adapter rather than a bespoke one', () => {
  const provider = createProvider({
    name: 'Colibrì',
    type: 'colibri',
    baseUrl: 'http://localhost:8000/v1',
  });

  // Colibrì serves a genuine OpenAI-compatible surface, so a separate adapter
  // would be duplicated code with its own drift. Asserting the *kind* pins the
  // routing decision without depending on object identity.
  assert.equal(adapterFor(provider).kind, 'openai');
});

// --- the acknowledgement gate ----------------------------------------------

test('advisory carries the caveat, the default URL and the field to echo back', () => {
  const advisory = colibriAdvisory();

  assert.equal(advisory.type, 'colibri');
  assert.equal(advisory.defaultBaseUrl, COLIBRI_DEFAULT_BASE_URL);
  assert.equal(advisory.acknowledgementRequired, true);
  assert.equal(advisory.acknowledgementField, 'acknowledgeSlow');

  // The caveat has to state the two things that read as a hung application
  // rather than a slow one. A vague "may be slower" would get the first long
  // silence reported as a bug.
  assert.match(advisory.caveat, /[Pp]refill/);
  assert.match(advisory.caveat, /token per second/);
});

test('enabling colibri without acknowledgement is refused, and the refusal carries the caveat', () => {
  const provider = createProvider({
    name: 'Colibrì',
    type: 'colibri',
    baseUrl: COLIBRI_DEFAULT_BASE_URL,
  });

  assert.throws(
    () => requireSlowAcknowledgement(provider, false),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'bad_request');
      assert.equal(error.retryable, false);
      // The whole point of enforcing this in the backend: the warning travels
      // with the refusal, so a client that never rendered the advisory still
      // has the text it needs to show.
      const details = error.details as { field?: string; caveat?: string } | undefined;
      assert.equal(details?.field, 'acknowledgeSlow');
      assert.equal(details?.caveat, COLIBRI_CAVEAT);
      return true;
    },
  );
});

test('acknowledging lets it through, and other provider types are never gated', () => {
  const colibri = createProvider({
    name: 'Colibrì',
    type: 'colibri',
    baseUrl: COLIBRI_DEFAULT_BASE_URL,
  });
  const remote = createProvider({ name: 'Remote', type: 'remote', baseUrl: 'https://r.test/v1' });
  const local = createProvider({ name: 'Local', type: 'local', baseUrl: 'http://127.0.0.1:11434' });

  // No throw is the assertion in all three cases.
  requireSlowAcknowledgement(colibri, true);
  requireSlowAcknowledgement(remote, false);
  requireSlowAcknowledgement(local, false);
});

test('an acknowledged colibri provider enables and obeys single-active', () => {
  const remote = createProvider({
    name: 'Remote',
    type: 'remote',
    baseUrl: 'https://r.test/v1',
    enabled: true,
  });
  const colibri = createProvider({
    name: 'Colibrì',
    type: 'colibri',
    baseUrl: COLIBRI_DEFAULT_BASE_URL,
  });

  requireSlowAcknowledgement(colibri, true);
  enableProvider(colibri.id);

  assert.equal(getActiveProvider()?.id, colibri.id);

  // The displaced provider stays configured, exactly as for any other type.
  const previous = listProviders().find((p) => p.id === remote.id);
  assert.equal(previous?.enabled, false);
  assert.equal(previous?.baseUrl, 'https://r.test/v1');
});

test('failover promotes a colibri standby without any acknowledgement', async () => {
  const broken = await startMockProvider({ models: ['shared-model'], failStatus: 500 });
  const colibriServer = await startMockProvider({ models: ['shared-model'], tokens: ['slow ok'] });

  try {
    createProvider({
      name: 'Broken',
      type: 'remote',
      baseUrl: broken.baseUrl,
      priority: 1,
      enabled: true,
    });
    createProvider({
      name: 'Colibrì',
      type: 'colibri',
      baseUrl: colibriServer.baseUrl,
      priority: 2,
    });

    let text = '';
    const events: string[] = [];
    for await (const event of stream({
      modelId: 'shared-model',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(event.type);
      if (event.type === 'token') text += event.text;
    }

    assert.ok(events.includes('switched'));
    assert.equal(text, 'slow ok');

    // This is the regression the gate's placement exists to prevent. Enforcing
    // the acknowledgement inside enableProvider() would strand this promotion
    // and leave the user with no provider at all — at the exact moment the
    // slow-but-working fallback is most wanted.
    assert.equal(getActiveProvider()?.name, 'Colibrì');
  } finally {
    await broken.close();
    await colibriServer.close();
  }
});

// --- the probe -------------------------------------------------------------

test('probing a live OpenAI-compatible server reports detected with its models', async () => {
  const result = await probeColibri(mock.baseUrl);

  assert.equal(result.detected, true);
  assert.equal(result.baseUrl, mock.baseUrl);
  assert.ok(result.models.some((m) => m.id === 'mock-model'));
  assert.equal(result.reason, undefined);

  // A probe answers a question; it must not quietly create configuration.
  assert.equal(listProviders().length, 0);
});

test('probing a dead port answers detected:false instead of throwing', async () => {
  const port = await unusedPort();

  const result = await probeColibri(`http://127.0.0.1:${port}/v1`);

  // A miss is a normal final answer, matching the /detect-local contract, so a
  // UI never has to special-case a failed probe as an exception.
  assert.equal(result.detected, false);
  assert.deepEqual(result.models, []);
  assert.equal(typeof result.reason, 'string');
  assert.ok((result.reason ?? '').length > 0);
});

test('a trailing slash does not produce a doubled path', async () => {
  const result = await probeColibri(`${mock.baseUrl}/`);

  assert.equal(result.detected, true);
  assert.equal(result.baseUrl, mock.baseUrl);
});

test('an empty base URL is rejected as a bad request, not probed', async () => {
  await assert.rejects(
    () => probeColibri('   '),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'bad_request');
      return true;
    },
  );
});
