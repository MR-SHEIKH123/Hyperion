/**
 * Artifact versions — currently export only.
 *
 * `artifact_versions` has no db module of its own; the orchestrator writes rows
 * directly and nothing has needed to read one back over HTTP until now. The
 * query therefore lives in the export service rather than being invented here,
 * so a future artifacts API has one place to grow from.
 */
import { Router } from 'express';

import { exportArtifact } from '../services/export/index.ts';
import { attachDownloadHeaders } from './download.ts';
import { wrap } from './errors.ts';
import { pathParam } from './params.ts';

export const artifactsRouter: Router = Router();

/** One artifact version as a file, in whatever format produced it. */
artifactsRouter.get(
  '/:id/export',
  wrap(async (req, res) => {
    const exported = exportArtifact(pathParam(req, 'id'));
    attachDownloadHeaders(res, exported.filename, exported.contentType);
    res.send(exported.content);
  }),
);
