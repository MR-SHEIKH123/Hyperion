/**
 * The MCP supervisor's boot wiring.
 *
 * The bug these cover: `processManager.ts` could spawn and supervise servers,
 * but nothing ever constructed it outside a test. `registerMcpProcessManager`
 * was called nowhere, so every install reported `managed: false`, the health
 * summary said no supervisor was registered, and an agent asking for a
 * filesystem tool found none. The first test here fails against that state.
 *
 * `HYPERION_MCP_DISABLED` is cleared below because `helpers.ts` sets it for the
 * suite at large. `env` resolves once at import time, so a single process can
 * only see one value — the default-disabled branch is covered by its own file,
 * `mcpsupervisordisabled.test.ts`.
 *
 * Every test injects a fake manager. A real `startAll()` spawns the default
 * filesystem server through `npx -y`, which downloads a package: not something a
 * unit suite should do, and the abandoned child would outlive the run.
 */
import './helpers.ts';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, cleanupHome } from './helpers.ts';

// Runs before the dynamic imports below, which is what matters: env.ts resolves
// this flag once, at its own first import. An empty string is not the same as
// absent to `bool()` — both fall back, and the fallback here is false — so this
// clears what helpers.ts set for the rest of the suite.
process.env.HYPERION_MCP_DISABLED = '';

import type { McpServerStatus } from '../src/types/core.ts';
import type { McpSupervisor } from '../src/services/mcp/supervisor.ts';

const { startMcpSupervisor, stopMcpSupervisor } = await import('../src/services/mcp/supervisor.ts');
const { getMcpProcessManager, mcpStatus, resetModules } = await import(
  '../src/orchestrator/agents.ts'
);
const { createApp } = await import('../src/http/app.ts');

interface FakeOptions {
  startAll?: () => Promise<void>;
  stopAll?: () => Promise<void>;
  status?: McpServerStatus[];
}

/** Records what boot asked of it, so the tests can assert on order. */
interface Fake extends McpSupervisor {
  calls: string[];
}

function fakeSupervisor(options: FakeOptions = {}): Fake {
  const calls: string[] = [];
  return {
    calls,
    getStatus: () => options.status ?? [],
    start: async (name) => {
      calls.push(`start:${name}`);
    },
    stop: async (name) => {
      calls.push(`stop:${name}`);
    },
    listTools: async () => [],
    callTool: async () => ({ content: [], isError: false }),
    startAll: async () => {
      calls.push('startAll');
      if (options.startAll) await options.startAll();
    },
    stopAll: async () => {
      calls.push('stopAll');
      if (options.stopAll) await options.stopAll();
    },
  };
}

describe('wiring the MCP supervisor into boot', () => {
  before(() => {
    freshDb();
  });

  afterEach(async () => {
    // Module state in supervisor.ts survives between tests; without this the
    // "already running" guard would fire in whichever test ran second.
    await stopMcpSupervisor();
    resetModules();
  });

  after(() => {
    cleanupHome();
  });

  it('registers the manager so the status endpoint stops reporting no supervisor', async () => {
    assert.equal(getMcpProcessManager(), null, 'nothing should be registered before boot runs');

    const fake = fakeSupervisor({
      status: [{ name: 'filesystem', state: 'running', pid: 4242, toolCount: 11 }],
    });
    startMcpSupervisor(() => fake);

    assert.equal(getMcpProcessManager(), fake);

    const server = createApp().listen(0);
    try {
      const address = server.address();
      assert.ok(address !== null && typeof address === 'object');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/mcp/status`);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { managed: boolean; servers: McpServerStatus[] };

      assert.equal(payload.managed, true, 'boot registered a manager, so this must not be false');
      assert.equal(payload.servers.length, 1);
      assert.equal(payload.servers[0]?.name, 'filesystem');
      assert.equal(payload.servers[0]?.toolCount, 11);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('starts every configured server', async () => {
    const fake = fakeSupervisor();
    startMcpSupervisor(() => fake);
    await stopMcpSupervisor();

    assert.deepEqual(fake.calls, ['startAll', 'stopAll']);
  });

  it('registers before the servers have finished spawning', async () => {
    // npx can take tens of seconds on a cold cache. Registering only afterwards
    // would leave /api/mcp/status claiming there is no supervisor for the whole
    // of that window, which is the very thing this wiring exists to fix.
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const fake = fakeSupervisor({ startAll: () => blocked });
    startMcpSupervisor(() => fake);

    // Released in `finally`, not after the assertions. afterEach calls
    // stopMcpSupervisor(), which waits for the in-flight startAll — so a failing
    // assertion here would strand the fake mid-spawn and hang the entire file
    // instead of reporting the one failure. Found by deliberately breaking the
    // registration to check these tests catch it: they did, then hung.
    try {
      assert.equal(getMcpProcessManager(), fake, 'the manager must be usable while spawning');
      assert.equal(mcpStatus().managed, true);
    } finally {
      release();
    }
  });

  it('keeps serving when a server fails to start', async () => {
    // A misconfigured server is the user's problem to fix, not a reason for the
    // process to come up without a supervisor at all.
    const fake = fakeSupervisor({
      startAll: () => Promise.reject(new Error('spawn ENOENT')),
    });
    startMcpSupervisor(() => fake);

    assert.equal(getMcpProcessManager(), fake);
    assert.equal(mcpStatus().managed, true);

    // The rejection is handled inside the module; nothing should escape to the
    // process as an unhandled rejection.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('a second call does not start a duplicate set of servers', async () => {
    const first = fakeSupervisor();
    const second = fakeSupervisor();

    startMcpSupervisor(() => first);
    startMcpSupervisor(() => second);

    assert.equal(getMcpProcessManager(), first, 'the first manager stays registered');
    assert.deepEqual(second.calls, [], 'the second must never have been constructed into use');
  });

  it('stops the servers only after an in-flight start has finished', async () => {
    // Tearing down mid-spawn would stop the servers that had connected and let
    // the rest finish spawning into a process that is exiting — orphaning the
    // children this is supposed to reap.
    const order: string[] = [];
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = () => {
        order.push('startAll finished');
        resolve();
      };
    });

    const fake = fakeSupervisor({
      startAll: () => blocked,
      stopAll: async () => {
        order.push('stopAll began');
      },
    });

    startMcpSupervisor(() => fake);
    const stopping = stopMcpSupervisor();

    try {
      // Give the stop path room to run to its await; it must still be waiting.
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(order, [], 'stopAll must not run while startAll is in flight');
    } finally {
      // Released in `finally` for the same reason as the test above: if this
      // assertion failed outside one, `stopping` would never settle and the file
      // would hang rather than report the failure.
      release();
    }

    await stopping;
    assert.deepEqual(order, ['startAll finished', 'stopAll began']);
  });

  it('stopping when nothing was started is not an error', async () => {
    await stopMcpSupervisor();
    assert.equal(getMcpProcessManager(), null);
  });

  it('a server that will not stop does not hold shutdown open forever', async () => {
    // Takes the full 3s stop budget by design. A hung client.close() must not
    // reach the entrypoint's force-exit, because that path skips closing the
    // database and would leave a hot WAL behind on every restart.
    const fake = fakeSupervisor({ stopAll: () => new Promise<void>(() => {}) });
    startMcpSupervisor(() => fake);

    const started = Date.now();
    await stopMcpSupervisor();
    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 2_500, `expected to wait for the stop budget, waited ${elapsed}ms`);
    assert.ok(elapsed < 5_500, `expected to give up well under the 6s force-exit, took ${elapsed}ms`);
  });

  it('status stops claiming supervision once the servers are stopped', async () => {
    // A real shutdown reaped all five processes of the filesystem server and
    // then still reported `managed: true`, because registration is a pointer
    // and nothing cleared it. A tool call arriving after this point would find
    // a manager whose transports are all closed.
    const fake = fakeSupervisor();
    startMcpSupervisor(() => fake);
    assert.equal(mcpStatus().managed, true);

    await stopMcpSupervisor();

    assert.equal(getMcpProcessManager(), null, 'the dead manager must not still be registered');
    assert.equal(mcpStatus().managed, false);
    assert.deepEqual(mcpStatus().servers, []);
  });

  it('a stop that times out still gives up the registration', async () => {
    // Takes the full 3s budget. The wedged case is the one that matters most:
    // those clients are the least able to serve a call, so continuing to
    // advertise them would be the most misleading answer of all.
    const fake = fakeSupervisor({ stopAll: () => new Promise<void>(() => {}) });
    startMcpSupervisor(() => fake);

    await stopMcpSupervisor();

    assert.equal(mcpStatus().managed, false, 'a timed-out stop must not leave status claiming supervision');
  });
});
