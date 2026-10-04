/**
 * Resolved runtime configuration.
 *
 * Everything the app needs to know about *where things live* and *how the
 * network is exposed* is computed exactly once, here, at import time. No other
 * module reads process.env directly — that keeps the security-critical bind
 * decision in a single auditable place.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

/**
 * A comma-separated list. Empty entries are dropped rather than kept as ''.
 *
 * Used by the Host and Origin allow-lists, where an empty string would be a
 * value that matches nothing and reads like an oversight.
 */
function list(name: string, fallback: string): string[] {
  return str(name, fallback)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Decide the bind address, refusing the dangerous default-by-accident case.
 *
 * There is deliberately no authentication in this app, so the bind address is
 * the *only* access control that exists. Binding to 0.0.0.0 would expose every
 * stored provider API key to anyone on the same network, so it requires an
 * explicit opt-in env var. Tailscale users should bind to their specific
 * 100.x.y.z interface address instead — that is private to their own mesh.
 */
function resolveBind(): { host: string; isLoopback: boolean } {
  const host = str('HYPERION_BIND', '127.0.0.1');
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const isWildcard = host === '0.0.0.0' || host === '::' || host === '*';

  if (isWildcard && !bool('HYPERION_ALLOW_ANY_BIND', false)) {
    throw new Error(
      [
        `Refusing to bind to "${host}".`,
        '',
        'Hyperion has no authentication by design, so binding to all interfaces',
        'would let anyone on your network read every stored provider API key.',
        '',
        'For remote access, install Tailscale and set HYPERION_BIND to this',
        "machine's Tailscale address (e.g. 100.x.y.z) — that is reachable only",
        'from your own private mesh.',
        '',
        'If you genuinely intend to listen on all interfaces, set',
        'HYPERION_ALLOW_ANY_BIND=1.',
      ].join('\n'),
    );
  }

  return { host, isLoopback };
}

const bind = resolveBind();

const home = path.resolve(str('HYPERION_HOME', path.join(os.homedir(), 'Hyperion')));

/** Every filesystem location the app is allowed to touch. */
const paths = {
  home,
  db: path.join(home, 'hyperion.db'),
  secretKey: path.join(home, 'secret.key'),
  mcpConfig: path.join(home, 'mcp_config.json'),
  /** Scoped roots — see security/fsScope.ts. Nothing outside these is writable. */
  attachments: path.join(home, 'attachments'),
  projects: path.join(home, 'projects'),
  skills: path.join(home, 'skills'),
  backups: path.join(home, 'backups'),
  tmp: path.join(home, 'tmp'),
  /**
   * Runtimes for MCP servers that need their own isolated environment (e.g. a
   * Python venv). Same reasoning as the per-skill venvs: an MCP server's
   * dependencies must never land in the app's own environment or in the user's
   * system Python. One subdirectory per server, named after the server.
   */
  mcp: path.join(home, 'mcp'),
  /** mem0's self-hosted store (vector index + history db). Never leaves disk. */
  memory: path.join(home, 'memory'),
  /**
   * Cowork's standing reference library. A sibling of `attachments` rather than
   * a directory inside it, because the two have opposite lifetimes: everything
   * under `attachments` is subject to the 3-month sweep, and everything here is
   * exempt by definition. Separate roots mean a future change to that sweep
   * cannot reach these files by accident.
   */
  knowledge: path.join(home, 'knowledge'),
  /**
   * Per-task git worktrees for parallel Code runs. Deliberately a sibling of
   * `projects` rather than a directory inside it: a worktree is scratch space
   * owned by a task, and nesting it under the user's code would put it in
   * every recursive scan, backup and filesystem-MCP listing of their projects.
   */
  worktrees: path.join(home, 'worktrees'),
} as const;

/**
 * The app's own installation: the checkout the code runs from. Computed from
 * this file's location, never from the working directory — the process may be
 * launched from anywhere, but the code always knows where it lives.
 *
 * Deliberately *not* in `paths`: those are data locations the app may write,
 * and the installation is not writable. Consumers: the first-party MCP server
 * seed (its script path) and the MCP config check, which exempts the app's own
 * code from data-root containment — pointing a server at its own implementation
 * grants it no access.
 */
const appRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export const env = {
  nodeEnv: str('NODE_ENV', 'development'),
  isTest: str('NODE_ENV', 'development') === 'test',
  logLevel: str('HYPERION_LOG_LEVEL', 'info'),
  /** The checkout root — code, not data (see above). */
  appRoot,

  host: bind.host,
  port: int('HYPERION_PORT', 4317),
  bindIsLoopback: bind.isLoopback,

  /**
   * Extra hostnames the API will answer to, beyond loopback and the bind
   * address — a Tailscale MagicDNS name or a 100.x.y.z address.
   *
   * This is the Host guard's allow-list (`src/http/networkGuard.ts`). A
   * loopback bind does not stop a page on an attacker's domain that resolves
   * to 127.0.0.1 from reaching this API, and the `Host` header is the only
   * thing that tells the two apart. Ports are ignored: the dev proxy forwards
   * the browser's `Host`, which carries the frontend's port, not the API's.
   */
  allowedHosts: list('HYPERION_ALLOWED_HOSTS', ''),

  /**
   * Origins allowed to make state-changing (POST/PUT/PATCH/DELETE) requests.
   *
   * The default is the Vite dev server on both loopback spellings. The API's
   * own origins are always allowed and are not listed here. Ports are explicit
   * on purpose — "any loopback port" would let anything else the user happens
   * to be running locally drive this API from a page.
   */
  appOrigins: list('HYPERION_APP_ORIGINS', 'http://127.0.0.1:4318,http://localhost:4318'),

  paths,

  ollamaUrl: str('OLLAMA_URL', 'http://localhost:11434').replace(/\/+$/, ''),

  /**
   * Runtime auto-failover. A provider that fails this many times in a row
   * inside the window is marked unhealthy and taken out of rotation.
   * Distinct from one-shot local-provider detection (3 attempts).
   */
  healthFailureThreshold: int('HYPERION_HEALTH_FAILURE_THRESHOLD', 2),
  healthWindowMs: int('HYPERION_HEALTH_WINDOW_MS', 20_000),

  /** One-shot local runner detection retries (flaky responses only). */
  localDetectAttempts: int('HYPERION_LOCAL_DETECT_ATTEMPTS', 3),
  localDetectTimeoutMs: int('HYPERION_LOCAL_DETECT_TIMEOUT_MS', 2_500),

  modelCacheTtlMs: int('HYPERION_MODEL_CACHE_TTL_MS', 300_000),
  requestTimeoutMs: int('HYPERION_REQUEST_TIMEOUT_MS', 120_000),

  assetTtlDays: int('HYPERION_ASSET_TTL_DAYS', 90),
  /**
   * Idle chats are swept after four months. Deliberately generous: a chat you
   * have not opened since last quarter is still often the one you want back,
   * and pinning/archiving are the explicit "keep forever" signals rather than
   * a short timer being the safety net.
   *
   * ACCEPTED DEVIATION FROM SPEC — do not "correct" this to 30.
   * docs/SPEC.md describes chat retention as "1 month". 120 days is the
   * owner's deliberate override, and the asymmetry is the reason: this sweep
   * is unattended and its deletions are irreversible, so keeping a dead chat
   * too long costs disk, while sweeping a live one too early costs work that
   * cannot be recovered. The threshold is tuned toward the survivable
   * mistake. docs/SPEC.md records the same decision.
   */
  chatTtlDays: int('HYPERION_CHAT_TTL_DAYS', 120),

  cleanupDisabled: bool('HYPERION_CLEANUP_DISABLED', false),

  // --- background jobs ------------------------------------------------------

  /**
   * Disables the automatic daily backup and the scheduled-task runner. Same
   * escape hatch as HYPERION_CLEANUP_DISABLED, and the switch the test helper
   * reaches for: a suite that boots the app must not start firing real Cowork
   * runs against the user's providers.
   */
  schedulerDisabled: bool('HYPERION_SCHEDULER_DISABLED', false),

  /**
   * Disables the MCP supervisor: no manager is registered and no server is
   * spawned. `GET /api/mcp/status` then keeps reporting `managed: false`,
   * which is the honest answer rather than a lie about a supervisor that
   * was never started.
   *
   * The test helper sets this. A suite that boots the app would otherwise
   * spawn the default filesystem server through `npx -y`, reaching the
   * network from a unit test and leaving child processes behind.
   */
  mcpDisabled: bool('HYPERION_MCP_DISABLED', false),

  /**
   * How many automatic backups to keep. Unbounded retention turns a safety
   * feature into the thing that fills the disk, and an automatic backup is only
   * worth keeping until the next few have proved themselves.
   */
  autoBackupKeep: int('HYPERION_AUTO_BACKUP_KEEP', 7),

  /**
   * An extra directory each automatic backup is copied into — typically a
   * Drive/Dropbox/OneDrive sync folder, so the archive leaves the machine
   * without Hyperion needing to know anything about cloud storage.
   *
   * Deliberately env-only, with no setting and no HTTP write path. This is the
   * one path in the app that is legitimately *outside* every fsScope root, and
   * a caller-supplied value would turn "back up my data" into an arbitrary
   * file-write primitive. An env var is set by the person who owns the machine,
   * which is a different trust level from a request body.
   *
   * The canonical archive still lands in the backups root: listing, inspection,
   * import and retention all resolve through that scope, and redirecting the
   * primary write would quietly break all four. This is a copy, not a move.
   */
  backupDest: str('HYPERION_BACKUP_DEST', ''),


  /**
   * How long a due scheduled task waits for the app-wide lock before recording
   * itself `skipped`.
   *
   * Fifteen minutes because the collision this exists for is a user mid-chat,
   * which resolves in minutes; a task still blocked after that is competing
   * with something long-running, and silently starting it an hour late is worse
   * than telling the user it did not run.
   */
  scheduledTaskWaitMs: int('HYPERION_SCHEDULED_TASK_WAIT_MS', 15 * 60_000),

  maxUploadBytes: int('HYPERION_MAX_UPLOAD_BYTES', 100 * 1024 * 1024),

  /**
   * Longest edge, in pixels, a stored image may keep. Anything larger is
   * downscaled once, on the way to disk.
   *
   * 1568 is roughly where vision models stop gaining anything from extra
   * resolution — beyond it an image costs upload time, disk and tokens and buys
   * nothing. Images already under the cap are stored byte-for-byte rather than
   * upscaled or needlessly re-encoded.
   *
   * A value <= 0 disables image processing entirely.
   */
  imageMaxEdge: int('HYPERION_IMAGE_MAX_EDGE', 1568),

  // --- skill dependency provisioning ---------------------------------------
  // Installing what a skill declares is what makes it runnable rather than
  // merely "looks fine on intake". Every knob here exists because the install
  // touches the network and the filesystem, and both can hang.

  /** Set to true to skip provisioning entirely (offline, or CI). */
  skillDepsDisabled: bool('HYPERION_SKILL_DEPS_DISABLED', false),
  /** Cap on one install command. Long enough for a real wheel build, short
   *  enough that a wedged installer fails the skill instead of the request. */
  skillDepsTimeoutMs: int('HYPERION_SKILL_DEPS_TIMEOUT_MS', 10 * 60 * 1000),
  /** Interpreter used to build a skill's venv. Overridable because "python" is
   *  not always on PATH and is not always Python 3. */
  skillDepsPython: str('HYPERION_SKILL_DEPS_PYTHON', ''),
  /** npm executable, same reasoning. */
  skillDepsNpm: str('HYPERION_SKILL_DEPS_NPM', ''),

  // --- Code task parallelism -----------------------------------------------

  /**
   * How many Code tasks may run at once.
   *
   * Code is the one tool where serialising everything is a real cost: a task is
   * minutes of agentic editing, not seconds of chat. Two is the default because
   * each parallel task needs its own worktree and its own share of the model's
   * rate limit, and beyond two the failure mode stops being "slow" and starts
   * being "several half-finished edits competing for review".
   *
   * This lane is separate from the app-wide single-job lock, which still
   * governs Chat, Cowork and Design.
   */
  codeLaneLimit: int('HYPERION_CODE_LANE_LIMIT', 2),
  /**
   * Set true to keep worktrees on disk after a task ends. Off by default; the
   * escape hatch exists for debugging a task that produced a wrong diff.
   */
  codeKeepWorktrees: bool('HYPERION_CODE_KEEP_WORKTREES', false),

  /**
   * Port for the sandboxed preview listener — a **second** HTTP server, not a
   * route on the API.
   *
   * The separate port *is* the isolation. Content served from the API's own
   * origin is same-origin with the API, so a page an agent wrote could read
   * `/api/settings` and every stored provider key with a plain `fetch`; no CSP
   * recovers that, because CSP constrains what a document may do, not what its
   * origin may read. See `src/http/previewServer.ts`.
   *
   * `0` disables the feature entirely — the listener is not started and
   * `POST /api/code/tasks/:taskId/preview` answers `capability_disabled`. A
   * port that is already in use at boot degrades the same way rather than
   * failing the boot: previews are a convenience, the API is not.
   */
  previewPort: int('HYPERION_PREVIEW_PORT', 4320),

  /**
   * mem0 runs fully self-hosted, which means it needs its own small LLM and an
   * embedding model to extract and index facts. Defaults point at Ollama so a
   * stock local install works with no keys and nothing leaves the machine.
   * These are deliberately separate from the chat provider: memory extraction
   * is a background chore and should not burn the good model's quota.
   */
  memoryProvider: str('HYPERION_MEMORY_PROVIDER', 'ollama'),
  memoryLlmModel: str('HYPERION_MEMORY_LLM_MODEL', 'llama3.1:8b'),
  memoryEmbedModel: str('HYPERION_MEMORY_EMBED_MODEL', 'nomic-embed-text'),
  memoryEmbedDims: int('HYPERION_MEMORY_EMBED_DIMS', 768),
  /** How many retrieved facts may be injected into a turn. A set, not a dump. */
  memoryRetrieveLimit: int('HYPERION_MEMORY_RETRIEVE_LIMIT', 5),
} as const;

/** Create the data directories. Called once during bootstrap. */
export function ensureDirectories(): void {
  for (const dir of [
    paths.home,
    paths.attachments,
    paths.projects,
    paths.skills,
    paths.backups,
    paths.tmp,
    paths.memory,
    paths.mcp,
    paths.worktrees,
    paths.knowledge,
  ]) {

    fs.mkdirSync(dir, { recursive: true });
  }

  // The data root can contain decryptable-with-secret.key material and every
  // uploaded file; keep it owner-only where the OS honours it.
  try {
    fs.chmodSync(paths.home, 0o700);
  } catch {
    /* best effort — chmod is largely a no-op on Windows */
  }
}

// --- one-time legacy home migration ----------------------------------------

/** The data directory used before the AIStudio -> Hyperion rename. */
const LEGACY_HOME = path.join(os.homedir(), 'AIStudio');

/**
 * Pre-rename database filenames. The -shm/-wal siblings must travel with the
 * main file: the WAL holds committed transactions not yet checkpointed into it,
 * so moving the .db alone can silently discard the most recent writes.
 */
const LEGACY_DB_FILES = ['aistudio.db', 'aistudio.db-shm', 'aistudio.db-wal'] as const;

export interface LegacyHomeMigration {
  migrated: boolean;
  /** Both directories exist, so the choice between them needs a human. */
  conflict: boolean;
  from: string;
  to: string;
  /** Why nothing moved, when `migrated` is false. */
  reason?: string;
  /** `old -> new` for each database file renamed inside the moved directory. */
  renamed: string[];
}

/**
 * Move a pre-rename `~/AIStudio` data directory to the current home, once.
 *
 * Without this, upgrading past the rename points the app at a home that does
 * not exist yet, so it creates an empty one and boots with no chats, providers
 * or settings. The old data is still on disk, which makes that a silent and
 * very alarming loss rather than a real one.
 *
 * Refuses when both directories exist. At that point there is data in both and
 * only the owner knows which matters; merging could bury a live database under
 * a stale one, so the safe move is to do nothing and report it.
 *
 * MUST run before ensureDirectories(), which creates the target and would make
 * the "current home does not exist yet" precondition false forever.
 */
export function migrateLegacyHome(
  legacy: string = LEGACY_HOME,
  target: string = paths.home,
): LegacyHomeMigration {
  const base: LegacyHomeMigration = {
    migrated: false,
    conflict: false,
    from: legacy,
    to: target,
    renamed: [],
  };

  if (path.resolve(legacy) === path.resolve(target)) {
    return { ...base, reason: 'legacy and current home are the same directory' };
  }
  if (!fs.existsSync(legacy)) {
    return { ...base, reason: 'no legacy data directory' };
  }
  if (fs.existsSync(target)) {
    return {
      ...base,
      conflict: true,
      reason:
        `both ${legacy} and ${target} exist, so they were left alone. ` +
        `Move anything still needed out of ${legacy} by hand, then delete it.`,
    };
  }

  // A custom HYPERION_HOME can sit anywhere, including under a parent that does
  // not exist yet; rename would fail with ENOENT on that parent.
  fs.mkdirSync(path.dirname(target), { recursive: true });

  try {
    fs.renameSync(legacy, target);
  } catch (error) {
    // rename cannot cross filesystems (separate drive, mounted home), and that
    // is a normal setup rather than a failure — fall back to copy-then-remove.
    if ((error as { code?: string }).code !== 'EXDEV') throw error;
    fs.cpSync(legacy, target, { recursive: true });
    fs.rmSync(legacy, { recursive: true, force: true });
  }

  // The database file was renamed along with the app, so the directory we just
  // moved still contains aistudio.db.
  const renamed: string[] = [];
  for (const legacyName of LEGACY_DB_FILES) {
    const from = path.join(target, legacyName);
    if (!fs.existsSync(from)) continue;
    const name = legacyName.replace('aistudio.db', 'hyperion.db');
    fs.renameSync(from, path.join(target, name));
    renamed.push(`${legacyName} -> ${name}`);
  }

  return { ...base, migrated: true, renamed };
}
