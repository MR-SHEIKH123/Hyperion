/**
 * The sandboxed browser preview — the second HTTP server.
 *
 * Two servers are under test at once, and that is the point: the API answers
 * `POST /api/code/tasks/:taskId/preview`, and a *different* port serves the
 * files. The tests speak to the preview port with raw `node:http` requests
 * (`agent: false`, `setHost: false`) because the Host header is part of what is
 * being tested and `fetch` is forbidden from setting it — the same reason
 * `networkguard.test.ts` does.
 *
 * The real listener is started, on a real ephemeral port, and the real files are
 * served from a real task workspace. Nothing here mocks the socket: the header
 * set, the refusals and the byte-for-byte image round trip are the feature.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Server } from 'node:http';

import { cleanupHome, freshDb, testHome, unusedPort } from './helpers.ts';

type WorktreeModule = typeof import('../src/services/code/worktree.ts');
type PreviewModule = typeof import('../src/services/code/preview.ts');
type PreviewServerModule = typeof import('../src/http/previewServer.ts');

let api: Server;
let apiBase: string;
let previewPort: number;
let worktrees: WorktreeModule;
let previews: PreviewModule;
let previewServer: PreviewServerModule;

const projectsRoot = path.join(testHome, 'projects');

/**
 * 1×1 transparent PNG. A real image, so the content-type allow-list and the
 * byte round trip are exercised on bytes that are not valid UTF-8.
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface Minted {
  taskId: string;
  token: string;
  url: string;
  expiresAt: number;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * One request to the preview port, with full control of the headers.
 *
 * `agent: false` keeps Node from reusing a keep-alive socket (which would hold
 * the test process open), and `setHost: false` is what makes `host: 'evil.test'`
 * mean the header really was forged rather than overridden by the client.
 */
function raw(
  route: string,
  options: {
    method?: string;
    host?: string | null;
    port?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<RawResponse> {
  const port = options.port ?? previewPort;
  const { method = 'GET', host } = options;

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: route,
        agent: false,
        setHost: false,
        headers: {
          ...(host === null ? {} : { Host: host ?? `127.0.0.1:${String(port)}` }),
          ...(options.headers ?? {}),
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/**
 * One response header as a string. `IncomingHttpHeaders` types a value as
 * `string | string[] | undefined` because a header may repeat; none of the ones
 * asserted here does, and this keeps the assertions honest about the single
 * value rather than casting the type.
 */
function header(response: RawResponse, name: string): string {
  const value = response.headers[name];
  if (Array.isArray(value)) return value.join(', ');
  return value ?? '';
}

/** Raw bytes, for the image round trip. */
function rawBytes(route: string): Promise<{ status: number; bytes: Buffer; type: string | undefined }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: previewPort,
        method: 'GET',
        path: route,
        agent: false,
        setHost: false,
        headers: { Host: `127.0.0.1:${String(previewPort)}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            bytes: Buffer.concat(chunks),
            type: response.headers['content-type'],
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/** The read: what is live for this task, without minting one. */
async function status(taskId: string): Promise<Response> {
  return fetch(`${apiBase}/api/code/tasks/${taskId}/preview`);
}

async function mint(taskId: string): Promise<Minted> {
  const response = await fetch(`${apiBase}/api/code/tasks/${taskId}/preview`, { method: 'POST' });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  return JSON.parse(body) as Minted;
}

function write(root: string, relative: string, content: string | Buffer): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

/** A workspace directory registered as a task, direct mode, no git required. */
async function workspace(taskId: string, name = taskId): Promise<string> {
  const dir = path.join(projectsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const worktree = await worktrees.provisionWorktree(taskId, dir);
  return worktree.dir;
}

before(async () => {
  await freshDb();
  const { ensureDirectories } = await import('../src/config/env.ts');
  ensureDirectories();

  worktrees = await import('../src/services/code/worktree.ts');
  previews = await import('../src/services/code/preview.ts');
  previewServer = await import('../src/http/previewServer.ts');

  // The fixture the conformance page also serves, in miniature.
  const alpha = await workspace('preview-alpha');
  write(alpha, 'index.html', '<!doctype html>\n<p>alpha</p>\n');
  write(alpha, 'hello.txt', 'alpha\n');
  write(alpha, 'script.js', 'window.__external = "ran";\n');
  write(alpha, 'data.json', '{"ok":true}\n');
  write(alpha, 'pixel.png', PNG);
  write(alpha, 'notes.sh', '#!/bin/sh\necho hi\n');
  write(alpha, 'sub/index.html', '<p>sub</p>\n');
  write(alpha, '.git/config', '[core]\n');
  write(alpha, '.gitignore', 'node_modules\n');

  const beta = await workspace('preview-beta');
  write(beta, 'hello.txt', 'beta\n');

  const { createApp } = await import('../src/http/app.ts');
  api = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    api.once('listening', resolve);
    api.once('error', reject);
  });
  const address = api.address();
  if (address === null || typeof address === 'string') throw new Error('expected an AddressInfo');
  apiBase = `http://127.0.0.1:${address.port}`;

  // A concrete port: 0 is the *disabled* value for this feature, so the tests
  // take a free port the same way `unusedPort()` does.
  previewPort = await unusedPort();
  previewServer.startPreviewServer({ port: previewPort });
  const status = await previewServer.previewReady();
  if (!status.running) throw new Error(`the preview listener did not start: ${status.reason ?? ''}`);
});

// Sessions are process-global state, so every test starts from none: a token
// another test minted must not be able to make this one pass (or fail).
beforeEach(() => {
  previews.resetPreviews();
});

after(async () => {
  previewServer.stopPreviewServer();
  await new Promise<void>((resolve) => {
    api.closeAllConnections();
    api.close(() => resolve());
  });
  await cleanupHome();
});

// ---------------------------------------------------------------------------

describe('minting a preview', () => {
  it('returns a 256-bit token and a URL naming the running listener', async () => {
    const before = Date.now();
    const minted = await mint('preview-alpha');

    // 32 random bytes as hex: 64 characters, no padding and nothing that needs
    // escaping inside a path segment. Hex rather than base64url because that is
    // what the app's one minter (`security/tokens.ts`) produces.
    assert.match(minted.token, /^[0-9a-f]{64}$/);
    assert.equal(minted.taskId, 'preview-alpha');
    assert.equal(minted.url, `http://127.0.0.1:${String(previewPort)}/p/${minted.token}/`);
    assert.ok(minted.expiresAt >= before + previews.DEFAULT_TTL_MS);
    assert.ok(minted.expiresAt <= Date.now() + previews.DEFAULT_TTL_MS);
  });

  it('keeps one session per task, so re-minting revokes the old token', async () => {
    const first = await mint('preview-alpha');
    const second = await mint('preview-alpha');
    assert.notEqual(first.token, second.token);

    const old = await raw(`/p/${first.token}/hello.txt`);
    assert.equal(old.status, 404, 'the replaced token must stop working');

    const current = await raw(`/p/${second.token}/hello.txt`);
    assert.equal(current.status, 200);
    assert.equal(current.body, 'alpha\n');
  });

  it('an unknown task cannot be minted or revoked', async () => {
    const minted = await fetch(`${apiBase}/api/code/tasks/no-such-task/preview`, { method: 'POST' });
    assert.equal(minted.status, 404);
    assert.equal(((await minted.json()) as { error: { code: string } }).error.code, 'not_found');

    const revoked = await fetch(`${apiBase}/api/code/tasks/no-such-task/preview`, {
      method: 'DELETE',
    });
    assert.equal(revoked.status, 404);
  });
});

// ---------------------------------------------------------------------------

describe('the preview listener', () => {
  it('refuses a Host the API guard would refuse, and answers an allowed one', async () => {
    const { token } = await mint('preview-alpha');

    const forged = await raw(`/p/${token}/hello.txt`, { host: 'evil.test' });
    assert.equal(forged.status, 403);
    assert.match(forged.body, /HYPERION_ALLOWED_HOSTS/);
    assert.equal(forged.body.includes(testHome), false);

    // A missing Host header is refused by the same predicate; Node's own parser
    // usually rejects it first for HTTP/1.1, and either answer is "not served".
    const absent = await raw(`/p/${token}/hello.txt`, { host: null });
    assert.ok(absent.status === 400 || absent.status === 403);

    const allowed = await raw(`/p/${token}/hello.txt`);
    assert.equal(allowed.status, 200);
  });

  it('requires a valid token, and says nothing about why an invalid one failed', async () => {
    const { token } = await mint('preview-alpha');

    for (const route of [
      '/p/not-a-real-token/hello.txt',
      '/p/',
      '/nope',
      `/p/${token}`,
    ]) {
      const response = await raw(route);
      if (route === `/p/${token}`) {
        // Bare token URL: the same session, served as the token root.
        assert.equal(response.status, 200, route);
        continue;
      }
      assert.equal(response.status, 404, route);
      assert.match(response.body, /not valid|No preview/);
    }
  });

  it('refuses an expired token', async () => {
    // Minted with a clock far enough in the past that the session is already
    // past its TTL — no sleeping, and no test-only route parameter.
    const stale = previews.mintPreview('preview-alpha', {
      port: previewPort,
      now: Date.now() - previews.DEFAULT_TTL_MS - 1_000,
    });

    assert.equal(previews.resolvePreview(stale.token), null);
    const response = await raw(`/p/${stale.token}/hello.txt`);
    assert.equal(response.status, 404);
  });

  it('one task\u2019s token cannot read another task\u2019s workspace', async () => {
    const alpha = await mint('preview-alpha');
    const beta = await mint('preview-beta');

    const alphaFile = await raw(`/p/${alpha.token}/hello.txt`);
    assert.equal(alphaFile.body, 'alpha\n');
    const betaFile = await raw(`/p/${beta.token}/hello.txt`);
    assert.equal(betaFile.body, 'beta\n');

    // The token selects the workspace; the path is resolved inside it, so a file
    // that exists in the other task is simply not there.
    const crossed = await raw(`/p/${alpha.token}/../preview-beta/hello.txt`);
    assert.notEqual(crossed.status, 200);
    assert.equal(crossed.body.includes('beta'), false);
  });

  it('carries the exact sandbox directive, and never the escape hatches', async () => {
    const { token } = await mint('preview-alpha');
    const response = await raw(`/p/${token}/index.html`);

    const csp = header(response, 'content-security-policy');
    // Exact pin, not a substring: re-adding any removed token (or an escape
    // hatch) must fail here. The original design is scripts + forms +
    // pointer-lock only, so mouse-capture previews work while generated code
    // cannot open windows, trigger downloads or raise dialogs.
    const sandbox = csp
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('sandbox'));
    assert.equal(sandbox, 'sandbox allow-scripts allow-forms allow-pointer-lock');
    // Named individually so a failure says which hatch came back. With
    // allow-same-origin the sandbox stops isolating anything: the served
    // page would be same-origin with this listener and every other preview.
    for (const forbidden of [
      'allow-same-origin',
      'allow-top-navigation',
      'allow-popups-to-escape-sandbox',
      'allow-popups',
      'allow-downloads',
      'allow-modals',
    ]) {
      assert.equal(csp.includes(forbidden), false, `sandbox must not contain ${forbidden}`);
    }
    assert.match(csp, /frame-ancestors http:\/\/127\.0\.0\.1:4318/);

    // A header, not a meta tag: it binds in a tab as well as inside an iframe.
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['cross-origin-resource-policy'], 'cross-origin');
    // Correct on this listener only — see the API assertion below.
    assert.equal(response.headers['access-control-allow-origin'], '*');
  });

  it("names both 'self' and the explicit origin in the CSP sources", async () => {
    const { token } = await mint('preview-alpha');
    const response = await raw(`/p/${token}/index.html`);
    const csp = header(response, 'content-security-policy');

    // `sandbox` gives the document an opaque origin, where `'self'` is not
    // guaranteed to match the URL it was fetched from. Both are sent so the
    // failure of either is not a failure of the page; the conformance fixture
    // under test/fixtures/preview-conformance/ measures which one did the work.
    assert.match(csp, /script-src 'self' http:\/\/127\.0\.0\.1:\d+/);
    assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:\d+/);
    assert.match(csp, /default-src 'none'/);
  });

  it('follows the proxy headers, so a TLS-terminated origin is the one named', async () => {
    const { token } = await mint('preview-alpha');

    // Plain HTTP here, HTTPS in the browser. The explicit origin exists to be
    // the source that matches under `sandbox` when `'self'` does not, so a
    // hardcoded http:// would leave the page with neither.
    const forwarded = await raw(`/p/${token}/index.html`, {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': `127.0.0.1:${String(previewPort)}` },
    });
    const csp = header(forwarded, 'content-security-policy');
    assert.match(csp, /script-src 'self' https:\/\/127\.0\.0\.1:\d+/);
    assert.match(csp, /connect-src 'self' https:\/\/127\.0\.0\.1:\d+/);

    // The forwarded host is used verbatim, port included — the browser's origin
    // carries the port it typed, not the one this process bound.
    const otherPort = await raw(`/p/${token}/index.html`, {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'localhost:9999' },
    });
    assert.match(header(otherPort, 'content-security-policy'), /https:\/\/localhost:9999/);
  });

  it('ignores a forwarded host this server would refuse, and a nonsense scheme', async () => {
    const { token } = await mint('preview-alpha');

    // The forwarded name never widens the policy: it is only used when the same
    // allow-list check the Host header passed accepts it too.
    const forged = await raw(`/p/${token}/index.html`, {
      headers: { 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' },
    });
    const csp = header(forged, 'content-security-policy');
    assert.equal(csp.includes('evil.test'), false);
    assert.match(csp, /https:\/\/127\.0\.0\.1:\d+/);

    // A scheme that is not http or https is ignored, not echoed.
    const nonsense = await raw(`/p/${token}/index.html`, { headers: { 'x-forwarded-proto': 'ftp' } });
    const plain = header(nonsense, 'content-security-policy');
    assert.equal(plain.includes('ftp://'), false);
    assert.match(plain, /http:\/\/127\.0\.0\.1:\d+/);
  });

  it('emits no CORS header on the API, where these previews are looked at from', async () => {
    const response = await fetch(`${apiBase}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  it('serves the allow-listed content types and refuses the rest', async () => {
    const { token } = await mint('preview-alpha');

    const json = await raw(`/p/${token}/data.json`);
    assert.equal(json.status, 200);
    assert.match(json.headers['content-type'] ?? '', /^application\/json/);
    assert.equal(json.body, '{"ok":true}\n');

    const script = await raw(`/p/${token}/script.js`);
    assert.match(script.headers['content-type'] ?? '', /^text\/javascript/);

    const image = await rawBytes(`/p/${token}/pixel.png`);
    assert.equal(image.status, 200);
    assert.equal(image.type, 'image/png');
    assert.deepEqual(image.bytes, PNG, 'the bytes must round-trip unchanged');

    // Not on the allow-list: refused rather than handed over as a download.
    const shell = await raw(`/p/${token}/notes.sh`);
    assert.equal(shell.status, 415);
    assert.equal(shell.body.includes(testHome), false);
  });

  it('injects a bounded, tagged console bridge into HTML responses only', async () => {
    const root = await workspace('console-shim-task');
    write(root, 'index.html', '<!doctype html><html><head><title>fixture</title></head><body></body></html>');
    write(root, 'site.css', 'body { color: red; }');
    const { token } = await mint('console-shim-task');

    const html = await raw(`/p/${token}/`);
    assert.equal(html.status, 200);
    assert.match(html.body, /source:\"hyperion-preview-console-v1\"/);
    assert.match(html.body, /kind,args:args\.map\(text\)/);
    assert.match(html.body, /TextEncoder\(\)\.encode\(JSON\.stringify\(message\)\)\.byteLength<=max/);
    assert.match(html.body, /window\.parent\.postMessage\(message,\"\*\"\)/);
    assert.ok(html.body.length < 8192);

    const css = await raw(`/p/${token}/site.css`);
    assert.equal(css.body, 'body { color: red; }');
  });

  it('serves index.html for a directory, with and without its trailing slash', async () => {
    const { token } = await mint('preview-alpha');

    const root = await raw(`/p/${token}/`);
    assert.equal(root.status, 200);
    assert.match(root.body, /<!doctype html>\n<head><script>.*hyperion-preview-console-v1.*<\/script><\/head>\n<p>alpha<\/p>/s);

    const sub = await raw(`/p/${token}/sub/`);
    assert.equal(sub.status, 200);
    assert.match(sub.body, /<head><script>.*hyperion-preview-console-v1.*<\/script><\/head><p>sub<\/p>/s);

    const subWithoutSlash = await raw(`/p/${token}/sub`);
    assert.equal(subWithoutSlash.status, 200);
    assert.match(subWithoutSlash.body, /<head><script>.*hyperion-preview-console-v1.*<\/script><\/head><p>sub<\/p>/s);
  });

  it('serves HEAD without a body', async () => {
    const { token } = await mint('preview-alpha');
    const response = await raw(`/p/${token}/hello.txt`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-length'], '6');
    assert.equal(response.body, '');
  });

  it('refuses anything but GET and HEAD', async () => {
    const { token } = await mint('preview-alpha');
    const response = await raw(`/p/${token}/hello.txt`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers['allow'], 'GET, HEAD');
  });

  it('refuses a traversal out of the task workspace, plain text and path-free', async () => {
    const { token } = await mint('preview-alpha');

    for (const route of [
      `/p/${token}/../preview-beta/hello.txt`,
      `/p/${token}/%2e%2e/preview-beta/hello.txt`,
      `/p/${token}/sub/../../preview-beta/hello.txt`,
    ]) {
      const response = await raw(route);
      assert.equal(response.status, 403, route);
      assert.equal(response.body.includes('beta'), false, route);
      assert.equal(response.body.includes(testHome), false, route);
      assert.match(response.body, /not inside this task/);
    }
  });

  it('refuses a symlink escape and a .git path through the same seam', async () => {
    const root = path.join(projectsRoot, 'preview-alpha');
    const outside = path.join(testHome, 'outside-preview-target');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET\n');
    fs.symlinkSync(outside, path.join(root, 'escape-dir'));

    const { token } = await mint('preview-alpha');

    const escape = await raw(`/p/${token}/escape-dir/secret.txt`);
    assert.equal(escape.status, 403);
    assert.equal(escape.body.includes('TOP SECRET'), false);

    const git = await raw(`/p/${token}/.git/config`);
    assert.equal(git.status, 403);
    assert.equal(git.body.includes(testHome), false);

    // The ordinary file next door is still served: the `.git` refusal is a
    // segment predicate, not a dotfile ban. (`.gitignore` itself is refused as
    // an unknown type — the allow-list is by extension, and it has none.)
    const neighbour = await raw(`/p/${token}/hello.txt`);
    assert.equal(neighbour.status, 200);
  });
});

// ---------------------------------------------------------------------------

describe('when nothing is listening', () => {
  it('degrades a busy port instead of failing, and refuses to mint', async () => {
    const occupied = await unusedPort();
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(occupied, '127.0.0.1', resolve));

    try {
      // Starting on a port somebody else holds must not throw: previews are a
      // convenience, the API is not.
      previewServer.startPreviewServer({ port: occupied });
      const status = await previewServer.previewReady();
      assert.equal(status.running, false);
      assert.match(status.reason ?? '', new RegExp(String(occupied)));
      assert.match(status.reason ?? '', /already in use/);

      const refused = await fetch(`${apiBase}/api/code/tasks/preview-alpha/preview`, {
        method: 'POST',
      });
      assert.equal(refused.status, 403);
      const error = (await refused.json()) as {
        error: { code: string; details?: Record<string, unknown> };
      };
      assert.equal(error.error.code, 'capability_disabled');
      assert.equal(error.error.details?.setting, 'HYPERION_PREVIEW_PORT');
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('answers HYPERION_PREVIEW_PORT=0 with the same capability_disabled', async () => {
    const status = previewServer.startPreviewServer({ port: 0 });
    assert.equal(status.enabled, false);
    assert.equal(status.running, false);
    assert.equal(status.reason?.includes('HYPERION_PREVIEW_PORT'), true);

    const refused = await fetch(`${apiBase}/api/code/tasks/preview-alpha/preview`, {
      method: 'POST',
    });
    assert.equal(refused.status, 403);
    const error = (await refused.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    assert.equal(error.error.code, 'capability_disabled');
    assert.equal(error.error.details?.setting, 'HYPERION_PREVIEW_PORT');

    // And back: the feature is a switch, not a one-way door.
    previewServer.startPreviewServer({ port: previewPort });
    const restarted = await previewServer.previewReady();
    assert.equal(restarted.running, true);
    const { token } = await mint('preview-alpha');
    assert.equal((await raw(`/p/${token}/hello.txt`)).status, 200);
  });

  it('stops without waiting on a connection that is parked mid-request', async () => {
    const status = await mint('preview-alpha');
    const socket = net.connect(previewPort, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    // A request the server will never see the end of: this is the shape of a
    // browser tab sitting on a preview.
    socket.write(`GET /p/${status.token}/hello.txt HTTP/1.1\r\nHost: 127.0.0.1:${String(previewPort)}\r\n`);

    const started = Date.now();
    previewServer.stopPreviewServer();
    // Synchronous on purpose: a shutdown path that awaited `close()` would hang
    // here until the parked socket went away.
    assert.ok(Date.now() - started < 1_000);
    assert.equal(previewServer.previewListener().running, false);

    socket.destroy();
    previewServer.startPreviewServer({ port: previewPort });
    await previewServer.previewReady();
  });
});

// ---------------------------------------------------------------------------

describe('revocation', () => {
  it('reads whether a preview is live, and mints nothing to say so', async () => {
    // No session yet: a fact about the task, not a missing resource.
    const none = await status('preview-alpha');
    assert.equal(none.status, 200);
    assert.deepEqual(await none.json(), { taskId: 'preview-alpha', preview: null });

    const minted = await mint('preview-alpha');

    // The read must agree with the mint, to the token — a row that showed a
    // different URL from the one a mint handed out would be showing a link that
    // does not resolve.
    const first = await status('preview-alpha');
    const firstBody = (await first.json()) as { taskId: string; preview: Minted };
    assert.equal(firstBody.preview.token, minted.token);
    assert.equal(firstBody.preview.url, minted.url);
    assert.equal(firstBody.preview.expiresAt, minted.expiresAt);

    // **The reason the read exists.** Minting replaces the session, so a status
    // row that minted in order to display would revoke the URL the user already
    // has open. Polling the read must leave the session exactly as it was.
    const second = await status('preview-alpha');
    const secondBody = (await second.json()) as { preview: Minted };
    assert.equal(secondBody.preview.token, minted.token);
    assert.equal((await raw(`/p/${minted.token}/hello.txt`)).status, 200);

    // And a revoked task reports nothing rather than a dead URL.
    await fetch(`${apiBase}/api/code/tasks/preview-alpha/preview`, { method: 'DELETE' });
    const revoked = await status('preview-alpha');
    assert.deepEqual(await revoked.json(), { taskId: 'preview-alpha', preview: null });
  });

  it('an expired session is not a live one, and is dropped rather than remembered', async () => {
    // Straight at the service, because the route mints with the real 30-minute
    // TTL and a test that waited for it would not be a test.
    await workspace('preview-alpha');
    const minted = previews.mintPreview('preview-alpha', { ttlMs: 1_000, now: 5_000 });

    assert.notEqual(previews.livePreview('preview-alpha', { now: 5_500 }), null);
    // Expiry is a deadline, not a hint: the row must not offer a link the
    // listener will refuse.
    assert.equal(previews.livePreview('preview-alpha', { now: 6_000 }), null);
    // Dropped, not merely reported absent — and the token stops resolving with
    // it, which is the same answer the listener gives.
    assert.equal(previews.livePreview('preview-alpha', { now: 6_001 }), null);
    assert.equal(previews.resolvePreview(minted.token), null);
  });

  it('an unknown task has no preview state either', async () => {
    const response = await status('no-such-task');
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'not_found');
  });

  it('DELETE revokes the token, and does nothing twice', async () => {
    const { token } = await mint('preview-alpha');

    const first = await fetch(`${apiBase}/api/code/tasks/preview-alpha/preview`, {
      method: 'DELETE',
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { revoked: true });

    const after = await raw(`/p/${token}/hello.txt`);
    assert.equal(after.status, 404);

    const second = await fetch(`${apiBase}/api/code/tasks/preview-alpha/preview`, {
      method: 'DELETE',
    });
    assert.deepEqual(await second.json(), { revoked: false });
  });

  it('a released worktree takes its preview with it', async () => {
    const { token } = await mint('preview-alpha');
    assert.equal((await raw(`/p/${token}/hello.txt`)).status, 200);

    // Releasing is what ends a task's claim on its workspace. The session must
    // die with it: `containAgentCwd` falls back to the *projects scope* for a
    // task it no longer knows, so a token that outlived its worktree would be
    // resolving against a wider boundary than the task ever had.
    await worktrees.releaseWorktree('preview-alpha');
    assert.equal((await raw(`/p/${token}/hello.txt`)).status, 404);

    // The task comes back for any later test, and so does a preview.
    await workspace('preview-alpha');
    const fresh = await mint('preview-alpha');
    assert.equal((await raw(`/p/${fresh.token}/hello.txt`)).status, 200);
  });
});
