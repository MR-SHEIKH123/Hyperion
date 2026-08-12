/**
 * HTTP error plumbing.
 *
 * The service layer throws `AppError`, which already carries both a stable
 * machine-readable `code` and the `status` it maps to. This module's only job
 * is to put that on the wire unchanged: Sol's frontend branches on `code`, so
 * translating errors into prose or collapsing them into a generic 500 here
 * would destroy the contract the rest of the app is built on.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { AppError, bodyParserType, toAppError } from '../util/errors.ts';
import { logError } from '../db/errorLog.ts';
import { redactSecrets } from '../util/redact.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('http');

/** Headers that carry credentials, and are therefore never written to disk. */
const SENSITIVE_HEADER = /authorization|cookie|x-api-key|x-auth-token|secret|token/i;

/**
 * What of a request is safe to keep alongside a logged 500.
 *
 * Enough to reproduce the call, nothing that could be a credential. Headers are
 * filtered by name; the **values** of the body never appear at all, only its
 * keys — a request body is exactly where a pasted API key lives, and `error_log`
 * is queryable through `GET /api/errors`, so anything stored here should be
 * assumed to reach a screen eventually. Knowing the body had a `key` field is
 * what makes the failure diagnosable; knowing what the key was adds nothing.
 *
 * The result is run through `redactSecrets` regardless, because a URL can carry
 * a token in its query string and header names are not an exhaustive defence.
 */
function sanitizeRequestContext(req: Request): string {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!SENSITIVE_HEADER.test(key) && typeof value === 'string') {
      headers[key] = value;
    }
  }

  const body: unknown = req.body;
  const context = {
    headers,
    query: req.query,
    bodyKeys:
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? Object.keys(body)
        : undefined,
  };

  return redactSecrets(JSON.stringify(context));
}


/**
 * Wraps an async handler so a rejected promise reaches the error middleware.
 * Express 5 forwards rejections on its own, but being explicit keeps the
 * behaviour independent of that version detail.
 */
export function wrap(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** 404 for anything that didn't match a route. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json(
    new AppError('not_found', `No route for ${req.method} ${req.path}.`).toJSON(),
  );
}

/**
 * Terminal error handler.
 *
 * Must keep all four parameters — Express identifies error middleware by
 * arity, and dropping `next` would silently turn this into a normal handler.
 */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const app = toAppError(error);

  // "Too large" is a client problem, but it deserves its own status rather than
  // a flat 400: multer reports it as LIMIT_FILE_SIZE, body-parser as
  // entity.too.large. Both are normalized to `bad_request` for the code the
  // frontend branches on, so the status has to be restored here.
  const tooLarge =
    (error !== null &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'LIMIT_FILE_SIZE') ||
    bodyParserType(error) === 'entity.too.large';
  const status = tooLarge ? 413 : app.status;


  if (status >= 500) {
    // `privateDetails` is withheld from the response by design, so the server log
    // is the only place it can be seen. Merging keeps the diagnostic value that
    // moving provider error bodies off the wire would otherwise have destroyed.
    const diagnostic =
      app.privateDetails !== undefined
        ? { ...app.details, ...app.privateDetails }
        : app.details;
    log.error(`${app.code}: ${app.message}`, diagnostic);

    // The same failure, structured, so `GET /api/errors` can show it. stderr is
    // rotated away and invisible from the app itself; this is the copy the user
    // can actually reach when they ask what went wrong an hour ago.
    try {
      logError({
        timestamp: Date.now(),
        severity: 'error',
        endpoint: _req.path,
        method: _req.method,
        status,
        error_code: app.code,
        error_message: app.message,
        ...(app.stack === undefined ? {} : { stack_trace: app.stack }),
        request_context: sanitizeRequestContext(_req),
      });
    } catch (logErr) {
      // Never let bookkeeping replace the response the client is waiting for:
      // this runs inside the terminal handler, so a throw here would leave the
      // request hanging with the real error unreported.
      log.error('failed to write an error_log entry', logErr);
    }

  }

  // Headers already flushed means an SSE stream is mid-flight; the stream
  // reports its own `error` event, and writing JSON now would corrupt it.
  if (res.headersSent) {
    next(error);
    return;
  }

  res.status(status).json(app.toJSON());
}
