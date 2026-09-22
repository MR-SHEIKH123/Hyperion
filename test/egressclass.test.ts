/**
 * "Leaves the machine" is a fact about the URL, not about the type name.
 *
 * The egress class was derived from `provider.type` alone, and two of the four
 * types *claim locality*: `local` and `colibri`. Nothing checked the claim.
 * `normalizeBaseUrl` accepts any http(s) host, so a Colibrì box (or an Ollama
 * server) on another machine could be registered, enabled and used while every
 * surface in the app said the bytes never left:
 *
 *   - `GET /api/providers/active` reported `egress: "local"` — the value the UI
 *     renders as "stays on this machine"
 *   - the credential scan was skipped, because `isEgress(type)` was false, so a
 *     prompt containing a key went out unremarked
 *   - `zdrStatusFor` answered `local_no_egress` — "retention by a third party is
 *     not a question that arises" — which *satisfies* a `require` policy
 *   - the exposure summary recorded the request in the `local` bucket, so the
 *     history understated egress permanently
 *
 * The rule these tests pin: a type that claims locality is verified against the
 * URL it will actually be called at. Loopback is this machine and stays `local`;
 * anything else is `remote`, which is what the app already does for opencodex.
 * A declared *remote* type is never downgraded — including one pointed at
 * 127.0.0.1 — because a locally-running proxy (opencodex routes to upstream
 * vendors) is remote in fact, and guessing "local" there would skip the gate.
 *
 * The summary half drives the real `recordUsage` path rather than the classifier,
 * because a correct classifier with an unstamped log would still report the old
 * bucket for every request ever made.
 */

import './helpers.ts';

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

const { createProvider } = await import('../src/providers/repository.ts');
const { assertOutboundSafe, egressClassFor } = await import('../src/services/safety/outbound.ts');
const { zdrStatusFor } = await import('../src/services/safety/zdr.ts');
const { recordUsage, summarizeExposure } = await import('../src/db/usage.ts');
const { getDb } = await import('../src/db/adapter.ts');
const { createApp } = await import('../src/http/app.ts');

/** TEST-NET-1: a URL that is off this machine and routable nowhere. */
const ELSEWHERE = 'http://192.0.2.10:8000/v1';

const FAKE_KEY = `sk-${'A1b2C3d4E5f6G7h8'}`;
const dirty = [{ role: 'user' as const, content: `deploy with ${FAKE_KEY}` }];

let server: http.Server;
let base: string;

before(async () => {
  await freshDb();
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

describe('the egress class of a provider that claims locality', () => {
  const cases: Array<[string, string, string]> = [
    ['a Colibrì on another machine', 'colibri', ELSEWHERE],
    ['an Ollama on another machine', 'local', ELSEWHERE],
    ['a Colibrì on a LAN address', 'colibri', 'http://192.168.1.40:8000/v1'],
    ['a Colibrì behind a name that only resolves to loopback', 'colibri', 'http://127.0.0.1.nip.io:8000/v1'],
  ];

  for (const [what, type, baseUrl] of cases) {
    test(`${what} is remote`, () => {
      assert.equal(egressClassFor({ type: type as never, baseUrl }), 'remote');
    });
  }

  const local: Array<[string, string]> = [
    ['the documented default', 'http://localhost:8000/v1'],
    ['an explicit IPv4 loopback', 'http://127.0.0.1:8000/v1'],
    ['the rest of the loopback block', 'http://127.0.0.2:8000/v1'],
    ['an IPv6 loopback', 'http://[::1]:8000/v1'],
  ];

  for (const [what, baseUrl] of local) {
    test(`a Colibrì at ${what} is still local, so nothing warns about it`, () => {
      assert.equal(egressClassFor({ type: 'colibri', baseUrl }), 'local');
      assert.equal(assertOutboundSafe({ messages: dirty, provider: { type: 'colibri', baseUrl }, enabled: true }), null);
    });
  }

  test('an unreadable or absent URL is not evidence of locality', () => {
    assert.equal(egressClassFor({ type: 'colibri', baseUrl: null }), 'remote');
    assert.equal(egressClassFor({ type: 'colibri', baseUrl: 'not a url' }), 'remote');
    assert.equal(egressClassFor({ type: 'colibri' }), 'remote');
  });

  test('a declared remote is never downgraded, even at loopback', () => {
    assert.equal(egressClassFor({ type: 'remote', baseUrl: 'http://127.0.0.1:11434/v1' }), 'remote');
    assert.equal(egressClassFor({ type: 'opencodex', baseUrl: 'http://[::1]:10100/v1' }), 'remote');
  });

  test('a provider we cannot classify stays unknown, whatever the URL', () => {
    assert.equal(egressClassFor(null), 'unknown');
    assert.equal(egressClassFor({ type: null, baseUrl: ELSEWHERE }), 'unknown');
    assert.equal(egressClassFor({ type: 'from-a-newer-build' as never, baseUrl: ELSEWHERE }), 'unknown');
  });
});

describe('what the rest of the app says about such a provider', () => {
  test('the credential scan is no longer skipped', () => {
    assert.throws(
      () => assertOutboundSafe({ messages: dirty, provider: { type: 'colibri', baseUrl: ELSEWHERE }, enabled: true }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: string }).code, 'redaction_flagged');
        assert.equal((error as { details?: { providerClass?: string } }).details?.providerClass, 'remote');
        return true;
      },
    );
  });

  test('the retention question is asked rather than dismissed', () => {
    const provider = createProvider({
      name: 'colibri-elsewhere',
      type: 'colibri',
      baseUrl: ELSEWHERE,
      apiKey: null,
    });
    assert.equal(zdrStatusFor(provider), 'zdr_unknown');

    const here = createProvider({
      name: 'colibri-here',
      type: 'colibri',
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: null,
    });
    assert.equal(zdrStatusFor(here), 'local_no_egress');
  });

  test('GET /api/providers/active reports where the bytes would go', async () => {
    const provider = createProvider({
      name: 'colibri-active',
      type: 'colibri',
      baseUrl: ELSEWHERE,
      apiKey: null,
      enabled: true,
    });
    const body = (await (await fetch(`${base}/api/providers/active`)).json()) as {
      egress: string;
      provider: { id: string };
    };
    assert.equal(body.provider.id, provider.id);
    assert.equal(body.egress, 'remote');
  });

  test('the exposure summary counts it as remote, at write time', () => {
    const provider = createProvider({
      name: 'colibri-summary',
      type: 'colibri',
      baseUrl: ELSEWHERE,
      apiKey: null,
    });
    recordUsage({
      tool: 'chat',
      modelId: 'colibri-model',
      providerId: provider.id,
      providerName: provider.name,
      providerType: provider.type,
      tokensIn: 10,
      tokensOut: 10,
    });

    const remote = summarizeExposure().byClass.find((bucket) => bucket.key === 'remote');
    assert.ok(remote, 'expected a remote bucket');
    assert.ok(remote.requests >= 1);
  });

  test('a row written before the column existed keeps the bucket it was written under', () => {
    // History is not restated: the URL was never stored, so there is nothing to
    // re-decide it with. Such rows keep the type-derived bucket they were lived
    // under, which is a permanent understatement this fix cannot repair.
    const provider = createProvider({
      name: 'colibri-legacy',
      type: 'colibri',
      baseUrl: ELSEWHERE,
      apiKey: null,
    });
    recordUsage({
      tool: 'chat',
      modelId: 'colibri-model',
      providerId: provider.id,
      providerType: provider.type,
      tokensIn: 1,
      tokensOut: 1,
    });
    getDb()
      .prepare(`UPDATE usage_log SET provider_egress = NULL WHERE provider_id = ?`)
      .run(provider.id);

    const rows = summarizeExposure().byClass.filter((bucket) => bucket.requests > 0);
    const local = rows.find((bucket) => bucket.key === 'local');
    assert.ok(local, 'expected the un-stamped row to fall back to its recorded type');
  });
});
