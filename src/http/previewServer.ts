/**
 * The second HTTP server: a sandboxed browser preview of a Code task's files.
 *
 * **Why a second port and not a route.** Content served from the API's own
 * origin is same-origin with the API: a page the agent wrote could read
 * `/api/settings`, `/api/backup` and every stored provider key with a plain
 * `fetch`, and no CSP recovers that — `frame-ancestors` and `sandbox` constrain
 * *where* a document may be framed from and what it may do, not what an origin
 * may read. The separate port is the isolation. The CSP is the second layer.
 *
 * What this listener is not: it is not a dev server. It serves the files that
 * are on disk when the browser asks for them — no build step, no hot reload, no
 * websocket, no directory listing. See `frontend/contracts/gaps.md`.
 *
 * **The Host guard is the same one the API uses** (`networkGuard.ts`), against
 * the same `HYPERION_ALLOWED_HOSTS`. A proxied deployment — Tailscale, a
 * reverse proxy — must therefore list the *preview* hostname there as well as
 * the API's, and the preview port must **not** be added to
 * `HYPERION_APP_ORIGINS`: an origin allowed to make state-changing requests to
 * the API is exactly what a preview origin must never be.
 *
 * **CSP details that are easy to get wrong.**
 *
 *   - It is a **header**, not a `<meta>` tag. A header binds in a tab as well as
 *     in an iframe; the attribute only covers the framed case, and a user who
 *     opens the URL directly gets no protection at all.
 *   - `sandbox allow-scripts …` creates an **opaque origin**. Under an opaque
 *     origin a CSP source of `'self'` is not guaranteed to match the document's
 *     own URL, so the header carries `'self'` **and** the explicit origin built
 *     from the validated `Host` header. Either mechanism working is enough;
 *     `test/fixtures/preview-conformance/` is the browser-verified fixture that
 *     measures which one did. `allow-same-origin` is deliberately absent — with
 *     it, `sandbox` stops being isolation at all, and the served page becomes
 *     same-origin with every other preview on this listener.
 *   - `frame-ancestors` comes from `HYPERION_APP_ORIGINS`, so the app may frame
 *     a preview and any other page may not.
 */
import fs from 'node:fs';
import http from 'node:http';

import { env } from '../config/env.ts';
import { MAX_VIEW_BYTES, canvasServices, formatBytes } from '../services/code/canvas.ts';
import { resolveCodePath } from '../services/code/files.ts';
import { previewHost, resolvePreview } from '../services/code/preview.ts';
import { canonicalHostname, canonicalOrigin, isAllowedHost } from './networkGuard.ts';
import { AppError, toAppError } from '../util/errors.ts';
import { createLogger } from '../util/logger.ts';

import type { Server } from 'node:http';

const log = createLogger('preview');

/**
 * Types this listener will serve.
 *
 * An allow-list rather than a guess, because the alternative is handing over
 * whatever bytes are on disk under a type the browser then executes. It covers
 * a page and its assets — markup, scripts, styles, data, images, fonts, media —
 * and anything not named here is refused rather than sent as
 * `application/octet-stream`.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export interface PreviewListenerStatus {
  /** The configured feature switch (`HYPERION_PREVIEW_PORT !== 0`). */
  enabled: boolean;
  running: boolean;
  /** The host a minted URL should name — never a wildcard bind address. */
  host: string;
  port: number;
  /** Why it is not running, or null while it is. */
  reason: string | null;
  server: Server | null;
}

let bindHost = env.host;

let listener: PreviewListenerStatus = {
  enabled: env.previewPort !== 0,
  running: false,
  host: previewHost(),
  port: env.previewPort,
  reason: 'the preview listener has not been started',
  server: null,
};

let ready: Promise<PreviewListenerStatus> = Promise.resolve(listener);

export function previewListener(): PreviewListenerStatus {
  return { ...listener };
}

/**
 * Resolves once `startPreviewServer` has either bound or failed.
 *
 * Exists for callers that need the *actual* port — tests, and anything that
 * wants to log the URL. Production does not await it, because a listener that
 * cannot bind must degrade the feature rather than delay boot.
 */
export function previewReady(): Promise<PreviewListenerStatus> {
  return ready;
}

/**
 * Start the listener, replacing any previous one.
 *
 * Never throws. A port already in use, a permission the process does not have,
 * an address the machine does not own — each leaves the API running with
 * previews switched off and a reason recorded, which is what "degrade the
 * feature, not fail boot" means. `requirePreviewEnabled` is what turns that
 * state into the route's `capability_disabled`.
 */
export function startPreviewServer(
  options: { port?: number; host?: string } = {},
): PreviewListenerStatus {
  stopPreviewServer();
  bindHost = options.host ?? env.host;
  const port = options.port ?? env.previewPort;

  if (port === 0) {
    listener = {
      enabled: false,
      running: false,
      host: previewHost(),
      port: 0,
      reason: 'HYPERION_PREVIEW_PORT is 0, so previews are disabled',
      server: null,
    };
    ready = Promise.resolve(listener);
    log.info('preview listener disabled (HYPERION_PREVIEW_PORT=0)');
    return previewListener();
  }

  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      log.error('preview request failed', error);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendText(response, 500, 'The preview server could not serve that file.');
    });
  });

  listener = {
    enabled: true,
    running: false,
    host: previewHost(),
    port,
    reason: `the preview listener is starting on port ${String(port)}`,
    server,
  };

  let settle = (): void => {};
  ready = new Promise<PreviewListenerStatus>((resolve) => {
    settle = () => resolve(previewListener());
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    // EADDRINUSE is the ordinary case, and it is why this is not fatal: another
    // Hyperion, or anything else, already holds the port.
    listener = {
      enabled: true,
      running: false,
      host: previewHost(),
      port,
      reason:
        error.code === 'EADDRINUSE'
          ? `port ${String(port)} is already in use, so previews are disabled`
          : `the preview listener could not start (${error.code ?? error.message})`,
      server: null,
    };
    log.warn(`preview listener not started: ${listener.reason}`);
    server.close();
    settle();
  });

  server.on('listening', () => {
    const address = server.address();
    const actual = address !== null && typeof address === 'object' ? address.port : port;
    listener = {
      enabled: true,
      running: true,
      host: previewHost(),
      port: actual,
      reason: null,
      server,
    };
    log.info(`preview listener on http://${listener.host}:${String(actual)}/p/<token>/`);
    settle();
  });

  server.listen(port, bindHost);
  return previewListener();
}

/**
 * Stop the listener if one is running, without waiting for it.
 *
 * Deliberately synchronous and deliberately not awaited: a browser parked on a
 * preview holds a socket open for as long as the tab lives, and a shutdown path
 * that waited for `close()` to call back would hang until the 6 s force-exit —
 * or forever, if that timer were ever removed. `closeAllConnections` drops the
 * parked sockets first, then `close()` is left to finish on its own. The
 * listener holds no database handle and no child process, so nothing is lost by
 * not waiting.
 */
export function stopPreviewServer(): void {
  const current = listener.server;
  listener = {
    enabled: env.previewPort !== 0,
    running: false,
    host: previewHost(),
    port: listener.port,
    reason: 'the preview listener is not running',
    server: null,
  };
  ready = Promise.resolve(listener);
  if (current !== null) {
    current.closeAllConnections?.();
    current.close();
  }
}

/**
 * The route's gate: minting is refused while nothing is listening.
 *
 * `capability_disabled` (403) and not a new code: the request is well-formed,
 * resending it changes nothing, and only a setting changes the answer — the
 * same reasoning `util/errors.ts` gives for the code it already has. The
 * setting is named because it is the only recourse.
 */
export function requirePreviewEnabled(): PreviewListenerStatus {
  if (listener.running) return { ...listener };
  throw new AppError(
    'capability_disabled',
    `Previews are not being served: ${listener.reason ?? 'the preview listener is not running'}. ` +
      'Set HYPERION_PREVIEW_PORT to a free port, or 0 to disable previews.',
    { details: { setting: 'HYPERION_PREVIEW_PORT' } },
  );
}

// --- request handling -------------------------------------------------------

/** Headers every response carries, refusals included. */
function baseHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'cross-origin-resource-policy': 'cross-origin',
    // Correct **on this listener only**: previews exist to be looked at from
    // the app's origin, and this port carries no credential and no API. The API
    // itself emits no CORS header at all, and must not start.
    'access-control-allow-origin': '*',
  };
}

function sendText(
  response: http.ServerResponse,
  status: number,
  body: string,
  extra: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...baseHeaders(),
    'content-type': 'text/plain; charset=utf-8',
    ...extra,
  });
  response.end(body);
}

/**
 * A refusal nobody can read a filesystem layout out of.
 *
 * The seam's own messages name absolute paths (`assertStillInside` says where
 * the path resolved to, deliberately, for the API's JSON errors). This listener
 * echoes none of it: a refusal is a sentence about the request, in plain text,
 * and the detail stays in the log.
 */
function refusalFor(error: unknown): { status: number; body: string } {
  // Normalized rather than `instanceof AppError`: `security/fsScope.ts` throws
  // its own `ScopeViolationError` (deliberately free of HTTP-layer imports), and
  // a traversal refused by the scope resolver would otherwise land in the
  // generic 500 branch — telling the caller the server broke when the request
  // was the problem.
  const app = toAppError(error);
  if (app.code === 'scope_violation') {
    return { status: 403, body: 'That path is not inside this task\u2019s workspace.' };
  }
  if (app.code === 'bad_request') {
    return { status: 400, body: 'That path cannot be served.' };
  }
  if (app.code === 'not_found') {
    return { status: 404, body: 'No such file in this task\u2019s workspace.' };
  }
  return { status: 500, body: 'The preview server could not serve that file.' };
}

/** One value from a header that may have arrived repeated or comma-joined. */
function firstHeaderValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
  return raw.split(',')[0]?.trim() ?? '';
}

/**
 * The origin the browser used — the `Host` header, or, behind a proxy, the
 * public name and scheme the proxy reports.
 *
 * The port is the one in the header rather than the one this process bound:
 * they are the same on a direct connection, and when they differ it is because
 * something is proxying — in which case the browser's origin is the header's,
 * and `'self'` may not match it.
 *
 * **Why the forwarded headers are read at all.** This listener speaks plain
 * HTTP, so the scheme cannot be read off the connection, and a hardcoded
 * `http://` names an origin the browser never used the moment anything
 * terminates TLS in front of us (Tailscale Serve, nginx, a preview gateway).
 * That matters more here than in most places: the explicit origin exists to be
 * the source that matches under `sandbox` when `'self'` does not, so a wrong
 * scheme would leave the page with neither. `x-forwarded-proto` supplies the
 * scheme, and `x-forwarded-host` the public name when the proxy rewrites `Host`.
 *
 * **Why this cannot widen the policy.** The forwarded name is only used when it
 * passes the same `isAllowedHost` check the `Host` header just passed — so a
 * forwarded header can name a host this server already answers to, and never
 * one it would have refused. A nonsense scheme is ignored rather than honoured.
 * `null` only when no usable header is present; the host guard has already
 * refused anything not on the allow-list by then.
 */
function requestOrigin(request: http.IncomingMessage): string | null {
  const forwardedHost = firstHeaderValue(request.headers['x-forwarded-host']);
  const host =
    forwardedHost !== '' && isAllowedHost(forwardedHost) ? forwardedHost : request.headers.host;
  if (typeof host !== 'string' || host.trim() === '') return null;

  const forwardedProto = firstHeaderValue(request.headers['x-forwarded-proto']).toLowerCase();
  const scheme = forwardedProto === 'https' ? 'https' : 'http';
  return canonicalOrigin(`${scheme}://${host.trim()}`);
}

function contentSecurityPolicy(request: http.IncomingMessage): string {
  const explicit = requestOrigin(request);
  // `'self'` AND the explicit origin: under `sandbox` the document has an
  // opaque origin, and whether `'self'` matches there is exactly the thing the
  // conformance fixture measures. Both are sent so the failure of either one is
  // not a failure of the page.
  const sources = explicit === null ? "'self'" : `'self' ${explicit}`;
  const frameAncestors = env.appOrigins.length > 0 ? env.appOrigins.join(' ') : "'none'";

  return [
    "default-src 'none'",
    `script-src ${sources} 'unsafe-inline'`,
    `style-src ${sources} 'unsafe-inline'`,
    `img-src ${sources} data:`,
    `font-src ${sources}`,
    `media-src ${sources}`,
    `manifest-src ${sources}`,
    `connect-src ${sources}`,
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
    // No `allow-same-origin`: with it the sandbox stops isolating anything, and
    // the served page becomes same-origin with every other preview on this
    // listener. `allow-scripts` is what makes a preview a preview.
    'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads',
  ].join('; ');
}

/** `segment` percent-decoded, or null when the escape is malformed. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

interface PreviewRequest {
  token: string;
  /** Path below the token, POSIX separators; empty for the token root. */
  relative: string;
  /** True when the URL named a directory (trailing slash). */
  directory: boolean;
}

function parsePreviewPath(url: string | undefined): PreviewRequest | null {
  if (typeof url !== 'string' || url === '') return null;
  const query = url.indexOf('?');
  const hash = url.indexOf('#');
  const end = Math.min(query === -1 ? url.length : query, hash === -1 ? url.length : hash);
  const pathname = url.slice(0, end);
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments.length < 2 || segments[0] !== 'p') return null;

  const token = decodeSegment(segments[1] ?? '');
  if (token === null || token === '') return null;

  const rest: string[] = [];
  for (const segment of segments.slice(2)) {
    const decoded = decodeSegment(segment);
    if (decoded === null) return null;
    rest.push(decoded);
  }

  return { token, relative: rest.join('/'), directory: pathname.endsWith('/') };
}

function contentTypeFor(file: string): string | null {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return null;
  return CONTENT_TYPES[file.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Serve one file from the session's task workspace.
 *
 * The path goes through `files.ts` like every other reader — `resolveCodePath`
 * is the same seam the Canvas routes use, so the subtree boundary, the symlink
 * refusal and the twice-run `.git` refusal are the same code rather than a
 * second implementation that could disagree with it.
 */
async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (!isAllowedHost(request.headers.host)) {
    log.warn('refused a preview request with an unrecognized Host header', {
      host: canonicalHostname(request.headers.host) ?? '(missing or unreadable)',
    });
    sendText(
      response,
      403,
      'This preview server does not answer to that hostname. Add it to HYPERION_ALLOWED_HOSTS if it is yours.',
    );
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, 'A preview is read-only; only GET and HEAD are served.', {
      allow: 'GET, HEAD',
    });
    return;
  }

  const parsed = parsePreviewPath(request.url);
  if (parsed === null) {
    sendText(response, 404, 'No preview here. A preview URL looks like /p/<token>/.');
    return;
  }

  const session = resolvePreview(parsed.token);
  if (session === null) {
    // One answer for unknown, expired, revoked and released-task tokens: the
    // caller learns nothing about which of those it was, and there is nothing
    // useful to do differently about any of them.
    sendText(
      response,
      404,
      'This preview link is not valid. It may have expired or been revoked, or the task it belonged to may have finished.',
    );
    return;
  }

  const services = canvasServices(session.taskId);

  // A directory, or the token root, means index.html. The URL may name the
  // directory with or without its trailing slash — a browser following a
  // relative link produces both shapes — and the first probe is also what
  // catches a `.git` path or a symlink escape before any read is attempted.
  let candidate = parsed.relative;
  if (candidate === '') candidate = 'index.html';
  else if (parsed.directory) candidate = `${candidate.replace(/\/+$/, '')}/index.html`;

  let location: { absolute: string; relative: string };
  try {
    location = resolveCodePath(candidate, services);
    const stats = await fs.promises.stat(location.absolute);
    if (stats.isDirectory()) {
      candidate = `${candidate.replace(/\/+$/, '')}/index.html`;
      location = resolveCodePath(candidate, services);
    }
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      sendText(response, 404, 'No such file in this task\u2019s workspace.');
      return;
    }
    const refusal = refusalFor(error);
    if (refusal.status === 500 && !(error instanceof AppError)) log.warn('preview path refused', error);
    sendText(response, refusal.status, refusal.body);
    return;
  }

  const type = contentTypeFor(candidate);
  if (type === null) {
    sendText(
      response,
      415,
      'That file type is not served by the preview. Pages, scripts, styles, data, images and fonts are.',
    );
    return;
  }

  let bytes: Buffer;
  try {
    const stats = await fs.promises.stat(location.absolute);
    if (!stats.isFile()) {
      sendText(response, 404, 'No such file in this task\u2019s workspace.');
      return;
    }
    if (stats.size > MAX_VIEW_BYTES) {
      sendText(
        response,
        413,
        `That file is ${formatBytes(stats.size)}; the preview serves at most ${formatBytes(MAX_VIEW_BYTES)}.`,
      );
      return;
    }
    // Bounded above, so this read cannot be the 200 MB string the size check
    // exists to prevent.
    bytes = await fs.promises.readFile(location.absolute);
  } catch {
    sendText(response, 404, 'No such file in this task\u2019s workspace.');
    return;
  }

  response.writeHead(200, {
    ...baseHeaders(),
    'content-type': type,
    'content-length': String(bytes.byteLength),
    'content-security-policy': contentSecurityPolicy(request),
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(bytes);
}
