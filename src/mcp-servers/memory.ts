/**
 * Hyperion's own memory, served over MCP.
 *
 * Two tools, no new memory infrastructure: `memory_search` reads through
 * `listMemories` and `memory_add` writes through `addMemory` — the same two
 * functions the Settings routes call, against the same mem0 store. An agent
 * calling these tools and an external MCP client calling them get the same
 * answers, because they are the same calls.
 *
 * Why a subprocess for functions the parent already has in-process: this is
 * what the MCP tool-registration path *is* in Hyperion. Agents consume MCP
 * tools from supervisor-spawned servers through `listTools`/`callTool`, and a
 * first-party server joins that path exactly like a third-party one — seeded
 * in `services/mcp/defaults.ts`, spawned and watched by the supervisor,
 * gated per tool in the Plugins hub. An in-process special case would be a
 * second consumption path to keep in lockstep with the first.
 *
 * The entry half owns its stdio, which is the whole contract of a stdio
 * server: JSON-RPC on stdout, so the Hyperion logger is silenced (an `info`
 * line mid-stream would corrupt the protocol) and `console.*` — mem0's
 * failure channel — is redirected to a log file, because this child's stderr
 * is piped but never drained and a chatty enough server would block on it.
 * The factory half is pure wiring and takes injected dependencies, so the
 * tools are unit-testable without spawning anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'node:util';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { env } from '../config/env.ts';
import type { AddMemoryOutcome, MemoryEntry } from '../services/memory/index.ts';
import {
  MEMORY_MAX_CHARS,
  addMemory,
  listMemories,
  memoryEnabled,
} from '../services/memory/index.ts';
import { setLogSilent } from '../util/logger.ts';

export const MEMORY_SEARCH_TOOL = 'memory_search';
export const MEMORY_ADD_TOOL = 'memory_add';

/** The same ceiling the list route holds reads to. */
const SEARCH_MAX_LIMIT = 200;

export interface MemoryMcpDependencies {
  isEnabled?: () => boolean;
  add?: (text: string) => Promise<AddMemoryOutcome>;
  list?: (options: { query?: string | undefined; limit?: number | undefined }) => Promise<MemoryEntry[]>;
}

function defaultDependencies(): Required<MemoryMcpDependencies> {
  return { isEnabled: memoryEnabled, add: addMemory, list: listMemories };
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function failed(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Read the plugin switch without letting a broken settings database become a
 * protocol error: a tool that throws answers `InternalError`, which says
 * nothing — a tool that refuses names the problem.
 */
function readEnabled(isEnabled: () => boolean): boolean | string {
  try {
    return isEnabled();
  } catch (error) {
    return `Could not read the Memory switch: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Recall memories ranked against a query — or the most recent ones when no
 * query is given, which is what the list route does with no `query` either.
 *
 * A disabled plugin is an error, not an empty list: the HTTP list answers `[]`
 * because a panel renders it next to `GET /status`, which explains why — a
 * tool result has no neighbouring status call, so the reason travels with it.
 */
export async function handleMemorySearch(
  args: Record<string, unknown>,
  deps: MemoryMcpDependencies = {},
): Promise<CallToolResult> {
  const { isEnabled, list } = { ...defaultDependencies(), ...deps };
  const enabled = readEnabled(isEnabled);
  if (typeof enabled === 'string') return failed(enabled);
  if (!enabled) {
    return failed('The Memory plugin is off, so there is nothing to search. Turn it on in Settings first.');
  }
  const query = args.query;
  if (query !== undefined && typeof query !== 'string') {
    return failed('query must be a string.');
  }
  const limit = args.limit;
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) {
    return failed('limit must be a positive whole number.');
  }
  if (typeof limit === 'number' && limit > SEARCH_MAX_LIMIT) {
    return failed(`limit must be at most ${SEARCH_MAX_LIMIT}.`);
  }
  try {
    const entries = await list({
      ...(query === undefined ? {} : { query }),
      ...(limit === undefined ? {} : { limit }),
    });
    return ok(JSON.stringify({ memories: entries }, null, 2));
  } catch (error) {
    return failed(`Memory search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Store one memory, exactly as the add route would: the same length bound,
 * the same backend outcomes, reworded from HTTP answers into tool answers.
 */
export async function handleMemoryAdd(
  args: Record<string, unknown>,
  deps: MemoryMcpDependencies = {},
): Promise<CallToolResult> {
  const { isEnabled, add } = { ...defaultDependencies(), ...deps };
  const enabled = readEnabled(isEnabled);
  if (typeof enabled === 'string') return failed(enabled);
  if (!enabled) {
    return failed('The Memory plugin is off, so nothing was stored. Turn it on in Settings first.');
  }
  const text = args.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return failed('text must be a non-empty string.');
  }
  if (text.length > MEMORY_MAX_CHARS) {
    return failed(`text must be at most ${MEMORY_MAX_CHARS} characters.`);
  }
  const outcome = await add(text);
  if (outcome === 'stored') return ok(JSON.stringify({ stored: true }));
  if (outcome === 'disabled') {
    return failed('The Memory plugin is off, so nothing was stored. Turn it on in Settings first.');
  }
  if (outcome === 'empty') return failed('text must be a non-empty string.');
  return failed('The memory backend is not available, so nothing was stored.');
}

const TOOL_DEFINITIONS = [
  {
    name: MEMORY_SEARCH_TOOL,
    description:
      'Search Hyperion memory for facts relevant to a query. Omit the query to list recent memories.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What to recall. Optional.' },
        limit: { type: 'integer', minimum: 1, maximum: SEARCH_MAX_LIMIT, description: 'How many memories, at most 200.' },
      },
    },
  },
  {
    name: MEMORY_ADD_TOOL,
    description: 'Store one fact in Hyperion memory, as written.',
    inputSchema: {
      type: 'object' as const,
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'The fact to remember. At most 4000 characters.' },
      },
    },
  },
];

/** The served tools, for tests that pin the surface without spawning. */
export function memoryToolDefinitions(): { name: string; description: string; inputSchema: unknown }[] {
  return TOOL_DEFINITIONS;
}

export function createMemoryMcpServer(deps: MemoryMcpDependencies = {}): Server {
  const server = new Server(
    { name: 'hyperion-memory', version: '1' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (request.params.name === MEMORY_SEARCH_TOOL) return handleMemorySearch(args, deps);
    if (request.params.name === MEMORY_ADD_TOOL) return handleMemoryAdd(args, deps);
    return failed(`Unknown tool "${request.params.name}". This server offers ${MEMORY_SEARCH_TOOL} and ${MEMORY_ADD_TOOL}.`);
  });
  return server;
}

// --- entry -----------------------------------------------------------------

async function main(): Promise<void> {
  // Own the stdio before anything can write to it. mem0 reports through
  // `console.*`, and the Hyperion logger writes stdout/stderr directly —
  // both would corrupt or block the protocol stream (see module docstring).
  const dir = path.join(env.paths.mcp, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const sink = fs.createWriteStream(path.join(dir, 'server.log'), { flags: 'a' });
  // A dead log sink must not kill the server: diagnostics are not the service,
  // and a full disk already surfaces as tool errors from the backend itself.
  sink.on('error', () => undefined);
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const redirect = console as unknown as Record<(typeof methods)[number], (...args: unknown[]) => void>;
  for (const method of methods) {
    redirect[method] = (...args: unknown[]) => {
      sink.write(`${new Date().toISOString()} [console.${method}] ${format(...args)}\n`);
    };
  }
  setLogSilent(true);

  const server = createMemoryMcpServer();
  await server.connect(new StdioServerTransport());
}

// Direct invocation: spawned by the MCP supervisor as `node <this file>`.
// pathToFileURL is required for correctness on Windows (see migrate.ts).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
