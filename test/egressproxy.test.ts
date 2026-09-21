/**
 * Per-provider egress proxy (Prompt 1 addendum 1.37).
 *
 * The claim this addendum makes is narrow and worth stating as a claim, because
 * everything here is one of three ways it could be false:
 *
 *   1. **The field exists but nothing dials it.** A stored proxy that the
 *      transport ignores is worse than no field at all: the user configured a
 *      route, and their traffic went direct while the settings screen said
 *      otherwise. The proxy tests below assert the bytes are *inside* the tunnel
 *      — the proxy logs the CONNECT it was asked for — and, in the negative,
 *      that an unreachable proxy makes the request *fail* rather than quietly
 *      succeed over a direct connection.
 *   2. **The disclosure leaks the credential.** A proxy URL commonly carries a
 *      user and password, and `GET /api/providers` is read by screens and by the
 *      exposure summary. Every read path is asserted against the password
 *      appearing anywhere in the payload.
 *   3. **The class still says `local`.** A loopback provider reached through a
 *      proxy elsewhere never touches this machine's loopback, so the egress class
 *      — which the credential scan, the retention policy and the exposure summary
 *      all branch on — has to see the proxy too. This is the same failure 019
 *      fixed one hop further out.
 */
import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import http from 'node:http';
import net from 'node:net';

import { cleanupHome, freshDb, startMockProvider, unusedPort } from './helpers.ts';
import type { MockProvider } from './helpers.ts';

import type { Server } from 'node:http';

// Imported after helpers.ts has set the environment.
const { createProvider, findProvider, toPublic, updateProvider } = await import(
  '../src/providers/repository.ts'
);
const { egressClassFor, isEgress, parseEgressProxy, proxyLeavesMachine, redactEgressProxy } =
  await import('../src/services/safety/outbound.ts');
const { recordUsage } = await import('../src/db/usage.ts');
const { getDb } = await import('../src/db/adapter.ts');
const { AppError } = await import('../src/util/errors.ts');

let mock: MockProvider;
let base: string;
let server: Server;
let password = 'hunter2-do-not-log-me';

/** A CONNECT proxy that tunnels to wherever it is asked, and records the asks. */
interface TestProxy {
  url: string;
  /** `host:port` of every tunnel requested, in order. */
  tunnels: string[];
  close(): Promise<void>;
}

async function startProxy(): Promise<TestProxy> {
  const tunnels: string[] = [];
  const proxyServer = http.createServer((_req, res) => {
    // Nothing here should ever be reached: undici tunnels even plain http
    // through CONNECT, so a non-CONNECT request means the transport is not
    // routing through this process at all.
    res.writeHead(501, { 'Content-Type': 'text/plain' });
    res.end('this proxy only tunnels');
  });

  proxyServer.on('connect', (req, clientSocket, head) => {
    const target = req.url ?? '';
    tunnels.push(target);
    const [host, port] = target.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  const address = proxyServer.address();
  if (address === null || typeof address === 'string') throw new Error('no proxy port');

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    tunnels,
    close: () => new Promise<void>((resolve) => proxyServer.close(() => resolve())),
  };
}

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
  mock.behave({ models: ['mock-model'], tokens: ['Hello'], failStatus: undefined });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mock.close();
  await cleanupHome();
});

// --- parsing and redaction -------------------------------------------------

test('a proxy URL is parsed into a dial URL and a credential-free authority', () => {
  const proxy = parseEgressProxy(`http://user:${password}@proxy.example.test:3128/ignored`);
  assert.ok(proxy);
  assert.equal(proxy.authority, 'proxy.example.test:3128');
  assert.equal(proxy.hasCredentials, true);
  // The path is dropped rather than stored and ignored: a CONNECT tunnel has no
  // use for it, and a stored value that is not the value in use is a lie waiting
  // for a reader.
  assert.equal(proxy.redacted, `http://user:***@proxy.example.test:3128`);
  assert.ok(proxy.url.includes(password), 'the dial URL keeps the credential');

  // Default ports are filled in, so `authority` is always dialable as written.
  assert.equal(parseEgressProxy('https://proxy.example.test')?.authority, 'proxy.example.test:443');
  assert.equal(parseEgressProxy('http://proxy.example.test')?.authority, 'proxy.example.test:80');
  assert.equal(parseEgressProxy('   ')?.authority ?? null, null);
  assert.equal(parseEgressProxy(null), null);
});

test('redaction keeps the user and replaces the password', () => {
  const proxy = parseEgressProxy(`http://alice:${password}@proxy.example.test:8080`);
  assert.ok(proxy);
  const redacted = redactEgressProxy(proxy);
  assert.ok(!redacted.includes(password), 'the password must not survive redaction');
  assert.match(redacted, /alice:\*\*\*@proxy\.example\.test:8080/);
});

test('a proxy this process cannot dial is rejected instead of stored', () => {
  // The one direction this refuses to fail in: a SOCKS URL accepted here would
  // be a route the transport cannot honour, so the traffic would go direct while
  // the disclosure said otherwise.
  for (const bad of ['socks5://proxy.example.test:1080', 'ftp://proxy.example.test', 'not a url']) {
    assert.throws(() => parseEgressProxy(bad), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'bad_request');
      return true;
    });
  }
});

// --- the class has to see the proxy ----------------------------------------

test('a local provider behind a proxy elsewhere is remote, not local', () => {
  const localAtLoopback = { type: 'local' as const, baseUrl: 'http://127.0.0.1:11434' };

  // The claim 1.37 adds: both the type and the URL say this machine, and the
  // bytes still leave it.
  assert.equal(egressClassFor(localAtLoopback), 'local');
  assert.equal(
    egressClassFor({ ...localAtLoopback, egressProxy: 'http://proxy.example.test:3128' }),
    'remote',
  );
  assert.equal(
    egressClassFor({ ...localAtLoopback, egressProxy: 'http://127.0.0.1:3128' }),
    'local',
    'a proxy on this machine keeps the traffic here',
  );
  assert.equal(isEgress({ ...localAtLoopback, egressProxy: 'http://proxy.example.test:3128' }), true);
  assert.equal(proxyLeavesMachine({ type: null, egressProxy: 'http://[::1]:3128' }), false);
  assert.equal(proxyLeavesMachine({ type: null, egressProxy: 'http://192.0.2.10:3128' }), true);

  // A provider type this build does not know stays unknown: not knowing what a
  // provider is cannot be improved by looking at its proxy.
  assert.equal(egressClassFor({ type: 'puter' as never, egressProxy: 'http://127.0.0.1:1' }), 'unknown');
});

// --- storage and disclosure ------------------------------------------------

test('the stored row keeps the dial URL and every read path redacts it', async () => {
  const provider = createProvider({
    name: 'Proxied',
    type: 'remote',
    baseUrl: mock.baseUrl,
    egressProxy: `http://alice:${password}@proxy.example.test:3128`,
  });

  // The row is the transport's source of truth: unmangled.
  assert.ok(provider.egressProxy?.includes(password));

  assert.equal(toPublic(provider).egressProxy, 'http://alice:***@proxy.example.test:3128');

  const listed = await fetch(`${base}/api/providers`);
  const listText = await listed.text();
  assert.ok(!listText.includes(password), 'the password must not reach the client');
  assert.ok(listText.includes('alice:***@proxy.example.test:3128'));
});

test('an unusable proxy is a rejected write, and null clears one', async () => {
  const rejected = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Bad',
      type: 'remote',
      baseUrl: mock.baseUrl,
      egressProxy: 'socks5://proxy.example.test:1080',
    }),
  });
  assert.equal(rejected.status, 400);
  const body = (await rejected.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'bad_request');

  const provider = createProvider({
    name: 'Clears',
    type: 'remote',
    baseUrl: mock.baseUrl,
    egressProxy: 'http://proxy.example.test:3128',
  });
  assert.equal(updateProvider(provider.id, { egressProxy: null }).egressProxy, null);
  assert.equal(updateProvider(provider.id, { egressProxy: 'http://proxy.example.test:3129' }).egressProxy, 'http://proxy.example.test:3129');
  // Undefined leaves it alone, the same tri-state the API key uses.
  assert.equal(updateProvider(provider.id, { name: 'Clears' }).egressProxy, 'http://proxy.example.test:3129');
});

test('the disclosure on /active names the proxy, and never its password', async () => {
  const provider = createProvider({
    name: 'Proxied',
    type: 'local',
    baseUrl: 'http://127.0.0.1:11434',
    egressProxy: `http://alice:${password}@proxy.example.test:3128`,
    enabled: true,
  });

  const res = await fetch(`${base}/api/providers/active`);
  const text = await res.text();
  assert.ok(!text.includes(password), 'the password must not reach the client');

  const body = JSON.parse(text) as {
    egress: string;
    egressProxy: { redacted: string; authority: string; offMachine: boolean; hasCredentials: boolean } | null;
  };
  assert.equal(body.egress, 'remote', 'the class sees the proxy');
  assert.deepEqual(body.egressProxy, {
    redacted: 'http://alice:***@proxy.example.test:3128',
    authority: 'proxy.example.test:3128',
    scheme: 'http',
    hasCredentials: true,
    offMachine: true,
  });
  assert.equal(findProvider(provider.id)?.name, 'Proxied');
});

test('a provider with no proxy discloses nothing rather than an empty object', async () => {
  createProvider({ name: 'Direct', type: 'remote', baseUrl: mock.baseUrl, enabled: true });
  const body = (await (await fetch(`${base}/api/providers/active`)).json()) as { egressProxy: unknown };
  assert.equal(body.egressProxy, null);
});

// --- the audit field -------------------------------------------------------

test('a usage row is stamped with where the request was routed, never the credential', () => {
  const provider = createProvider({
    name: 'Audited',
    type: 'remote',
    baseUrl: mock.baseUrl,
    egressProxy: `http://alice:${password}@proxy.example.test:3128`,
  });

  recordUsage({ tool: 'chat', modelId: 'mock-model', providerId: provider.id, tokensIn: 1, tokensOut: 1 });

  const row = getDb()
    .prepare<{ provider_egress: string | null; egress_proxy: string | null }>(
      'SELECT provider_egress, egress_proxy FROM usage_log ORDER BY created_at DESC LIMIT 1',
    )
    .get();

  assert.equal(row?.egress_proxy, 'proxy.example.test:3128');
  assert.equal(row?.provider_egress, 'remote');
});

test('a usage row for a local provider behind a proxy is stamped remote', () => {
  const provider = createProvider({
    name: 'LocalButTunnelled',
    type: 'local',
    baseUrl: 'http://127.0.0.1:11434',
    egressProxy: 'http://192.0.2.10:3128',
  });

  recordUsage({ tool: 'chat', modelId: 'mock-model', providerId: provider.id, tokensIn: 1, tokensOut: 1 });

  const row = getDb()
    .prepare<{ provider_egress: string | null }>(
      'SELECT provider_egress FROM usage_log ORDER BY created_at DESC LIMIT 1',
    )
    .get();
  // The whole point of 1.37's class change, seen from the audit side.
  assert.equal(row?.provider_egress, 'remote');
});

// --- the transport actually uses it ----------------------------------------

test('a proxied request is tunnelled through the proxy', async () => {
  const proxy = await startProxy();
  try {
    const provider = createProvider({
      name: 'ThroughProxy',
      type: 'remote',
      baseUrl: mock.baseUrl,
      egressProxy: proxy.url,
      enabled: true,
    });
    const { stream } = await import('../src/providers/router.ts');

    const tokens: string[] = [];
    for await (const event of stream({ modelId: 'mock-model', messages: [] })) {
      if (event.type === 'token') tokens.push(event.text);
    }

    assert.deepEqual(tokens, ['Hello'], 'the request still reached the provider');
    const target = `${new URL(mock.baseUrl).hostname}:${new URL(mock.baseUrl).port}`;
    // More than one tunnel is expected — the model list is fetched first — so what
    // is asserted is that *every* connection went through the proxy, and none
    // went anywhere else.
    assert.ok(proxy.tunnels.length > 0, 'the proxy was used');
    assert.deepEqual([...new Set(proxy.tunnels)], [target], 'every tunnel targeted the provider');
    assert.ok(findProvider(provider.id));
  } finally {
    await proxy.close();
  }
});

test('an unreachable proxy fails the request instead of going direct', async () => {
  const deadPort = await unusedPort();
  createProvider({
    name: 'DeadProxy',
    type: 'remote',
    baseUrl: mock.baseUrl,
    egressProxy: `http://127.0.0.1:${String(deadPort)}`,
    enabled: true,
  });

  const { stream } = await import('../src/providers/router.ts');
  const before = mock.streamCalls.length;

  await assert.rejects(async () => {
    for await (const _ of stream({ modelId: 'mock-model', messages: [] })) {
      // no output expected
    }
  });

  // The provider was never called: a configured proxy that cannot be reached is
  // a failure, not an invitation to send the payload over a direct connection.
  assert.equal(mock.streamCalls.length, before);
});
