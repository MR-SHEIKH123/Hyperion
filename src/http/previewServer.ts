/**
 * Browser preview listener.
 *
 * This is intentionally a second HTTP server. Serving task-controlled HTML on
 * the API listener would make it same-origin with an unauthenticated local API;
 * no page CSP can put those origins back apart after the response is served.
 *
 * A reverse proxy must put its preview hostname in HYPERION_ALLOWED_HOSTS. The
 * preview port itself deliberately does not become an allowed app Origin.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { env } from '../config/env.ts';
import { canonicalOrigin, isAllowedHost } from './networkGuard.ts';
import { resolveCodePath } from '../services/code/files.ts';
import { canvasServices } from '../services/code/canvas.ts';
import {
  resolvePreview,
  setPreviewOrigin,
} from '../services/code/preview.ts';
import { AppError, toAppError } from '../util/errors.ts';
import { createLogger } from '../util/logger.ts';

import type { Express, NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';

const log = createLogger('preview');

const CONTENT_TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.wasm', 'application/wasm'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

export function createPreviewApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.enable('strict routing');
  app.set('etag', false);
  app.set('trust proxy', false);

  // Every response, including a malformed token or unknown route, gets the
  // transport protections. CORS is intentional *only* on this isolated,
  // read-only listener so an opaque sandbox origin can fetch its own assets.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  });

  // Same policy and canonical Host parser as the API guard. The response is
  // plain text here because preview refusals must not expose internal details.
  app.use((req, res, next) => {
    if (!isAllowedHost(req.headers.host)) {
      plain(res, 403, 'Preview host is not allowed.');
      return;
    }

    const ownOrigin = originFromHost(req.headers.host);
    if (ownOrigin === null) {
      plain(res, 403, 'Preview host is not allowed.');
      return;
    }
    res.setHeader('Content-Security-Policy', contentSecurityPolicy(ownOrigin));
    next();
  });

  // The root and asset routes are separate so the asset wildcard always names
  // at least one segment. Express/browser URL normalisation turns a plain
  // `/p/<token>/../x` into a path outside this token route (404). The filesystem
  // seam below remains the authority for symlink and `.git` cases; URL routing
  // is not treated as a substitute for it.
  app.get('/p/:token/', servePreview);
  app.get('/p/:token/*assetPath', servePreview);

  app.use((_req, res) => {
    plain(res, 404, 'Preview resource was not found.');
  });

  // Keep this listener's errors out of the API JSON/error-log plumbing: no
  // absolute path or syscall message crosses this boundary.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) {
      plain(res, 404, 'Preview resource was not found.');
      return;
    }
    const appError = toAppError(error);
    if (appError.code === 'not_found') {
      plain(res, 404, 'Preview resource was not found.');
    } else if (appError.code === 'scope_violation') {
      plain(res, 403, 'Preview resource is outside the task workspace.');
    } else if (appError.code === 'bad_request') {
      plain(res, 400, 'Preview resource is not available.');
    } else {
      log.warn('preview request failed', { code: appError.code });
      plain(res, 500, 'Preview resource could not be served.');
    }
  });

  return app;
}

export function createPreviewServer(): Server {
  return http.createServer(createPreviewApp());
}

/** Start the configured listener, degrading rather than failing application boot. */
export function startPreviewServer(): Server | null {
  if (env.previewPort === 0) {
    setPreviewOrigin(null);
    log.info('browser preview disabled (HYPERION_PREVIEW_PORT=0)');
    return null;
  }

  const server = createPreviewServer();
  server.on('listening', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') return;
    const origin = `http://${urlHost(destinationHost(env.host))}:${address.port}`;
    setPreviewOrigin(origin);
    log.info(`preview listening on ${origin}`);
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    setPreviewOrigin(null);
    if (error.code === 'EADDRINUSE') {
      log.warn(
        `browser preview disabled because port ${env.previewPort} is already in use`,
        { setting: 'HYPERION_PREVIEW_PORT' },
      );
      return;
    }
    // Preview is optional. A bind failure must not take down the API or expose a
    // half-working capability.
    log.warn('browser preview listener failed; preview is disabled', {
      code: error.code ?? 'unknown',
      setting: 'HYPERION_PREVIEW_PORT',
    });
  });
  server.on('close', () => setPreviewOrigin(null));
  server.listen(env.previewPort, env.host);
  return server;
}

async function servePreview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = stringParam(req, 'token');
    const session = resolvePreview(token);
    if (session === undefined) {
      plain(res, 403, 'Preview token is invalid, expired, or revoked.');
      return;
    }

    const asset = wildcardParam(req, 'assetPath');
    let candidate = asset === '' ? 'index.html' : asset;
    const services = canvasServices(session.taskId);
    let location = resolveCodePath(candidate, services);
    let stat = await fs.promises.lstat(location.absolute);

    if (stat.isDirectory()) {
      candidate = candidate.replace(/\/+$/, '');
      candidate = candidate === '' ? 'index.html' : `${candidate}/index.html`;
      location = resolveCodePath(candidate, services);
      stat = await fs.promises.lstat(location.absolute);
    }
    if (stat.isSymbolicLink()) {
      throw new AppError('scope_violation', 'Preview does not follow symbolic links.');
    }
    if (!stat.isFile()) {
      throw new AppError('not_found', 'Preview resource was not found.');
    }

    const contentType = CONTENT_TYPES.get(path.extname(location.relative).toLowerCase());
    if (contentType === undefined) {
      plain(res, 415, 'Preview resource type is not allowed.');
      return;
    }

    const body = await fs.promises.readFile(location.absolute);
    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', body.byteLength);
    res.end(body);
  } catch (error) {
    next(error);
  }
}

function contentSecurityPolicy(ownOrigin: string): string {
  const frameAncestors = env.appOrigins
    .map((entry) => canonicalOrigin(entry))
    .filter((entry): entry is string => entry !== null);
  const ancestors = frameAncestors.length === 0 ? "'none'" : frameAncestors.join(' ');
  // A sandbox without allow-same-origin gives the document an opaque origin.
  // Both 'self' and the explicit, validated preview origin ship so external
  // scripts, modules, images and fetch work whichever interpretation a browser
  // applies to 'self' for that opaque document.
  return [
    "default-src 'none'",
    `script-src 'self' ${ownOrigin}`,
    `connect-src 'self' ${ownOrigin}`,
    `img-src 'self' ${ownOrigin} data:`,
    `style-src 'self' ${ownOrigin} 'unsafe-inline'`,
    `font-src 'self' ${ownOrigin}`,
    `media-src 'self' ${ownOrigin}`,
    `frame-ancestors ${ancestors}`,
    'sandbox allow-scripts',
  ].join('; ');
}

function originFromHost(host: string | undefined): string | null {
  if (!isAllowedHost(host) || host === undefined) return null;
  try {
    const origin = new URL(`http://${host.trim()}`).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

function destinationHost(bind: string): string {
  const value = bind.trim();
  return value === '0.0.0.0' || value === '::' || value === '*' || value === ''
    ? '127.0.0.1'
    : value;
}

function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function stringParam(req: Request, name: string): string {
  const value: unknown = (req.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || value === '') {
    throw new AppError('bad_request', 'Preview URL is malformed.');
  }
  return value;
}

function wildcardParam(req: Request, name: string): string {
  const value: unknown = (req.params as Record<string, unknown>)[name];
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join('/');
  }
  throw new AppError('bad_request', 'Preview URL is malformed.');
}

function plain(res: Response, status: number, message: string): void {
  if (res.headersSent) return;
  res.status(status);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(`${message}\n`);
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code;
}
