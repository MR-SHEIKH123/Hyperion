/**
 * First-run MCP server seeding.
 *
 * Hyperion ships with a few MCP servers that are useful out of the box — a
 * filesystem server scoped to the projects root, `wigolo`, the local-first web
 * research server Cowork uses, and `graphify`, which turns a repository into a
 * traversable knowledge graph. None of them existed in the database before this
 * module: `mcp_config.json` was only ever written *from* the table, so a fresh
 * install started with an empty MCP list.
 *
 * Two rules govern seeding, both of them about not fighting the user:
 *
 *   1. **Once, not every boot.** Each default carries a marker in `settings`
 *      (`mcp_seeded.<name>`). Once the marker is set the entry is never
 *      re-created, so deleting a default you don't want makes it stay deleted.
 *      Re-creating it on the next restart would be the single most annoying
 *      thing this file could do.
 *   2. **Never clobber.** If a server with the same name already exists —
 *      hand-written into `mcp_config.json`, restored from a backup, or created
 *      through the API — it is left exactly as it is and only the marker is set.
 *
 * Seeding writes through `createServer`, so the entries land in the table *and*
 * in `mcp_config.json` with the same shape as anything the user adds by hand,
 * and they show up in the existing MCP status list with no special casing.
 *
 * Nothing here spawns a process. `npx -y <pkg>` resolves and caches the package
 * when the MCP supervisor first launches it; wigolo may additionally want a
 * one-time `init`, and graphify needs its venv created, which is why both are
 * seeded **disabled** — see below.
 */
import path from 'node:path';

import { env } from '../../config/env.ts';
import { listProjects } from '../../db/projects.ts';
import { getSetting, setSetting } from '../../db/settings.ts';
import { defaultProjectRoot, getRoot } from '../../security/fsScope.ts';

import { createLogger } from '../../util/logger.ts';
import type { McpServerInput } from './registry.ts';
import { createServer, findServerByName, updateServer } from './registry.ts';


const log = createLogger('mcp:defaults');

/** `settings` key marking a default as already handled. */
function seedKey(name: string): string {
  return `mcp_seeded.${name}`;
}

export interface DefaultServer {
  input: McpServerInput;
  /** Shown in the seed log and useful to Sol when rendering setup hints. */
  note: string;
}

/** The server's name in the registry, and the key `rescopeFilesystemServer` finds it by. */
const FILESYSTEM_NAME = 'filesystem';

/**
 * Everything before the root on the filesystem server's argv.
 *
 * Shared with `rescopeFilesystemServer`, which recognises a still-default entry
 * by matching this prefix. Written down once so seeding and rescoping cannot
 * drift into disagreeing about what "the default filesystem server" looks like.
 */
const FILESYSTEM_ARGV = ['-y', '@modelcontextprotocol/server-filesystem'] as const;

/**
 * browser-use's documented MCP launch, from its own docs:
 * `uvx --from 'browser-use[cli]' browser-use --mcp`. The `[cli]` extra is not
 * optional — without it the package starts and reports that the CLI addon is
 * missing, which reads as a broken install rather than a wrong argument list.
 */
const BROWSER_USE_ARGV = ['--from', 'browser-use[cli]', 'browser-use', '--mcp'] as const;


/**
 * The seed set.
 *
 * `filesystem` is enabled immediately: `@modelcontextprotocol/server-filesystem`
 * needs no setup beyond the roots passed on argv, and it is scoped to the
 * projects directory so it cannot reach anything outside the app's own sandbox
 * (the same root `security/fsScope.ts` enforces for our own writes).
 *
 * `wigolo`, `graphify` and `browser-use` are seeded **disabled** on purpose. wigolo is
 * documented as possibly needing a one-time `wigolo init` before it will serve,
 * and graphify's interpreter does not exist until its venv has been created —
 * nor does the graph it serves, which has to be built first. A server
 * `browser-use` needs `uv` on PATH (the entry runs `uvx`) and a model API key of
 * its own in its environment, which only the user can supply — the browser agent
 * runs its own model loop, so it is not satisfied by whatever drives Hyperion.
 * A server that fails on every start would sit permanently red in the status bar
 * and make the whole MCP panel look broken. Disabled means: visible in the list,
 * pre-filled, one click away — the user turns it on once its first-run setup is
 * done. That also matches the app-wide rule that nothing auto-enables itself.
 */
export function defaultServers(): DefaultServer[] {
  return [
    {
      note: 'Filesystem access scoped to the active project.',
      input: {
        name: FILESYSTEM_NAME,
        type: 'local',
        command: 'npx',
        args: [...FILESYSTEM_ARGV, getRoot('projects')],
        enabled: true,
      },

    },

    {
      note:
        'Local-first web research (search, fetch, crawl, extract, find-similar). ' +
        'No API keys. May require a one-time `npx -y wigolo init`; seeded disabled ' +
        'until that first-run setup is done.',
      input: {
        name: 'wigolo',
        type: 'local',
        command: 'npx',
        args: ['-y', 'wigolo'],
        enabled: false,
      },
    },
    {
      note:
        'Codebase knowledge graph — maps a repository with tree-sitter into a ' +
        'traversable graph, so navigating a large codebase is a graph query rather ' +
        'than a grep. Needs a one-time setup because it is a Python package with ' +
        'its own isolated venv, and because the graph has to be built before ' +
        'there is anything to serve; see the Recommended MCP servers section of ' +
        'docs/CONTRACTS.md. Two things to know: the PyPI distribution is ' +
        '"graphifyy" (two y\'s), and there is no console script for the server — ' +
        'it runs as a module, which is why the command here is the venv\'s own ' +
        'python. Seeded disabled until that setup has been done.',
      input: {
        name: 'graphify',
        type: 'local',
        command: graphifyPython(),
        args: ['-m', 'graphify.serve', graphifyGraph()],
        enabled: false,
      },
    },
    {
      note:
        'Headed browser automation over MCP (browser-use 1.35): the server drives a real browser — ' +
        'visiting pages, clicking, typing and downloading with the network access this machine has — ' +
        'and the model loop inside it is its own, so it needs an API key of its own in its environment ' +
        '(added by you; nothing is seeded here, and no placeholder key is written). It runs through ' +
        '`uvx`, so `uv` has to be installed first. Seeded disabled: nothing auto-enables itself, and a ' +
        'server that cannot start would sit permanently red in the status list.',
      input: {
        name: 'browser-use',
        type: 'local',
        command: 'uvx',
        args: [...BROWSER_USE_ARGV],
        enabled: false,
      },
    },
  ];
}

/** The venv this server's Python package is installed into. */
function graphifyHome(): string {
  return path.join(env.paths.mcp, 'graphify', '.venv');
}

/**
 * The venv's own interpreter, by absolute path.
 *
 * Absolute because an MCP entry has no `cwd` and the venv is deliberately never
 * on the process PATH — that isolation is the point, so the full path is how it
 * gets found. Calling the interpreter directly is also what makes `-m
 * graphify.serve` resolve *inside* the venv without activating it.
 *
 * The platform branch stays because venv layout genuinely differs: CPython puts
 * the interpreter in `Scripts/python.exe` on Windows and `bin/python` elsewhere.
 */
function graphifyPython(): string {
  return process.platform === 'win32'
    ? path.join(graphifyHome(), 'Scripts', 'python.exe')
    : path.join(graphifyHome(), 'bin', 'python');
}

/**
 * Where the built graph is expected to live.
 *
 * `serve` takes the graph as a positional argument rather than discovering it,
 * so this path is part of the command.
 *
 * The `graphify-out/` segment is not ours to choose: the build step always
 * writes `graphify-out/graph.json` **relative to the working directory it was
 * run from**, and there is no flag or environment variable to redirect it. The
 * directory being scanned is an argument, not the destination. So the documented
 * setup runs the build *from* `<mcp>/graphify/` with the repository as its
 * argument, which lands the graph exactly here — the app's files stay the app's,
 * and nothing is written into the user's repository.
 *
 * A user who would rather keep the graph next to their code can point the args
 * at their own `graphify-out/graph.json`; the entry is seeded disabled and fully
 * editable, and `serve` will take any path it is given.
 */
function graphifyGraph(): string {
  return path.join(env.paths.mcp, 'graphify', 'graphify-out', 'graph.json');
}

export interface SeedResult {

  created: string[];
  /** Present but not created by us — an existing server kept its own config. */
  skippedExisting: string[];
  /** Already seeded once before; the user's later decision is authoritative. */
  skippedSeeded: string[];
}

/**
 * Idempotent. Safe to call on every boot; after the first one it is a handful
 * of key lookups and no writes.
 */
export function seedDefaultServers(): SeedResult {
  const result: SeedResult = { created: [], skippedExisting: [], skippedSeeded: [] };

  for (const { input, note } of defaultServers()) {
    const key = seedKey(input.name);

    if (getSetting(key) !== null) {
      result.skippedSeeded.push(input.name);
      continue;
    }

    if (findServerByName(input.name)) {
      // Someone got here first. Record the marker so we never reconsider, but
      // touch nothing: their command/args/env win.
      setSetting(key, Date.now());
      result.skippedExisting.push(input.name);
      continue;
    }

    try {
      createServer(input);
      setSetting(key, Date.now());
      result.created.push(input.name);
      log.info(`seeded default MCP server "${input.name}"`, { note });
    } catch (error) {
      // A failed seed must never stop boot — the app is fully usable without
      // any MCP server. No marker is set, so it will be retried next start.
      log.warn(`could not seed default MCP server "${input.name}"`, error);
    }
  }

  return result;
}

/**
 * Re-point the default filesystem server at the active project.
 *
 * Seeding runs once, so without this the root chosen on first boot would be
 * frozen into the entry forever and the MCP server would keep serving the
 * previous project after a switch — the one scope the user cannot see is wrong.
 *
 * Only an entry that still looks exactly like the seeded one is touched: same
 * command, same package, and a single root argument that is a directory this app
 * knows about (a registered project, or the default root). Anything else means
 * the user edited it — added a second root, pointed it somewhere of their own —
 * and their configuration wins, which is the same "never clobber" rule seeding
 * follows. A `false` return is therefore a normal outcome, not a failure.
 */
export function rescopeFilesystemServer(): boolean {
  const server = findServerByName(FILESYSTEM_NAME);
  if (server === null) return false;

  const root = getRoot('projects');
  const args = server.args;

  const isDefaultShape =
    server.command === 'npx' &&
    args.length === FILESYSTEM_ARGV.length + 1 &&
    FILESYSTEM_ARGV.every((arg, index) => args[index] === arg);
  if (!isDefaultShape) return false;

  const current = args[args.length - 1];
  if (current === root) return false; // already correct

  // The existing root must be one we would have set ourselves: the default root
  // from a fresh seed, or a directory that is a registered project. A path the
  // user typed is in neither list and must not be silently replaced.
  const ours = new Set([defaultProjectRoot(), ...listProjects().map((project) => project.path)]);
  if (current === undefined || !ours.has(current)) return false;


  updateServer(server.id, { args: [...FILESYSTEM_ARGV, root] });
  log.info('re-scoped the filesystem MCP server to the active project', { root });
  return true;
}

