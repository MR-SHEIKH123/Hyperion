/**
 * Minimal levelled logger.
 *
 * Writes single-line, timestamped output to stdout/stderr, which is what PM2
 * captures into its log files. No external logging dependency: this app has one
 * user and one process, so structured log shipping would be pure overhead.
 */
import { env } from '../config/env.ts';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
export type LogLevel = keyof typeof LEVELS;

const threshold = LEVELS[env.logLevel as LogLevel] ?? LEVELS.info;

/**
 * Discard every log line instead of writing it.
 *
 * For children that own their stdio: an MCP server speaks JSON-RPC on stdout,
 * so an `info` line landing mid-stream would corrupt the protocol, and its
 * stderr is piped but never drained, so even warnings would eventually block
 * it. Set by the entry point, not by configuration — the parent process always
 * wants its logs.
 */
let silent = false;

/** Silence (or re-enable) all logging process-wide. Used by the MCP server entry; tests restore it. */
export function setLogSilent(on: boolean): void {
  silent = on;
}

function emit(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (silent) return;
  if (LEVELS[level] > threshold) return;

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line + '\n');

  if (extra !== undefined) {
    stream.write(indent(formatExtra(extra)) + '\n');
  }
}

function formatExtra(extra: unknown): string {
  if (extra instanceof Error) {
    return extra.stack ?? `${extra.name}: ${extra.message}`;
  }
  if (typeof extra === 'string') return extra;
  try {
    return JSON.stringify(extra, null, 2);
  } catch {
    return String(extra);
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n');
}

export interface Logger {
  error(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  debug(message: string, extra?: unknown): void;
  child(subScope: string): Logger;
}

/** Create a logger tagged with a scope, e.g. `logger('providers')`. */
export function createLogger(scope: string): Logger {
  return {
    error: (m, e) => emit('error', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    debug: (m, e) => emit('debug', scope, m, e),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger('hyperion');
