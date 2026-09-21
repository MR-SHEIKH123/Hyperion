/**
 * Per-error-type provider cooldowns (Prompt 1 addendum 1.36).
 *
 * The addendum's claim is a table — 401/403 60m, 402 30m, 429 5m + `Retry-After`,
 * 404 2m, 5xx 1m, network 30s — so the tests are about the table being the table
 * and about the behaviour it implies. The behaviour is the interesting half: a
 * wrong key used to be retried on every single request, because `health.ts`
 * deliberately excludes non-retryable failures from its threshold and the router
 * throws immediately for them. These tests assert the hole is closed end to end
 * over real sockets: a 401 sets the hour, and the *next* request goes elsewhere.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupHome, freshDb, startMockProvider } from './helpers.ts';
import type { MockProvider } from './helpers.ts';

// Imported after helpers.ts has set the environment.
const { createProvider, enableProvider, getActiveProvider } = await import('../src/providers/repository.ts');
const { selectProvider, stream } = await import('../src/providers/router.ts');
const { resetAllHealth } = await import('../src/providers/health.ts');
const {
  COOLDOWN_MAX_MS,
  COOLDOWN_MS,
  classifyFailure,
  clearCooldown,
  cooldownFor,
  coolingProviderIds,
  describeCooldown,
  isCoolingDown,
  recordCooldown,
} = await import('../src/providers/cooldowns.ts');
const { resetHealth } = await import('../src/providers/health.ts');
const { AppError } = await import('../src/util/errors.ts');

let mock: MockProvider;

before(async () => {
  mock = await startMockProvider();
});

beforeEach(async () => {
  await freshDb();
  resetAllHealth();
  clearCooldown('anything');
  mock.behave({ models: ['mock-model'], tokens: ['Hello'], failStatus: undefined });
});

after(async () => {
  await mock.close();
  await cleanupHome();
});

// --- the table -------------------------------------------------------------

test('every class in the addendum has its own duration, and the cap is the longest one', () => {
  assert.deepEqual(COOLDOWN_MS, {
    auth: 60 * 60_000,
    payment: 30 * 60_000,
    rate_limit: 5 * 60_000,
    not_found: 2 * 60_000,
    server: 60_000,
    network: 30_000,
  });
  // The cap exists so a header cannot outlast the longest judgement this process
  // makes on its own. If the table ever grows past the cap, the cap is wrong.
  assert.equal(COOLDOWN_MAX_MS, Math.max(...Object.values(COOLDOWN_MS)));
});

test('the class comes from the HTTP status where there is one', () => {
  const withStatus = (status: number) =>
    new AppError('provider_error', 'nope', { details: { status }, retryable: status >= 500 || status === 429 });

  assert.equal(classifyFailure(withStatus(401)), 'auth');
  assert.equal(classifyFailure(withStatus(403)), 'auth');
  assert.equal(classifyFailure(withStatus(402)), 'payment');
  assert.equal(classifyFailure(withStatus(429)), 'rate_limit');
  assert.equal(classifyFailure(withStatus(404)), 'not_found');
  assert.equal(classifyFailure(withStatus(500)), 'server');
  assert.equal(classifyFailure(withStatus(503)), 'server');
});

test('a status that is this process\'s own fault sets no cooldown', () => {
  // A malformed request is a bug here. Parking the provider for it would hide the
  // bug behind a back-off that reads like the provider's problem.
  assert.equal(classifyFailure(new AppError('provider_error', 'bad', { details: { status: 400 } })), null);
  assert.equal(classifyFailure(new AppError('bad_request', 'bad')), null);
  assert.equal(classifyFailure(new AppError('aborted', 'cancelled')), null);
});

test('failures with no response map by code, and a raw throw is a network fault', () => {
  assert.equal(classifyFailure(new AppError('provider_auth_failed', 'bad key')), 'auth');
  assert.equal(classifyFailure(new AppError('provider_unreachable', 'refused')), 'network');
  assert.equal(classifyFailure(new AppError('provider_timeout', 'too slow')), 'network');
  // Not an AppError at all: a DNS or TLS failure out of fetch.
  assert.equal(classifyFailure(new Error('getaddrinfo ENOTFOUND')), 'network');
});

// --- the mechanics ---------------------------------------------------------

test('a cooldown expires on its own, and expiry is applied when read', () => {
  const error = new AppError('provider_auth_failed', 'bad key');
  const cooldown = recordCooldown('p-expire', error, { now: 1_000_000 });

  assert.equal(cooldown?.ms, COOLDOWN_MS.auth);
  assert.equal(isCoolingDown('p-expire', 1_000_000 + COOLDOWN_MS.auth - 1), true);
  assert.equal(isCoolingDown('p-expire', 1_000_000 + COOLDOWN_MS.auth), false);
  // Read-and-expired means forgotten: no janitor has to run for the entry to go.
  assert.equal(cooldownFor('p-expire', 1_000_000 + COOLDOWN_MS.auth), null);
});

test('a 429 is left alone for the longer of the table and the provider\'s Retry-After', () => {
  const rateLimited = new AppError('provider_error', 'slow down', {
    details: { status: 429 },
    retryable: true,
  });

  // Shorter than the table: the table wins, so a provider saying "2s" does not
  // make this process poll it sooner than it would have anyway.
  const short = recordCooldown('p-short', rateLimited, { retryAfterSeconds: 2, now: 0 });
  assert.equal(short?.ms, COOLDOWN_MS.rate_limit);
  assert.equal(short?.source, 'table');

  // Longer: the provider wins, and the cooldown says where it came from.
  const long = recordCooldown('p-long', rateLimited, { retryAfterSeconds: 600, now: 0 });
  assert.equal(long?.ms, 600_000);
  assert.equal(long?.source, 'retry_after');
});

test('a Retry-After beyond the cap is clamped rather than honoured', () => {
  const rateLimited = new AppError('provider_error', 'slow down', {
    details: { status: 429 },
    retryable: true,
  });

  // The capped-backoff rule: one header must not decommission a provider for a
  // day. An unparseable value is treated as absent, not as zero, so a broken
  // gateway falls back to the table instead of disabling the back-off.
  const clamped = recordCooldown('p-clamp', rateLimited, { retryAfterSeconds: 86_400, now: 0 });
  assert.equal(clamped?.ms, COOLDOWN_MAX_MS);
  assert.equal(recordCooldown('p-nan', rateLimited, { retryAfterSeconds: Number.NaN, now: 0 })?.ms, COOLDOWN_MS.rate_limit);
});

test('a later failure replaces the cooldown, because it is the newer fact', () => {
  const rateLimited = new AppError('provider_error', 'slow down', { details: { status: 429 } });
  const authFailed = new AppError('provider_auth_failed', 'bad key');

  recordCooldown('p-replace', rateLimited, { now: 0 });
  const replaced = recordCooldown('p-replace', authFailed, { now: 1_000 });

  // Parked for the hour, not the five minutes: the key is what is wrong now.
  assert.equal(replaced?.failureClass, 'auth');
  assert.equal(cooldownFor('p-replace', 1_000)?.until, 1_000 + COOLDOWN_MS.auth);
});

test('a failure with no provider meaning records nothing at all', () => {
  assert.equal(recordCooldown('p-nothing', new AppError('bad_request', 'bad'), { now: 0 }), null);
  assert.equal(isCoolingDown('p-nothing', 0), false);
});

test('the description names the class, not the status code', () => {
  recordCooldown('p-words', new AppError('provider_auth_failed', 'bad key'), { now: 0 });
  assert.equal(describeCooldown('p-words', 0), 'the credentials were rejected — waiting 60m');
  // Expired: nothing to describe.
  assert.equal(describeCooldown('p-words', COOLDOWN_MS.auth), null);
});

test('a user action clears the cooldown, so fixing a key is not punished', () => {
  recordCooldown('p-cleared', new AppError('provider_auth_failed', 'bad key'), { now: 0 });
  assert.equal(isCoolingDown('p-cleared', 0), true);

  resetHealth('p-cleared');

  assert.equal(isCoolingDown('p-cleared', 0), false);
  assert.equal(cooldownFor('p-cleared', 0), null);
});

test('coolingProviderIds reports only what is still cooling', () => {
  recordCooldown('p-a', new AppError('provider_auth_failed', 'bad key'), { now: 0 });
  recordCooldown('p-b', new AppError('provider_unreachable', 'refused'), { now: 0 });

  assert.deepEqual([...coolingProviderIds(0)].sort(), ['p-a', 'p-b']);
  assert.deepEqual([...coolingProviderIds(COOLDOWN_MS.auth)].sort(), []);
});

// --- end to end over real sockets -----------------------------------------

test('one 401 pauses the provider for the hour without counting toward the health threshold', async () => {
  mock.behave({ models: ['mock-model'], failStatus: 401 });
  const provider = createProvider({ name: 'BadKey', type: 'remote', baseUrl: mock.baseUrl, enabled: true });

  await assert.rejects(async () => {
    for await (const _ of stream({ modelId: 'mock-model', messages: [] })) {
      // no output expected
    }
  });

  const cooldown = cooldownFor(provider.id);
  assert.equal(cooldown?.failureClass, 'auth');
  assert.equal(cooldown?.ms, COOLDOWN_MS.auth);

  // The health tracker still refuses to evict on a wrong key, unchanged.
  const { findProvider } = await import('../src/providers/repository.ts');
  assert.equal(findProvider(provider.id)?.healthStatus, 'degraded');
});

test('the request after a 401 goes to a provider that is not cooling down', async () => {
  const broken = await startMockProvider({ models: ['shared'], failStatus: 401 });
  const healthy = await startMockProvider({ models: ['shared'], tokens: ['ok'] });

  try {
    const bad = createProvider({
      name: 'Bad',
      type: 'remote',
      baseUrl: broken.baseUrl,
      priority: 1,
      enabled: true,
    });
    const good = createProvider({ name: 'Good', type: 'remote', baseUrl: healthy.baseUrl, priority: 2 });

    await assert.rejects(async () => {
      for await (const _ of stream({ modelId: 'shared', messages: [] })) {
        // no output expected
      }
    });
    assert.equal(isCoolingDown(bad.id), true);

    // The next request: the active provider is the one with the bad key, and the
    // selection leaves it — with a reason the run state machine can explain.
    const selection = await selectProvider('shared');
    assert.equal(selection.provider.id, good.id);
    assert.equal(selection.switched, true);
    assert.equal(selection.reason, 'cooldown');
    assert.match(selection.message ?? '', /credentials were rejected/);
    assert.match(selection.message ?? '', /using Good instead/);

    // And the switch is real: tokens arrive from the other provider.
    const chunks: string[] = [];
    for await (const event of stream({ modelId: 'shared', messages: [] })) {
      if (event.type === 'token') chunks.push(event.text);
    }
    assert.deepEqual(chunks, ['ok']);
  } finally {
    await broken.close();
    await healthy.close();
  }
});

test('a 429 is left alone long enough that the next attempt is not immediate', async () => {
  const limited = await startMockProvider({ models: ['shared'], failStatus: 429, retryAfter: '900' });
  const other = await startMockProvider({ models: ['shared'], tokens: ['ok'] });

  try {
    const throttled = createProvider({
      name: 'Throttled',
      type: 'remote',
      baseUrl: limited.baseUrl,
      priority: 1,
      enabled: true,
    });
    const spare = createProvider({ name: 'Spare', type: 'remote', baseUrl: other.baseUrl, priority: 2 });

    // A 429 is retryable, so the router spends its threshold attempt on the same
    // provider and only then fails over — which is exactly the hammering a
    // cooldown exists to bound. Both attempts are counted below.
    const tokens: string[] = [];
    for await (const event of stream({ modelId: 'shared', messages: [] })) {
      if (event.type === 'token') tokens.push(event.text);
    }
    assert.deepEqual(tokens, ['ok']);

    // 900 seconds from the header, under the cap, so the provider's own number wins.
    const cooldown = cooldownFor(throttled.id);
    assert.equal(cooldown?.source, 'retry_after');
    assert.equal(cooldown?.ms, 900_000);
    assert.equal(limited.streamCalls.length, 2); // the router's own threshold retry

    const selection = await selectProvider('shared');
    assert.equal(selection.provider.id, spare.id);

    // The throttled provider is not asked again while the cooldown stands.
    const before = limited.streamCalls.length;
    for await (const _ of stream({ modelId: 'shared', messages: [] })) {
      // consumes from the spare provider
    }
    assert.equal(limited.streamCalls.length, before);
  } finally {
    await limited.close();
    await other.close();
  }
});

test('a successful request clears the cooldown it was serving', async () => {
  mock.behave({ models: ['mock-model'], tokens: ['ok'] });
  const provider = createProvider({ name: 'Recovering', type: 'remote', baseUrl: mock.baseUrl, enabled: true });
  recordCooldown(provider.id, new AppError('provider_unreachable', 'refused'));

  for await (const _ of stream({ modelId: 'mock-model', messages: [] })) {
    // drain
  }

  assert.equal(isCoolingDown(provider.id), false);
});

test('a second provider with an unhealthy history is still preferred over one cooling down', async () => {
  const unhealthy = await startMockProvider({ models: ['shared'], tokens: ['ok'] });
  const healthy = await startMockProvider({ models: ['shared'], tokens: ['ok'] });

  try {
    const degraded = createProvider({ name: 'Degraded', type: 'remote', baseUrl: unhealthy.baseUrl, priority: 1 });
    const active = createProvider({
      name: 'Cooling',
      type: 'remote',
      baseUrl: healthy.baseUrl,
      priority: 2,
      enabled: true,
    });

    // A DB-level unhealthy verdict is display/order state; a cooldown is a live
    // deadline. Both push the same provider down, and the live one wins.
    const { recordHealth } = await import('../src/providers/repository.ts');
    recordHealth(degraded.id, 'unhealthy');
    recordCooldown(active.id, new AppError('provider_auth_failed', 'bad key'));

    const selection = await selectProvider('shared');
    assert.equal(selection.provider.id, degraded.id);
  } finally {
    await unhealthy.close();
    await healthy.close();
  }
});

test('the active provider is still used when it is the only one that can serve the model', async () => {
  mock.behave({ models: ['only-here'], tokens: ['ok'] });
  const provider = createProvider({ name: 'Only', type: 'remote', baseUrl: mock.baseUrl, enabled: true });
  recordCooldown(provider.id, new AppError('provider_auth_failed', 'bad key'));

  // Cooling last, not excluded: refusing here would turn a key the user is about
  // to fix into an outage. The attempt is made and will fail honestly.
  const selection = await selectProvider('only-here');
  assert.equal(selection.provider.id, provider.id);
  assert.equal(selection.switched, false);
  assert.equal(getActiveProvider()?.id, provider.id);
});
