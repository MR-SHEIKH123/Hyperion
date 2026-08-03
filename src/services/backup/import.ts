/**
 * Backup restore.
 *
 * Restoring is the most destructive operation in the app: it replaces the
 * user's live database. The whole design here is about making that survivable.
 *
 *   1. **Inspect before touching anything.** `inspectArchive()` validates the
 *      manifest and the DB snapshot (it actually opens the snapshot and reads
 *      its table counts) and returns what would happen. The route exposes this
 *      as a dry run, so "restore" is never a blind leap.
 *
 *   2. **Snapshot the current state first.** Before the swap we export the
 *      existing install to `backups/pre-restore-<ts>.zip`. If the archive turns
 *      out to be wrong — wrong machine, wrong month, truncated download — the
 *      user has a one-file path back. This is not optional and cannot be
 *      disabled: the cost is a few seconds, the alternative is unrecoverable.
 *
 *   3. **Swap, don't merge.** A restore makes this install *be* the archive.
 *      Merging two SQLite databases with overlapping primary keys has no
 *      correct answer, and guessing one silently corrupts history. Anything not
 *      in the archive (e.g. attachments, when they weren't included) is left
 *      alone rather than deleted, so a metadata-only backup doesn't wipe files
 *      it never claimed to own.
 *
 *   4. **`secret.key` is never overwritten if one already exists.** Replacing
 *      the live key would render every currently-stored credential permanently
 *      undecryptable. If the archive's DB was encrypted with a different key,
 *      the keys inside it simply fail to decrypt (tryDecrypt returns null and
 *      warns) and the user re-enters them — recoverable. Clobbering the key is
 *      not.
 *
 * The process must be restarted after a restore: the old DB handle points at a
 * replaced file. `restoreBackup()` says so in its result rather than trying to
 * hot-swap connections underneath live requests.
 */

import fs from 'node:fs';
import path from 'node:path';

import AdmZip from 'adm-zip';

import { env } from '../../config/env.ts';
import { closeDb, getDb, openDatabase, setDb } from '../../db/adapter.ts';
import { runMigrations } from '../../db/migrate.ts';
import { getRoot, resolveInScope } from '../../security/fsScope.ts';
import { AppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';

import {
  ATTACHMENTS_PREFIX,
  BACKUP_FORMAT_VERSION,
  DB_ENTRY,
  KEY_ENTRY,
  MANIFEST_ENTRY,
  MCP_ENTRY,
  SKILLS_PREFIX,
  exportBackup,
  type BackupManifest,
} from './export.ts';

const log = createLogger('restore');

/**
 * What the DB snapshot was called before the Hyperion rename. Archives written
 * by older builds carry this name; refusing them would make every pre-rename
 * backup unrestorable, which is precisely the situation backups exist for.
 */
const LEGACY_DB_ENTRY = 'aistudio.db';

export interface ArchiveInspection {
  valid: boolean;
  /** Present when the archive carried a readable manifest. */
  manifest: BackupManifest | null;
  hasDatabase: boolean;
  hasMcpConfig: boolean;
  hasEncryptionKey: boolean;
  skillFiles: number;
  attachmentFiles: number;
  /** Row counts read from the archived DB itself, not from the manifest. */
  counts: Record<string, number>;
  /** Blocking reasons. A non-empty list means restore is refused. */
  problems: string[];
  /** Non-blocking things the user should know before confirming. */
  warnings: string[];
}

function readZip(source: string | Buffer): AdmZip {
  try {
    return new AdmZip(source);
  } catch (error) {
    throw new AppError('bad_request', `Not a readable zip archive: ${String(error)}`);
  }
}

function entryText(zip: AdmZip, name: string): string | null {
  const entry = zip.getEntry(name);
  return entry ? entry.getData().toString('utf8') : null;
}

function countPrefix(zip: AdmZip, prefix: string): number {
  return zip.getEntries().filter((e) => !e.isDirectory && e.entryName.startsWith(prefix)).length;
}

/** The DB snapshot, under either the current or the pre-rename entry name. */
function databaseEntry(zip: AdmZip) {
  return zip.getEntry(DB_ENTRY) ?? zip.getEntry(LEGACY_DB_ENTRY) ?? null;
}

/**
 * Validate an archive without modifying anything. The DB snapshot is written to
 * a temp file and opened read-only-ish so we can report real counts — a zip can
 * contain a file called hyperion.db that isn't a database at all.
 */
export function inspectArchive(source: string | Buffer): ArchiveInspection {
  const zip = readZip(source);
  const problems: string[] = [];
  const warnings: string[] = [];

  let manifest: BackupManifest | null = null;
  const manifestText = entryText(zip, MANIFEST_ENTRY);
  if (!manifestText) {
    warnings.push(
      'No manifest.json in the archive. It may not have been produced by Hyperion; the database will still be checked.',
    );
  } else {
    try {
      manifest = JSON.parse(manifestText) as BackupManifest;
      if (typeof manifest.format === 'number' && manifest.format > BACKUP_FORMAT_VERSION) {
        problems.push(
          `The archive uses backup format ${manifest.format}, but this version of Hyperion only understands ${BACKUP_FORMAT_VERSION}. Update the app before restoring.`,
        );
      }
    } catch {
      warnings.push('manifest.json could not be parsed; continuing on the database contents.');
    }
  }

  const dbEntry = databaseEntry(zip);
  const hasDatabase = Boolean(dbEntry);
  if (!hasDatabase) {
    problems.push(`The archive has no ${DB_ENTRY}, so there is nothing to restore.`);
  }

  const counts: Record<string, number> = {};
  if (dbEntry) {
    const probe = resolveInScope('tmp', `inspect-${Date.now()}-${process.pid}.db`);
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    try {
      fs.writeFileSync(probe, dbEntry.getData());
      const candidate = openDatabase(probe);
      try {
        const tables = candidate
          .prepare<{
            name: string;
          }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all()
          .map((r) => r.name);

        if (!tables.includes('chats') || !tables.includes('providers')) {
          problems.push(
            'The archived file is a database, but not a Hyperion one (expected tables are missing).',
          );
        }
        for (const table of tables) {
          const row = candidate.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`).get();
          counts[table] = row?.n ?? 0;
        }
      } finally {
        candidate.close();
      }
    } catch (error) {
      problems.push(`The archived database could not be opened: ${String(error)}`);
    } finally {
      fs.rmSync(probe, { force: true });
      for (const suffix of ['-wal', '-shm']) fs.rmSync(probe + suffix, { force: true });
    }
  }

  const hasEncryptionKey = Boolean(zip.getEntry(KEY_ENTRY));
  if (hasEncryptionKey) {
    warnings.push(
      'This archive contains an encryption key. Your existing key will NOT be replaced — if the archive came from another machine, its stored API keys will need to be re-entered.',
    );
  } else if (fs.existsSync(env.paths.secretKey)) {
    warnings.push(
      'The archive has no encryption key. If it came from a different machine, stored API keys will not decrypt and must be re-entered after restoring.',
    );
  }

  const attachmentFiles = countPrefix(zip, ATTACHMENTS_PREFIX);
  if (attachmentFiles === 0 && (counts['attachments'] ?? 0) > 0) {
    warnings.push(
      'The archive lists attachments in its database but does not contain the files. Existing files on this machine are left untouched; any that are missing will show as unavailable in the gallery.',
    );
  }

  return {
    valid: problems.length === 0,
    manifest,
    hasDatabase,
    hasMcpConfig: Boolean(zip.getEntry(MCP_ENTRY)),
    hasEncryptionKey,
    skillFiles: countPrefix(zip, SKILLS_PREFIX),
    attachmentFiles,
    counts,
    problems,
    warnings,
  };
}

export interface RestoreOptions {
  /** Report what would happen and change nothing. */
  dryRun?: boolean;
  /**
   * Restore attachment files too, when present. Defaults to true — if the
   * archive bothered to carry them, the user wants them.
   */
  includeAttachments?: boolean;
}

export interface RestoreResult {
  restored: boolean;
  dryRun: boolean;
  inspection: ArchiveInspection;
  /** The safety net taken before the swap. */
  preRestoreBackup: string | null;
  filesWritten: { database: boolean; mcpConfig: boolean; skills: number; attachments: number };
  /** Always true for a real restore; the caller should surface it to the user. */
  restartRequired: boolean;
}

/**
 * Extract the entries under `prefix` into `root`, refusing anything that tries
 * to escape it. Zip entry names are attacker-controlled data even when the
 * "attacker" is a well-meaning archive from elsewhere.
 */
function extractPrefix(zip: AdmZip, prefix: string, root: string): number {
  let written = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (!entry.entryName.startsWith(prefix)) continue;

    const rel = entry.entryName.slice(prefix.length);
    if (!rel || rel.includes('\0')) continue;

    const target = path.resolve(root, rel);
    const relToRoot = path.relative(root, target);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
      log.warn('skipping archive entry that escapes its root', { entry: entry.entryName });
      continue;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
    written += 1;
  }
  return written;
}

export function restoreBackup(
  source: string | Buffer,
  options: RestoreOptions = {},
): RestoreResult {
  const dryRun = options.dryRun ?? false;
  const includeAttachments = options.includeAttachments ?? true;

  const zip = readZip(source);
  const inspection = inspectArchive(source);

  const base: RestoreResult = {
    restored: false,
    dryRun,
    inspection,
    preRestoreBackup: null,
    filesWritten: { database: false, mcpConfig: false, skills: 0, attachments: 0 },
    restartRequired: false,
  };

  if (!inspection.valid) {
    throw new AppError(
      'bad_request',
      `This archive cannot be restored: ${inspection.problems.join(' ')}`,
      { details: { problems: inspection.problems, warnings: inspection.warnings } },
    );
  }

  if (dryRun) return base;

  // --- safety net ---------------------------------------------------------
  // Taken before anything is replaced. If this fails we stop: proceeding
  // without a way back is not a trade worth making.
  let preRestoreBackup: string | null = null;
  try {
    const snapshot = exportBackup({
      includeAttachments: false,
      outFile: resolveInScope('backups', `pre-restore-${Date.now()}.zip`),
    });
    preRestoreBackup = snapshot.filename;
    log.info('pre-restore snapshot written', { file: snapshot.filename });
  } catch (error) {
    throw new AppError(
      'storage_error',
      `Refusing to restore: could not snapshot the current data first (${String(error)}). ` +
        'Nothing has been changed.',
    );
  }

  // --- swap ---------------------------------------------------------------
  const dbEntry = databaseEntry(zip);
  if (!dbEntry) throw new AppError('bad_request', `The archive has no ${DB_ENTRY}.`);

  // Close first: on Windows an open handle makes the rename fail outright,
  // and on every platform a live handle would keep reading the old file.
  closeDb();

  const dbFile = env.paths.db;
  const displaced = `${dbFile}.replaced-${Date.now()}`;

  try {
    if (fs.existsSync(dbFile)) fs.renameSync(dbFile, displaced);
    // The WAL/SHM sidecars belong to the file we just moved aside; leaving them
    // next to the new database would corrupt it.
    for (const suffix of ['-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });

    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.writeFileSync(dbFile, dbEntry.getData(), { mode: 0o600 });
    base.filesWritten.database = true;
  } catch (error) {
    // Put the original back before surfacing the failure.
    try {
      if (fs.existsSync(displaced)) {
        fs.rmSync(dbFile, { force: true });
        fs.renameSync(displaced, dbFile);
      }
    } catch {
      /* the original error is the useful one */
    }
    throw new AppError('storage_error', `Restore failed while replacing the database: ${String(error)}`);
  }

  // Reopen and bring the restored DB up to the current schema — an older
  // archive may predate a migration this build expects.
  setDb(openDatabase(dbFile));
  try {
    runMigrations(getDb());
  } catch (error) {
    log.error('restored database failed migration', { error: String(error) });
    throw new AppError(
      'storage_error',
      `The database was restored but could not be migrated to the current schema: ${String(error)}. ` +
        `The previous database was preserved at "${path.basename(displaced)}".`,
    );
  }

  // --- side files ---------------------------------------------------------
  const mcpText = entryText(zip, MCP_ENTRY);
  if (mcpText !== null) {
    fs.mkdirSync(path.dirname(env.paths.mcpConfig), { recursive: true });
    fs.writeFileSync(env.paths.mcpConfig, mcpText, { mode: 0o600 });
    base.filesWritten.mcpConfig = true;
  }

  base.filesWritten.skills = extractPrefix(zip, SKILLS_PREFIX, getRoot('skills'));
  if (includeAttachments) {
    base.filesWritten.attachments = extractPrefix(
      zip,
      ATTACHMENTS_PREFIX,
      getRoot('attachments'),
    );
  }

  if (zip.getEntry(KEY_ENTRY) && !fs.existsSync(env.paths.secretKey)) {
    // Only when there is no key here to destroy. See the header.
    fs.writeFileSync(env.paths.secretKey, zip.getEntry(KEY_ENTRY)!.getData(), { mode: 0o600 });
    log.info('encryption key restored (none was present)');
  }

  // The displaced database stays on disk. It is the last line of defence and
  // costs a few megabytes; the user (or a future cleanup pass) can remove it.
  log.info('restore complete', {
    preRestoreBackup,
    displaced: path.basename(displaced),
    ...base.filesWritten,
  });

  return {
    ...base,
    restored: true,
    preRestoreBackup,
    restartRequired: true,
  };
}
