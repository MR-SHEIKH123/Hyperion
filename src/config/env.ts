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
   * Per-task git worktrees for parallel Code runs. Deliberately a sibling of
   * `projects` rather than a directory inside it: a worktree is scratch space
   * owned by a task, and nesting it under the user's code would put it in
   * every recursive scan, backup and filesystem-MCP listing of their projects.
   */
  worktrees: path.join(home, 'worktrees'),
} as const;


export const env = {
  nodeEnv: str('NODE_ENV', 'development'),
  isTest: str('NODE_ENV', 'development') === 'test',
  logLevel: str('HYPERION_LOG_LEVEL', 'info'),

  host: bind.host,
  port: int('HYPERION_PORT', 4317),
  bindIsLoopback: bind.isLoopback,

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
