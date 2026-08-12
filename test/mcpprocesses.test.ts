/**
 * Process-manager lifecycle tests.
 *
 * These run a real child process — a tiny MCP server written to a temp file —
 * because the behaviour under test (spawn, crash detection, restart, stop) is
 * exactly the part a stub cannot exercise. The fake server speaks just enough
 * MCP over stdio to answer the client's `initialize` and `tools/list`.
 */
import './helpers.ts';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testHome, freshDb, cleanupHome } from './helpers.ts';

const { createProcessManager, FILESYSTEM_SERVER_NAME } = await import(
  '../src/services/mcp/processManager.ts'
);
const { createServer, deleteServer, findServerByName } = await import(
  '../src/services/mcp/registry.ts'
);

/**
 * A minimal MCP stdio server. It answers `initialize` and `tools/list` and
 * ignores everything else, which is all the client needs to reach "running".
 * Written to a temp .mjs file and spawned with `node`.
 */
const FAKE_SERVER = `
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '0.0.1' },
      }});
    } else if (msg.method === 'notifications/initialized') {
      // no response
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'ping', description: 'ping', inputSchema: { type: 'object' } },
      ]}});
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
`;

function fakeServerPath(): string {
  const file = path.join(testHome, `fake-mcp-${Date.now()}.mjs`);
  fs.writeFileSync(file, FAKE_SERVER);
  return file;
}

/** Poll until a condition holds or the deadline passes. */
async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for condition.');
}

describe('MCP process manager', () => {
  before(async () => {
    await freshDb();
  });

  after(async () => {
    await cleanupHome();
  });

  it('spawns a configured stdio server and reports it running', async () => {
    const script = fakeServerPath();
    const record = createServer({
      name: 'fake-stdio',
      type: 'local',
      command: process.execPath,
      args: [script],
      enabled: true,
    });

    const manager = createProcessManager();
    try {
      await manager.start(record.name);
      await waitFor(() =>
        manager.getStatus().some((s) => s.name === 'fake-stdio' && s.state === 'running'),
      );
      const status = manager.getStatus().find((s) => s.name === 'fake-stdio');
      assert.equal(status?.state, 'running');
      assert.equal(status?.toolCount, 1);
      assert.ok(status?.pid, 'a stdio server should expose its child pid');
    } finally {
      await manager.stopAll();
    }
  });

  it('restarts a stdio server that crashes', async () => {
    const script = fakeServerPath();
    const record = createServer({
      name: 'fake-crash',
      type: 'local',
      command: process.execPath,
      args: [script],
      enabled: true,
    });

    const manager = createProcessManager();
    try {
      await manager.start(record.name);
      await waitFor(() =>
        manager.getStatus().some((s) => s.name === 'fake-crash' && s.state === 'running'),
      );
      const firstPid = manager.getStatus().find((s) => s.name === 'fake-crash')?.pid;
      assert.ok(firstPid);

      // Kill the child out from under the manager; it should restart it.
      process.kill(firstPid!);
      await waitFor(() => {
        const s = manager.getStatus().find((x) => x.name === 'fake-crash');
        return s?.state === 'running' && s.pid !== undefined && s.pid !== firstPid;
      });
      const restarted = manager.getStatus().find((s) => s.name === 'fake-crash');
      assert.equal(restarted?.state, 'running');
      assert.notEqual(restarted?.pid, firstPid);
    } finally {
      await manager.stopAll();
    }
  });

  it('stops a server and does not restart it', async () => {
    const script = fakeServerPath();
    const record = createServer({
      name: 'fake-stop',
      type: 'local',
      command: process.execPath,
      args: [script],
      enabled: true,
    });

    const manager = createProcessManager();
    await manager.start(record.name);
    await waitFor(() =>
      manager.getStatus().some((s) => s.name === 'fake-stop' && s.state === 'running'),
    );

    await manager.stop(record.name);
    const status = manager.getStatus().find((s) => s.name === 'fake-stop');
    assert.equal(status?.state, 'stopped');

    // Give any erroneous restart a chance to fire; it must not.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterWait = manager.getStatus().find((s) => s.name === 'fake-stop');
    assert.equal(afterWait?.state, 'stopped');
    await manager.stopAll();
  });

  it('auto-spawns the default filesystem server when none is configured', async () => {
    // No 'filesystem' server exists in this fresh database.
    assert.equal(findServerByName(FILESYSTEM_SERVER_NAME), null);

    const manager = createProcessManager();
    try {
      await manager.startAll();
      // The default filesystem server is spawned via npx; on a test box without
      // the package cached it may legitimately fail to start, so we assert the
      // attempt was made (an entry exists) rather than demanding it be running.
      const status = manager.getStatus().find((s) => s.name === FILESYSTEM_SERVER_NAME);
      assert.ok(status, 'the default filesystem server should be spawned');
    } finally {
      await manager.stopAll();
    }
  });

  it('does not double-spawn the filesystem server if one is configured', async () => {
    const script = fakeServerPath();
    createServer({
      name: FILESYSTEM_SERVER_NAME,
      type: 'local',
      command: process.execPath,
      args: [script],
      enabled: true,
    });

    const manager = createProcessManager();
    try {
      await manager.startAll();
      await waitFor(() =>
        manager.getStatus().some((s) => s.name === FILESYSTEM_SERVER_NAME && s.state === 'running'),
      );
      const matches = manager.getStatus().filter((s) => s.name === FILESYSTEM_SERVER_NAME);
      assert.equal(matches.length, 1);
      assert.equal(matches[0]?.state, 'running');
    } finally {
      await manager.stopAll();
      const configured = findServerByName(FILESYSTEM_SERVER_NAME);
      if (configured) deleteServer(configured.id);
    }
  });
});
