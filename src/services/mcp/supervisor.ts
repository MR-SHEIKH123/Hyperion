/**
 * Boot wiring for the MCP process manager.
 *
 * `processManager.ts` has been able to spawn and supervise servers since MCP
 * Slice 1, but nothing ever constructed it outside a test: `createProcessManager`
 * was called only from `test/mcpprocesses.test.ts`, and
 * `registerMcpProcessManager` was called nowhere at all. The consequence was
 * quiet and expensive — `GET /api/mcp/status` reported `managed: false` on every
 * install, the health summary permanently read "No MCP supervisor is registered",
 * and an agent asking for a filesystem tool found zero tools. Degraded mode was
 * not a fallback, it was the only mode. This module is the missing half.
 *
 * It sits here rather than in `index.ts` for two reasons. Every other background
 * job the entrypoint owns — cleanup, backup, the scheduled-task runner — exposes
 * a `start*`/`stop*` pair from a service module, and matching that keeps the
 * entrypoint a list of intentions rather than a place where policy lives. The
 * second reason is testability: `index.ts` calls `main()` at module scope, so
 * importing it from a test would boot the whole app and bind a port.
 *
 * **Registration is synchronous; spawning is not.** The manager is registered
 * before any server has connected, so `GET /api/mcp/status` answers truthfully
 * from the very first request — `managed: true`, with each server showing
 * `starting` and then `running`. Spawning a stdio server means `npx`, which on a
 * cold cache can take tens of seconds, and no HTTP request should wait for that.
 * Registering only after `startAll()` resolved would have made the status
 * endpoint lie about the supervisor for the whole of that window.
 */
import { env } from '../../config/env.ts';
import {
  registerMcpProcessManager,
  unregisterMcpProcessManager,
} from '../../orchestrator/agents.ts';
import type { McpProcessManager } from '../../types/core.ts';
import { createLogger } from '../../util/logger.ts';
import { createProcessManager } from './processManager.ts';

const log = createLogger('mcp:supervisor');

/**
 * The manager as boot uses it. `McpProcessManager` is the orchestrator's view —
 * status and per-server start/stop — and the two bulk operations are what a
 * lifecycle owner additionally needs. Declared as an interface rather than using
 * the concrete class so a test can supply a double: `ProcessManager` has private
 * fields, which no object literal can ever satisfy.
 */
export interface McpSupervisor extends McpProcessManager {
  startAll(): Promise<void>;
  stopAll(): Promise<void>;
}

/**
 * How long shutdown waits for servers to stop before giving up on them.
 *
 * Bounded deliberately. A hung `client.close()` on an unresponsive server would
 * otherwise hold the shutdown sequence until the entrypoint's 6s force-exit
 * fired, and that would skip closing the database — leaving a hot WAL behind on
 * every restart. Losing a child process to the OS is the lesser failure.
 */
const STOP_TIMEOUT_MS = 3_000;

let manager: McpSupervisor | null = null;
/** The in-flight `startAll()`, so shutdown can wait for it rather than race it. */
let starting: Promise<void> | null = null;

/**
 * Construct the manager, register it, and start every enabled server in the
 * background.
 *
 * The `create` parameter exists for tests. A real `startAll()` spawns the default
 * filesystem server through `npx -y`, which reaches the network, so a test that
 * used the real factory would be neither fast nor offline-safe.
 */
export function startMcpSupervisor(create: () => McpSupervisor = createProcessManager): void {
  if (env.mcpDisabled) {
    // Nothing is registered, so status keeps reporting `managed: false`. That is
    // the honest answer: with the supervisor off, no servers are being managed.
    log.info('MCP supervisor disabled by configuration; no servers will be spawned');
    return;
  }

  // A second call would spawn a duplicate of every server. The entrypoint calls
  // this once, but the guard makes that a property of the module rather than of
  // its one caller.
  if (manager) {
    log.warn('the MCP supervisor is already running');
    return;
  }

  const instance = create();
  manager = instance;
  registerMcpProcessManager(instance);

  // Not awaited: see the module comment. Failures are logged and left visible in
  // each server's `lastError`, which the status endpoint already surfaces — a
  // misconfigured server must not stop the process from serving.
  starting = instance
    .startAll()
    .catch((error: unknown) => {
      log.error('failed to start the configured MCP servers', error);
    })
    .finally(() => {
      starting = null;
    });
}

/**
 * Stop every server. Called from the entrypoint's shutdown path.
 *
 * Waits for an in-flight `startAll()` first. Stopping while a spawn is still
 * running would tear down the servers that had already connected and then let
 * the remaining ones finish spawning into a process that is about to exit —
 * orphaning exactly the child processes this function exists to reap.
 *
 * Drops the registration on the way out so status does not outlive the
 * servers it describes.
 */
export async function stopMcpSupervisor(): Promise<void> {
  const instance = manager;
  if (!instance) return;
  manager = null;

  if (starting) {
    try {
      await starting;
    } catch {
      // `starting` already has its own catch; this is only for the await.
    }
  }

  // Deliberately not unref'd. By this point in shutdown the schedulers are
  // stopped and the force-exit timer is unref'd, so an unref'd timer here could
  // let the process exit before the budget expired — turning a bounded wait into
  // a coin flip. The `finally` below clears it on every path, so a ref'd timer
  // cannot hold the process open either.
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), STOP_TIMEOUT_MS);
  });

  try {
    const outcome = await Promise.race([
      instance.stopAll().then(() => 'stopped' as const),
      expired,
    ]);
    if (outcome === 'timeout') {
      log.warn(`MCP servers did not stop within ${STOP_TIMEOUT_MS}ms; continuing shutdown`);
    }
  } catch (error) {
    log.warn('an MCP server failed to stop cleanly', error);
  } finally {
    if (timer) clearTimeout(timer);
    // Unconditional, including after a timeout: the clients are closed or
    // wedged either way, so leaving the registration in place would have
    // `/api/mcp/status` keep answering `managed: true` for a manager that can
    // no longer serve a tool call. Found by a real shutdown, which reported
    // `managed: true` after every child had been reaped.
    unregisterMcpProcessManager();
  }
}
