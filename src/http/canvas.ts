/** Read-only Canvas routes for active Code task workspaces. */
import { Router } from 'express';

import { wrap } from './errors.ts';
import { pathParam } from './params.ts';
import {
  canvasDiff,
  canvasFile,
  canvasServices,
  listCanvasFiles,
} from '../services/code/canvas.ts';
import { mintPreview, revokePreview } from '../services/code/preview.ts';
import { AppError } from '../util/errors.ts';

import type { Request } from 'express';

export const canvasRouter = Router();

canvasRouter.get(
  '/tasks/:taskId/files',
  wrap(async (req, res) => {
    const taskId = pathParam(req, 'taskId');
    const candidate = singlePathQuery(req, false) ?? '.';
    res.json(await listCanvasFiles(taskId, candidate));
  }),
);

canvasRouter.get(
  '/tasks/:taskId/file',
  wrap(async (req, res) => {
    const taskId = pathParam(req, 'taskId');
    const candidate = singlePathQuery(req, true);
    if (candidate === undefined) throw missingPath();
    res.json(await canvasFile(taskId, candidate));
  }),
);

canvasRouter.get(
  '/tasks/:taskId/diff',
  wrap(async (req, res) => {
    res.json(await canvasDiff(pathParam(req, 'taskId')));
  }),
);

canvasRouter.post(
  '/tasks/:taskId/preview',
  wrap(async (req, res) => {
    const taskId = pathParam(req, 'taskId');
    // Establish task ownership before reporting listener availability. An
    // unknown id is always not_found, even on an install with preview disabled.
    canvasServices(taskId);
    res.status(201).json(mintPreview(taskId));
  }),
);

canvasRouter.delete(
  '/tasks/:taskId/preview',
  wrap(async (req, res) => {
    const taskId = pathParam(req, 'taskId');
    canvasServices(taskId);
    res.json({ revoked: revokePreview(taskId) });
  }),
);

/**
 * Query keys may repeat in Express, in which case their value is an array.
 * Taking the first path silently would make the wire ambiguous, so Canvas is
 * stricter than the historical queryString helper.
 */
function singlePathQuery(req: Request, required: boolean): string | undefined {
  const value: unknown = req.query.path;
  if (value === undefined || value === null) {
    if (required) throw missingPath();
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('bad_request', 'path must be one non-empty query string value.', {
      details: { field: 'path' },
    });
  }
  return value;
}

function missingPath(): AppError {
  return new AppError('bad_request', 'path is required.', {
    details: { field: 'path' },
  });
}
