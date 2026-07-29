/**
 * Provider layer behaviour.
 *
 * These assert the spec's contentious points rather than mere code coverage:
 * single-active enforcement, keys never surfacing, capability misses costing
 * zero upstream calls, and the 2-failures-in-a-window threshold.
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupHome, freshDb, startMockProvider, unusedPort } from './helpers.ts';
import type { MockProvider } from './helpers.ts';

// Imported after helpers.ts has set the environment.
const { createProvider, enableProvider, getActiveProvider, listProviders, toPublic, updateProvider } =
  await import('../src/providers/repository.ts');
const { cachedSupportsModel, detectAndRegisterLocal, getModels, matchesModelId } = await import(
  '../src/providers/registry.ts'
);
const { selectProvider, stream } = await import('../src/providers/router.ts');
const { recordFailure, recordSuccess, resetAllHealth } = await import('../src/providers/health.ts');
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

// --- registry --------------------------------------------------------------

test('enabling a provider puts the previous one on standby rather than deleting it', () => {
  const first = createProvider({ name: 'A', type: 'remote', baseUrl: 'https://a.test/v1', enabled: true });
  const second = createProvider({ name: 'B', type: 'remote', baseUrl: 'https://b.test/v1' });

  enableProvider(second.id);

  const active = getActiveProvider();
  assert.equal(active?.id, second.id);

  // The point of "standby, not deleted": the old config survives intact.
  const all = listProviders();
  assert.equal(all.length, 2);
  const previous = all.find((p) => p.id === first.id);
  assert.equal(previous?.enabled, false);
  assert.equal(previous?.baseUrl, 'https://a.test/v1');
});

test('the public serializer exposes no key material, only a 4-char hint', () => {
  const provider = createProvider({
    name: 'Keyed',
    type: 'remote',
    baseUrl: 'https://k.test/v1',
    apiKey: 'sk-supersecret-value-9876',
  });

  const wire = toPublic(provider);
  const serialized = JSON.stringify(wire);

  assert.equal(wire.hasKey, true);
  assert.equal(wire.apiKeyHint, '9876');
  // The real key, and the ciphertext, must both be absent from the payload.
  assert.ok(!serialized.includes('supersecret'));
  assert.ok(!serialized.includes(provider.apiKeyEnc ?? 'nothing'));
  assert.ok(!('apiKeyEnc' in wire));
});

test('changing the base URL invalidates the cached model list', async () => {
  const provider = createProvider({
    name: 'Cached',
    type: 'remote',
    baseUrl: mock.baseUrl,
    enabled: true,
  });
  await getModels(provider);

  const { findProvider } = await import('../src/providers/repository.ts');
  assert.ok(findProvider(provider.id)?.models);

  // A different endpoint is a different set of models; keeping the old list
  // would let the capability check answer for the wrong server.
  const updated = updateProvider(provider.id, { baseUrl: 'https://elsewhere.test/v1' });
  assert.equal(updated.models, null);
  assert.equal(updated.healthStatus, 'unknown');
});

test('model IDs match across gateway renaming conventions', () => {
  assert.ok(matchesModelId('gpt-4o', 'gpt-4o'));
  assert.ok(matchesModelId('openai/gpt-4o', 'gpt-4o'));
  assert.ok(matchesModelId('llama3:latest', 'llama3'));
  assert.ok(!matchesModelId('gpt-4o', 'gpt-4o-mini'));
});

// --- capability check ------------------------------------------------------

test('a capability miss is resolved without sending an upstream request', async () => {
  const other = await startMockProvider({ models: ['deepseek-v3'] });
  try {
    createProvider({
      name: 'Gateway',
      type: 'remote',
      baseUrl: mock.baseUrl, // only offers mock-model
      enabled: true,
    });
    const holder = createProvider({ name: 'Holder', type: 'remote', baseUrl: other.baseUrl });

    const callsBefore = mock.streamCalls.length;
    const selection = await selectProvider('deepseek-v3');

    assert.equal(selection.switched, true);
    assert.equal(selection.provider.id, holder.id);
    assert.equal(selection.reason, 'capability_mismatch');
    // The whole point: discovering the mismatch cost zero completion requests.
    assert.equal(mock.streamCalls.length, callsBefore);
  } finally {
    await other.close();
  }
});

test('a model no provider offers fails fast, without a request', async () => {
  createProvider({ name: 'Only', type: 'remote', baseUrl: mock.baseUrl, enabled: true });
  const callsBefore = mock.streamCalls.length;

  await assert.rejects(
    () => selectProvider('nonexistent-model'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'no_provider_for_model');
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(mock.streamCalls.length, callsBefore);
});

test('an unknown model cache is treated as "might work", not as a mismatch', async () => {
  const provider = createProvider({
    name: 'Unprobed',
    type: 'remote',
    baseUrl: 'https://unreachable.invalid/v1',
    enabled: true,
  });

  // Listing fails, so the cache stays empty. Refusing to send here would turn a
  // listing failure into a hard outage.
  const selection = await selectProvider('some-model');
  assert.equal(selection.provider.id, provider.id);
  assert.equal(cachedSupportsModel(selection.provider, 'some-model'), null);
});

// --- health / failover ----------------------------------------------------

test('one retryable failure degrades; the second within the window evicts', async () => {
  const provider = createProvider({ name: 'Flaky', type: 'remote', baseUrl: mock.baseUrl });
  const error = new AppError('provider_error', 'boom', { retryable: true });

  const first = recordFailure(provider.id, error);
  assert.equal(first.unhealthy, false);
  assert.equal(first.consecutive, 1);

  const second = recordFailure(provider.id, error);
  assert.equal(second.unhealthy, true);
  assert.equal(second.consecutive, 2);

  const { findProvider } = await import('../src/providers/repository.ts');
  assert.equal(findProvider(provider.id)?.healthStatus, 'unhealthy');
});

test('a rejected API key never counts toward the eviction threshold', async () => {
  const provider = createProvider({ name: 'BadKey', type: 'remote', baseUrl: mock.baseUrl });
  const authError = new AppError('provider_auth_failed', 'bad key', { retryable: false });

  // Ten wrong-key responses must not evict a provider that is plainly alive —
  // failing over would just repeat the same misconfiguration elsewhere.
  for (let i = 0; i < 10; i++) {
    const verdict = recordFailure(provider.id, authError);
    assert.equal(verdict.unhealthy, false);
    assert.equal(verdict.counted, false);
  }

  const { findProvider } = await import('../src/providers/repository.ts');
  assert.equal(findProvider(provider.id)?.healthStatus, 'degraded');
});

test('a success clears the failure streak', () => {
  const provider = createProvider({ name: 'Recovering', type: 'remote', baseUrl: mock.baseUrl });
  const error = new AppError('provider_error', 'boom', { retryable: true });

  recordFailure(provider.id, error);
  recordSuccess(provider.id);

  // Streak reset, so the next single failure must not immediately evict.
  const verdict = recordFailure(provider.id, error);
  assert.equal(verdict.consecutive, 1);
  assert.equal(verdict.unhealthy, false);
});

test('streaming fails over to a healthy provider and reports the switch', async () => {
  const broken = await startMockProvider({ models: ['shared-model'], failStatus: 500 });
  const healthy = await startMockProvider({ models: ['shared-model'], tokens: ['ok'] });

  try {
    createProvider({ name: 'Broken', type: 'remote', baseUrl: broken.baseUrl, priority: 1, enabled: true });
    createProvider({ name: 'Healthy', type: 'remote', baseUrl: healthy.baseUrl, priority: 2 });

    const events: string[] = [];
    let text = '';
    for await (const event of stream({ modelId: 'shared-model', messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event.type);
      if (event.type === 'token') text += event.text;
    }

    assert.ok(events.includes('switched'));
    assert.equal(text, 'ok');
    // Two attempts against the broken provider is what produces the second
    // data point the threshold requires; more than that would be thrashing.
    assert.equal(broken.streamCalls.length, 2);

    const active = getActiveProvider();
    assert.equal(active?.name, 'Healthy');
  } finally {
    await broken.close();
    await healthy.close();
  }
});

test('a provider failing after output has started surfaces the error instead of failing over', async () => {
  const truncating = await startMockProvider({
    models: ['shared-model'],
    tokens: ['partial', ' text', ' more'],
    truncateAfter: 2,
  });
  const healthy = await startMockProvider({ models: ['shared-model'], tokens: ['replacement'] });

  try {
    createProvider({ name: 'Truncates', type: 'remote', baseUrl: truncating.baseUrl, priority: 1, enabled: true });
    createProvider({ name: 'Standby', type: 'remote', baseUrl: healthy.baseUrl, priority: 2 });

    let text = '';
    let failed = false;
    try {
      for await (const event of stream({
        modelId: 'shared-model',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        if (event.type === 'token') text += event.text;
      }
    } catch {
      failed = true;
    }

    assert.equal(failed, true);
    // The partial text the user already saw is preserved and NOT re-generated
    // elsewhere, which would duplicate or contradict it.
    assert.equal(text, 'partial text');
    assert.equal(healthy.streamCalls.length, 0);
  } finally {
    await truncating.close();
    await healthy.close();
  }
});

test('with no healthy alternative the error is no_healthy_provider, and history is not lost', async () => {
  const broken = await startMockProvider({ models: ['solo-model'], failStatus: 503 });
  try {
    createProvider({ name: 'Solo', type: 'remote', baseUrl: broken.baseUrl, enabled: true });

    await assert.rejects(
      async () => {
        for await (const _ of stream({
          modelId: 'solo-model',
          messages: [{ role: 'user', content: 'hi' }],
        })) {
          void _;
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'no_healthy_provider');
        return true;
      },
    );

    // Critically, the failed provider is NOT disabled when there is no
    // replacement: zero active providers would turn a blip into a dead app.
    assert.equal(getActiveProvider()?.name, 'Solo');
  } finally {
    await broken.close();
  }
});

test('usage is reported for the cost dashboard', async () => {
  createProvider({ name: 'Metered', type: 'remote', baseUrl: mock.baseUrl, enabled: true });

  let usage: { tokensIn: number; tokensOut: number } | null = null;
  for await (const event of stream({
    modelId: 'mock-model',
    messages: [{ role: 'user', content: 'hi' }],
  })) {
    if (event.type === 'usage') usage = event.usage;
  }

  assert.deepEqual(usage, { tokensIn: 11, tokensOut: 22 });
});

// --- local detection ------------------------------------------------------

test('an absent local runner reports not-detected immediately, without retrying', async () => {
  const port = await unusedPort();
  const started = Date.now();

  const result = await detectAndRegisterLocal(`http://127.0.0.1:${port}`);

  assert.equal(result.detected, false);
  // A refusal is conclusive, so the retry budget must not be spent on it.
  assert.equal(result.attempts, 1);
  assert.ok(Date.now() - started < 2000);
  assert.equal(listProviders().length, 0);
});
