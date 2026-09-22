/**
 * The Plugins hub (1.34).
 *
 * Three things are being asserted, and they are the three ways a hub can be
 * useless or dishonest:
 *
 *   1. **The catalogue composes, it does not invent.** Every fact about a plugin
 *      comes from the registry that stores it, and the ids are spelled one way.
 *   2. **The scan is a reading, not a verdict.** Grades name what a plugin *is*
 *      — a command that runs here, an endpoint it talks to, a flagged file — and
 *      the caveat travels with the grade. A secret a plugin holds must never
 *      appear in the reading: the scan says a credential is stored, not what it is.
 *   3. **A decision is honoured, and "the default" is the absence of one.**
 *      Availability is read by the consumers (memory's recall/remember, the agent
 *      context's skills list, Cowork's MCP use) — and clearing an override deletes
 *      the row rather than storing a decision that happens to agree with it.
 *
 * The write route is driven over HTTP: the refusals (unknown plugin, unknown
 * tool, missing `available`) are part of the contract, and a 400 that does not
 * say which field was wrong is the failure mode this endpoint is most likely to
 * have.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

const { createApp } = await import('../src/http/app.ts');
const { createServer, listServers } = await import('../src/services/mcp/registry.ts');
const { insertSkill } = await import('../src/services/skills/registry.ts');
const { listPluginAvailability, setPluginAvailability } = await import('../src/db/plugins.ts');
const { MEMORY_PLUGIN_ID, mcpPluginId, skillPluginId } = await import('../src/services/plugins/availability.ts');
const { listPlugins, setPluginAvailabilityFor } = await import('../src/services/plugins/hub.ts');
const { skillsAvailableTo } = await import('../src/services/plugins/consumers.ts');
const { skillsSummary } = await import('../src/services/skills/registry.ts');
const { memoryEnabled, rememberTurn, recallForTurn, setMemoryEnabled } = await import('../src/services/memory/index.ts');

let server: http.Server;
let base: string;

before(async () => {
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  await freshDb();
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

/** A local MCP server with a token — the shape that has the most to say. */
function seedLocalServer(name = 'files', enabled = true) {
  return createServer({
    name,
    type: 'local',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    env: { HYPERION_ROOT: '/tmp' },
    token: 'super-secret-token',
    enabled,
  });
}

function seedRemoteServer(name = 'research') {
  return createServer({
    name,
    type: 'remote',
    url: 'https://user:hunter2@mcp.example.test/sse',
    enabled: true,
  });
}

function seedSkill(name: string, flags: unknown[] = []) {
  return insertSkill({
    name,
    description: `${name} summary`,
    sourceType: 'upload',
    relPath: name,
    riskFlags: flags as never,
    enabled: true,
  });
}

async function patch(id: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}/api/plugins/${encodeURIComponent(id)}/availability`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('the plugin catalogue', () => {
  test('composes the three kinds, defaults availability to available, and names consumers', async () => {
    const local = seedLocalServer();
    const wigolo = seedLocalServer('wigolo', false);
    seedSkill('summaries');
    const catalogue = listPlugins();

    const ids = catalogue.plugins.map((plugin) => plugin.id);
    assert.ok(ids.includes(mcpPluginId(local.id)));
    assert.ok(ids.includes(mcpPluginId(wigolo.id)));
    assert.ok(ids.includes(MEMORY_PLUGIN_ID));
    assert.equal(ids.filter((id) => id.startsWith('skill:')).length, 1, 'the seeded skill is listed');

    const byId = new Map(catalogue.plugins.map((plugin) => [plugin.id, plugin]));
    const localEntry = byId.get(mcpPluginId(local.id));
    assert.ok(localEntry);
    assert.equal(localEntry.kind, 'mcp');
    assert.equal(localEntry.enabled, true);
    // The default is available — absence of a decision is not a decision to switch off.
    assert.deepEqual(localEntry.availability, { chat: true, code: true, cowork: true, design: true, playground: true });
    assert.equal(localEntry.availabilityUpdatedAt, null);

    // Consumers are facts about the code: only Cowork reads MCP servers, and only
    // the one it names. A second server is honestly reported as unread by anything.
    assert.deepEqual(localEntry.consumers, []);
    assert.deepEqual(byId.get(mcpPluginId(wigolo.id))?.consumers, ['cowork']);

    const skillEntry = catalogue.plugins.find((plugin) => plugin.kind === 'skill');
    assert.ok(skillEntry);
    assert.deepEqual(skillEntry.consumers, ['code', 'cowork', 'design']);

    const memory = byId.get(MEMORY_PLUGIN_ID);
    assert.ok(memory);
    assert.equal(memory.kind, 'builtin');
    assert.equal(memory.enabled, memoryEnabled());
    assert.deepEqual(catalogue.tools, ['chat', 'code', 'cowork', 'design', 'playground']);
    assert.equal(catalogue.orphanedAvailability, 0);
  });

  test('reads the scan off what each plugin is, and never off the secret it holds', async () => {
    seedLocalServer();
    seedRemoteServer();
    seedSkill('clean');
    seedSkill('flagged', [
      { category: 'network', severity: 'warning', file: 'run.py', line: 12, message: 'outbound request' },
      { category: 'oversize', severity: 'info', file: 'data.json', message: 'large file' },
    ]);
    const catalogue = listPlugins();
    const serialized = JSON.stringify(catalogue);

    const local = catalogue.plugins.find((plugin) => plugin.name === 'files');
    assert.ok(local);
    assert.equal(local.scan.grade, 'active');
    assert.match(local.scan.summary, /can act/);
    const command = local.scan.findings.find((finding) => finding.code === 'mcp.local-command');
    assert.ok(command);
    assert.equal(command.severity, 'warning');
    assert.match(command.message, /Runs `npx` with 2 argument\(s\)/);
    assert.match(local.scan.findings.find((f) => f.code === 'mcp.environment')?.message ?? '', /1 environment variable/);
    assert.match(
      local.scan.findings.find((finding) => finding.code === 'mcp.stored-credential')?.message ?? '',
      /stored credential/,
    );
    // A credential is a fact about the plugin; its value is not the hub's to
    // publish. Both forms are checked: the hub never holds the plaintext (the
    // registry encrypts it on write), but it *does* hold the stored ciphertext,
    // so an implementation that spread a registry record would leak the second.
    // "It is encrypted anyway" is not a reason for it to travel.
    assert.ok(!serialized.includes('super-secret-token'), 'the token must not appear anywhere in the catalogue');
    for (const record of listServers()) {
      if (record.tokenEnc !== null) {
        assert.ok(!serialized.includes(record.tokenEnc), 'stored credential material stays in the database layer');
      }
    }

    const remote = catalogue.plugins.find((plugin) => plugin.name === 'research');
    assert.ok(remote);
    assert.match(
      remote.scan.findings.find((finding) => finding.code === 'mcp.remote-endpoint')?.message ?? '',
      /mcp\.example\.test/,
    );
    assert.ok(!serialized.includes('hunter2'), 'credentials in a stored endpoint are redacted');

    const clean = catalogue.plugins.find((plugin) => plugin.name === 'clean');
    assert.ok(clean);
    assert.equal(clean.scan.grade, 'inert');
    assert.deepEqual(clean.scan.findings, []);

    const flagged = catalogue.plugins.find((plugin) => plugin.name === 'flagged');
    assert.ok(flagged);
    assert.equal(flagged.scan.grade, 'active');
    assert.match(flagged.scan.summary, /flagged 2 signal/);
    assert.deepEqual(
      flagged.scan.findings.map((finding) => `${finding.code}:${finding.severity}`),
      ['skill.network:warning', 'skill.oversize:info'],
    );
    assert.match(flagged.scan.findings[0]?.message ?? '', /run\.py:12: outbound request/);

    const memory = catalogue.plugins.find((plugin) => plugin.id === MEMORY_PLUGIN_ID);
    assert.ok(memory);
    assert.equal(memory.scan.grade, 'builtin');
    assert.match(memory.scan.summary, /provenance, not safety/);

    for (const plugin of catalogue.plugins) {
      assert.ok(plugin.scan.disclaimer.length > 80, `${plugin.id} carries the caveat verbatim`);
    }
  });

  test('reads a seeded browser-use server as what it is (1.35)', async () => {
    const { seedDefaultServers } = await import('../src/services/mcp/defaults.ts');
    seedDefaultServers();

    const catalogue = listPlugins();
    const browser = catalogue.plugins.find((plugin) => plugin.name === 'browser-use');
    assert.ok(browser, 'the seeded browser-use server appears in the hub like any other plugin');
    assert.equal(browser.kind, 'mcp');
    // The seed is a normal MCP entry: the hub composes it, it does not special-case it.
    assert.equal(browser.enabled, false);
    assert.equal(browser.scan.grade, 'active');

    const reading = browser.scan.findings.find((finding) => finding.code === 'mcp.browser-automation');
    assert.ok(reading, 'a browser-driving server is read as one');
    assert.equal(reading.severity, 'warning');
    assert.match(reading.message, /Browser automation \(`browser-use` appears in its command\)/);
    assert.match(reading.message, /signed in to/);

    // Evidence, not a verdict: the marker found is named, and the generic
    // local-command finding still stands beside it.
    assert.ok(browser.scan.findings.some((finding) => finding.code === 'mcp.local-command'));
    // Nothing invented a credential for it: the seed adds no key and no token,
    // so the hub must not report one.
    assert.ok(!browser.scan.findings.some((finding) => finding.code === 'mcp.stored-credential'));
    // It declares no environment variables, and the absence is an absence: a
    // zero-count finding would read as "checked, and it holds something".
    assert.ok(!browser.scan.findings.some((finding) => finding.code === 'mcp.environment'));
  });

  test('reports an override per tool and leaves the others at the default', async () => {
    const skill = seedSkill('summaries');
    setPluginAvailability(skillPluginId(skill.id), 'code', false);

    const entry = listPlugins().plugins.find((plugin) => plugin.id === skillPluginId(skill.id));
    assert.ok(entry);
    assert.equal(entry.availability.code, false);
    assert.equal(entry.availability.chat, true);
    assert.equal(entry.availability.cowork, true);
    assert.equal(typeof entry.availabilityUpdatedAt, 'number');

    // A stale row from a build with another tool must not silently mean "off".
    setPluginAvailability(skillPluginId(skill.id), 'someday', false);
    const afterRow = listPlugins().plugins.find((plugin) => plugin.id === skillPluginId(skill.id));
    assert.deepEqual(Object.keys(afterRow?.availability ?? {}), ['chat', 'code', 'cowork', 'design', 'playground']);
  });
});

describe('the availability write', () => {
  test('records a decision and returns the updated plugin', async () => {
    const skill = seedSkill('summaries');
    const id = skillPluginId(skill.id);
    const response = await patch(id, { tool: 'code', available: false });

    assert.equal(response.status, 200);
    assert.equal(response.body.plugin.id, id);
    assert.equal(response.body.plugin.availability.code, false);
    assert.equal(response.body.plugin.availability.chat, true);
    assert.equal(response.body.pruned, 0);
  });

  test('a null clear deletes the row instead of storing the default', async () => {
    const skill = seedSkill('summaries');
    const id = skillPluginId(skill.id);
    await patch(id, { tool: 'code', available: false });
    assert.equal(listPluginAvailability().length, 1);

    const cleared = await patch(id, { tool: 'code', available: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.plugin.availability.code, true);
    assert.equal(cleared.body.plugin.availabilityUpdatedAt, null);
    assert.deepEqual(listPluginAvailability(), [], 'the override is gone, not stored as a truthy value');
  });

  test('refuses an unknown plugin, an unknown tool, and a missing decision, naming each', async () => {
    const missing = await patch('mcp:does-not-exist', { tool: 'code', available: false });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error.message, /mcp:does-not-exist/);

    const skill = seedSkill('summaries');
    const badTool = await patch(skillPluginId(skill.id), { tool: 'someday', available: false });
    assert.equal(badTool.status, 400);
    assert.equal(badTool.body.error.details.field, 'tool');
    assert.match(badTool.body.error.message, /not a known tool/);
    // The vocabulary a caller needs is published by the read, not repeated in
    // every refusal: the catalogue's `tools` is the single list.
    assert.deepEqual(listPlugins().tools, ['chat', 'code', 'cowork', 'design', 'playground']);

    const badValue = await patch(skillPluginId(skill.id), { tool: 'code' });
    assert.equal(badValue.status, 400);
    assert.equal(badValue.body.error.details.field, 'available');
    assert.match(badValue.body.error.message, /true, false, or null/);

    // Nothing was written by any of the refusals.
    assert.deepEqual(listPluginAvailability(), []);
  });

  test('reports overrides whose plugin is gone, and prunes them on the next write', async () => {
    seedSkill('summaries');
    setPluginAvailability('mcp:deleted-server', 'code', false);

    const before = listPluginAvailability();
    assert.equal(before.length, 1);
    assert.equal(listPlugins().orphanedAvailability, 1, 'debris is reported by the read, not hidden');

    const skill = seedSkill('later');
    const written = setPluginAvailabilityFor(skillPluginId(skill.id), 'chat', false);
    assert.ok(written);
    assert.equal(written.pruned, 1);
    assert.deepEqual(listPluginAvailability().map((row) => row.pluginId), [skillPluginId(skill.id)]);
    assert.equal(listPlugins().orphanedAvailability, 0);
  });
});

describe('the consumers honour the decision', () => {
  test('memory neither recalls into nor remembers from a tool it is switched off for', async () => {
    setMemoryEnabled(true);
    setPluginAvailability(MEMORY_PLUGIN_ID, 'chat', false);

    // The writer's gate is the sharp one: it answers `unavailable` before it
    // touches anything, so the answer itself is the proof. The reader's gate
    // returns null — which is also what an unreachable backend returns, and the
    // backend needs Ollama, which no test here has. So this asserts the
    // documented answer for a gated tool, not the mechanism behind it.
    assert.equal(await recallForTurn('what did we decide?', 'chat'), null);
    assert.equal(rememberTurn('a question', 'an answer', { tool: 'chat', chatId: 'c1' }), 'unavailable');

    // Another tool is unaffected, and the gate is the *only* thing that changed:
    // an empty exchange still lands on the ordinary 'empty' answer.
    assert.equal(rememberTurn('', '', { tool: 'code', chatId: 'c2' }), 'empty');
  });

  test('a skill switched off for one tool leaves that tool\u2019s list but stays in the library', async () => {
    const skill = seedSkill('summaries');
    assert.deepEqual(skillsAvailableTo('code').map((entry) => entry.name), ['summaries']);

    setPluginAvailability(skillPluginId(skill.id), 'code', false);
    assert.deepEqual(skillsAvailableTo('code'), []);
    assert.deepEqual(skillsAvailableTo('cowork').map((entry) => entry.name), ['summaries']);
    // The Settings library is not a tool's view: the skill is still installed,
    // and the screen that can explain the switch still lists it.
    assert.deepEqual(skillsSummary().map((entry) => entry.name), ['summaries']);
    assert.equal(skillsSummary()[0]?.id, skill.id, 'the summary carries the id the question is asked about');
  });
});
