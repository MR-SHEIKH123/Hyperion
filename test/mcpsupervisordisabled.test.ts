/**
 * The MCP supervisor's off switch.
 *
 * A separate file from `mcpsupervisor.test.ts` because `src/config/env.ts`
 * resolves `HYPERION_MCP_DISABLED` once, at import time. One process can only
 * observe one value, so the enabled and disabled branches cannot share a file.
 * `helpers.ts` already sets the flag for the whole suite, which is exactly the
 * state under test here — nothing needs setting up.
 *
 * The guarantee: with the supervisor off, `managed` stays false. It must not
 * claim a supervisor that was never started, because the health summary renders
 * that field as "no servers are being managed" and the user would be told
 * something untrue about their own install.
 */
import './helpers.ts';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, cleanupHome } from './helpers.ts';

import type { McpServerStatus } from '../src/types/core.ts';
import type { McpSupervisor } from '../src/services/mcp/supervisor.ts';

const { startMcpSupervisor, stopMcpSupervisor } = await import('../src/services/mcp/supervisor.ts');
const { getMcpProcessManager, mcpStatus, resetModules } = await import(
  '../src/orchestrator/agents.ts'
);

describe('the MCP supervisor with HYPERION_MCP_DISABLED set', () => {
  before(() => {
    freshDb();
  });

  after(async () => {
    await stopMcpSupervisor();
    resetModules();
    cleanupHome();
  });

  it('registers nothing and spawns nothing', async () => {
    let constructed = false;
    const create = (): McpSupervisor => {
      constructed = true;
      return {
        getStatus: (): McpServerStatus[] => [],
        start: async () => {},
        stop: async () => {},
        listTools: async () => [],
        callTool: async () => ({ content: [], isError: false }),
        startAll: async () => {},
        stopAll: async () => {},
      };
    };

    startMcpSupervisor(create);

    assert.equal(constructed, false, 'the factory must not even be called when disabled');
    assert.equal(getMcpProcessManager(), null);

    // False rather than true-with-an-empty-list: no supervisor is running, and
    // the health summary turns this field into a sentence the user reads.
    assert.equal(mcpStatus().managed, false);

    // Stopping is still safe, which matters because the entrypoint's shutdown
    // path calls it unconditionally.
    await stopMcpSupervisor();
  });
});
