/**
 * The Host and Origin guards.
 *
 * Both are HTTP-boundary behaviour, so both are driven against the real app on
 * a real port with real headers. A unit test on the matcher would prove the
 * matcher matches; it would not prove the middleware is mounted ahead of the
 * body parsers, that it covers the SSE routes, or that a refused multipart
 * upload is refused before multer buffers it — which is the whole point.
 *
 * The rebinding case is the one worth spelling out: `fetch` will not let a
 * caller set `Host`, because in a browser it is a forbidden header. That is
 * exactly the situation being simulated — an attacker's page whose *name*
 * resolves to 127.0.0.1, so the browser writes `Host: evil.test:4317` itself —
 * so these tests speak HTTP directly (`node:http`, which does let the Host
 * header be set) instead.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before, describe } from 'node:test';

import './helpers.ts';

// Set before the first `src/` import: config/env.ts resolves every value once,
// at import time. These are the two new vars under test.
process.env.HYPERION_ALLOWED_HOSTS = 'hyperion.tailnet.ts.net, 100.80.1.2';
// The harness listens on an ephemeral port; this is the *configured* port, and
// the only thing it feeds is the API's own origin, so it may as well be real.
process.env.HYPERION_PORT = '4317';
process.env.HYPERION_APP_ORIGINS = 'http://127.0.0.1:4318,http://localhost:4318';

const { freshDb } = await import('./helpers.ts');
const { createApp } = await import('../src/http/app.ts');
const { buildPolicy, canonicalHostname, canonicalOrigin, isAllowedHost, isAllowedOrigin } =
  await import('../src/http/networkGuard.ts');

import type { Server } from 'node:http';

let server: Server;
let port: number;

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * One request, with full control of every header.
 *
 * `fetch` cannot set `Host`, and an SSE route has to be readable without
 * waiting for a body that never ends, so both cases want the raw client.
 */
function raw(
  options: {
    method?: string;
    path?: string;
    host?: string | null;
    origin?: string | null;
    headers?: Record<string, string>;
    body?: string | Buffer;
  } = {},
): Promise<RawResponse> {
  const { method = 'GET', path = '/api/health', host, origin, headers = {}, body } = options;

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        // A fresh agent per request: Node's global agent keeps sockets alive,
        // which would hold the test process open after the last assertion.
        agent: false,
        // setHost:false stops Node adding its own Host header, so `host: null`
        // really means "no Host header at all".
        setHost: false,
        headers: {
          ...(host === null ? {} : { Host: host ?? `127.0.0.1:${port}` }),
          ...(origin === null || origin === undefined ? {} : { Origin: origin }),
          ...headers,
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
          // An SSE route answers 200 and then never ends; one frame is enough
          // to know the guard let it through.
          if (response.headers['content-type']?.includes('text/event-stream')) {
            request.destroy();
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text });
          }
        });
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }),
        );
        response.on('error', () => {
          /* destroyed on purpose above */
        });
      },
    );
    request.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNRESET') return; // our own destroy()
      reject(error);
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/** A minimal multipart body, so the multipart routes are exercised as multipart. */
function multipart(field: string, filename: string, content: string): { body: string; type: string } {
  const boundary = '----hyperiontestboundary';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n' +
    `${content}\r\n` +
    `--${boundary}--\r\n`;
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

/**
 * A state-changing JSON route with no side effects worth cleaning up: a
 * temporary chat is held in memory and never inserted.
 */
function newChat(): { path: string; headers: Record<string, string>; body: string } {
  return {
    path: '/api/chat',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'chat', temporary: true }),
  };
}

function errorOf(response: RawResponse): { code: string; message: string; details?: Record<string, unknown> } {
  return (JSON.parse(response.body) as {
    error: { code: string; message: string; details?: Record<string, unknown> };
  }).error;
}

before(async () => {
  await freshDb();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected an AddressInfo');
  port = address.port;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
});

describe('the Host guard', () => {
  test('a rebound host is refused on a GET', async () => {
    const response = await raw({ host: `evil.test:${port}` });
    assert.equal(response.status, 403);
    const error = errorOf(response);
    assert.equal(error.code, 'scope_violation');
    assert.match(error.message, /evil\.test/);
    assert.equal(error.details?.setting, 'HYPERION_ALLOWED_HOSTS');
  });

  test('a rebound host is refused on a POST', async () => {
    const response = await raw({
      method: 'POST',
      path: '/api/resources/detect',
      host: 'attacker.example',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'https://example.com' }),
    });
    assert.equal(response.status, 403);
    assert.equal(errorOf(response).code, 'scope_violation');
  });

  test('a rebound host is refused on an SSE route', async () => {
    // POST /api/chat/stream is an SSE route: on success it answers 200 with
    // text/event-stream and streams frames. The guard has to refuse it as a
    // plain JSON 403 instead, before a stream is opened.
    const response = await raw({
      method: 'POST',
      path: '/api/chat/stream',
      host: 'rebound.test',
      origin: 'http://localhost:4318',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: 'c1', message: 'hi' }),
    });
    assert.equal(response.status, 403);
    assert.equal(errorOf(response).code, 'scope_violation');
    assert.ok(!(response.headers['content-type'] ?? '').includes('text/event-stream'));
  });

  test('it covers routes that do not exist, so a probe cannot map the API', async () => {
    const refused = await raw({ path: '/api/nope', host: 'evil.test' });
    assert.equal(refused.status, 403);
    const allowed = await raw({ path: '/api/nope' });
    assert.equal(allowed.status, 404);
  });

  test('loopback hosts are accepted on any port', async () => {
    for (const host of [
      '127.0.0.1:4318',
      'localhost:4318',
      'localhost',
      '[::1]:4318',
      `127.0.0.1:${port}`,
      'LOCALHOST:4318',
      'localhost.:4318',
    ]) {
      const response = await raw({ host });
      assert.equal(response.status, 200, `expected ${host} to be accepted`);
    }
  });

  test('a HYPERION_ALLOWED_HOSTS entry is accepted, by name and by address', async () => {
    for (const host of ['hyperion.tailnet.ts.net:4318', 'hyperion.tailnet.ts.net', '100.80.1.2:4317']) {
      const response = await raw({ host });
      assert.equal(response.status, 200, `expected ${host} to be accepted`);
    }
  });

  test('a hostname that merely contains an allowed one is refused', async () => {
    // Substring and suffix matching are the classic ways a host allow-list is
    // got past: `notlocalhost` ends with `localhost`, and
    // `localhost.evil.test` starts with it. Both are attacker-registrable
    // names, and a mutation that swapped set membership for `endsWith` passed
    // the rest of this suite.
    for (const host of [
      'notlocalhost:4318',
      'localhost.evil.test',
      'evil.test.hyperion.tailnet.ts.net.evil.test',
      'hyperion.tailnet.ts.net.evil.test',
      'xn--localhost-0za', // an IDN that punycodes to something else entirely
      '127.0.0.1.evil.test',
    ]) {
      const response = await raw({ host });
      assert.equal(response.status, 403, `expected ${host} to be refused`);
    }
  });

  test('a missing Host header never reaches a route', async () => {
    // Node's own HTTP parser refuses an HTTP/1.1 request with no Host header
    // (400) before Express sees it, so the guard's own "(missing or unreadable)"
    // branch is unreachable over the wire. Asserted as "refused", not as a
    // specific code, because which layer refuses it is Node's business — the
    // contract is that no route runs.
    const response = await raw({ host: null });
    assert.ok(response.status === 400 || response.status === 403, `got ${response.status}`);
    assert.ok(!response.body.includes('"status":"ok"'));
  });

  test('the refusal reports the parsed hostname, not the raw header', async () => {
    // The header is attacker-chosen and the message is echoed back and logged.
    const response = await raw({ host: 'EVIL.TEST.:4318' });
    assert.equal(errorOf(response).details?.host, 'evil.test');
  });
});

describe('the Origin guard', () => {
  const disallowed = 'http://evil.test:4318';

  test('a disallowed Origin is refused on the backup import route (multipart)', async () => {
    const part = multipart('file', 'backup.zip', 'not a real archive');
    const response = await raw({
      method: 'POST',
      path: '/api/backup/import',
      origin: disallowed,
      headers: { 'Content-Type': part.type },
      body: part.body,
    });
    assert.equal(response.status, 403);
    const error = errorOf(response);
    assert.equal(error.code, 'scope_violation');
    assert.equal(error.details?.setting, 'HYPERION_APP_ORIGINS');
  });

  test('a disallowed Origin is refused on the skills upload route (multipart)', async () => {
    const part = multipart('files', 'SKILL.md', '# skill');
    const response = await raw({
      method: 'POST',
      path: '/api/skills/upload',
      origin: disallowed,
      headers: { 'Content-Type': part.type },
      body: part.body,
    });
    assert.equal(response.status, 403);
    assert.equal(errorOf(response).code, 'scope_violation');
  });

  test('a disallowed Origin is refused on the Cowork knowledge route (multipart)', async () => {
    const part = multipart('file', 'note.txt', 'hello');
    const response = await raw({
      method: 'POST',
      path: '/api/cowork/knowledge',
      origin: disallowed,
      headers: { 'Content-Type': part.type },
      body: part.body,
    });
    assert.equal(response.status, 403);
    assert.equal(errorOf(response).code, 'scope_violation');
  });

  test('a disallowed Origin is refused on a JSON route', async () => {
    const response = await raw({ method: 'POST', ...newChat(), origin: disallowed });
    assert.equal(response.status, 403);
    assert.equal(errorOf(response).code, 'scope_violation');
  });

  test('a disallowed Origin is refused on DELETE and PATCH too', async () => {
    for (const method of ['DELETE', 'PATCH', 'PUT']) {
      const response = await raw({
        method,
        path: '/api/chat/anything',
        origin: disallowed,
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 403, `expected ${method} to be refused`);
    }
  });

  test('a loopback origin on another port is refused, end to end', async () => {
    // The explicitly forbidden shortcut: "allow any loopback port" would let a
    // preview, another dev server, or anything else the user happens to be
    // running locally drive this API from a page. Ports are exact.
    //
    // This assertion exists because a mutation that widened the live middleware
    // to `/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/` passed the whole suite
    // without it: the matcher unit test below covers the function, not the
    // middleware the requests actually travel through.
    for (const origin of ['http://127.0.0.1:5173', 'http://localhost:3000', 'http://127.0.0.1', 'http://localhost:4320']) {
      const response = await raw({ method: 'POST', ...newChat(), origin });
      assert.equal(response.status, 403, `expected ${origin} to be refused`);
      assert.equal(errorOf(response).code, 'scope_violation');
    }
  });

  test('an https origin on an allowed host and port is refused', async () => {
    // The API terminates no TLS, so this is a caller guessing, not the app.
    const response = await raw({ method: 'POST', ...newChat(), origin: 'https://localhost:4318' });
    assert.equal(response.status, 403);
  });

  test('Origin: null is refused', async () => {
    const response = await raw({ method: 'POST', ...newChat(), origin: 'null' });
    assert.equal(response.status, 403);
    assert.equal(errorOf(response).details?.origin, 'null');
  });

  test('an allowed Origin passes', async () => {
    // The Vite dev server, on both loopback spellings — the default value of
    // HYPERION_APP_ORIGINS, and what the browser sends in development.
    for (const origin of ['http://localhost:4318', 'http://127.0.0.1:4318']) {
      const response = await raw({ method: 'POST', ...newChat(), origin });
      assert.equal(response.status, 201, `expected ${origin} to be accepted`);
    }
  });

  test("the API's own origin passes", async () => {
    // Built from the configured port (HYPERION_PORT), not the ephemeral listen
    // port: a browser pointed straight at the API sends the former.
    const response = await raw({ method: 'POST', ...newChat(), origin: 'http://127.0.0.1:4317' });
    assert.equal(response.status, 201);
  });

  test('an absent Origin passes, because curl and the test suite are not browsers', async () => {
    const response = await raw({ method: 'POST', ...newChat() });
    assert.equal(response.status, 201);
  });

  test('a disallowed Origin on a GET passes: nothing changes and no CORS header is sent', async () => {
    const response = await raw({ origin: disallowed });
    assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });

  test('no CORS headers are emitted on an allowed request either', async () => {
    const response = await raw({ method: 'POST', ...newChat(), origin: 'http://localhost:4318' });
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
    assert.equal(response.headers['vary'], undefined);
  });

  test('the guards run before the body parsers', async () => {
    // Body-parser answers a malformed JSON body with 400 `bad_request`. Getting
    // 403 instead is the proof that nothing read the body first — which is what
    // keeps a refused 100 MB upload from being buffered.
    const response = await raw({
      method: 'POST',
      path: '/api/resources/detect',
      origin: disallowed,
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(response.status, 403);
    assert.equal(errorOf(response).code, 'scope_violation');
  });
});

describe('the allow-list matchers', () => {
  const p = buildPolicy({
    bind: '100.80.1.2',
    port: 4317,
    allowedHosts: ['hyperion.tailnet.ts.net'],
    appOrigins: ['http://127.0.0.1:4318'],
  });

  test('a hostname is compared without its port, case or trailing dot', () => {
    assert.equal(canonicalHostname('LocalHost.:4318'), 'localhost');
    assert.equal(canonicalHostname('[0:0:0:0:0:0:0:1]:4317'), '[::1]');
    assert.equal(canonicalHostname('127.0.0.1'), '127.0.0.1');
  });

  test('anything that is not purely an authority is rejected outright', () => {
    for (const value of ['', '   ', 'evil.test/127.0.0.1', '127.0.0.1@evil.test', 'evil.test?a=1', '::1']) {
      assert.equal(canonicalHostname(value), null, `expected ${JSON.stringify(value)} to be rejected`);
    }
  });

  test('an origin keeps its scheme and explicit port', () => {
    assert.equal(canonicalOrigin('http://localhost:4318'), 'http://localhost:4318');
    assert.equal(canonicalOrigin('http://localhost:4318/'), 'http://localhost:4318');
    assert.equal(canonicalOrigin('null'), null);
    assert.equal(canonicalOrigin('https://localhost:4318'), 'https://localhost:4318');
  });

  test('the bind address and the allow-list are hosts; loopback always is', () => {
    for (const host of ['127.0.0.1:9999', 'localhost', '[::1]:1', '100.80.1.2', 'hyperion.tailnet.ts.net']) {
      assert.ok(isAllowedHost(host, p), `expected ${host} to be allowed`);
    }
    for (const host of ['evil.test', '127.0.0.2', 'localhost.evil.test', undefined, 'null']) {
      assert.ok(!isAllowedHost(host, p), `expected ${String(host)} to be refused`);
    }
  });

  test('only the configured app origins and the API\'s own origins are allowed', () => {
    for (const origin of [
      'http://127.0.0.1:4318',
      'http://127.0.0.1:4317',
      'http://localhost:4317',
      'http://100.80.1.2:4317',
    ]) {
      assert.ok(isAllowedOrigin(origin, p), `expected ${origin} to be allowed`);
    }
    // No "any loopback port": the dev server's port is allowed because it is
    // configured, and nothing else on the machine inherits that.
    for (const origin of [
      'http://localhost:4318', // not configured in this policy
      'http://127.0.0.1:5173',
      'http://127.0.0.1',
      'https://127.0.0.1:4318',
      'http://evil.test:4318',
      'null',
      undefined,
    ]) {
      assert.ok(!isAllowedOrigin(origin, p), `expected ${String(origin)} to be refused`);
    }
  });

  test('a malformed allow-list entry fails the boot instead of being dropped', () => {
    assert.throws(
      () => buildPolicy({ bind: '127.0.0.1', port: 4317, allowedHosts: ['http://a/b c'], appOrigins: [] }),
      /HYPERION_ALLOWED_HOSTS/,
    );
    assert.throws(
      () => buildPolicy({ bind: '127.0.0.1', port: 4317, allowedHosts: [], appOrigins: ['localhost:4318'] }),
      /HYPERION_APP_ORIGINS/,
    );
  });

  test('a wildcard bind contributes no hostname of its own', () => {
    const wild = buildPolicy({ bind: '0.0.0.0', port: 4317, allowedHosts: [], appOrigins: [] });
    assert.deepEqual([...wild.hostnames].sort(), ['127.0.0.1', '[::1]', 'localhost']);
    assert.ok(!isAllowedHost('0.0.0.0', wild));
  });
});
