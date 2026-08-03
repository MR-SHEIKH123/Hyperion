/**
 * Non-blocking MCP connection test.
 *
 * The contract from the spec: **saving a config succeeds regardless of whether
 * the test passes.** The test is informational — a diagnostic the user asks for,
 * never a gate on persistence. So this module:
 *
 *   - never throws (every failure becomes a `{ ok: false, message }` result),
 *   - never mutates the config, and
 *   - is only ever called *after* a save has already committed.
 *
 * What "tested" means differs by type:
 *
 *   - **remote**: we can genuinely reach out — an HTTP probe with a short timeout
 *     tells us whether the URL resolves and whether the token is accepted.
 *   - **local (stdio)**: a real test means spawning the process, which is Kimi's
 *     `McpProcessManager`, not ours. If a manager has been registered we delegate
 *     to its `testConnection()`. If not, we fall back to *static* checks (is the
 *     executable plausible, do the args point inside the scoped root) and say so
 *     plainly, so the UI never shows a green tick we didn't earn.
 */
import fs from 'node:fs';
import { env } from '../../config/env.ts';
import { isInScope } from '../../security/fsScope.ts';
import type { ScopeName } from '../../security/fsScope.ts';
import { getMcpProcessManager } from '../../orchestrator/agents.ts';
import { createLogger } from '../../util/logger.ts';
import type { McpServerRecord } from './registry.ts';
import { recordTestResult, serverToken } from './registry.ts';

const log = createLogger('mcp:test');

export interface McpTestResult {
  ok: boolean;
  /** Human-readable outcome, shown verbatim in the UI. */
  message: string;
  /** True when nothing was actually connected to, only inspected. */
  static: boolean;
  durationMs: number;
}

const PROBE_TIMEOUT_MS = 6_000;

/** Runs the test and records the outcome. Never throws. */
export async function testServer(server: McpServerRecord): Promise<McpTestResult> {
  const started = Date.now();
  let result: McpTestResult;
  try {
    result =
      server.type === 'remote' ? await testRemote(server) : await testLocal(server);
  } catch (error) {
    // Defensive: the helpers below are already total, but a test must never be
    // able to fail a request.
    log.warn(`connection test for "${server.name}" threw`, error);
    result = {
      ok: false,
      message: error instanceof Error ? error.message : 'The connection test failed.',
      static: false,
      durationMs: Date.now() - started,
    };
  }

  result.durationMs = Date.now() - started;
  try {
    recordTestResult(server.id, result.ok ? 'ok' : 'failed', result.message);
  } catch (error) {
    log.warn('could not record the MCP test result', error);
  }
  return result;
}

// --- remote ----------------------------------------------------------------

async function testRemote(server: McpServerRecord): Promise<McpTestResult> {
  const url = server.url;
  if (!url) {
    return { ok: false, message: 'No URL is configured.', static: true, durationMs: 0 };
  }

  const headers: Record<string, string> = { Accept: 'text/event-stream, application/json' };
  for (const [key, value] of Object.entries(server.headers)) headers[key] = value;
  const token = serverToken(server);
  if (token && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch (error) {
    return {
      ok: false,
      message: describeNetworkError(error, url),
      static: false,
      durationMs: 0,
    };
  }

  // The body is irrelevant — we only need the status line. Cancel it so an SSE
  // endpoint that would stream forever doesn't leave the socket open.
  try {
    await response.body?.cancel();
  } catch {
    /* already closed */
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      message: token
        ? `The server rejected the token (HTTP ${response.status}).`
        : `The server requires authentication (HTTP ${response.status}). Add a token.`,
      static: false,
      durationMs: 0,
    };
  }

  if (response.status >= 500) {
    return {
      ok: false,
      message: `Reached the server, but it returned HTTP ${response.status}.`,
      static: false,
      durationMs: 0,
    };
  }

  // 404/405 still prove the host is up and answering; many MCP endpoints only
  // accept POST, so a 405 on GET is a *successful* reachability test.
  if (response.status === 404 || response.status === 405) {
    return {
      ok: true,
      message: `Reachable (HTTP ${response.status} on a GET probe, which is normal for POST-only endpoints).`,
      static: false,
      durationMs: 0,
    };
  }

  return {
    ok: response.ok,
    message: response.ok
      ? `Connected (HTTP ${response.status}).`
      : `Reached the server, but it returned HTTP ${response.status}.`,
    static: false,
    durationMs: 0,
  };
}

function describeNetworkError(error: unknown, url: string): string {
  const chain: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === 'string') chain.push(code);
    if ((current as Error).name === 'TimeoutError') chain.push('TIMEOUT');
    current = (current as { cause?: unknown }).cause;
  }
  if (chain.includes('TIMEOUT')) return `No response within ${PROBE_TIMEOUT_MS / 1000}s.`;
  if (chain.includes('ECONNREFUSED')) return `Connection refused by ${url}.`;
  if (chain.includes('ENOTFOUND')) return `The host in ${url} could not be resolved.`;
  if (chain.some((code) => code.startsWith('CERT') || code.startsWith('ERR_TLS'))) {
    return 'The TLS certificate could not be verified.';
  }
  return error instanceof Error ? error.message : 'The connection failed.';
}

// --- local (stdio) ---------------------------------------------------------

async function testLocal(server: McpServerRecord): Promise<McpTestResult> {
  const manager = getMcpProcessManager();
  if (manager?.testConnection) {
    try {
      const outcome = await manager.testConnection(server.name);
      return {
        ok: outcome.ok,
        message: outcome.message,
        static: false,
        durationMs: 0,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'The process manager reported a failure.',
        static: false,
        durationMs: 0,
      };
    }
  }

  const problems = staticProblems(server);
  if (problems.length > 0) {
    return {
      ok: false,
      message: `Config check failed: ${problems.join(' ')}`,
      static: true,
      durationMs: 0,
    };
  }

  return {
    ok: true,
    message:
      'The configuration looks valid, but the server was not started: no MCP process manager ' +
      'is running yet, so this is a config check only, not a live connection.',
    static: true,
    durationMs: 0,
  };
}

/**
 * Roots a stdio server may legitimately be pointed at.
 *
 * `projects` is the user's code. `mcp` is the server's *own* installation
 * directory (`~/AIStudio/mcp/<name>/`) — its virtual environment and any data
 * files it generates. A server being handed a path to its own artefacts is not
 * a containment breach, and treating it as one meant our own seeded defaults
 * failed their own config check.
 */
const ALLOWED_ARG_SCOPES: ScopeName[] = ['projects', 'mcp'];

/** Cheap static sanity checks for a stdio server. */
function staticProblems(server: McpServerRecord): string[] {
  const problems: string[] = [];
  const command = server.command?.trim() ?? '';
  if (command === '') problems.push('No command is configured.');
  if (/[\r\n]/.test(command)) problems.push('The command contains a line break.');

  // An absolute command names a concrete file, so its absence is knowable now
  // rather than at spawn time. A bare command (`npx`, `python`) is resolved
  // from PATH by the OS and is not ours to second-guess here.
  if (command !== '' && looksAbsolute(command) && !fs.existsSync(command)) {
    problems.push(
      `The executable "${command}" does not exist yet. A server that runs from its own ` +
        'virtual environment needs its one-time setup done first — see the MCP section of ' +
        'docs/CONTRACTS.md.',
    );
  }

  // A filesystem-style server takes a directory argument. Any argument that
  // looks like an absolute path must stay inside a root we control — this is
  // the same containment the Code tool is held to.
  for (const arg of server.args) {
    if (!looksAbsolute(arg)) continue;

    if (!ALLOWED_ARG_SCOPES.some((scope) => isInScope(scope, arg))) {
      problems.push(
        `The path "${arg}" is outside the allowed roots (${env.paths.projects} and ` +
          `${env.paths.mcp}); filesystem access is scoped deliberately.`,
      );
      continue;
    }

    // In scope but not there yet. A data file a server reads at startup (a
    // pre-built graph, an index) has to be generated before the server can
    // run, and saying so now beats a spawn failure later. Extension-less
    // arguments are left alone: those are directories, which a server may
    // legitimately create for itself on first run.
    if (/\.[A-Za-z0-9]+$/.test(arg) && !fs.existsSync(arg)) {
      problems.push(
        `The file "${arg}" does not exist yet; it has to be generated before this server ` +
          'can start — see the MCP section of docs/CONTRACTS.md.',
      );
    }
  }
  return problems;
}

function looksAbsolute(value: string): boolean {
  return /^([A-Za-z]:[\\/]|\/)/.test(value);
}
