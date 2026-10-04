/**
 * Canvas routes — `GET /api/code/tasks/:taskId/{files,file,diff}` and the
 * preview mint/revoke pair.
 *
 * Read-only views of a Code task's workspace, plus the one write this feature
 * has: minting a preview token, which writes nothing to the workspace itself.
 * Every path is resolved by `services/code/canvas.ts` through `files.ts`, so
 * these routes add no path validation of their own to drift out of step with
 * the agent's.
 *
 * Mounted at `/api/code`, before the agents router. The sub-paths here do not
 * collide with any of its routes, and if one ever does, the more specific mount
 * is the one that should decide.
 */
import { Router } from 'express';

import { wrap } from './errors.ts';
import { pathParam, querySingleString } from './params.ts';
import { canvasDiff, listCanvasTree, readCanvasFile, requireWorktree } from '../services/code/canvas.ts';
import { livePreview, mintPreview, revokePreview } from '../services/code/preview.ts';
import { requirePreviewEnabled } from './previewServer.ts';
import { AppError } from '../util/errors.ts';

import type { Request } from 'express';

export const canvasRouter: Router = Router();

/** The listing root. `.` — the whole workspace — when the caller omits it. */
function subtreeQuery(req: Request): string {
  return querySingleString(req, 'path') ?? '.';
}

canvasRouter.get(
  '/tasks/:taskId/files',
  wrap(async (req, res) => {
    const tree = await listCanvasTree(pathParam(req, 'taskId'), subtreeQuery(req));
    res.json(tree);
  }),
);

canvasRouter.get(
  '/tasks/:taskId/file',
  wrap(async (req, res) => {
    // Required, and required *explicitly*: a missing `?path=` must not quietly
    // become `.` here, because `.` is a directory and the answer would be a 400
    // about a file that was never named. The listing is where a default makes
    // sense.
    const candidate = querySingleString(req, 'path');
    if (candidate === undefined) {
      throw new AppError('bad_request', 'path is required.', { details: { field: 'path' } });
    }
    const file = await readCanvasFile(pathParam(req, 'taskId'), candidate);
    res.json(file);
  }),
);

canvasRouter.get(
  '/tasks/:taskId/diff',
  wrap(async (req, res) => {
    res.json(await canvasDiff(pathParam(req, 'taskId')));
  }),
);

/**
 * Mint a preview URL for a task's workspace. `201` because this is the one
 * route here that creates something — a session with a lifetime.
 *
 * Refused with `capability_disabled` while nothing is listening. The refusal
 * happens before the session exists, so a caller cannot hold a token for a
 * listener that is not there.
 */
canvasRouter.post(
  '/tasks/:taskId/preview',
  wrap(async (req, res) => {
    const taskId = pathParam(req, 'taskId');
    const listener = requirePreviewEnabled();
    requireWorktree(taskId);
    const minted = mintPreview(taskId, { host: listener.host, port: listener.port });
    res.status(201).json(minted);
  }),
);

/**
 * Whether a preview is live for this task, and where. A read, because minting
 * rotates the token — see `livePreview`.
 *
 * Gated like mint, so a host with the feature off answers `capability_disabled`
 * rather than `{ preview: null }`: "previews are disabled here" and "nothing is
 * running right now" are different facts, and a panel has to say which one it
 * is looking at. An unknown or released task is still a 404, like every other
 * route on this router.
 */
canvasRouter.get(
  '/tasks/:taskId/preview',
  wrap(async (req, res) => {
    const taskId = pathParam(req, 'taskId');
    const listener = requirePreviewEnabled();
    requireWorktree(taskId);
    res.json({ taskId, preview: livePreview(taskId, { host: listener.host, port: listener.port }) });
  }),
);

/**
 * Revoke a task's preview. `{ revoked: false }` when there was nothing to
 * revoke — deleting a thing that does not exist is the outcome the caller
 * wanted, so it is a 200 rather than a 404 about the session. An unknown *task*
 * is still a 404, because that is a claim about a different object.
 */
canvasRouter.delete(
  '/tasks/:taskId/preview',
  wrap(async (req, res) => {
    const taskId = pathParam(req, 'taskId');
    requireWorktree(taskId);
    res.json(revokePreview(taskId));
  }),
);
