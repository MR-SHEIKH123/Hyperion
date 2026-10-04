/**
 * Preview sessions — the tokens that let a browser reach a task's workspace.
 *
 * A preview is a URL a browser can open: `http://<host>:<port>/p/<token>/`. The
 * token is the whole of the authorization, because Hyperion has no
 * authentication of its own and the preview listener is a second HTTP port that
 * anybody who can reach the machine can reach. 256 bits from the one minter the
 * app has (`security/tokens.ts`), one live session per task, and a TTL, because a
 * link that is pasted into a chat window outlives the task that minted it.
 *
 * Three decisions worth stating:
 *
 *   - **One session per task.** Minting again replaces the previous token
 *     instead of accumulating links nobody can enumerate. There is no "list my
 *     previews" route, so a replaced token is not recoverable — which is the
 *     point.
 *   - **Revocation is derived, not evented.** `resolvePreview` re-checks that
 *     the task still holds a worktree. `releaseWorktree` therefore revokes every
 *     preview of the task without `worktree.ts` having to know this module
 *     exists, and it closes the real hole: `containAgentCwd` falls back to the
 *     *projects scope* for a task it no longer knows, so a token outliving its
 *     worktree would resolve paths against a wider boundary than the task ever
 *     had.
 *   - **The token is minted and compared by `security/tokens.ts`.** Not a local
 *     copy: a comparison that returns early on the first differing byte lets the
 *     token be recovered one byte at a time by whoever can measure the
 *     difference, and that module exists so the app has exactly one call site
 *     that cannot accidentally be written with `===`. A preview token and a
 *     terminal session token are the same kind of secret. The loop over
 *     sessions leaks only how many sessions exist, which the URL does not
 *     depend on.
 */
import { env } from '../../config/env.ts';
import { mintToken, tokensMatch } from '../../security/tokens.ts';
import { AppError } from '../../util/errors.ts';
import { getWorktree } from './worktree.ts';

/** How long a minted preview lives. Long enough to read a page, short enough to forget. */
export const DEFAULT_TTL_MS = 30 * 60_000;

export interface PreviewSession {
  taskId: string;
  token: string;
  createdAt: number;
  expiresAt: number;
}

export interface MintedPreview {
  taskId: string;
  token: string;
  url: string;
  expiresAt: number;
}

/** Live sessions, keyed by task. At most one per task — see `mintPreview`. */
const sessions = new Map<string, PreviewSession>();

/** Bind values that name every interface rather than one host. */
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '*', '']);

/**
 * The host a minted URL should name.
 *
 * The app's own bind spelling when that spelling is a *destination*, and
 * `127.0.0.1` otherwise. `0.0.0.0` and `::` are bind addresses: a browser sent
 * to `http://0.0.0.0:4320/` is being told to connect to all interfaces at once,
 * which on some platforms resolves and on others does not, and never to the
 * thing the user meant.
 */
export function previewHost(): string {
  const host = env.host.trim();
  if (WILDCARD_BINDS.has(host)) return '127.0.0.1';
  return host;
}

/** An IPv6 literal has to be bracketed inside a URL authority. */
function authority(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * The URL a browser opens. Trailing slash included: `/p/<token>` and
 * `/p/<token>/` are both served, but the slash is what makes relative links
 * inside the served page resolve under the token rather than above it.
 */
export function previewUrl(token: string, options: { host?: string; port?: number } = {}): string {
  const host = authority(options.host ?? previewHost());
  const port = options.port ?? env.previewPort;
  return `http://${host}:${String(port)}/p/${token}/`;
}

/**
 * Mint (or replace) the session for a task.
 *
 * Refuses a task with no registered worktree: the preview would have nothing to
 * serve, and — worse — `containAgentCwd` would silently widen to the projects
 * scope for it. `host` and `port` default to the configured values and are
 * passed by the route from the *running* listener, so the URL names the port
 * that actually answered.
 */
export function mintPreview(
  taskId: string,
  options: { host?: string; port?: number; ttlMs?: number; now?: number } = {},
): MintedPreview {
  const worktree = getWorktree(taskId);
  if (worktree === undefined) {
    throw new AppError('not_found', `No active code task with id "${taskId}".`, {
      details: { taskId },
    });
  }

  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const session: PreviewSession = {
    taskId: worktree.taskId,
    token: mintToken(),
    createdAt: now,
    expiresAt: now + ttlMs,
  };

  // Replacing is the revocation: the previous token stops resolving the moment
  // it is overwritten, so an old link cannot be resurrected by minting again.
  sessions.set(worktree.taskId, session);

  return {
    taskId: session.taskId,
    token: session.token,
    url: previewUrl(session.token, options),
    expiresAt: session.expiresAt,
  };
}

/**
 * The live preview for a task, or `null`.
 *
 * **Why a read exists at all.** Minting is a POST and *replaces* the session,
 * which is how revocation works. A status row that minted in order to display
 * would therefore revoke the URL a user already has open — on every render, or
 * on every poll. A read can be asked repeatedly and changes nothing.
 *
 * **Why it carries the URL.** The row's job is "it is running here", and the
 * origin is the thing the reader wants. A caller who can read this route can
 * already call mint and be handed the same URL, so withholding it here would
 * buy nothing and push the client into exactly the rotation this exists to
 * avoid.
 *
 * The two refusals `resolvePreview` applies to a token are applied here too,
 * and for the same reasons: an expired session is not a live one (a row must
 * not offer a link the listener will refuse), and a session whose task no
 * longer holds a worktree stops resolving (serving it would widen the boundary
 * the task had, because `containAgentCwd` falls back to the projects scope for
 * a task the registry does not know). Either way the stale entry is dropped
 * rather than left to be found again.
 */
export function livePreview(
  taskId: string,
  options: { host?: string; port?: number; now?: number } = {},
): MintedPreview | null {
  const session = sessions.get(taskId);
  if (session === undefined) return null;

  const now = options.now ?? Date.now();
  if (now >= session.expiresAt) {
    sessions.delete(taskId);
    return null;
  }
  if (getWorktree(session.taskId) === undefined) {
    sessions.delete(taskId);
    return null;
  }

  return {
    taskId: session.taskId,
    token: session.token,
    url: previewUrl(session.token, options),
    expiresAt: session.expiresAt,
  };
}

/** Drop a task's session. Returns whether there was one to drop. */
export function revokePreview(taskId: string): { revoked: boolean } {
  const worktree = getWorktree(taskId);
  const key = worktree?.taskId ?? taskId.trim();
  return { revoked: sessions.delete(key) };
}

/**
 * The session a token names, or null.
 *
 * Expiry and task-liveness are checked here rather than trusted from mint time.
 * An expired session is dropped when it is seen, and a session whose task no
 * longer holds a worktree is dropped and refused — see the module note for why
 * that second check is load-bearing rather than tidy.
 */
export function resolvePreview(token: string): PreviewSession | null {
  if (typeof token !== 'string' || token === '') return null;

  const now = Date.now();
  for (const [taskId, session] of sessions) {
    if (now >= session.expiresAt) {
      sessions.delete(taskId);
      continue;
    }
    if (!tokensMatch(session.token, token)) continue;
    if (getWorktree(session.taskId) === undefined) {
      sessions.delete(taskId);
      return null;
    }
    return session;
  }
  return null;
}

/** Test hook. Drops every session without touching the worktree registry. */
export function resetPreviews(): void {
  sessions.clear();
}
