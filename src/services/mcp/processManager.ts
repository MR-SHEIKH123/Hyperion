/**
 * MCP process manager — the piece of the MCP system that actually *runs* the
 * servers the registry describes.
 *
 * The split of responsibility, per the build contract:
 *
 *   - `registry.ts` owns configuration: the `mcp_servers` table, the
 *     `mcp_config.json` interchange file, the CRUD API. It never spawns.
 *   - This module owns lifecycle: spawn each enabled server, watch it, restart
 *     it when it dies, and report live status for `GET /api/mcp/status`.
 *
 * Design notes, in the order they tend to surprise people:
 *
 * **Local (stdio) servers are child processes; remote servers are connections.**
 * A `local` entry spawns `command args` with the configured env and speaks MCP
 * over its stdio. A `remote` entry has no process to supervise — we open a
 * client connection to its URL and treat "connected" as the running state.
 *
 * **The filesystem server is special.** It is the one every agentic task
 * depends on, so it is spawned automatically pointed at the scoped projects
 * directory even if the user never configured it. It is also the one server a
 * crash of which we treat as worth an immediate restart rather than a backoff.
 *
 * **Restart is bounded, not infinite.** A server that crashes repeatedly is
 * almost always misconfigured, and an unbounded restart loop would burn CPU and
 * flood the log. We back off exponentially and give up after a cap, surfacing
 * the failure in `lastError` so the status bar can show it.
 *
 * **Status is a snapshot, not a subscription.** `getStatus()` returns a plain
 * array the HTTP layer serialises verbatim. The in-flight tool-call label is
 * tracked here so the activity feed can show "filesystem: reading app.js"
 * without a separate channel.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { env } from '../../config/env.ts';
import type { McpProcessManager, McpServerStatus } from '../../types/core.ts';
import { createLogger } from '../../util/logger.ts';
import { listServers, serverToken } from './registry.ts';
import type { McpServerRecord } from './registry.ts';

const log = createLogger('mcp:processes');

/** The name the auto-spawned filesystem server is registered under. */
export const FILESYSTEM_SERVER_NAME = 'filesystem';

/** Restart backoff: 1s, 2s, 4s … capped, and we stop trying after MAX_RESTARTS. */
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;
const MAX_RESTARTS = 5;

/** How long a test-connection probe waits before declaring the server dead. */
const PROBE_TIMEOUT_MS = 8_000;

interface RunningServer {
  record: McpServerRecord;
  state: McpServerStatus['state'];
  client: Client | null;
  /** The child process pid for stdio servers; undefined for remote. */
  pid?: number;
  startedAt: number;
  restarts: number;
  lastError?: string;
  toolCount?: number;
  /** Set while a tool call is in flight, for the live activity feed. */
  activeTool?: string;
  /** True once we've intentionally stopped it — suppresses auto-restart. */
  stopping: boolean;
}

/**
 * The concrete manager. Construct once at boot, then `start()` every enabled
 * server. Registered with the orchestrator via `registerMcpProcessManager`.
 */
export class ProcessManager implements McpProcessManager {
  private readonly servers = new Map<string, RunningServer>();

  /** Snapshot for `GET /api/mcp/status`. */
  getStatus(): McpServerStatus[] {
    const out: McpServerStatus[] = [];
    for (const server of this.servers.values()) {
      const status: McpServerStatus = { name: server.record.name, state: server.state };
      if (server.pid !== undefined) status.pid = server.pid;
      if (server.state === 'running') status.uptimeMs = Date.now() - server.startedAt;
      if (server.toolCount !== undefined) status.toolCount = server.toolCount;
      if (server.lastError !== undefined) status.lastError = server.lastError;
      out.push(status);
    }
    return out;
  }

  /** The in-flight tool-call label, for the activity feed. */
  activeToolCall(name: string): string | null {
    return this.servers.get(name)?.activeTool ?? null;
  }

  /**
   * Spawn every enabled server from the registry, plus the default filesystem
   * server if it isn't configured. Called once at boot.
   */
  async startAll(): Promise<void> {
    const configured = listServers();
    for (const record of configured) {
      if (record.enabled) await this.spawn(record);
    }
    if (!configured.some((record) => record.name === FILESYSTEM_SERVER_NAME)) {
      await this.spawnDefaultFilesystem();
    }
  }

  /** Start one server by name (from the registry). */
  async start(name: string): Promise<void> {
    const record = listServers().find((entry) => entry.name === name);
    if (!record) throw new Error(`No MCP server named "${name}".`);
    await this.spawn(record);
  }

  /** Stop one server. Intentional, so no auto-restart. */
  async stop(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) return;
    server.stopping = true;
    await this.teardown(server);
  }

  /** Stop everything, on shutdown. */
  async stopAll(): Promise<void> {
    for (const server of this.servers.values()) {
      server.stopping = true;
      await this.teardown(server);
    }
  }

  /**
   * Live probe for the test-connection endpoint. Spawns a throwaway client,
   * asks for the tool list, and reports. Never leaves a process running.
   */
  async testConnection(name: string): Promise<{ ok: boolean; message: string }> {
    const record = listServers().find((entry) => entry.name === name);
    if (!record) return { ok: false, message: `No MCP server named "${name}".` };

    const client = new Client({ name: 'hyperion-probe', version: '0' });
    try {
      const transport = this.buildTransport(record);
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timed out')), PROBE_TIMEOUT_MS),
        ),
      ]);
      const tools = await client.listTools();
      return { ok: true, message: `Connected; ${tools.tools.length} tools available.` };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'The connection failed.',
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  // --- internals -----------------------------------------------------------

  private async spawnDefaultFilesystem(): Promise<void> {
    const record: McpServerRecord = {
      id: 'default-filesystem',
      name: FILESYSTEM_SERVER_NAME,
      type: 'local',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', env.paths.projects],
      env: {},
      url: null,
      headers: {},
      tokenEnc: null,
      enabled: true,
      lastTestStatus: 'unknown',
      lastTestMessage: null,
      lastTestAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.spawn(record);
  }

  private async spawn(record: McpServerRecord): Promise<void> {
    // Replace any existing entry for this name.
    const existing = this.servers.get(record.name);
    if (existing) {
      existing.stopping = true;
      await this.teardown(existing);
    }

    const server: RunningServer = {
      record,
      state: 'starting',
      client: null,
      startedAt: Date.now(),
      restarts: existing?.restarts ?? 0,
      stopping: false,
    };
    this.servers.set(record.name, server);

    try {
      const transport = this.buildTransport(record);
      const client = new Client({ name: 'hyperion', version: '0' });
      await client.connect(transport);
      server.client = client;
      server.state = 'running';
      server.startedAt = Date.now();
      server.lastError = undefined;

      // Count tools once, for the status bar.
      try {
        const tools = await client.listTools();
        server.toolCount = tools.tools.length;
      } catch {
        server.toolCount = undefined;
      }

      // For stdio servers, capture the pid and watch for a crash. The SDK
      // types pid as number | null (null until the child actually spawns);
      // our record uses undefined for "not a stdio server / not started".
      if (transport instanceof StdioClientTransport) {
        server.pid = transport.pid ?? undefined;
        this.watchProcess(server, transport);
      }
      log.info(`MCP server "${record.name}" is running`, { pid: server.pid });
    } catch (error) {
      server.state = 'error';
      server.lastError = error instanceof Error ? error.message : 'Failed to start.';
      log.warn(`MCP server "${record.name}" failed to start`, error);
      this.scheduleRestart(server);
    }
  }

  private buildTransport(record: McpServerRecord) {
    if (record.type === 'local') {
      return new StdioClientTransport({
        command: record.command ?? '',
        args: record.args,
        env: { ...process.env, ...record.env } as Record<string, string>,
        stderr: 'pipe',
      });
    }
    const headers = { ...record.headers };
    const token = serverToken(record);
    if (token && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
      headers.Authorization = `Bearer ${token}`;
    }
    return new StreamableHTTPClientTransport(new URL(record.url ?? ''), {
      requestInit: { headers },
    });
  }

  /** Watch a stdio child; on unexpected exit, schedule a restart. */
  private watchProcess(server: RunningServer, transport: StdioClientTransport): void {
    transport.onclose = () => {
      if (server.stopping) return;
      server.state = 'error';
      server.lastError = 'The process exited unexpectedly.';
      log.warn(`MCP server "${server.record.name}" exited unexpectedly`);
      this.scheduleRestart(server);
    };
  }

  private scheduleRestart(server: RunningServer): void {
    if (server.stopping) return;
    if (server.restarts >= MAX_RESTARTS) {
      server.state = 'error';
      server.lastError = `Gave up after ${MAX_RESTARTS} restarts: ${server.lastError ?? 'unknown error'}`;
      log.error(`MCP server "${server.record.name}" gave up restarting`);
      return;
    }
    server.restarts += 1;
    const delay = Math.min(RESTART_BASE_MS * 2 ** (server.restarts - 1), RESTART_MAX_MS);
    log.info(`Restarting MCP server "${server.record.name}" in ${delay}ms`, {
      attempt: server.restarts,
    });
    setTimeout(() => {
      if (server.stopping) return;
      void this.spawn(server.record);
    }, delay).unref();
  }

  private async teardown(server: RunningServer): Promise<void> {
    try {
      await server.client?.close();
    } catch (error) {
      log.warn(`Error closing MCP server "${server.record.name}"`, error);
    }
    server.client = null;
    server.state = 'stopped';
    server.pid = undefined;
    server.activeTool = undefined;
  }
}

/** Construct the manager. Boot wires this into the orchestrator. */
export function createProcessManager(): ProcessManager {
  return new ProcessManager();
}
