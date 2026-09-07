/**
 * The Phase 1 permission and profile routes — Prompts 1.27 §6 and 1.28 §3.
 *
 * These are discovery endpoints, and the thing worth asserting about a discovery
 * endpoint is that it does not lie by simplification. `GET /code/permissions`
 * exists to answer "why was this refused?", so a merged map would pass a naive
 * test while being useless: the whole answer is *which layer* said so. Every case
 * here therefore checks provenance, not just the effective action.
 *
 * `PUT /settings/agents` is checked for the ordering trap too. `/:key` is a
 * catch-all on the same router, so a route registered after it would silently
 * store a settings row literally named `agents` and return 200.
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before, describe } from 'node:test';

import { cleanupHome, freshDb, testHome } from './helpers.ts';

import type { Server } from 'node:http';

const { getSetting, setSetting } = await import('../src/db/settings.ts');

let server: Server;
let base: string;

before(async () => {
  await freshDb();
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

interface Layer {
  layer: string;
  rules: Record<string, unknown>;
}

async function get(path: string): Promise<{ status: number; json: Record<string, never> }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, json: (await response.json()) as Record<string, never> };
}

async function send(
  method: 'PUT' | 'POST',
  path: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, never> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, json: (await response.json()) as Record<string, never> };
}

let counter = 0;

/** A project directory holding agent profiles and an optional permissions file. */
async function project(files: Record<string, string>, permissions?: string): Promise<string> {
  counter += 1;
  const name = `perm-routes-${counter}`;
  const root = join(testHome, 'projects', name);
  await mkdir(join(root, '.hyperion', 'agents'), { recursive: true });
  for (const [filename, contents] of Object.entries(files)) {
    await writeFile(join(root, '.hyperion', 'agents', filename), contents, 'utf8');
  }
  if (permissions !== undefined) {
    await writeFile(join(root, '.hyperion', 'permissions.json'), permissions, 'utf8');
  }
  return name;
}

describe('GET /api/code/permissions', () => {
  test('returns the layers in evaluation order rather than a merged map', async () => {
    const dir = await project(
      { 'docs.md': '---\nname: docs\nmode: plan\npermissions: {"write":{"docs/**":"allow"}}\n---\nDocs only.\n' },
      '{"bash":"deny"}',
    );

    const { status, json } = await get(`/api/code/permissions?project=${dir}&profile=docs`);
    assert.equal(status, 200);

    const layers = json.layers as unknown as Layer[];
    assert.deepEqual(
      layers.map((entry) => entry.layer),
      ['builtin', 'profile', 'project'],
      'reading top to bottom must be exactly how the engine reaches its verdict',
    );
    assert.deepEqual(layers[1]?.rules, { write: { 'docs/**': 'allow' } });
    assert.deepEqual(layers[2]?.rules, { bash: 'deny' });
  });

  test('reports the profile that was resolved, not just the rules', async () => {
    const dir = await project({ 'docs.md': '---\nname: docs\nmode: plan\n---\nDocs.\n' });

    const { json } = await get(`/api/code/permissions?project=${dir}&profile=docs`);
    assert.deepEqual(json.profile, { name: 'docs', builtin: false, mode: 'plan' });
  });

  test('resolves a different baseline per mode, because Ask, Plan and Act are not the same answer', async () => {
    const dir = await project({});

    for (const mode of ['ask', 'plan', 'act'] as const) {
      const { json } = await get(`/api/code/permissions?project=${dir}&mode=${mode}`);
      assert.equal((json.profile as unknown as { name: string }).name, mode);
      assert.equal(json.mode, mode);
    }
  });

  test('defaults to act when no mode is named, matching parseTaskInput', async () => {
    const { json } = await get(`/api/code/permissions?project=${await project({})}`);
    assert.equal(json.mode, 'act');
  });

  test('omits a layer that contributes nothing instead of returning an empty one', async () => {
    // An empty layer in the response reads as "this layer said allow nothing",
    // which is the opposite of "this layer had no opinion".
    const { json } = await get(`/api/code/permissions?project=${await project({})}`);
    assert.deepEqual((json.layers as unknown as Layer[]).map((entry) => entry.layer), ['builtin']);
  });

  test('includes a task session layer only when a task id is supplied', async () => {
    const { recordApproval, resolveApproval } = await import('../src/db/approvals.ts');
    const approval = recordApproval({
      taskId: 'route-session-task',
      tool: 'code',
      toolName: 'bash',
      arguments: '{"command":"npm test"}',
      permissionKey: 'bash',
    });
    resolveApproval(approval.id, 'allow_session');

    const dir = await project({});
    const without = await get(`/api/code/permissions?project=${dir}`);
    assert.equal((without.json.layers as unknown as Layer[]).some((entry) => entry.layer === 'session'), false);

    const withTask = await get(`/api/code/permissions?project=${dir}&taskId=route-session-task`);
    const session = (withTask.json.layers as unknown as Layer[]).find((entry) => entry.layer === 'session');
    assert.deepEqual(session?.rules, { bash: 'allow' });
  });

  test('rejects an unknown profile with 404 rather than silently answering for act', async () => {
    const { status, json } = await get(`/api/code/permissions?project=${await project({})}&profile=nope`);
    assert.equal(status, 404);
    assert.equal((json.error as unknown as { code: string }).code, 'not_found');
  });

  test('rejects a project outside the scope', async () => {
    const { status, json } = await get('/api/code/permissions?project=../../etc');
    assert.equal(status, 403);
    assert.equal((json.error as unknown as { code: string }).code, 'scope_violation');
  });

  test('reports a malformed permissions file as a 400 naming the file', async () => {
    const dir = await project({}, '{not json}');
    const { status, json } = await get(`/api/code/permissions?project=${dir}`);

    assert.equal(status, 400);
    assert.match((json.error as unknown as { message: string }).message, /permissions\.json/);
  });
});

describe('GET /api/settings/agent-profiles', () => {
  test('lists the built-ins alongside a project’s own', async () => {
    const dir = await project({ 'docs.md': '---\nname: docs\nmode: plan\n---\nDocs.\n' });
    const { status, json } = await get(`/api/settings/agent-profiles?project=${dir}`);

    assert.equal(status, 200);
    const names = (json.profiles as unknown as { name: string }[]).map((profile) => profile.name);
    assert.deepEqual(names.slice(0, 3), ['ask', 'plan', 'act']);
    assert.ok(names.includes('docs'));
  });

  test('omits a hidden profile unless includeHidden is asked for', async () => {
    const dir = await project({ 'mine.md': '---\nname: mine\nhidden: true\n---\nMine.\n' });

    const listed = await get(`/api/settings/agent-profiles?project=${dir}`);
    assert.equal((listed.json.profiles as unknown as { name: string }[]).some((p) => p.name === 'mine'), false);

    const all = await get(`/api/settings/agent-profiles?project=${dir}&includeHidden=true`);
    assert.equal((all.json.profiles as unknown as { name: string }[]).some((p) => p.name === 'mine'), true);
  });

  test('never serializes a profile body, which is a prompt fragment nothing renders', async () => {
    const dir = await project({ 'long.md': '---\nname: long\n---\nA very long system prompt fragment.\n' });
    const { json } = await get(`/api/settings/agent-profiles?project=${dir}&includeHidden=true`);

    assert.doesNotMatch(JSON.stringify(json), /system prompt fragment/);
  });
});

describe('GET|PUT /api/settings/agents', () => {
  test('reads back as null when nothing is stored, not as act', async () => {
    setSetting('default_agent_profile', null);
    const { status, json } = await get('/api/settings/agents');

    assert.equal(status, 200);
    assert.equal(json.defaultAgentProfile, null);
  });

  test('spells out that Ask and Plan ignore the stored default', async () => {
    // A settings panel that implied otherwise would show the user a control that
    // does not do what it says.
    await send('PUT', '/api/settings/agents', { defaultAgentProfile: 'house' });
    const { json } = await get('/api/settings/agents');

    assert.deepEqual(json.resolvedFor, { ask: 'ask', plan: 'plan', act: 'house' });
  });

  test('stores the default under the key the resolver reads', async () => {
    // A typo'd key write succeeds while the reader keeps returning its default, so
    // the setting silently never applies.
    await send('PUT', '/api/settings/agents', { defaultAgentProfile: 'reviewer' });
    assert.equal(getSetting('default_agent_profile'), 'reviewer');
  });

  test('clears the default with an explicit blank, the way every other setting clears', async () => {
    // `asClearableString`'s convention, followed rather than reinvented: an
    // omitted key is an error so a partial payload cannot wipe a setting, and an
    // explicitly blank string is what "unset" means. A `null` here is a 400 for
    // the same reason.
    await send('PUT', '/api/settings/agents', { defaultAgentProfile: 'reviewer' });
    const { status, json } = await send('PUT', '/api/settings/agents', { defaultAgentProfile: '' });

    assert.equal(status, 200);
    assert.equal(json.defaultAgentProfile, null);
    assert.equal(getSetting('default_agent_profile'), null);

    const nulled = await send('PUT', '/api/settings/agents', { defaultAgentProfile: null });
    assert.equal(nulled.status, 400);
  });

  test('refuses a name that could never resolve to a file', async () => {
    const { status, json } = await send('PUT', '/api/settings/agents', {
      defaultAgentProfile: '../../etc/passwd',
    });

    assert.equal(status, 400);
    assert.equal((json.error as unknown as { code: string }).code, 'bad_request');
  });

  test('requires the field rather than treating an absent one as a clear', async () => {
    const { status } = await send('PUT', '/api/settings/agents', {});
    assert.equal(status, 400);
  });

  test('is not swallowed by the /:key catch-all', async () => {
    // The ordering trap: `/:key` is registered last on purpose. If it were not,
    // this PUT would store a settings row literally named `agents` and still 200.
    await send('PUT', '/api/settings/agents', { defaultAgentProfile: 'reviewer' });
    assert.equal(getSetting('agents'), null);
  });
});

describe('POST /api/settings/reload-config', () => {
  test('validates the project files and returns what it resolved', async () => {
    const dir = await project(
      { 'docs.md': '---\nname: docs\nmode: plan\n---\nDocs.\n' },
      '{"bash":"ask"}',
    );

    const { status, json } = await send('POST', '/api/settings/reload-config', { project: dir });
    assert.equal(status, 200);
    assert.equal(json.validated, true);
    assert.deepEqual(json.permissions, { bash: 'ask' });
    assert.equal((json.profiles as unknown as { name: string }[]).some((p) => p.name === 'docs'), true);
  });

  test('reports a malformed profile here, before a run hits it', async () => {
    // The whole value of this endpoint: `db/settings.ts` is deliberately un-cached
    // and project files are read per task, so there is nothing stale to clear. What
    // it buys is finding a broken front-matter block on demand.
    const dir = await project({ 'broken.md': '---\nname: broken\npermissions: {nope}\n---\nBroken.\n' });

    const { status, json } = await send('POST', '/api/settings/reload-config', { project: dir });
    assert.equal(status, 400);
    assert.equal((json.error as unknown as { code: string }).code, 'bad_request');
  });

  test('never returns a secret setting', async () => {
    setSetting('push_vapid_private', 'super-secret-signing-key');
    const { json } = await send('POST', '/api/settings/reload-config', { project: await project({}) });

    assert.doesNotMatch(JSON.stringify(json), /super-secret-signing-key/);
  });
});
