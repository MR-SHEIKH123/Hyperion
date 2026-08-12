/**
 * The integration seam between this backend and the two other build layers.
 *
 * Kimi's code/cowork agents, Sol's design agent, Sol's terminal executor and
 * Kimi's MCP process manager are all **in-process modules**, registered here at
 * boot. They are deliberately not HTTP services:
 *
 *   - a shell command that has to cross a socket to run adds latency to every
 *     single tool call in an agentic loop, and
 *   - an agent that streams thousands of tokens through a second HTTP hop doubles
 *     the places a stream can break.
 *
 * So the contract is a plain function call. Everything below is the exact shape
 * the other two layers must implement; nothing here does any work itself.
 *
 * ---------------------------------------------------------------------------
 * FOR SOL — terminal module (Code tool shell execution)
 *
 *   import { registerTerminal } from './orchestrator/agents.ts';
 *
 *   registerTerminal({
 *     async executeCommand(cwd, command, options) {
 *       // → { stdout, stderr, exitCode, timedOut }
 *     },
 *   });
 *
 * `cwd` is always already validated before you receive it, and the boundary it
 * was validated against depends on the task. A parallel Code task works in its
 * own git worktree under `~/Hyperion/worktrees/<task-id>/`, and is contained to
 * *that* directory rather than to the projects root — otherwise two concurrent
 * tasks could reach into each other's checkout. Everything else is contained to
 * `~/Hyperion/projects/`. Pass `options.taskId` when you have one so the tighter
 * boundary applies; without it, containment falls back to the projects root plus
 * any registered worktree. If you ever accept a path from somewhere other than
 * this backend, validate it yourself as well.
 *
 * FOR SOL — design agent
 *
 *   registerAgent('design', { async runTask(input, ctx) { ... } });
 *
 * FOR KIMI — code and cowork agents
 *
 *   registerAgent('code',   { async runTask(input, ctx) { ... } });
 *   registerAgent('cowork', { async runTask(input, ctx) { ... } });
 *
 * Inside `runTask` you get an `AgentContext` with `ctx.llm.stream()` (already
 * routed through provider failover), `ctx.executeCommand()` (Sol's module, or a
 * clear `terminal_not_registered` error if it isn't loaded), `ctx.emit()` for SSE
 * progress, `ctx.saveArtifactVersion()` for undo history, and `ctx.signal` which
 * aborts when the browser disconnects. Long loops must check `ctx.signal.aborted`.
 *
 * FOR KIMI — MCP process manager
 *
 *   registerMcpProcessManager({
 *     getStatus() { ... },        // surfaced verbatim by GET /api/mcp/status
 *     start(name) { ... },
 *     stop(name)  { ... },
 *     testConnection(name) { ... },   // optional; enables live stdio tests
 *   });
 *
 * Read server definitions from `mcp_config.json` (we own writing it) or call
 * `listServers()` in `services/mcp/registry.ts`.
 * ---------------------------------------------------------------------------
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
 * Both the HTTP route and Kimi's code agent go through here so the scope check
 * cannot be bypassed by one caller forgetting it. `options.taskId` tightens the
 * boundary to that task's own worktree — the thing that keeps parallel Code
 * tasks out of each other's directories. Note the imports are lazy: this module
 * is imported by `services/mcp/test.ts`, and `fsScope` pulls in `env`, which
 * would otherwise widen the import graph of every consumer.
 *
 * The capability gate runs **before** the scope check and before the terminal
 * module is asked for anything. Prompt 1.20 §2 requires that `executeCommand`
 * calls be "rejected before Sol's module ever runs anything", and putting the
 * gate here rather than in the HTTP route is what makes that true of the agent
 * path too — a route-level check would leave Kimi's code agent ungated.
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
