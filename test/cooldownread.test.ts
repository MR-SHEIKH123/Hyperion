/**
 * The cooldown a client can see (1.36, closing `a declared frontend gap`).
 *
 * The env addendum's table was enforced from the day it landed and *reported*
 * nowhere: a provider serving a 60-minute auth cooldown was skipped by the router
 * and the provider read said nothing about it, so the only account of why was the
 * server log. `frontend-contracts.json` recorded that as exactly that
 * (`providers.cooldown`, `partial`) and named where it belonged — the provider
 * list — and this file is the other half of that sentence.
 *
 * Three things can be wrong with a disclosure like this, so they are the tests:
 * **it can be absent when the state is real** (the router cools, the read says
 * nothing), **it can outlive the state** (a cleared cooldown still rendering), and
 * **it can describe a different length than the one being enforced** (a client
 * counting down to a deadline the router is not honouring).
 */
import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { cleanupHome, freshDb, startMockProvider } from './helpers.ts';
import type { MockProvider } from './helpers.ts';

import type { Server } from 'node:http';

// Imported after helpers.ts has set the environment.
const { createProvider, enableProvider, toPublic } = await import(
  '../src/providers/repository.ts'
);
const { recordCooldown, clearCooldown, cooldownFor, describeCooldown, cooldownSnapshot, COOLDOWN_MS } =
  await import('../src/providers/cooldowns.ts');
const { AppError } = await import('../src/util/errors.ts');

/**
 * The failures the tests cool a provider with.
 *
 * `recordCooldown` classifies the *error* rather than taking a class, which is
 * the behaviour under test one layer up (`classifyFailure` decides what a 402
 * means); these construct the two shapes a real caller has — a typed auth failure
 * and a status-bearing refusal.
 */
const AUTH_FAILURE = new AppError('provider_auth_failed', 'The provider rejected the key.');
const statusFailure = (status: number) =>
  new AppError('provider_error', `The provider answered ${status}.`, { details: { status } });
const { resetAllHealth } = await import('../src/providers/health.ts');
const { createApp } = await import('../src/http/app.ts');

let mock: MockProvider;
let server: Server;
let base: string;

before(async () => {
  mock = await startMockProvider();
});

beforeEach(async () => {
  await freshDb();
  resetAllHealth();
  mock.behave({ models: ['mock-model'], tokens: ['Hello'] });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mock.close();
  await cleanupHome();
});

/** An app on an ephemeral port, created once — the DB is reopened per test. */
async function listen(): Promise<void> {
  if (server !== undefined) return;
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected an AddressInfo');
  base = `http://127.0.0.1:${address.port}`;
}

// --- the read model --------------------------------------------------------

test('a provider that is not cooling reads as null, not as an empty state', () => {
  const provider = createProvider({ name: 'Nowhere', type: 'remote', baseUrl: 'https://example.test' });

  assert.equal(toPublic(provider).cooldown, null);
  assert.equal(cooldownSnapshot(provider.id), null);
});

test('a recorded cooldown reaches the read with its deadline, class and reason', () => {
  const provider = createProvider({ name: 'Refuses', type: 'remote', baseUrl: 'https://example.test' });
  const now = Date.now();
  const recorded = recordCooldown(provider.id, AUTH_FAILURE, { now });
  assert.ok(recorded);

  const read = toPublic(provider).cooldown;
  assert.ok(read, 'the enforced cooldown was not disclosed');
  // The deadline, not a length: a client counting down needs the instant, and the
  // two must agree with what the router is enforcing.
  assert.equal(read.until, recorded.until);
  assert.equal(read.until, now + COOLDOWN_MS.auth);
  assert.equal(read.failureClass, 'auth');
  assert.equal(read.source, 'table');
  // The sentence comes from the module that writes the switch messages, so the
  // panel and the routing decision cannot describe one cooldown two ways.
  assert.equal(read.reason, describeCooldown(provider.id, now));
  assert.match(read.reason, /credentials were rejected/);
});

test('a Retry-After cooldown says where its length came from', () => {
  const provider = createProvider({ name: 'Busy', type: 'remote', baseUrl: 'https://example.test' });
  const now = Date.now();
  // 600s of Retry-After against a 5-minute table entry: the provider's own number
  // wins *when it asks for more than this process would have waited anyway*, and
  // the read has to say that is where the length came from.
  const asked = 600;
  recordCooldown(provider.id, statusFailure(429), { now, retryAfterSeconds: asked });

  const read = toPublic(provider).cooldown;
  assert.ok(read);
  assert.equal(read.source, 'retry_after');
  assert.equal(read.until, now + asked * 1_000);
});

test('the read is live: an expired cooldown is gone without a write', () => {
  const provider = createProvider({ name: 'Recovers', type: 'remote', baseUrl: 'https://example.test' });
  const now = Date.now();
  recordCooldown(provider.id, statusFailure(503), { now });

  // The snapshot takes `now`, which is what makes this assertable at all: the
  // third failure this file exists to prevent is a disclosure that outlives the
  // state it describes.
  assert.ok(cooldownSnapshot(provider.id, now + 1_000));
  assert.equal(cooldownSnapshot(provider.id, now + COOLDOWN_MS.server), null);
  assert.equal(toPublic(provider).cooldown, null, 'the read must not resurrect it');
});

test('clearing a cooldown clears the disclosure with it', () => {
  const provider = createProvider({ name: 'Fixed', type: 'remote', baseUrl: 'https://example.test' });
  recordCooldown(provider.id, AUTH_FAILURE);
  assert.ok(cooldownFor(provider.id));

  clearCooldown(provider.id);
  assert.equal(toPublic(provider).cooldown, null);
});

// --- over the wire ---------------------------------------------------------

test('the provider list carries the cooldown, and every other provider is null', async () => {
  await listen();
  const cooling = createProvider({ name: 'Cooling', type: 'remote', baseUrl: 'https://example.test' });
  const fine = createProvider({ name: 'Fine', type: 'remote', baseUrl: 'https://example.test' });
  enableProvider(fine.id);
  recordCooldown(cooling.id, statusFailure(402));

  const res = await fetch(`${base}/api/providers`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    providers: { id: string; cooldown: { failureClass: string; reason: string } | null }[];
  };

  const reported = body.providers.find((p) => p.id === cooling.id)?.cooldown;
  assert.ok(reported, 'the list did not disclose the cooldown');
  assert.equal(reported.failureClass, 'payment');
  // The module's own words, not the status code: a user reads why, not 402.
  assert.equal(reported.reason, 'the account cannot be billed — waiting 30m');

  assert.equal(body.providers.find((p) => p.id === fine.id)?.cooldown, null);
});

test('deleting a provider forgets what was concluded about it', async () => {
  // Found by deleting a provider live while checking this disclosure: the row went
  // and the cooldown stayed, keyed by an id nothing could read again — it would sit
  // in the process until it exited. Deleting is one of the gestures `resetHealth`
  // exists for, and this is the assertion that keeps the route wired to it (the
  // call lives in the route because `health.ts` already imports the repository, and
  // the reverse import would be a cycle).
  await listen();
  const provider = createProvider({ name: 'Doomed', type: 'remote', baseUrl: 'https://example.test' });
  recordCooldown(provider.id, AUTH_FAILURE);
  assert.ok(cooldownFor(provider.id));

  const res = await fetch(`${base}/api/providers/${provider.id}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(cooldownFor(provider.id), null, 'the cooldown outlived the provider');
});

test('the active-provider read carries it too, because that is the chip a user sees', async () => {
  await listen();
  const provider = createProvider({ name: 'Cooling too', type: 'remote', baseUrl: 'https://example.test' });
  enableProvider(provider.id);
  recordCooldown(provider.id, new Error('getaddrinfo ENOTFOUND example.test'));

  const res = await fetch(`${base}/api/providers/active`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { provider: { cooldown: { failureClass: string } | null } };
  assert.equal(body.provider.cooldown?.failureClass, 'network');
});
