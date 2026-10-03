/** Isolated, tokenised Canvas browser previews. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { cleanupHome, freshDb, testHome } from './helpers.ts';

// Resolved by config/env.ts at its first dynamic import below.
process.env.HYPERION_PREVIEW_PORT = '0';
process.env.HYPERION_ALLOWED_HOSTS = 'preview.test';
process.env.HYPERION_APP_ORIGINS = 'http://127.0.0.1:4318,http://localhost:4318';

import type { Server } from 'node:http';

type Worktrees = typeof import('../src/services/code/worktree.ts');
type Previews = typeof import('../src/services/code/preview.ts');

let apiServer: Server;
let apiPort: number;
let previewServer: Server;
let previewPort: number;
let worktrees: Worktrees;
let previews: Previews;
let sequence = 0;
const projectsRoot = path.join(testHome, 'projects');
const symlinkOnly = process.platform === 'win32' ? { skip: 'symlink fixture needs POSIX permissions' } : {};

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function raw(
  port: number,
  options: {
    method?: string;
    path?: string;
    host?: string | null;
    origin?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        // Full Host control, matching the network-guard fixture. A browser sets
        // Host itself, while fetch deliberately forbids tests from setting it.
        agent: false,
        setHost: false,
        headers: {
          ...(options.host === null ? {} : { Host: options.host ?? `127.0.0.1:${port}` }),
          ...(options.origin === undefined ? {} : { Origin: options.origin }),
          ...(options.headers ?? {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    request.on('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function project(prefix: string): string {
  const dir = path.join(projectsRoot, `${prefix}-${++sequence}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function task(prefix = 'preview'): Promise<{ taskId: string; dir: string }> {
  const dir = project(prefix);
  const taskId = `${prefix}-task-${sequence}`;
  const registered = await worktrees.provisionWorktree(taskId, dir);
  assert.equal(registered.mode, 'direct');
  return { taskId, dir };
}

async function api(pathname: string, method = 'GET'): Promise<RawResponse> {
  return raw(apiPort, { method, path: pathname });
}

function parse(response: RawResponse): any {
  return JSON.parse(response.body);
}

async function minted(taskId: string): Promise<{ taskId: string; token: string; url: string; expiresAt: number }> {
  const response = await api(`/api/code/tasks/${taskId}/preview`, 'POST');
  assert.equal(response.status, 201, response.body);
  return parse(response);
}

before(async () => {
  await freshDb();
  worktrees = await import('../src/services/code/worktree.ts');
  previews = await import('../src/services/code/preview.ts');
  const { createApp } = await import('../src/http/app.ts');
  const { createPreviewApp } = await import('../src/http/previewServer.ts');

  apiServer = createApp().listen(0, '127.0.0.1');
  previewServer = createPreviewApp().listen(0, '127.0.0.1');
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      apiServer.once('listening', resolve);
      apiServer.once('error', reject);
    }),
    new Promise<void>((resolve, reject) => {
      previewServer.once('listening', resolve);
      previewServer.once('error', reject);
    }),
  ]);
  const apiAddress = apiServer.address();
  const previewAddress = previewServer.address();
  if (apiAddress === null || typeof apiAddress === 'string') throw new Error('expected API TCP address');
  if (previewAddress === null || typeof previewAddress === 'string') throw new Error('expected preview TCP address');
  apiPort = apiAddress.port;
  previewPort = previewAddress.port;
  previews.setPreviewOrigin(`http://127.0.0.1:${previewPort}`);
});

beforeEach(() => {
  worktrees.resetWorktrees();
  previews.resetPreviews();
  previews.setPreviewOrigin(`http://127.0.0.1:${previewPort}`);
});

after(async () => {
  previews.setPreviewOrigin(null);
  await Promise.all([
    new Promise<void>((resolve) => {
      apiServer.closeAllConnections();
      apiServer.close(() => resolve());
    }),
    new Promise<void>((resolve) => {
      previewServer.closeAllConnections();
      previewServer.close(() => resolve());
    }),
  ]);
  await cleanupHome();
});

describe('preview sessions', () => {
  it('mints a 256-bit bearer token and a 30-minute URL', async () => {
    const owner = await task('mint');
    const before = Date.now();
    const result = await minted(owner.taskId);
    assert.equal(result.taskId, owner.taskId);
    assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(result.url, `http://127.0.0.1:${previewPort}/p/${result.token}/`);
    assert.ok(result.expiresAt >= before + 30 * 60_000);
    assert.ok(result.expiresAt <= Date.now() + 30 * 60_000);
  });

  it('keeps only one live session per task', async () => {
    const owner = await task('replace');
    fs.writeFileSync(path.join(owner.dir, 'index.html'), '<h1>replacement</h1>');
    const first = await minted(owner.taskId);
    const second = await minted(owner.taskId);
    assert.notEqual(first.token, second.token);
    assert.equal((await raw(previewPort, { path: `/p/${first.token}/` })).status, 403);
    assert.equal((await raw(previewPort, { path: `/p/${second.token}/` })).status, 200);
  });

  it('DELETE revokes the current token', async () => {
    const owner = await task('revoke');
    fs.writeFileSync(path.join(owner.dir, 'index.html'), 'hello');
    const session = await minted(owner.taskId);
    const revoked = await api(`/api/code/tasks/${owner.taskId}/preview`, 'DELETE');
    assert.equal(revoked.status, 200);
    assert.deepEqual(parse(revoked), { revoked: true });
    assert.equal((await raw(previewPort, { path: `/p/${session.token}/` })).status, 403);
  });

  it('DELETE reports false when the task has no current token', async () => {
    const owner = await task('empty-revoke');
    const response = await api(`/api/code/tasks/${owner.taskId}/preview`, 'DELETE');
    assert.equal(response.status, 200);
    assert.deepEqual(parse(response), { revoked: false });
  });

  it('parking or releasing a task revokes preview authority', async () => {
    const parked = await task('park');
    fs.writeFileSync(path.join(parked.dir, 'index.html'), 'hello');
    const parkedSession = await minted(parked.taskId);
    worktrees.holdWorktree(parked.taskId);
    assert.equal((await raw(previewPort, { path: `/p/${parkedSession.token}/` })).status, 403);
    assert.equal((await api(`/api/code/tasks/${parked.taskId}/preview`, 'POST')).status, 404);

    const released = await task('release');
    fs.writeFileSync(path.join(released.dir, 'index.html'), 'hello');
    const releasedSession = await minted(released.taskId);
    await worktrees.releaseWorktree(released.taskId);
    assert.equal((await raw(previewPort, { path: `/p/${releasedSession.token}/` })).status, 403);
  });

  it('refuses an expired token', async () => {
    const owner = await task('expired');
    fs.writeFileSync(path.join(owner.dir, 'index.html'), 'hello');
    const session = previews.mintPreview(owner.taskId, {
      origin: `http://127.0.0.1:${previewPort}`,
      now: 1,
      ttlMs: 1,
    });
    assert.equal((await raw(previewPort, { path: `/p/${session.token}/` })).status, 403);
    assert.equal(previews.resolvePreview(session.token), undefined);
  });

  it('does not accept one task\'s token as another task\'s authority', async () => {
    const one = await task('token-one');
    const two = await task('token-two');
    const session = previews.mintPreview(one.taskId, { origin: `http://127.0.0.1:${previewPort}` });
    assert.equal(previews.resolvePreview(two.taskId, session.token), undefined);
    assert.equal(previews.resolvePreview(one.taskId, session.token)?.taskId, one.taskId);
  });

  it('handles malformed tokens with the fixed-length, constant-time comparator', async () => {
    const owner = await task('malformed');
    previews.mintPreview(owner.taskId, { origin: `http://127.0.0.1:${previewPort}` });
    assert.doesNotThrow(() => previews.resolvePreview('x'));
    assert.equal(previews.resolvePreview('x'), undefined);

    // Constant-time comparison has no reliable behavioural timing assertion.
    // Keep the structural security primitive under mutation coverage instead
    // of pretending a noisy wall-clock benchmark proves it.
    const source = fs.readFileSync(
      new URL('../src/services/code/preview.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /return timingSafeEqual\(left, right\)/);
  });

  it('disabled preview returns the existing capability_disabled code and setting', async () => {
    const owner = await task('disabled');
    previews.setPreviewOrigin(null);
    const response = await api(`/api/code/tasks/${owner.taskId}/preview`, 'POST');
    assert.equal(response.status, 403);
    const body = parse(response);
    assert.equal(body.error.code, 'capability_disabled');
    assert.equal(body.error.details.setting, 'HYPERION_PREVIEW_PORT');
  });

  it('an unknown task stays not_found even while preview is disabled', async () => {
    previews.setPreviewOrigin(null);
    const response = await api('/api/code/tasks/unknown-preview/preview', 'POST');
    assert.equal(response.status, 404);
    assert.equal(parse(response).error.code, 'not_found');
  });
});

describe('the isolated listener', () => {
  it('requires a valid token before serving task content', async () => {
    const owner = await task('auth');
    fs.writeFileSync(path.join(owner.dir, 'index.html'), '<h1>private preview</h1>');
    assert.equal((await raw(previewPort, { path: '/p/not-a-token/' })).status, 403);
    assert.equal((await raw(previewPort, { path: '/p/' })).status, 404);
    assert.equal((await raw(previewPort, { path: '/index.html' })).status, 404);
  });

  it('serves index.html and nested resources for a valid token', async () => {
    const owner = await task('serve');
    fs.mkdirSync(path.join(owner.dir, 'assets'));
    fs.writeFileSync(path.join(owner.dir, 'index.html'), '<h1>hello</h1>');
    fs.writeFileSync(path.join(owner.dir, 'assets', 'app.js'), 'globalThis.ok = true;');
    const session = await minted(owner.taskId);

    const page = await raw(previewPort, { path: `/p/${session.token}/` });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'] ?? '', /^text\/html/);
    assert.equal(page.body, '<h1>hello</h1>');
    const script = await raw(previewPort, { path: `/p/${session.token}/assets/app.js` });
    assert.equal(script.status, 200);
    assert.match(script.headers['content-type'] ?? '', /^text\/javascript/);
  });

  it('sends the sandbox CSP without allow-same-origin', async () => {
    const owner = await task('csp');
    fs.writeFileSync(path.join(owner.dir, 'index.html'), 'csp');
    const session = await minted(owner.taskId);
    const response = await raw(previewPort, { path: `/p/${session.token}/` });
    const csp = String(response.headers['content-security-policy'] ?? '');
    assert.match(csp, /sandbox allow-scripts(?:;|$)/);
    assert.equal(csp.includes('allow-same-origin'), false);
    assert.match(csp, /frame-ancestors http:\/\/127\.0\.0\.1:4318 http:\/\/localhost:4318/);
    assert.match(csp, new RegExp(`script-src 'self' http:\\/\\/127\\.0\\.0\\.1:${previewPort}`));
  });

  it('builds the explicit CSP source from a validated forged Host', async () => {
    const owner = await task('host-csp');
    fs.writeFileSync(path.join(owner.dir, 'index.html'), 'host');
    const session = await minted(owner.taskId);
    const response = await raw(previewPort, {
      path: `/p/${session.token}/`,
      host: 'preview.test:9443',
    });
    assert.equal(response.status, 200);
    assert.match(String(response.headers['content-security-policy'] ?? ''), /script-src 'self' http:\/\/preview\.test:9443/);
  });

  it('uses the API Host allow-list and refuses a rebound host', async () => {
    const owner = await task('bad-host');
    fs.writeFileSync(path.join(owner.dir, 'index.html'), 'never');
    const session = await minted(owner.taskId);
    const response = await raw(previewPort, {
      path: `/p/${session.token}/`,
      host: 'evil.test:4320',
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.includes(owner.dir), false);
    assert.match(String(response.headers['x-content-type-options'] ?? ''), /nosniff/);
  });

  it('sets all isolation headers and CORS only on preview', async () => {
    const owner = await task('headers');
    fs.writeFileSync(path.join(owner.dir, 'index.html'), 'headers');
    const session = await minted(owner.taskId);
    const response = await raw(previewPort, { path: `/p/${session.token}/` });
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.equal(response.headers['access-control-allow-origin'], '*');

    const apiResponse = await api('/api/health');
    assert.equal(apiResponse.headers['access-control-allow-origin'], undefined);
  });

  it('allows only named content types', async () => {
    const owner = await task('types');
    fs.writeFileSync(path.join(owner.dir, 'index.html'), 'ok');
    fs.writeFileSync(path.join(owner.dir, 'data.json'), '{}');
    fs.writeFileSync(path.join(owner.dir, 'secret.bin'), 'binary');
    const session = await minted(owner.taskId);
    const allowed = await raw(previewPort, { path: `/p/${session.token}/data.json` });
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers['content-type'] ?? '', /^application\/json/);
    const refused = await raw(previewPort, { path: `/p/${session.token}/secret.bin` });
    assert.equal(refused.status, 415);
    assert.equal(refused.body.includes(owner.dir), false);
    const missing = await raw(previewPort, { path: `/p/${session.token}/missing.css` });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.includes(owner.dir), false);
  });

  it('refuses .git through files.ts with a plain response naming no filesystem path', async () => {
    const owner = await task('preview-git');
    fs.mkdirSync(path.join(owner.dir, '.git'));
    fs.writeFileSync(path.join(owner.dir, '.git', 'config'), '[core]\n');
    fs.writeFileSync(path.join(owner.dir, 'index.html'), 'ok');
    const session = await minted(owner.taskId);
    const response = await raw(previewPort, { path: `/p/${session.token}/.git/config` });
    assert.equal(response.status, 403);
    assert.match(response.headers['content-type'] ?? '', /^text\/plain/);
    assert.equal(response.body.includes(testHome), false);
    assert.equal(response.body.includes(owner.dir), false);
  });

  it('refuses a symlink escape through the shared seam without leaking its target', symlinkOnly, async () => {
    const owner = await task('preview-link');
    const outside = project('preview-outside');
    fs.writeFileSync(path.join(outside, 'secret.html'), '<h1>secret</h1>');
    fs.symlinkSync(outside, path.join(owner.dir, 'escape'), 'dir');
    fs.writeFileSync(path.join(owner.dir, 'index.html'), 'ok');
    const session = await minted(owner.taskId);
    const response = await raw(previewPort, { path: `/p/${session.token}/escape/secret.html` });
    assert.equal(response.status, 403);
    assert.equal(response.body.includes(outside), false);
    assert.equal(response.body.includes('secret</h1>'), false);
  });

  it('records that plain URL traversal is normalised to a 404 by Express 5', async () => {
    const owner = await task('url-traversal');
    fs.writeFileSync(path.join(owner.dir, 'index.html'), 'ok');
    const session = await minted(owner.taskId);
    const browserPath = new URL(
      `http://127.0.0.1:${previewPort}/p/${session.token}/../index.html`,
    ).pathname;
    const response = await raw(previewPort, { path: browserPath });
    assert.equal(response.status, 404);
  });
});
