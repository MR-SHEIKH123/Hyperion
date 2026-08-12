import { Router } from 'express';
import type { Request } from 'express';

import { wrap } from './errors.ts';
import {
  asBool,
  asEnum,
  asNumber,
  asTool,
  body,
  pathParam,
  queryBool,
  queryNumber,
  queryString,
} from './params.ts';
import {
  assetExists,
  assetPath,
  deleteAsset,
  listAssets,
  requireAsset,
  setAssetPinned,
  storageStats,
  toPublic,
  touchAsset,
} from '../services/storage/gallery.ts';
import type { AssetOrigin, AssetQuery } from '../services/storage/gallery.ts';
import { listCleanupLog, runCleanup } from '../services/storage/cleanup.ts';
import { AppError } from '../util/errors.ts';

const ORIGINS = ['uploaded', 'generated'] as const satisfies readonly AssetOrigin[];

/** Reads the gallery filter set from the query string. */
function readQuery(req: Request): AssetQuery {
  return {
    chatId: queryString(req, 'chatId'),
    tool: asTool(queryString(req, 'tool')),
    origin: asEnum<AssetOrigin>(queryString(req, 'origin'), 'origin', ORIGINS),
    pinned: queryBool(req, 'pinned'),
    brandApproved: queryBool(req, 'brandApproved'),
    search: queryString(req, 'search'),
    limit: queryNumber(req, 'limit'),
    offset: queryNumber(req, 'offset'),
  };
}

export const storageRouter = Router();

// Literal segments are declared before any `:id` route so they are not shadowed.

storageRouter.get(
  '/stats',
  wrap(async (_req, res) => {
    res.json(storageStats());
  }),
);

storageRouter.get(
  '/cleanup/log',
  wrap(async (req, res) => {
    res.json({ entries: listCleanupLog(queryNumber(req, 'limit') ?? 50) });
  }),
);

/**
 * Runs the retention sweep on demand. `dryRun` reports what would be removed
 * without touching anything, which is what the settings screen previews with.
 */
storageRouter.post(
  '/cleanup',
  wrap(async (req, res) => {
    const payload = body(req);
    res.json(
      runCleanup({
        dryRun: asBool(payload.dryRun, 'dryRun') ?? false,
        assetTtlDays: asNumber(payload.assetTtlDays, 'assetTtlDays'),
        chatTtlDays: asNumber(payload.chatTtlDays, 'chatTtlDays'),
      }),
    );
  }),
);

storageRouter.get(
  '/assets',
  wrap(async (req, res) => {
    res.json(listAssets(readQuery(req)));
  }),
);

storageRouter.get(
  '/assets/:id',
  wrap(async (req, res) => {
    res.json({ asset: toPublic(requireAsset(pathParam(req, 'id'))) });
  }),
);

/**
 * Streams the asset bytes. A row can outlive its file (manual deletion, failed
 * restore), so a missing file is reported as `not_found` rather than a 500.
 */
storageRouter.get(
  '/assets/:id/file',
  wrap(async (req, res, next) => {
    const id = pathParam(req, 'id');
    const asset = requireAsset(id);
    if (!assetExists(asset)) {
      throw new AppError('not_found', `Asset file is missing on disk: ${asset.filename}`, {
        details: { id, relPath: asset.relPath },
      });
    }
    touchAsset(id);
    res.sendFile(assetPath(asset), (error) => {
      if (error) next(error);
    });
  }),
);

/** Toggles when `pinned` is omitted; sets explicitly when provided. */
storageRouter.post(
  '/assets/:id/pin',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    const pinned = asBool(body(req).pinned, 'pinned');
    const asset = pinned === undefined ? setAssetPinned(id) : setAssetPinned(id, pinned);
    res.json({ asset: toPublic(asset) });
  }),
);

storageRouter.delete(
  '/assets/:id',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    requireAsset(id);
    const keepFile = queryBool(req, 'keepFile') ?? asBool(body(req).keepFile, 'keepFile') ?? false;
    // deleteAsset returns BYTES FREED, not a row count. requireAsset above has
    // already thrown not_found if the row was absent, so by this point the row
    // existed and is now gone: deletion is unconditionally true. Deriving it
    // from the byte count reported deleted:false for successful deletes whenever
    // keepFile was set, the file was already missing, or the file was empty.
    const bytesFreed = deleteAsset(id, { keepFile });
    res.json({ deleted: true, keepFile, bytesFreed });
  }),
);
