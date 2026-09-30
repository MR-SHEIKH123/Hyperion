/**
 * Host and Origin guards.
 *
 * Hyperion has no authentication by design, and until now the bind address was
 * the only thing standing between the API and a caller. That leaves two holes a
 * loopback bind does not close, both of which are reachable from any page the
 * user happens to have open:
 *
 *   1. **DNS rebinding.** `evil.test` resolves to `127.0.0.1`, the browser
 *      treats `http://evil.test:4317` as same-origin with the page, and the
 *      request arrives on the loopback socket like any other. The only thing
 *      that distinguishes it from a real local call is the `Host` header, which
 *      nothing was reading.
 *   2. **Simple cross-origin requests.** A cross-origin `fetch` cannot read the
 *      response without CORS headers (and there are none), but a `multipart/
 *      form-data` POST is a *simple* request: it is sent, and its side effects
 *      happen, before the browser ever considers whether the caller may see the
 *      answer. Backup import, skills upload, Cowork knowledge upload, memory
 *      import and profile import are all of that shape.
 *
 * So: the `Host` header decides whether the request may be served at all, and
 * the `Origin` header decides whether a state-changing request may be served.
 * Both run before the body parsers, so a refused upload is refused before a
 * byte of it is buffered.
 *
 * **These are not authentication.** They say "this request came from a page
 * Hyperion is willing to be called by", not "this request came from the owner".
 * Anything that is not a browser — curl, a script, a test — can set or omit
 * either header freely, and an absent `Origin` is allowed for exactly that
 * reason. The bind address is still the access control; these guards close the
 * two holes a bind cannot see.
 *
 * No CORS headers are emitted anywhere. An allowed `Origin` means the request
 * proceeds, not that the response becomes readable cross-origin.
 */

import { env } from '../config/env.ts';
import { AppError } from '../util/errors.ts';
import { createLogger } from '../util/logger.ts';

import type { RequestHandler } from 'express';

const log = createLogger('http');

/**
 * Always-allowed hostnames.
 *
 * Hostname only, deliberately without a port: the Vite dev server proxies
 * `/api` to the backend with `changeOrigin: false`, so the `Host` the backend
 * sees on a development request is the browser's — `localhost:4318`, not
 * `127.0.0.1:4317`. Matching the port here would break the dev workflow, and it
 * would buy nothing: a rebinding attack controls the name, not the port.
 *
 * `[::1]` is stored bracketed because that is how a `Host` header (and the URL
 * parser) spells an IPv6 literal.
 */
const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'] as const;

/** Bind values that name every interface rather than one host. */
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '*', '']);

/** Methods that cannot change state, and are therefore exempt from the Origin check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface GuardPolicy {
  /** Canonical hostnames the `Host` header may name. */
  readonly hostnames: ReadonlySet<string>;
  /** Canonical origins an `Origin` header may carry on a state-changing request. */
  readonly origins: ReadonlySet<string>;
}

export interface GuardConfig {
  /** `HYPERION_BIND`. */
  bind: string;
  /** `HYPERION_PORT`. */
  port: number;
  /** `HYPERION_ALLOWED_HOSTS`, already split. */
  allowedHosts: readonly string[];
  /** `HYPERION_APP_ORIGINS`, already split. */
  appOrigins: readonly string[];
}

/**
 * Reduce a `Host` header (or an allow-list entry) to a comparable hostname.
 *
 * Parsing through `URL` rather than by hand is deliberate: it strips the port,
 * lower-cases, punycodes an international name, canonicalizes an IPv6 literal
 * (`[0:0:0:0:0:0:0:1]` and `[::1]` become the same string) and rejects the
 * shapes that are not a host at all. Anything with userinfo, a path or a query
 * is refused rather than trimmed — `evil.test/127.0.0.1` is not 127.0.0.1, and
 * a guard that silently repaired it would be the bug.
 *
 * Returns `null` when the value cannot be read as a hostname; callers treat
 * that as "not allowed", never as "allow by default".
 */
export function canonicalHostname(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  let url: URL;
  try {
    url = new URL(`http://${trimmed}`);
  } catch {
    return null;
  }

  // `http://<value>` must have consumed the whole value as an authority.
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;

  let hostname = url.hostname.toLowerCase();
  // A trailing dot is the DNS root and names the same host; normalize so it
  // cannot be used to slip past an allow-list entry written without it.
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  return hostname === '' ? null : hostname;
}

/**
 * Reduce an `Origin` header (or an allow-list entry) to a canonical origin
 * string: scheme, host and explicit port, with nothing else.
 *
 * `Origin: null` is the literal a browser sends for an opaque origin — a
 * sandboxed iframe, a `data:` document, some redirect chains. It is a value, not
 * a name, and it is precisely what an attacker-controlled sandbox produces, so
 * it is refused here rather than matched against anything.
 */
export function canonicalOrigin(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'null') return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.origin === 'null') return null;
  return url.origin;
}

/**
 * The origin the API answers on for a given hostname.
 *
 * `http` only: Hyperion terminates no TLS, so an `https` origin naming the API
 * is either a proxy nobody configured or a caller guessing.
 */
function selfOrigin(hostname: string, port: number): string {
  return new URL(`http://${hostname}:${port}`).origin;
}

/**
 * Resolve the allow-lists once, from configuration.
 *
 * A malformed entry throws rather than being dropped: an allow-list that
 * silently ignores the line the user added is worse than one that refuses to
 * boot, because the failure shows up later as "Hyperion stopped working over
 * Tailscale" with nothing pointing at the typo.
 */
export function buildPolicy(config: GuardConfig): GuardPolicy {
  const hostnames = new Set<string>(LOOPBACK_HOSTNAMES);

  // A specific bind address is, by definition, a name this API answers on.
  if (!WILDCARD_BINDS.has(config.bind.trim())) {
    const bound = canonicalHostname(config.bind);
    if (bound === null) {
      throw new Error(`HYPERION_BIND is not a usable host: "${config.bind}"`);
    }
    hostnames.add(bound);
  }

  for (const entry of config.allowedHosts) {
    const hostname = canonicalHostname(entry);
    if (hostname === null) {
      throw new Error(
        `HYPERION_ALLOWED_HOSTS contains an entry that is not a hostname: "${entry}". ` +
          'Use a comma-separated list of names or IPs, e.g. "hyperion.tailnet.ts.net,100.80.1.2".',
      );
    }
    hostnames.add(hostname);
  }

  // The API's own origins: every name it can be reached under, on its own port.
  // This is what a browser pointed straight at the API would send, and it is the
  // "API's own origin" half of the Origin rule. It never widens the rule to
  // other ports — the app's port comes from HYPERION_APP_ORIGINS and nowhere else.
  const origins = new Set<string>();
  for (const hostname of hostnames) origins.add(selfOrigin(hostname, config.port));

  for (const entry of config.appOrigins) {
    const origin = canonicalOrigin(entry);
    if (origin === null) {
      throw new Error(
        `HYPERION_APP_ORIGINS contains an entry that is not an origin: "${entry}". ` +
          'Use a comma-separated list of scheme://host:port values, e.g. ' +
          '"http://127.0.0.1:4318,http://localhost:4318".',
      );
    }
    origins.add(origin);
  }

  return { hostnames, origins };
}

/**
 * The live policy, resolved once at import time from the frozen `env`.
 *
 * Same reasoning as `config/env.ts` itself: the security-relevant decision is
 * made in one place, at boot, and cannot drift per-request.
 */
export const policy: GuardPolicy = buildPolicy({
  bind: env.host,
  port: env.port,
  allowedHosts: env.allowedHosts,
  appOrigins: env.appOrigins,
});

export function isAllowedHost(header: string | undefined | null, p: GuardPolicy = policy): boolean {
  const hostname = canonicalHostname(header);
  return hostname !== null && p.hostnames.has(hostname);
}

export function isAllowedOrigin(header: string | undefined | null, p: GuardPolicy = policy): boolean {
  const origin = canonicalOrigin(header);
  return origin !== null && p.origins.has(origin);
}

/**
 * `scope_violation` (403), not a new code.
 *
 * It is the existing code for "this request asked to cross a boundary the
 * server enforces", it already maps to 403, and the frontend's error enum
 * already carries it — a new code would be a wire change in a fix that is
 * supposed to touch nothing else. The message names the env var that changes
 * the answer, because that is the only recourse.
 */
function refusal(message: string, details: Record<string, unknown>): AppError {
  return new AppError('scope_violation', message, { details, retryable: false });
}

/**
 * First middleware in the stack: every route, including the SSE ones and the
 * 404 handler, is behind it.
 */
export const hostGuard: RequestHandler = (req, _res, next) => {
  const hostname = canonicalHostname(req.headers.host);
  if (hostname !== null && policy.hostnames.has(hostname)) {
    next();
    return;
  }

  // The normalized hostname, never the raw header: the value is attacker-chosen
  // and this string is echoed to the caller and written to the log.
  const reported = hostname ?? '(missing or unreadable)';
  log.warn('refused a request with an unrecognized Host header', {
    host: reported,
    method: req.method,
    path: req.path,
  });
  next(
    refusal(
      `Hyperion does not answer to the host "${reported}". Add it to HYPERION_ALLOWED_HOSTS if it is yours.`,
      { host: reported, setting: 'HYPERION_ALLOWED_HOSTS' },
    ),
  );
};

/**
 * Runs immediately after the Host guard, still before any body parser.
 *
 * Only state-changing methods are checked. A cross-origin GET can already read
 * nothing (no CORS headers are sent), and the methods a browser can aim at this
 * API without a preflight are all in here.
 */
export const originGuard: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  const raw = req.headers.origin;
  // No Origin at all is the non-browser case — curl, a test, a script on the
  // machine. Those are not what this guard defends against, and refusing them
  // would break every local client without stopping a single browser attack:
  // a browser always sends Origin on these methods.
  if (raw === undefined) {
    next();
    return;
  }

  const origin = canonicalOrigin(raw);
  if (origin !== null && policy.origins.has(origin)) {
    next();
    return;
  }

  const reported = origin ?? (raw.trim() === 'null' ? 'null' : '(unreadable)');
  log.warn('refused a state-changing request from an unrecognized Origin', {
    origin: reported,
    method: req.method,
    path: req.path,
  });
  next(
    refusal(
      `Hyperion does not accept ${req.method} requests from the origin "${reported}". ` +
        'Add it to HYPERION_APP_ORIGINS if it is yours.',
      { origin: reported, setting: 'HYPERION_APP_ORIGINS' },
    ),
  );
};
