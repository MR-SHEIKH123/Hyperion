/**
 * The settings HTTP surface.
 *
 * Both bugs covered here were found by booting the real server and calling it,
 * not by reading the code, and neither was reachable from a module-level test.
 *
 * 1. `GET /api/settings` serialized the whole `settings` table — including the
 *    VAPID private key and the push subscription list that
 *    `services/notify/push.ts` stores there. That module's header promises the
 *    private key "never leaves the server", but nothing enforced it. The suite
 *    stayed green because the keypair is generated lazily on first push use, so
 *    the table is empty in any test that never exercises push.
 *
 * 2. `DELETE /api/settings/:key` had never once succeeded. It cleared a key by
 *    writing NULL, but `value` is `NOT NULL` in the schema, so every call
 *    raised `NOT NULL constraint failed` and returned a 500.
 *
 * The assertions read raw response *text* where a secret is concerned, so a
 * value nested anywhere in the envelope still fails the test.
 */

import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import './helpers.ts';
import { cleanupHome, freshDb } from './helpers.ts';

import type { Server } from 'node:http';

/** Distinctive enough that finding it anywhere in a response is unambiguous. */
const PRIVATE_KEY = 'v1:NONCE:SALT:VAPID-PRIVATE-KEY-MUST-NEVER-BE-SERVED';
const SUBSCRIPTION = '[{"endpoint":"https://push.example.com/CAPABILITY-TOKEN"}]';

let server: Server;
let base: string;
let setSetting: (key: string, value: string | number | boolean | null) => void;
let getSetting: (key: string) => string | null;

before(async () => {
  await freshDb();

  ({ setSetting, getSetting } = await import('../src/db/settings.ts'));

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
  await cleanupHome();
});

describe('settings never serialize credential material', () => {
  before(() => {
    setSetting('push_vapid_private', PRIVATE_KEY);
    setSetting('push_subscriptions', SUBSCRIPTION);
    setSetting('push_vapid_public', 'PUBLIC-HALF-IS-FINE');
    setSetting('theme', 'dark');
  });

  test('reading settings omits the VAPID private key and the subscription list', async () => {
    const res = await fetch(`${base}/api/settings`);
    const text = await res.text();
    const parsed = JSON.parse(text) as { settings: Record<string, string | null> };

    assert.equal(res.status, 200);
    assert.equal(text.includes(PRIVATE_KEY), false, 'the private key reached the client');
    assert.equal(
      text.includes('CAPABILITY-TOKEN'),
      false,
      'a subscription endpoint reached the client',
    );
    assert.equal('push_vapid_private' in parsed.settings, false);
    assert.equal('push_subscriptions' in parsed.settings, false);
  });

  test('the harmless settings still come through, so this is a filter and not a blackout', async () => {
    const res = await fetch(`${base}/api/settings`);
    const parsed = (await res.json()) as {
      settings: Record<string, string | null>;
      resolved: { pushEnabled: boolean };
    };

    assert.equal(parsed.settings.theme, 'dark');
    // The public half is not a secret — the browser needs it to subscribe.
    assert.equal(parsed.settings.push_vapid_public, 'PUBLIC-HALF-IS-FINE');
    assert.equal(parsed.resolved.pushEnabled, false);
  });

  test('a bulk write echoes settings back without the secrets', async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'light' }),
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.equal(text.includes(PRIVATE_KEY), false);
    assert.equal(text.includes('CAPABILITY-TOKEN'), false);
  });

  test('a single-key write echoes settings back without the secrets', async () => {
    const res = await fetch(`${base}/api/settings/theme`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'dark' }),
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.equal(text.includes(PRIVATE_KEY), false);
    assert.equal(text.includes('CAPABILITY-TOKEN'), false);
  });

  test('clearing a key echoes settings back without the secrets', async () => {
    const res = await fetch(`${base}/api/settings/theme`, { method: 'DELETE' });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.equal(text.includes(PRIVATE_KEY), false);
    assert.equal(text.includes('CAPABILITY-TOKEN'), false);
  });

  test('the key is hidden, not destroyed — push must still be able to sign', async () => {
    // Omission has to be a serializer concern only. If filtering had been done
    // by deleting the row, every browser already subscribed would break.
    assert.equal(getSetting('push_vapid_private'), PRIVATE_KEY);
    assert.equal(getSetting('push_subscriptions'), SUBSCRIPTION);
  });

  test('the public key is still reachable through the push route that owns it', async () => {
    const res = await fetch(`${base}/api/push/key`);
    const parsed = (await res.json()) as { publicKey: string };

    assert.equal(res.status, 200);
    assert.equal(parsed.publicKey, 'PUBLIC-HALF-IS-FINE');
  });
});

describe('clearing a setting restores its built-in default', () => {
  test('deleting a key succeeds instead of failing the NOT NULL constraint', async () => {
    setSetting('theme', 'light');

    const res = await fetch(`${base}/api/settings/theme`, { method: 'DELETE' });
    const parsed = (await res.json()) as {
      cleared: string;
      settings: Record<string, string | null>;
    };

    assert.equal(res.status, 200);
    assert.equal(parsed.cleared, 'theme');
    assert.equal('theme' in parsed.settings, false);
  });

  test('a cleared key reads back as null, which is what a default falls back from', async () => {
    setSetting('theme', 'light');
    setSetting('theme', null);

    assert.equal(getSetting('theme'), null);
  });

  test('clearing a resolved setting returns the backend to its documented default', async () => {
    await fetch(`${base}/api/settings/concurrency_mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'queue' }),
    });
    const queued = (await (await fetch(`${base}/api/settings`)).json()) as {
      resolved: { concurrencyMode: string };
    };
    assert.equal(queued.resolved.concurrencyMode, 'queue');

    const res = await fetch(`${base}/api/settings/concurrency_mode`, { method: 'DELETE' });
    const parsed = (await res.json()) as { settings: Record<string, string | null> };
    assert.equal(res.status, 200);
    assert.equal('concurrency_mode' in parsed.settings, false);

    const cleared = (await (await fetch(`${base}/api/settings`)).json()) as {
      resolved: { concurrencyMode: string };
    };
    assert.equal(cleared.resolved.concurrencyMode, 'reject');
  });

  test('an explicit null through the write route clears rather than erroring', async () => {
    setSetting('theme', 'light');

    const res = await fetch(`${base}/api/settings/theme`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: null }),
    });

    assert.equal(res.status, 200);
    assert.equal(getSetting('theme'), null);
  });

  test('clearing a key that was never set is a no-op, not a 404 or a crash', async () => {
    const res = await fetch(`${base}/api/settings/never_set_by_anyone`, { method: 'DELETE' });

    assert.equal(res.status, 200);
    assert.equal(getSetting('never_set_by_anyone'), null);
  });
});
