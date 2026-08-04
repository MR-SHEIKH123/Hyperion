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

import { createLogger } from '../util/logger.ts';

const log = createLogger('http');

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
  }

  // Headers already flushed means an SSE stream is mid-flight; the stream
  // reports its own `error` event, and writing JSON now would corrupt it.
  if (res.headersSent) {
    next(error);
    return;
  }

  res.status(status).json(app.toJSON());
}
