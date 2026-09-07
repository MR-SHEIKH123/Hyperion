/**
 * In-process registries for agent, terminal and MCP orchestration modules.
 *
 * Production composition synchronously registers Cowork, Code, and the local
 * terminal executor after bootstrap and before HTTP or schedulers start. Design
 * remains optional and therefore keeps its explicit 501 boundary when absent.
 * MCP is different again: its supervisor owns manager registration for
 * the duration of the supervised transports rather than composition owning it.
 *
 * These contracts deliberately remain plain function calls. Shell commands and
 * streamed agent turns should not cross a second HTTP hop, which would add
 * latency and another failure boundary without adding isolation.
 *
 * Registry presence is not lifecycle ownership. Registering an agent or terminal
 * makes it callable; schedulers, request handlers and the MCP supervisor still
 * start and stop their own work.
 */
import type {
  AgentModule,
  CommandResult,
  McpProcessManager,
  McpServerStatus,
  TerminalModule,
} from '../types/core.ts';

import { AppError } from '../util/errors.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('agents');

/** Only these tools run through an agentic loop. */
export type AgentTool = 'code' | 'cowork' | 'design';

const agents = new Map<AgentTool, AgentModule>();
let terminal: TerminalModule | null = null;
let mcpManager: McpProcessManager | null = null;

// --- agents ----------------------------------------------------------------

export function registerAgent(tool: AgentTool, module: AgentModule): void {
  if (agents.has(tool)) log.warn(`the ${tool} agent was already registered; replacing it`);
  agents.set(tool, module);
  log.info(`registered the ${tool} agent`);
}

export function getAgent(tool: AgentTool): AgentModule | null {
  return agents.get(tool) ?? null;
}

/**
 * Throws a 501 rather than a 500 when a module hasn't been loaded. The
 * distinction matters: "this part of the app hasn't shipped yet" is a different
 * message for the UI than "something broke".
 */
export function requireAgent(tool: AgentTool): AgentModule {
  const module = agents.get(tool);
  if (!module) {
    throw new AppError(
      'agent_not_registered',
      `The ${tool} agent module is not loaded yet, so ${tool} tasks cannot run. ` +
        'Everything else in the app is unaffected.',
      { details: { tool } },
    );
  }
  return module;
}

export function registeredAgents(): AgentTool[] {
  return [...agents.keys()];
}

// --- terminal --------------------------------------------------------------

export function registerTerminal(module: TerminalModule): void {
  terminal = module;
  log.info('registered the terminal execution module');
}

export function getTerminal(): TerminalModule | null {
  return terminal;
}

export function requireTerminal(): TerminalModule {
  if (!terminal) {
    throw new AppError(
      'terminal_not_registered',
      'Shell execution is not available: the terminal module is not loaded.',
    );
  }
  return terminal;
}

/**
 * The single entry point for running a shell command.
 *
 * Both the HTTP route and every agent module go through here so the scope check
 * cannot be bypassed by one caller forgetting it. `options.taskId` tightens the
 * boundary to that task's own worktree — the thing that keeps parallel Code
 * tasks out of each other's directories. Note the imports are lazy: this module
 * is imported by `services/mcp/test.ts`, and `fsScope` pulls in `env`, which
 * would otherwise widen the import graph of every consumer.
 *
 * The capability gate runs **before** the scope check and before the terminal
 * module is asked for anything. Prompt 1.20 §2 requires that `executeCommand`
 * calls be rejected before the terminal module ever runs anything, and putting the
 * gate here rather than in the HTTP route is what makes that true of the agent
 * path too — a route-level check would leave an in-process agent ungated.
 */
export async function executeCommand(
  cwd: string,
  command: string,
  options?: { timeoutMs?: number; signal?: AbortSignal; taskId?: string },
): Promise<CommandResult> {
  const { assertCommandAllowed } = await import('../services/limits/capabilities.ts');
  assertCommandAllowed(command);

  const module = requireTerminal();
  const { containAgentCwd } = await import('../services/code/worktree.ts');
  const safeCwd = containAgentCwd(cwd, options?.taskId);
  return module.executeCommand(safeCwd, command, options);
}

// --- MCP process manager ---------------------------------------------------

export function registerMcpProcessManager(manager: McpProcessManager): void {
  mcpManager = manager;
  log.info('registered the MCP process manager');
}

export function getMcpProcessManager(): McpProcessManager | null {
  return mcpManager;
}

/**
 * Dropped on shutdown, so status stops claiming supervision the moment the
 * servers are gone.
 *
 * Registration is a pointer, not a lease: without this, `mcpStatus()` keeps
 * answering `managed: true` after every client has been closed, and a late
 * tool call finds a manager whose transports are already dead and fails on it
 * confusingly instead of getting the honest "nothing is supervised".
 */
export function unregisterMcpProcessManager(): void {
  mcpManager = null;
  log.info('unregistered the MCP process manager');
}

/**
 * Status for `GET /api/mcp/status`.
 *
 * With no manager registered this returns an empty list rather than throwing:
 * the endpoint's job is to report what is running, and "nothing, because no
 * supervisor is loaded" is a valid answer the UI can render.
 */
export function mcpStatus(): { managed: boolean; servers: McpServerStatus[] } {
  if (!mcpManager) return { managed: false, servers: [] };
  try {
    return { managed: true, servers: mcpManager.getStatus() };
  } catch (error) {
    log.warn('the MCP process manager failed to report status', error);
    return { managed: true, servers: [] };
  }
}

/** Test hook. */
export function resetModules(): void {
  agents.clear();
  terminal = null;
  mcpManager = null;
}
