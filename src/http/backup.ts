import path from 'node:path';

import { Router } from 'express';
import multer from 'multer';

import { wrap } from './errors.ts';
import { asBool, asOptionalString, body, queryBool, queryLimit } from './params.ts';
import { listRestoreAudit } from '../db/restoreAudit.ts';
import { getRoot } from '../security/fsScope.ts';
import {
  getS3PublicConfig,
  saveS3Config,
  testS3Connection,
  uploadFileToS3,
} from '../services/backup/destinations.ts';
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
 *
 * `uploadToS3` (1.29 destinations) uploads the finished archive to the
 * configured S3 destination before the download starts, and reports its key in
 * the `x-hyperion-s3-key` response header. An explicit upload that fails fails
 * the request (409 when S3 is not configured, 500 when the service refuses)
 * — but the local archive is already written, so the error still names the file
 * and the download can be retried with `uploadToS3` left off.
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
    if ((asBool(payload.uploadToS3, 'uploadToS3') ?? false) === true) {
      try {
        const uploaded = await uploadFileToS3(result.file, result.filename);
        res.set('x-hyperion-s3-key', uploaded.key);
      } catch (error) {
        // The archive is already on disk; say so, so the user knows the retry
        // is a download, not a rebuild.
        if (error instanceof AppError) {
          throw new AppError(error.code, `${error.message} The archive is saved locally as ${result.filename}.`, {
            details: { ...error.details, file: result.filename },
            privateDetails: error.privateDetails,
            retryable: error.retryable,
            cause: error,
          });
        }
        throw error;
      }
    }
    res.download(result.file, result.filename, (error) => {
      if (error) next(error);
    });
  }),
);

/**
 * Where finished archives go besides the backups root (1.29 destinations).
 *
 * `local` is the pre-existing env-only mirror; `s3` is the configured
 * S3-compatible destination, redacted — the secret access key is never
 * returned, only `hasSecret`.
 */
backupRouter.get(
  '/destinations',
  wrap(async (_req, res) => {
    res.json({
      local: {
        directory: getRoot('backups'),
        mirror: env.backupDest === '' ? null : env.backupDest,
      },
      s3: getS3PublicConfig(),
    });
  }),
);

/**
 * Partial update of the S3 destination: omitted fields are left alone, null or
 * `""` clears a field, unknown fields are rejected. The response is the same
 * redacted shape as `GET /destinations`.
 */
backupRouter.put(
  '/destinations/s3',
  wrap(async (req, res) => {
    res.json({ s3: saveS3Config(body(req)) });
  }),
);

/**
 * Round-trip probe of the S3 destination: PUT a small marker, HEAD it back,
 * DELETE it. Always answers 200 with `{ ok, steps }` — a failed probe is a
 * diagnosis, not a server error, and is deliberately not written to
 * `error_log`, which the Attention queue reads as real backup failures.
 */
backupRouter.post(
  '/destinations/s3/test',
  wrap(async (_req, res) => {
    res.json(await testS3Connection());
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
