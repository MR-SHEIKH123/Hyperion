/**
 * Seeded MCP defaults, and the static config check that judges them.
 *
 * The bug this file exists to prevent: the static check validated every
 * absolute-looking argument against the `projects` root only, while the seeded
 * `graphify` entry legitimately points at its own installation under
 * `~/Hyperion/mcp/`. Our own default therefore failed our own check, with a
 * message accusing it of escaping the sandbox.
 *
 * `testServer()` is used rather than the private `staticProblems()` because that
 * is the path the API actually takes, and it also pins the surrounding contract:
 * a local server is never spawned here, so the result must always be `static`.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { cleanupHome, freshDb } from './helpers.ts';
// Type-only, so it is erased at compile time and does not load `src/` before
// the harness above has set HYPERION_HOME.
import type { McpServerRecord } from '../src/services/mcp/registry.ts';

describe('seeded MCP defaults', () => {
  before(async () => {
    await freshDb();
  });

  after(async () => {
    await cleanupHome();
  });

  it('seeds filesystem enabled, wigolo and graphify disabled', async () => {
    const { seedDefaultServers } = await import('../src/services/mcp/defaults.ts');
    const { listServers } = await import('../src/services/mcp/registry.ts');

    const result = seedDefaultServers();
    assert.deepEqual(result.created.sort(), ['filesystem', 'graphify', 'wigolo']);

    const byName = new Map(listServers().map((server) => [server.name, server]));
    assert.equal(byName.get('filesystem')?.enabled, true);
    assert.equal(byName.get('wigolo')?.enabled, false);
    // Nothing auto-enables itself, and graphify additionally has a one-time
    // setup: neither its interpreter nor its graph exists on a fresh install.
    assert.equal(byName.get('graphify')?.enabled, false);
  });

  it('is idempotent — a second call creates nothing', async () => {
    const { seedDefaultServers } = await import('../src/services/mcp/defaults.ts');
    const result = seedDefaultServers();
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.skippedSeeded.sort(), ['filesystem', 'graphify', 'wigolo']);
  });

  it('points graphify at its own venv interpreter and graph, not at PATH', async () => {
    const { defaultServers } = await import('../src/services/mcp/defaults.ts');
    const { env } = await import('../src/config/env.ts');

    const graphify = defaultServers().find((server) => server.input.name === 'graphify');
    assert.ok(graphify, 'graphify should be part of the seed set');

    const command = graphify.input.command ?? '';
    assert.ok(path.isAbsolute(command), 'the interpreter must be absolute: the venv is not on PATH');
    assert.ok(command.includes('.venv'), 'the interpreter must come from the isolated venv');

    // There is no `graphify-mcp` console script; the server runs as a module.
    assert.deepEqual(graphify.input.args?.slice(0, 2), ['-m', 'graphify.serve']);

    const graph = graphify.input.args?.[2] ?? '';
    assert.ok(
      graph.startsWith(env.paths.mcp),
      'the graph must live under the app MCP directory, not in the user repository',
    );
    // The build writes `graphify-out/graph.json` relative to its working
    // directory and offers no flag to redirect it, so this segment is fixed.
    assert.ok(graph.includes('graphify-out'), 'the graphify-out segment is not ours to rename');
  });
});

describe('static config check for stdio servers', () => {
  before(async () => {
    await freshDb();
  });

  after(async () => {
    await cleanupHome();
  });

  it('accepts a path under the app MCP root, which the seeded graphify uses', async () => {
    const { env } = await import('../src/config/env.ts');
    const { createServer } = await import('../src/services/mcp/registry.ts');
    const { testServer } = await import('../src/services/mcp/test.ts');

    // Both the interpreter and the graph exist here, so the only thing under
    // test is the scope decision.
    const home = path.join(env.paths.mcp, 'graphify');
    const python = path.join(home, '.venv', 'python');
    const graph = path.join(home, 'graphify-out', 'graph.json');
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.mkdirSync(path.dirname(graph), { recursive: true });
    fs.writeFileSync(python, '');
    fs.writeFileSync(graph, '{}');

    const server = createServer({
      name: 'graphify-scope',
      type: 'local',
      command: python,
      args: ['-m', 'graphify.serve', graph],
    });

    const result = await testServer(server);
    assert.equal(result.ok, true, result.message);
    // No process manager is registered in tests, so nothing was started.
    assert.equal(result.static, true);
    assert.match(result.message, /not started/);
  });

  it('accepts a path under the projects root', async () => {
    const { env } = await import('../src/config/env.ts');
    const { createServer } = await import('../src/services/mcp/registry.ts');
    const { testServer } = await import('../src/services/mcp/test.ts');

    const server = createServer({
      name: 'filesystem-scope',
      type: 'local',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', env.paths.projects],
    });

    const result = await testServer(server);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.static, true);
  });

  it('still rejects a path outside every allowed root', async () => {
    const { createServer } = await import('../src/services/mcp/registry.ts');
    const { testServer } = await import('../src/services/mcp/test.ts');

    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc';
    const server = createServer({
      name: 'out-of-scope',
      type: 'local',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', outside],
    });

    const result = await testServer(server);
    assert.equal(result.ok, false);
    assert.equal(result.static, true);
    assert.match(result.message, /outside the allowed roots/);
  });

  it('reports an absolute command that does not exist yet', async () => {
    const { env } = await import('../src/config/env.ts');
    const { createServer } = await import('../src/services/mcp/registry.ts');
    const { testServer } = await import('../src/services/mcp/test.ts');

    // Exactly the state of a fresh install: the entry is correct, the venv has
    // simply not been created. "Looks valid" would be a lie.
    const missing = path.join(env.paths.mcp, 'nothing-here', '.venv', 'python');
    const server = createServer({
      name: 'missing-interpreter',
      type: 'local',
      command: missing,
      args: [],
    });

    const result = await testServer(server);
    assert.equal(result.ok, false);
    assert.equal(result.static, true);
    assert.match(result.message, /does not exist yet/);
    assert.match(result.message, /one-time setup/);
  });

  it('reports an in-scope data file that has not been generated', async () => {
    const { env } = await import('../src/config/env.ts');
    const { createServer } = await import('../src/services/mcp/registry.ts');
    const { testServer } = await import('../src/services/mcp/test.ts');

    const python = path.join(env.paths.mcp, 'built', '.venv', 'python');
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, '');

    const graph = path.join(env.paths.mcp, 'built', 'graphify-out', 'graph.json');
    const server = createServer({
      name: 'missing-graph',
      type: 'local',
      command: python,
      args: ['-m', 'graphify.serve', graph],
    });

    const result = await testServer(server);
    assert.equal(result.ok, false);
    assert.equal(result.static, true);
    assert.match(result.message, /graph\.json/);
    assert.match(result.message, /generated/);
  });

  it('does not second-guess a bare command or an in-scope directory', async () => {
    const { env } = await import('../src/config/env.ts');
    const { createServer } = await import('../src/services/mcp/registry.ts');
    const { testServer } = await import('../src/services/mcp/test.ts');

    // `npx` is resolved from PATH by the OS, and a directory argument with no
    // extension may legitimately be created by the server on first run.
    const server = createServer({
      name: 'bare-command',
      type: 'local',
      command: 'npx',
      args: ['-y', 'some-server', path.join(env.paths.projects, 'not-created-yet')],
    });

    const result = await testServer(server);
    assert.equal(result.ok, true, result.message);
  });

  it('flags an empty command', async () => {
    const { testServer } = await import('../src/services/mcp/test.ts');

    // Deliberately not via `createServer`: the registry rejects a commandless
    // local server outright, so this branch only ever guards a record that
    // arrived some other way — an entry hand-written into `mcp_config.json` and
    // picked up as an orphan. The check has to hold for those too.
    const server: McpServerRecord = {
      id: 'not-persisted',
      name: 'no-command',
      type: 'local',
      command: '',
      args: [],
      env: {},
      url: null,
      headers: {},
      tokenEnc: null,
      enabled: false,
      lastTestStatus: 'unknown',
      lastTestMessage: null,
      lastTestAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = await testServer(server);
    assert.equal(result.ok, false);
    assert.match(result.message, /No command is configured/);
  });
});
