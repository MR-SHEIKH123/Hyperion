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
  const host = str('AISTUDIO_BIND', '127.0.0.1');
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const isWildcard = host === '0.0.0.0' || host === '::' || host === '*';

  if (isWildcard && !bool('AISTUDIO_ALLOW_ANY_BIND', false)) {
    throw new Error(
      [
        `Refusing to bind to "${host}".`,
        '',
        'AIStudio has no authentication by design, so binding to all interfaces',
        'would let anyone on your network read every stored provider API key.',
        '',
        'For remote access, install Tailscale and set AISTUDIO_BIND to this',
        "machine's Tailscale address (e.g. 100.x.y.z) — that is reachable only",
        'from your own private mesh.',
        '',
        'If you genuinely intend to listen on all interfaces, set',
        'AISTUDIO_ALLOW_ANY_BIND=1.',
      ].join('\n'),
    );
  }

  return { host, isLoopback };
}

const bind = resolveBind();

const home = path.resolve(str('AISTUDIO_HOME', path.join(os.homedir(), 'AIStudio')));

/** Every filesystem location the app is allowed to touch. */
const paths = {
  home,
  db: path.join(home, 'aistudio.db'),
  secretKey: path.join(home, 'secret.key'),
  mcpConfig: path.join(home, 'mcp_config.json'),
  /** Scoped roots — see security/fsScope.ts. Nothing outside these is writable. */
  attachments: path.join(home, 'attachments'),
  projects: path.join(home, 'projects'),
  skills: path.join(home, 'skills'),
  backups: path.join(home, 'backups'),
  tmp: path.join(home, 'tmp'),
} as const;

export const env = {
  nodeEnv: str('NODE_ENV', 'development'),
  isTest: str('NODE_ENV', 'development') === 'test',
  logLevel: str('AISTUDIO_LOG_LEVEL', 'info'),

  host: bind.host,
  port: int('AISTUDIO_PORT', 4317),
  bindIsLoopback: bind.isLoopback,

  paths,

  ollamaUrl: str('OLLAMA_URL', 'http://localhost:11434').replace(/\/+$/, ''),

  /**
   * Runtime auto-failover. A provider that fails this many times in a row
   * inside the window is marked unhealthy and taken out of rotation.
   * Distinct from one-shot local-provider detection (3 attempts).
   */
  healthFailureThreshold: int('AISTUDIO_HEALTH_FAILURE_THRESHOLD', 2),
  healthWindowMs: int('AISTUDIO_HEALTH_WINDOW_MS', 20_000),

  /** One-shot local runner detection retries (flaky responses only). */
  localDetectAttempts: int('AISTUDIO_LOCAL_DETECT_ATTEMPTS', 3),
  localDetectTimeoutMs: int('AISTUDIO_LOCAL_DETECT_TIMEOUT_MS', 2_500),

  modelCacheTtlMs: int('AISTUDIO_MODEL_CACHE_TTL_MS', 300_000),
  requestTimeoutMs: int('AISTUDIO_REQUEST_TIMEOUT_MS', 120_000),

  assetTtlDays: int('AISTUDIO_ASSET_TTL_DAYS', 90),
  chatTtlDays: int('AISTUDIO_CHAT_TTL_DAYS', 30),
  cleanupDisabled: bool('AISTUDIO_CLEANUP_DISABLED', false),

  maxUploadBytes: int('AISTUDIO_MAX_UPLOAD_BYTES', 100 * 1024 * 1024),
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
