/**
 * Artifact versions, read back.
 *
 * The table is written by the two paths that version their work — Code's file
 * writes (a snapshot of the file *before* each write, so version 1 is the state
 * before the first edit) and Design's saved versions — and until now the only way
 * to see one was to export it by id. Export is a download; what the version
 * timeline needs is the *list*.
 *
 * `artifact_key` is a file path for Code and a namespaced id (`design:…`) for
 * Design, so it travels as a query parameter rather than a path segment: a key
 * containing slashes cannot be a route path without inventing an encoding, and an
 * encoding would then have to be guessed by every caller.
 */
import { Router } from 'express';

import { listArtifactVersions } from '../db/artifactVersions.ts';
import { exportArtifact } from '../services/export/index.ts';
import { AppError } from '../util/errors.ts';
import { attachDownloadHeaders } from './download.ts';
import { wrap } from './errors.ts';
import { pathParam, queryLimit, queryString } from './params.ts';

export const artifactsRouter: Router = Router();

/**
 * The version timeline of one artifact.
 *
 * Each entry carries `parentVersion` — Prompt 1.39 A6's first provenance field,
 * and the only relationship worth stating: versions are a chain, and "what did
 * this replace?" is the question a timeline answers. It is **derived**, not
 * stored: `artifact_versions` has no `parent` column because it does not need one
 * — the parent of version *n* is *n-1*, and the table's own
 * `UNIQUE (artifact_key, version)` is what makes that unambiguous. A column would
 * be a second source of truth for a fact the key already holds, and the first
 * thing to drift after a restore or a hand-edited row.
 *
 * `parentVersion` is null only for the first version of a key, which is the
 * snapshot of the state *before* any edit — so `null` here means "this is where
 * the artifact started", not "the parent is unknown".
 */
artifactsRouter.get(
  '/versions',
  wrap(async (req, res) => {
    const key = queryString(req, 'key');
    if (key === undefined || key.trim().length === 0) {
      throw new AppError('bad_request', 'key must name the artifact whose versions to list', {
        details: { field: 'key' },
      });
    }
    const versions = listArtifactVersions(key.trim(), {
      limit: queryLimit(req, 'limit', { fallback: 200, max: 1000 }),
    });
    res.json({ artifactKey: key.trim(), versions });
  }),
);

/** One artifact version as a file, in whatever format produced it. */
artifactsRouter.get(
  '/:id/export',
  wrap(async (req, res) => {
    const exported = exportArtifact(pathParam(req, 'id'));
    attachDownloadHeaders(res, exported.filename, exported.contentType);
    res.send(exported.content);
  }),
);
