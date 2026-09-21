import path from 'node:path';

import { Router } from 'express';
import multer from 'multer';

import { wrap } from './errors.ts';
import { asBool, asOptionalString, body, queryBool, queryLimit } from './params.ts';
import { listRestoreAudit } from '../db/restoreAudit.ts';
import { backupPath, exportBackup, listBackups } from '../services/backup/export.ts';
import {
  inspectArchive,
  openArchive,
  openArchiveForRestore,
  restoreBackup,
} from '../services/backup/import.ts';
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
 * What to call this archive in the audit trail: the name it was uploaded under,
 * or the name it has in the backups directory. Never a path.
 */
function sourceName(req: Parameters<Parameters<typeof wrap>[0]>[0]): string | undefined {
  const uploaded = req.file?.originalname;
  if (uploaded) return uploaded;
  const named = asOptionalString(body(req).file, 'file');
  return named ? path.basename(named) : undefined;
}

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

/**
 * The passphrase for a protected archive, if the request carries one.
 *
 * Deliberately **never** accepted from a query string: a URL ends up in browser
 * history, in `Referer` headers and in this app's own request logs, and a
 * passphrase that decrypts the database is not something to leave in any of
 * them. It travels in a JSON body (`POST /export`) or as a multipart field
 * beside the upload (`POST /inspect`, `POST /import`).
 */
function passphraseFrom(payload: Record<string, unknown>): string | undefined {
  return asOptionalString(payload.passphrase, 'passphrase');
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

/**
 * Builds an archive and returns it, with the passphrase in the body (1.29).
 *
 * A POST rather than a parameter on `GET /export` for one reason: the
 * passphrase must not be able to reach a URL. Everything else matches the GET —
 * keys excluded by default, attachments included by default — and the response is
 * a `.hypbak` download rather than a `.zip`.
 */
backupRouter.post(
  '/export',
  wrap(async (req, res, next) => {
    const payload = body(req);
    const result = await exportBackup({
      includeKeys: asBool(payload.includeKeys, 'includeKeys') ?? false,
      includeAttachments: asBool(payload.includeAttachments, 'includeAttachments') ?? true,
      passphrase: passphraseFrom(payload),
    });
    res.download(result.file, result.filename, (error) => {
      if (error) next(error);
    });
  }),
);

/**
 * What restores have happened here (1.29): every attempt, including the ones
 * that were refused and the dry runs that answered "here is what would change".
 *
 * Read after a restore, this is the only record that survives — the row written
 * by a successful restore lives inside the database that restore produced.
 */
backupRouter.get(
  '/restores',
  wrap((req, res) => {
    res.json({ restores: listRestoreAudit(queryLimit(req, 'limit', { fallback: 50, max: 500 })) });
  }),
);

/** Reads the manifest without writing anything, for the confirm dialog. */
backupRouter.post(
  '/inspect',
  upload.single('file'),
  wrap(async (req, res) => {
    const opened = await openArchive(readSource(req), passphraseFrom(body(req)));
    res.json({ inspection: inspectArchive(opened.zip, { encrypted: opened.encrypted }) });
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
    const opened = await openArchiveForRestore(readSource(req), passphraseFrom(payload), {
      ...(sourceName(req) !== undefined ? { filename: sourceName(req) } : {}),
    });
    const result = await restoreBackup(opened.zip, {
      dryRun: asBool(payload.dryRun, 'dryRun') ?? false,
      includeAttachments: asBool(payload.includeAttachments, 'includeAttachments') ?? true,
      encrypted: opened.encrypted,
      filename: sourceName(req),
    });
    res.json(result);
  }),
);
