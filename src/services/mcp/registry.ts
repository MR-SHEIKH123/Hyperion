/**
 * The MCP server registry.
 *
 * Two stores are kept in step:
 *
 *   - the `mcp_servers` table, which is the authority (it holds the encrypted
 *     token and the last test result), and
 *   - `mcp_config.json`, which is the *interchange* format Kimi's process
 *     manager and other MCP hosts read.
 *
 * Every mutation writes the table first and then re-materialises the file. If the
 * file write fails, the transaction is rolled back, so the two can't silently
 * diverge.
 *
 * Note what this module does NOT do: it never spawns a process. Starting,
 * stopping and supervising servers is Kimi's `McpProcessManager`; we only own
 * persistence and the API surface around it.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/adapter.ts';
import { encrypt, keyHint, tryDecrypt } from '../../security/keystore.ts';
import { AppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';
import type { McpConfigEntry } from './configFile.ts';
import { readConfig, replaceServers, writeConfig } from './configFile.ts';

const log = createLogger('mcp:registry');

export type McpServerType = 'local' | 'remote';
export type McpTestStatus = 'ok' | 'failed' | 'unknown';

/** Internal record, including the encrypted token. Never leaves the backend. */
export interface McpServerRecord {
  id: string;
  name: string;
  type: McpServerType;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  tokenEnc: string | null;
  enabled: boolean;
  lastTestStatus: McpTestStatus;
  lastTestMessage: string | null;
  lastTestAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Wire shape. Like providers, the token is reduced to a boolean plus a 4-char
 * hint — the real value never reaches the browser.
 */
export interface McpServerPublic {
  id: string;
  name: string;
  type: McpServerType;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  hasToken: boolean;
  tokenHint: string | null;
  enabled: boolean;
  lastTestStatus: McpTestStatus;
  lastTestMessage: string | null;
  lastTestAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  name: string;
  type: string;
  command: string | null;
  args_json: string | null;
  env_json: string | null;
  url: string | null;
  headers_json: string | null;
  token_enc: string | null;
  enabled: number;
  last_test_status: string;
  last_test_message: string | null;
  last_test_at: number | null;
  created_at: number;
  updated_at: number;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapRow(row: Row): McpServerRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type === 'remote' ? 'remote' : 'local',
    command: row.command,
    args: parseJson<string[]>(row.args_json, []),
    env: parseJson<Record<string, string>>(row.env_json, {}),
    url: row.url,
    headers: parseJson<Record<string, string>>(row.headers_json, {}),
    tokenEnc: row.token_enc,
    enabled: row.enabled === 1,
    lastTestStatus:
      row.last_test_status === 'ok' || row.last_test_status === 'failed'
        ? row.last_test_status
        : 'unknown',
    lastTestMessage: row.last_test_message,
    lastTestAt: row.last_test_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The only serializer allowed to produce data for the frontend. */
export function toPublic(server: McpServerRecord): McpServerPublic {
  const token = server.tokenEnc ? tryDecrypt(server.tokenEnc) : null;
  return {
    id: server.id,
    name: server.name,
    type: server.type,
    command: server.command,
    args: server.args,
    env: server.env,
    url: server.url,
    headers: server.headers,
    hasToken: server.tokenEnc !== null,
    tokenHint: token ? keyHint(token) : null,
    enabled: server.enabled,
    lastTestStatus: server.lastTestStatus,
    lastTestMessage: server.lastTestMessage,
    lastTestAt: server.lastTestAt,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}

const SELECT = `SELECT * FROM mcp_servers`;

export function listServers(): McpServerRecord[] {
  return getDb()
    .prepare<Row>(`${SELECT} ORDER BY name COLLATE NOCASE`)
    .all()
    .map(mapRow);
}

export function findServer(id: string): McpServerRecord | null {
  const row = getDb().prepare<Row>(`${SELECT} WHERE id = ?`).get(id);
  return row ? mapRow(row) : null;
}

export function findServerByName(name: string): McpServerRecord | null {
  const row = getDb()
    .prepare<Row>(`${SELECT} WHERE name = ? COLLATE NOCASE`)
    .get(name);
  return row ? mapRow(row) : null;
}

export function requireServer(id: string): McpServerRecord {
  const server = findServer(id);
  if (!server) throw new AppError('not_found', `No MCP server with id ${id}.`);
  return server;
}

/** Decrypts the token for backend use only (test-connection, process spawn). */
export function serverToken(server: McpServerRecord): string | null {
  return server.tokenEnc ? tryDecrypt(server.tokenEnc) : null;
}

// --- config file materialisation ------------------------------------------

/**
 * Builds the on-disk entry for one server. The token is expanded into a real
 * `Authorization: Bearer` header here, at the last moment, because the process
 * manager needs a usable header and the file is already 0o600.
 */
function toEntry(server: McpServerRecord): McpConfigEntry {
  if (server.type === 'local') {
    const entry: McpConfigEntry = { command: server.command ?? '' };
    if (server.args.length > 0) entry.args = server.args;
    if (Object.keys(server.env).length > 0) entry.env = server.env;
    entry.disabled = !server.enabled;
    return entry;
  }

  const headers = { ...server.headers };
  const token = serverToken(server);
  if (token && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
    headers.Authorization = `Bearer ${token}`;
  }
  const entry: McpConfigEntry = { url: server.url ?? '' };
  if (Object.keys(headers).length > 0) entry.headers = headers;
  entry.disabled = !server.enabled;
  return entry;
}

/** Rewrites `mcp_config.json` from the table. */
export function syncConfigFile(): void {
  const servers: Record<string, McpConfigEntry> = {};
  for (const server of listServers()) servers[server.name] = toEntry(server);
  replaceServers(servers);
}

// --- mutations -------------------------------------------------------------

export interface McpServerInput {
  name: string;
  type: McpServerType;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  url?: string | null;
  headers?: Record<string, string>;
  /** Plaintext; encrypted before storage. */
  token?: string | null;
  enabled?: boolean;
}

function validate(input: McpServerInput): void {
  const name = input.name?.trim();
  if (!name) throw new AppError('bad_request', 'An MCP server needs a name.');
  if (input.type !== 'local' && input.type !== 'remote') {
    throw new AppError('bad_request', 'MCP server type must be "local" or "remote".');
  }
  if (input.type === 'local' && !input.command?.trim()) {
    throw new AppError('bad_request', 'A local (stdio) MCP server needs a command.');
  }
  if (input.type === 'remote') {
    const url = input.url?.trim();
    if (!url) throw new AppError('bad_request', 'A remote MCP server needs a URL.');
    try {
      new URL(url);
    } catch {
      throw new AppError('bad_request', `"${url}" is not a valid URL.`);
    }
  }
}

export function createServer(input: McpServerInput): McpServerRecord {
  validate(input);
  const name = input.name.trim();
  if (findServerByName(name)) {
    throw new AppError('conflict', `An MCP server named "${name}" already exists.`);
  }

  const db = getDb();
  const id = randomUUID();
  const now = Date.now();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO mcp_servers
         (id, name, type, command, args_json, env_json, url, headers_json, token_enc,
          enabled, last_test_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`,
    ).run(
      id,
      name,
      input.type,
      input.type === 'local' ? (input.command?.trim() ?? null) : null,
      input.args && input.args.length > 0 ? JSON.stringify(input.args) : null,
      input.env && Object.keys(input.env).length > 0 ? JSON.stringify(input.env) : null,
      input.type === 'remote' ? (input.url?.trim() ?? null) : null,
      input.headers && Object.keys(input.headers).length > 0 ? JSON.stringify(input.headers) : null,
      input.token ? encrypt(input.token) : null,
      input.enabled === false ? 0 : 1,
      now,
      now,
    );
    syncConfigFile();
  })();

  log.info(`registered MCP server "${name}" (${input.type})`);
  return requireServer(id);
}

/**
 * Updates an existing server **in place**.
 *
 * `token` is tri-state, matching the provider repository: `undefined` leaves the
 * stored token alone (the frontend never receives it, so it can't echo it back),
 * `null`/`''` clears it, and a string replaces it.
 */
export function updateServer(id: string, input: Partial<McpServerInput>): McpServerRecord {
  const existing = requireServer(id);
  const merged: McpServerInput = {
    name: input.name?.trim() ?? existing.name,
    type: input.type ?? existing.type,
    command: input.command !== undefined ? input.command : existing.command,
    args: input.args ?? existing.args,
    env: input.env ?? existing.env,
    url: input.url !== undefined ? input.url : existing.url,
    headers: input.headers ?? existing.headers,
    enabled: input.enabled ?? existing.enabled,
  };
  validate(merged);

  if (merged.name !== existing.name && findServerByName(merged.name)) {
    throw new AppError('conflict', `An MCP server named "${merged.name}" already exists.`);
  }

  const tokenEnc =
    input.token === undefined
      ? existing.tokenEnc
      : input.token
        ? encrypt(input.token)
        : null;

  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE mcp_servers
          SET name = ?, type = ?, command = ?, args_json = ?, env_json = ?,
              url = ?, headers_json = ?, token_enc = ?, enabled = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      merged.name,
      merged.type,
      merged.type === 'local' ? (merged.command?.trim() ?? null) : null,
      merged.args && merged.args.length > 0 ? JSON.stringify(merged.args) : null,
      merged.env && Object.keys(merged.env).length > 0 ? JSON.stringify(merged.env) : null,
      merged.type === 'remote' ? (merged.url?.trim() ?? null) : null,
      merged.headers && Object.keys(merged.headers).length > 0
        ? JSON.stringify(merged.headers)
        : null,
      tokenEnc,
      merged.enabled === false ? 0 : 1,
      Date.now(),
      id,
    );

    // A rename must not leave the old key behind in the file.
    if (merged.name !== existing.name) {
      const config = readConfig();
      delete config.mcpServers[existing.name];
      writeConfig(config);
    }
    syncConfigFile();
  })();

  return requireServer(id);
}

export function deleteServer(id: string): void {
  const existing = requireServer(id);
  const db = getDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM mcp_servers WHERE id = ?`).run(id);
    const config = readConfig();
    delete config.mcpServers[existing.name];
    writeConfig(config);
  })();
  log.info(`removed MCP server "${existing.name}"`);
}

/** Records the outcome of a connection test. Purely informational. */
export function recordTestResult(id: string, status: McpTestStatus, message: string | null): void {
  getDb()
    .prepare(
      `UPDATE mcp_servers
          SET last_test_status = ?, last_test_message = ?, last_test_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(status, message, Date.now(), Date.now(), id);
}

/**
 * Imports any entries present in `mcp_config.json` but missing from the table.
 *
 * This runs at boot so a config file the user hand-edited (or restored from a
 * backup) still shows up in the UI rather than being invisible-but-running.
 */
export function importOrphanEntries(): number {
  const config = readConfig();
  let imported = 0;
  for (const [name, entry] of Object.entries(config.mcpServers)) {
    if (findServerByName(name)) continue;
    const isRemote = typeof entry.url === 'string' && entry.url !== '';
    try {
      createServer({
        name,
        type: isRemote ? 'remote' : 'local',
        command: typeof entry.command === 'string' ? entry.command : null,
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        env: (entry.env as Record<string, string> | undefined) ?? {},
        url: isRemote ? (entry.url as string) : null,
        headers: (entry.headers as Record<string, string> | undefined) ?? {},
        enabled: entry.disabled !== true,
      });
      imported += 1;
    } catch (error) {
      log.warn(`could not import MCP entry "${name}" from mcp_config.json`, error);
    }
  }
  if (imported > 0) log.info(`imported ${imported} MCP server(s) from mcp_config.json`);
  return imported;
}
