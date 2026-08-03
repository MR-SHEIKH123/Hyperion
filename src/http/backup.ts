import { Router } from 'express';
import multer from 'multer';

import { wrap } from './errors.ts';
import { asBool, asOptionalString, body, queryBool } from './params.ts';
import { backupPath, exportBackup, listBackups } from '../services/backup/export.ts';
import { inspectArchive, restoreBackup } from '../services/backup/import.ts';
import { env } from '../config/env.ts';
import { AppError } from '../util/errors.ts';

/**
 * Archives arrive as a single in-memory upload. `maxUploadBytes` already
 * governs attachments, so a backup larger than that is rejected by multer
 * with LIMIT_FILE_SIZE, which the error handler turns into a 413.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadBytes, files: 1 },
});

/**
 * Resolves the archive to work on: either the uploaded buffer, or the name of
 * a backup already sitting in the backups directory.
 */
function readSource(req: Parameters<Parameters<typeof wrap>[0]>[0]): string | Buffer {
  const file = req.file;
  if (file?.buffer) return file.buffer;
  const name = asOptionalString(body(req).file, 'file');
  if (name) return backupPath(name);
  throw new AppError('bad_request', 'Provide an archive upload or the name of an existing backup');
}

export const backupRouter = Router();

/** Lists archives already on disk (including auto pre-restore snapshots). */
backupRouter.get(
  '/',
  wrap(async (_req, res) => {
    res.json({ backups: listBackups() });
  }),
);

/**
 * Builds an archive and streams it back as a download. Keys are excluded by
 * default: an export that leaves the machine should not carry provider
 * credentials unless the user explicitly asks for a full-fidelity restore.
 */
backupRouter.get(
  '/export',
  wrap(async (req, res, next) => {
    const result = await exportBackup({
      includeKeys: queryBool(req, 'includeKeys') ?? false,
      includeAttachments: queryBool(req, 'includeAttachments') ?? true,
    });
    res.download(result.file, result.filename, (error) => {
      if (error) next(error);
    });
  }),
);

/** Reads the manifest without writing anything, for the confirm dialog. */
backupRouter.post(
  '/inspect',
  upload.single('file'),
  wrap(async (req, res) => {
    res.json({ inspection: inspectArchive(readSource(req)) });
  }),
);

/**
 * Restores an archive. A pre-restore snapshot is taken by the service, and
 * `restartRequired` is echoed so the UI can prompt for a PM2 restart when the
 * database file itself was replaced underneath the running process.
 */
backupRouter.post(
  '/import',
  upload.single('file'),
  wrap(async (req, res) => {
    const payload = body(req);
    const result = await restoreBackup(readSource(req), {
      dryRun: asBool(payload.dryRun, 'dryRun') ?? false,
      includeAttachments: asBool(payload.includeAttachments, 'includeAttachments') ?? true,
    });
    res.json(result);
  }),
);
