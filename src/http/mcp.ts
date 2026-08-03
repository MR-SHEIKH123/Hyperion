/**
 * MCP server configuration endpoints.
 *
 * This router owns persistence only: rows in the database plus the generated
 * `mcp_config.json`. Spawning and supervising the actual MCP processes belongs
 * to the process-lifecycle module, so `GET /status` simply reports whatever
 * that module tells us (and reports `managed: false` when it isn't loaded).
 *
 * Connection tests are informational. A failing test records its result and
 * returns 200 with `ok: false` — it never blocks a save, because a server can
 * legitimately be configured before the thing it talks to is running.
 */

import { Router } from 'express';

import { mcpStatus } from '../orchestrator/agents.ts';
import {
  createServer,
  deleteServer,
  importOrphanEntries,
  listServers,
  requireServer,
  syncConfigFile,
  toPublic,
  updateServer,
} from '../services/mcp/registry.ts';
import type { McpServerInput, McpServerType } from '../services/mcp/registry.ts';
import { testServer } from '../services/mcp/test.ts';
import { AppError } from '../util/errors.ts';
import { wrap } from './errors.ts';
import {
  asBool,
  asEnum,
  asNullableString,
  asOptionalString,
  asString,
  asStringArray,
  asStringRecord,
  body,
  pathParam,
} from './params.ts';

export const mcpRouter: Router = Router();

const SERVER_TYPES = ['local', 'remote'] as const;

/**
 * Builds the create payload. `type` decides which transport fields matter, so
 * we validate the pairing here rather than letting a half-configured row land
 * in the config file and fail mysteriously at spawn time.
 */
function readCreateInput(payload: Record<string, unknown>): McpServerInput {
  const type = asEnum<McpServerType>(payload.type, 'type', SERVER_TYPES) ?? 'local';
  const input: McpServerInput = {
    name: asString(payload.name, 'name'),
    type,
    command: asOptionalString(payload.command, 'command'),
    args: asStringArray(payload.args, 'args'),
    env: asStringRecord(payload.env, 'env'),
    url: asOptionalString(payload.url, 'url'),
    headers: asStringRecord(payload.headers, 'headers'),
    token: asNullableString(payload.token, 'token'),
    enabled: asBool(payload.enabled, 'enabled'),
  };

  if (type === 'local' && !input.command) {
    throw new AppError('bad_request', 'A local MCP server needs a command to run.');
  }
  if (type === 'remote' && !input.url) {
    throw new AppError('bad_request', 'A remote MCP server needs a url.');
  }
  return input;
}

/**
 * Partial update. Every field is optional and `undefined` means "leave this
 * column alone", so a PATCH that only renames a server keeps its token.
 *
 * `token` is the one tri-state field, and it needs `asNullableString`:
 * `asOptionalString` folds `null` into `undefined`, which made an explicit
 * `{"token": null}` read as "not provided" and left the stored token in place.
 * Since the token is never sent to the browser, the client cannot clear it by
 * sending back an empty value either — `null` was the only way to ask, and it
 * silently did nothing. `updateServer` already understands the tri-state.
 */
function readUpdateInput(payload: Record<string, unknown>): Partial<McpServerInput> {
  return {
    name: asOptionalString(payload.name, 'name'),
    type: asEnum<McpServerType>(payload.type, 'type', SERVER_TYPES),
    command: asOptionalString(payload.command, 'command'),
    args: asStringArray(payload.args, 'args'),
    env: asStringRecord(payload.env, 'env'),
    url: asOptionalString(payload.url, 'url'),
    headers: asStringRecord(payload.headers, 'headers'),
    token: asNullableString(payload.token, 'token'),
    enabled: asBool(payload.enabled, 'enabled'),
  };
}

// --- status ----------------------------------------------------------------

/**
 * Live status of the running servers. Declared before `/servers/:id` purely for
 * readability; the paths don't actually collide.
 */
mcpRouter.get(
  '/status',
  wrap(async (_req, res) => {
    res.json(mcpStatus());
  }),
);

/** Regenerates `mcp_config.json` from the database rows. */
mcpRouter.post(
  '/sync',
  wrap(async (_req, res) => {
    syncConfigFile();
    res.json({ synced: true, servers: listServers().map(toPublic) });
  }),
);

/**
 * Adopts entries that exist in `mcp_config.json` but not in the database —
 * useful when the file was hand-edited.
 */
mcpRouter.post(
  '/import-orphans',
  wrap(async (_req, res) => {
    const imported = importOrphanEntries();
    res.json({ imported, servers: listServers().map(toPublic) });
  }),
);

// --- CRUD ------------------------------------------------------------------

mcpRouter.get(
  '/servers',
  wrap(async (_req, res) => {
    res.json({ servers: listServers().map(toPublic) });
  }),
);

mcpRouter.post(
  '/servers',
  wrap(async (req, res) => {
    const server = createServer(readCreateInput(body(req)));
    res.status(201).json({ server: toPublic(server) });
  }),
);

mcpRouter.get(
  '/servers/:id',
  wrap(async (req, res) => {
    res.json({ server: toPublic(requireServer(pathParam(req, 'id'))) });
  }),
);

// PUT and PATCH share a handler: both are partial updates here, because the
// token is write-only and a true replace would have no way to preserve it.
const updateHandler = wrap(async (req, res) => {
  const id = pathParam(req, 'id');
  requireServer(id);
  const server = updateServer(id, readUpdateInput(body(req)));
  res.json({ server: toPublic(server) });
});

mcpRouter.put('/servers/:id', updateHandler);
mcpRouter.patch('/servers/:id', updateHandler);

mcpRouter.delete(
  '/servers/:id',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    requireServer(id);
    deleteServer(id);
    res.json({ deleted: true, id });
  }),
);

// --- connection test -------------------------------------------------------

/**
 * Non-blocking connection test. Always 200: the result lives in the body so the
 * UI can show a red dot next to a server that is saved but not reachable.
 */
mcpRouter.post(
  '/servers/:id/test',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    const server = requireServer(id);
    // `testServer` records the outcome itself — that is part of its contract and
    // it never throws. Recording it again here bumped `updated_at` a second time
    // and duplicated the ok/failed mapping, giving two places to keep in step.
    const result = await testServer(server);
    res.json({
      ok: result.ok,
      message: result.message,
      static: result.static,
      durationMs: result.durationMs,
      server: toPublic(requireServer(id)),
    });
  }),
);
