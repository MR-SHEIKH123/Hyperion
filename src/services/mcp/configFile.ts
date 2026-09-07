/**
 * Reader/writer for `mcp_config.json`.
 *
 * The format is deliberately *not* ours to invent — it is the same shape Cline
 * and other MCP hosts already use, so the file stays portable:
 *
 *   {
 *     "mcpServers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/scoped/path"],
 *         "env": { "FOO": "bar" },
 *         "disabled": false
 *       },
 *       "some-remote": {
 *         "url": "https://example.com/sse",
 *         "headers": { "Authorization": "Bearer ..." },
 *         "disabled": false
 *       }
 *     }
 *   }
 *
 * Two properties matter more than elegance here:
 *
 * 1. **Writes are atomic.** The file is written to a sibling temp file and then
 *    renamed over the target. A crash mid-write can therefore never leave a
 *    truncated config behind — the process manager reads this file, and half a
 *    JSON document would take down every server at once.
 *
 * 2. **Unknown fields survive.** Other tools may add keys we don't model (e.g.
 *    `alwaysAllow`, `timeout`). Rewriting an entry merges over whatever is
 *    already on disk instead of replacing it wholesale, so we never silently
 *    delete another host's settings.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env.ts';
import { AppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';

const log = createLogger('mcp:config');

/** A single entry as it appears on disk. Extra keys are preserved verbatim. */
export interface McpConfigEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  [extra: string]: unknown;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpConfigEntry>;
  [extra: string]: unknown;
}

function emptyConfig(): McpConfigFile {
  return { mcpServers: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the config file. A missing file is not an error — it simply means no
 * servers have been configured yet.
 *
 * A *corrupt* file is also not fatal: we log loudly, move the bad file aside so
 * the user can inspect it, and continue from empty. Refusing to boot because a
 * hand-edited config has a trailing comma would be a worse outcome than
 * degrading to "no MCP servers", since the database still holds the real
 * registry and the next write regenerates the file.
 */
export function readConfig(): McpConfigFile {
  const file = env.paths.mcpConfig;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig();
    throw new AppError('storage_error', `Could not read ${file}.`, { cause: error });
  }

  if (raw.trim() === '') return emptyConfig();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const quarantine = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, quarantine);
      log.error(`mcp_config.json was not valid JSON; moved aside to ${quarantine}`, error);
    } catch (renameError) {
      log.error('mcp_config.json was not valid JSON and could not be moved aside', renameError);
    }
    return emptyConfig();
  }

  if (!isRecord(parsed)) return emptyConfig();
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  const entries: Record<string, McpConfigEntry> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (isRecord(entry)) entries[name] = entry as McpConfigEntry;
  }
  return { ...parsed, mcpServers: entries };
}

/** Writes the whole file atomically (temp file + rename). */
export function writeConfig(config: McpConfigFile): void {
  const file = env.paths.mcpConfig;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const body = `${JSON.stringify(config, null, 2)}\n`;

  // 0o600: the file can hold bearer tokens for remote servers.
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* the temp file is disposable */
    }
    throw new AppError('storage_error', `Could not write ${file}.`, { cause: error });
  }
}

/**
 * Creates or updates one entry **by name**.
 *
 * Editing an existing server must reuse its entry rather than delete-and-recreate
 * it: a delete/recreate pair changes key ordering, drops unknown fields, and (if
 * the process manager is watching the file) looks like a server disappearing and
 * a different one arriving, which would restart it twice.
 */
export function upsertEntry(name: string, entry: McpConfigEntry): McpConfigFile {
  const config = readConfig();
  const existing = config.mcpServers[name];
  const merged: McpConfigEntry = { ...existing, ...entry };

  // A server is either local or remote. Switching type must clear the fields
  // belonging to the other kind, or the merge would leave a contradictory entry
  // holding both a `command` and a `url`.
  if (entry.command !== undefined) {
    delete merged.url;
    delete merged.headers;
  }
  if (entry.url !== undefined) {
    delete merged.command;
    delete merged.args;
    delete merged.env;
  }

  config.mcpServers[name] = merged;
  writeConfig(config);
  return config;
}

/** Removes one entry. Absent entries are treated as already removed. */
export function removeEntry(name: string): void {
  const config = readConfig();
  if (!(name in config.mcpServers)) return;
  delete config.mcpServers[name];
  writeConfig(config);
}

/** Renames an entry in place, preserving its settings. */
export function renameEntry(from: string, to: string): void {
  if (from === to) return;
  const config = readConfig();
  const entry = config.mcpServers[from];
  if (!entry) return;
  delete config.mcpServers[from];
  config.mcpServers[to] = entry;
  writeConfig(config);
}

/**
 * Replaces the `mcpServers` map wholesale while keeping any top-level keys other
 * tools may have added. Used to re-materialise the file from the database, which
 * is the authority for the registry.
 */
export function replaceServers(servers: Record<string, McpConfigEntry>): void {
  const config = readConfig();
  const existing = config.mcpServers;
  const merged: Record<string, McpConfigEntry> = {};
  for (const [name, entry] of Object.entries(servers)) {
    merged[name] = { ...existing[name], ...entry };
  }
  writeConfig({ ...config, mcpServers: merged });
}
