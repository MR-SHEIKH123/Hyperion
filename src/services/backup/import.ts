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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import AdmZip from 'adm-zip';

import { env } from '../../config/env.ts';
import { closeDb, getDb, openDatabase, setDb } from '../../db/adapter.ts';
import { runMigrations } from '../../db/migrate.ts';
import { recordRestoreAudit } from '../../db/restoreAudit.ts';
import { getRoot, resolveInScope } from '../../security/fsScope.ts';
import { AppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';

import { decryptArchive, isEncryptedArchive } from './crypto.ts';

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

export interface TableDelta {
  table: string;
  /** Rows in the live database. */
  current: number;
  /** Rows in the archive. */
  archive: number;
  /** `archive - current`: positive means the restore brings rows in. */
  delta: number;
}

export interface ArchiveDiff {
  tables: TableDelta[];
  /** Tables in the archive with no live counterpart. */
  onlyInArchive: string[];
  /** Live tables the archive does not carry. They are left as they are. */
  onlyHere: string[];
  /** Migrations the archive has not been through, newest-last as applied. */
  missingFromArchive: string[];
  currentMigrations: number;
  archiveMigrations: number;
}

export interface ArchiveInspection {
  valid: boolean;
  /**
   * True when the file arrived as a passphrase-protected container (1.29). The
   * caller already had to open it to get this far, so the field is for the user
   * — "this archive was protected in transit" is worth knowing before deciding
   * where to keep it.
   */
  encrypted: boolean;
  /** Present when the archive carried a readable manifest. */
  manifest: BackupManifest | null;
  hasDatabase: boolean;
  hasMcpConfig: boolean;
  hasEncryptionKey: boolean;
  skillFiles: number;
  attachmentFiles: number;
  /** Row counts read from the archived DB itself, not from the manifest. */
  counts: Record<string, number>;
  /**
   * What a restore would change, as row counts: current (live) against archive
   * (this file), per table, with a delta (1.29's diff preview).
   *
   * Counts rather than a row-by-row diff, and that is a deliberate limit rather
   * than a shortcut: a restore **replaces** the database rather than merging it,
   * so the honest question before confirming is "does this archive know more or
   * less than what I have now, and where" — and a count answers it for every
   * table without inventing a merge that will not happen. `onlyInArchive` and
   * `onlyHere` name the tables that exist on one side and not the other, which is
   * what a schema drift looks like from here.
   */
  diff: ArchiveDiff;
  /** Blocking reasons. A non-empty list means restore is refused. */
  problems: string[];
  /** Non-blocking things the user should know before confirming. */
  warnings: string[];
}

function readZip(source: string | Buffer): AdmZip {
  const bytes = typeof source === 'string' ? fs.readFileSync(source) : source;
  if (isEncryptedArchive(bytes)) {
    // A direct caller that skipped `openArchive`. Failing here with the reason
    // beats AdmZip's "Invalid or unsupported zip format" on ciphertext, which
    // reads like corruption rather than like a missing passphrase.
    throw new AppError(
      'bad_request',
      'This backup is passphrase-protected. Open it with `openArchive` and the passphrase first.',
    );
  }
  try {
    return new AdmZip(bytes);
  } catch (error) {
    throw new AppError('bad_request', `Not a readable zip archive: ${String(error)}`);
  }
}

export interface OpenArchiveResult {
  /** The zip bytes, decrypted when the source was a protected container. */
  zip: Buffer;
  encrypted: boolean;
}

/**
 * Resolve a source — a path inside the backups scope, or an uploaded buffer —
 * into the zip bytes this module reads, decrypting first when the file is a
 * passphrase-protected container (1.29).
 *
 * Both restore routes go through here so the decision "is this protected, and
 * can we open it?" happens once, before any archive parsing: an encrypted backup
 * opened without a passphrase is a 400 that says so, and one opened with the
 * wrong passphrase is the container's own refusal, which never distinguishes
 * "wrong passphrase" from "modified file" because the tag cannot.
 */
export async function openArchive(
  source: string | Buffer,
  passphrase?: string,
): Promise<OpenArchiveResult> {
  const bytes = typeof source === 'string' ? fs.readFileSync(source) : source;
  if (!isEncryptedArchive(bytes)) return { zip: bytes, encrypted: false };

  if (passphrase === undefined || passphrase.trim() === '') {
    throw new AppError(
      'bad_request',
      'This backup is passphrase-protected. Supply the passphrase to inspect or restore it.',
      { details: { encrypted: true, field: 'passphrase' } },
    );
  }

  const { plaintext } = await decryptArchive(bytes, passphrase);
  return { zip: plaintext, encrypted: true };
}

/**
 * `openArchive`, with the refusals audited.
 *
 * A file that cannot even be opened is still a restore attempt, and it is the
 * near-miss kind the audit trail exists for — someone reaching for a backup they
 * cannot open is exactly what a user asks about a week later. The inspect route
 * deliberately does **not** use this: an inspection is a question, and a wrong
 * passphrase typed twice while reading a manifest should not fill the trail with
 * attempts that were never made.
 *
 * The audit entry records the passphrase's *absence* by outcome, never by value:
 * the failure message is what travels, and it is the same one the user sees.
 */
export async function openArchiveForRestore(
  source: string | Buffer,
  passphrase: string | undefined,
  options: { filename?: string } = {},
): Promise<OpenArchiveResult> {
  const bytes = typeof source === 'string' ? fs.readFileSync(source) : source;
  try {
    return await openArchive(bytes, passphrase);
  } catch (error) {
    const message = error instanceof AppError ? error.message : String(error);
    recordRestoreAudit({
      filename: options.filename ?? (typeof source === 'string' ? path.basename(source) : null),
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      encrypted: isEncryptedArchive(bytes),
      dryRun: false,
      restored: false,
      outcome: 'refused',
      detail: message.slice(0, 500),
    });
    throw error;
  }
}

/** The migration names a database has recorded, oldest first. Empty if it has none. */
function migrationNames(db: { prepare: (sql: string) => { all: () => unknown[] } }): string[] {
  try {
    const rows = db
      .prepare('SELECT name FROM _migrations ORDER BY name')
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  } catch {
    // A database from before `_migrations` existed, or one where the table is
    // named differently. "No migrations recorded" is the honest answer.
    return [];
  }
}

/**
 * Compare the archive's tables against the live install's (1.29).
 *
 * Deliberately tolerant: every read here is a "best effort" and a failure
 * produces less information rather than an error. An inspection that refuses to
 * run because the *current* database is odd would block the restore that might
 * be the way out of that oddness.
 */
function buildDiff(
  archivedTables: string[],
  archiveCounts: Record<string, number>,
  archiveMigrations: string[],
): ArchiveDiff {
  const liveTables = new Map<string, number>();
  let currentMigrations: string[] = [];
  try {
    const db = getDb();
    currentMigrations = migrationNames(db);
    for (const { name } of db
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()) {
      const row = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`).get();
      liveTables.set(name, row?.n ?? 0);
    }
  } catch {
    // Leave the live side empty; `onlyInArchive` then lists what the archive has.
  }

  const names = [...new Set([...liveTables.keys(), ...archivedTables])].sort();
  const tables: TableDelta[] = names.map((table) => {
    const current = liveTables.get(table) ?? 0;
    const archive = archiveCounts[table] ?? 0;
    return { table, current, archive, delta: archive - current };
  });

  const archived = new Set(archivedTables);
  return {
    tables,
    onlyInArchive: [...archived].filter((name) => !liveTables.has(name)).sort(),
    onlyHere: [...liveTables.keys()].filter((name) => !archived.has(name)).sort(),
    missingFromArchive: currentMigrations.filter((name) => !archiveMigrations.includes(name)),
    currentMigrations: currentMigrations.length,
    archiveMigrations: archiveMigrations.length,
  };
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
export function inspectArchive(
  source: string | Buffer,
  options: { encrypted?: boolean } = {},
): ArchiveInspection {
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
  let archivedTables: string[] = [];
  let archiveMigrations: string[] = [];
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
        archivedTables = tables;
        archiveMigrations = migrationNames(candidate);
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

  // The diff is computed against the live database, so it only means anything for
  // a real restore on a real install — and it must never be the reason an
  // inspection throws. A fresh install with no schema yet, or a database this
  // process cannot read, degrades to empty lists rather than to a 500.
  const diff = buildDiff(archivedTables, counts, archiveMigrations);

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
    encrypted: options.encrypted ?? false,
    manifest,
    hasDatabase,
    hasMcpConfig: Boolean(zip.getEntry(MCP_ENTRY)),
    hasEncryptionKey,
    skillFiles: countPrefix(zip, SKILLS_PREFIX),
    attachmentFiles,
    counts,
    diff,
    problems,
    warnings,
  };
}

export interface RestoreOptions {
  /** Report what would happen and change nothing. */
  dryRun?: boolean;
  /** What the caller calls this archive — recorded in the audit trail. */
  filename?: string;
  /**
   * The source was a passphrase-protected container that the caller already
   * opened with `openArchive`. Carried through so the returned inspection can
   * say so; it changes nothing about what is restored.
   */
  encrypted?: boolean;
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

/** Identify the file that was restored. Digest of the bytes as they arrived. */
function digestOf(source: string | Buffer): string {
  const bytes = typeof source === 'string' ? fs.readFileSync(source) : source;
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function restoreBackup(
  source: string | Buffer,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const dryRun = options.dryRun ?? false;
  const includeAttachments = options.includeAttachments ?? true;

  const zip = readZip(source);
  const inspection = inspectArchive(source, { encrypted: options.encrypted ?? false });
  const audit = {
    filename: options.filename ?? (typeof source === 'string' ? path.basename(source) : null),
    bytes: (typeof source === 'string' ? fs.readFileSync(source) : source).length,
    sha256: digestOf(source),
    encrypted: options.encrypted ?? false,
  };

  const base: RestoreResult = {
    restored: false,
    dryRun,
    inspection,
    preRestoreBackup: null,
    filesWritten: { database: false, mcpConfig: false, skills: 0, attachments: 0 },
    restartRequired: false,
  };

  if (!inspection.valid) {
    // Recorded before the throw: the attempt is the interesting fact, and this is
    // the only branch where the archive is named and nothing has been touched.
    recordRestoreAudit({
      ...audit,
      dryRun,
      restored: false,
      outcome: 'refused',
      detail: inspection.problems.join(' ').slice(0, 500),
    });
    throw new AppError(
      'bad_request',
      `This archive cannot be restored: ${inspection.problems.join(' ')}`,
      { details: { problems: inspection.problems, warnings: inspection.warnings } },
    );
  }

  if (dryRun) {
    recordRestoreAudit({ ...audit, dryRun: true, restored: false, outcome: 'dry_run' });
    return base;
  }

  // --- safety net ---------------------------------------------------------
  // Taken before anything is replaced. If this fails we stop: proceeding
  // without a way back is not a trade worth making.
  let preRestoreBackup: string | null = null;
  try {
    const snapshot = await exportBackup({
      includeAttachments: false,
      outFile: resolveInScope('backups', `pre-restore-${Date.now()}.zip`),
    });
    preRestoreBackup = snapshot.filename;
    log.info('pre-restore snapshot written', { file: snapshot.filename });
  } catch (error) {
    recordRestoreAudit({
      ...audit,
      dryRun: false,
      restored: false,
      outcome: 'refused',
      detail: `Could not snapshot the current data first: ${String(error)}`.slice(0, 500),
    });
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

  // Written last, and against the *restored* database: the record then lives in
  // the install the restore produced, which is where anyone asking "how did this
  // database get here?" will be looking (migration 024).
  recordRestoreAudit({
    ...audit,
    dryRun: false,
    restored: true,
    outcome: 'restored',
    preRestoreBackup,
    detail: `database replaced (${String(base.filesWritten.database)}), previous file kept as ${path.basename(displaced)}`,
  });

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
