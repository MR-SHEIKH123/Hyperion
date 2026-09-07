/**
 * Backup export.
 *
 * Packages everything needed to reconstruct this install into one zip:
 *
 *   manifest.json      — what's inside, and which schema/app version wrote it
 *   hyperion.db        — a consistent snapshot of the SQLite database
 *   mcp_config.json    — the MCP server config (Cline format)
 *   skills/**          — the skill files themselves, since the DB only stores
 *                        their paths and losing the files leaves dead rows
 *
 * Three decisions worth stating plainly:
 *
 *   1. **The DB snapshot uses `VACUUM INTO`, not a file copy.** Copying a live
 *      SQLite file in WAL mode gives you a torn database: recent commits are in
 *      the -wal file you didn't copy. `VACUUM INTO` asks SQLite itself for a
 *      consistent, checkpointed copy, so the archive is restorable even if it
 *      was taken mid-request.
 *
 *   2. **`secret.key` is excluded by default.** The DB contains API keys
 *      encrypted with that key; shipping both in one archive means the archive
 *      is a plaintext credential store, and backups get emailed to themselves,
 *      dropped in cloud folders, and copied to USB sticks. Excluding the key
 *      means a leaked backup exposes conversations but not credentials. The
 *      user can opt in with `includeKeys` — and when they do, the manifest says
 *      so in words, so a restore can warn them what they're handling.
 *
 *   3. **Attachments are not included by default.** They're the bulk of the
 *      data (images, generated files) and a backup that takes ten minutes is a
 *      backup nobody runs. `includeAttachments` bundles them for a full
 *      machine migration.
 */

import fs from 'node:fs';
import path from 'node:path';

import AdmZip from 'adm-zip';

import { env } from '../../config/env.ts';
import { getDb, openDatabase, type Db } from '../../db/adapter.ts';
import { getRoot, resolveInScope } from '../../security/fsScope.ts';
import { AppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';

const log = createLogger('backup');

/** Bumped only when the archive layout changes in a way a reader must know about. */
export const BACKUP_FORMAT_VERSION = 1;

export const DB_ENTRY = 'hyperion.db';
export const MANIFEST_ENTRY = 'manifest.json';
export const MCP_ENTRY = 'mcp_config.json';
export const SKILLS_PREFIX = 'skills/';
export const ATTACHMENTS_PREFIX = 'attachments/';
export const KEY_ENTRY = 'secret.key';

export interface BackupManifest {
  format: number;
  app: string;
  createdAt: number;
  createdAtIso: string;
  schemaMigrations: string[];
  contents: {
    database: boolean;
    mcpConfig: boolean;
    skills: number;
    attachments: number;
    encryptionKey: boolean;
  };
  counts: Record<string, number>;
  /** Present only when the encryption key is inside. Human-readable on purpose. */
  warning?: string;
}

export interface ExportOptions {
  includeKeys?: boolean;
  includeAttachments?: boolean;
  /** Where to write the archive; defaults to the backups scope. */
  outFile?: string;
}

export interface ExportResult {
  file: string;
  filename: string;
  bytes: number;
  manifest: BackupManifest;
}

const KEY_WARNING =
  'This archive contains secret.key, which decrypts every stored API key and token. ' +
  'Treat the file itself as a credential: anyone who obtains it obtains your provider keys.';

function timestamp(at: number): string {
  // Local time, filesystem-safe: 2026-07-29_1904
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function tableCounts(): Record<string, number> {
  const db = getDb();
  const tables = [
    'chats',
    'messages',
    'providers',
    'attachments',
    'mcp_servers',
    'skills',
    'artifact_versions',
    'usage_log',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    try {
      const row = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get();
      counts[table] = row?.n ?? 0;
    } catch {
      // A table missing from an older DB shouldn't block a backup.
      counts[table] = -1;
    }
  }
  return counts;
}

function appliedMigrations(): string[] {
  try {
    const rows = getDb()
      .prepare<{ name: string }>('SELECT name FROM _migrations ORDER BY name')
      .all();
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

/**
 * Ask SQLite for a consistent copy. Returns the temp file path; the caller is
 * responsible for removing it (we do, in a finally).
 */
function snapshotDatabase(): string {
  const target = resolveInScope('tmp', `backup-${Date.now()}-${process.pid}.db`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { force: true });

  // VACUUM INTO refuses to overwrite, hence the rm above. Quotes doubled for
  // SQL string literal safety on Windows paths.
  getDb().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

/**
 * Remove `task_messages` from the temp copy, before it is archived.
 *
 * That table holds a parked run's conversation verbatim, and a conversation's tool
 * results carry **full file contents the agent read and raw command output**. A
 * backup today contains *no* project source at all — only the database, the MCP
 * config, the skills tree and (optionally) attachments — so carrying snapshots
 * would introduce a new *category* of content to an off-machine artifact rather
 * than more of an existing one. `mirrorBackup` copies each automatic archive to
 * `HYPERION_BACKUP_DEST`, so "off-machine" is the normal case.
 *
 * Nothing real is lost, and that is an argument rather than an assumption:
 * continuation across a restore is impossible regardless. This archive has never
 * included the projects directory or any worktree, so a restored backup has no
 * worktree for a parked Code task to continue *into*. Carrying the conversation
 * would buy a capability the restore cannot deliver.
 *
 * Operates on the copy `snapshotDatabase()` produced, never on the live database —
 * a backup must not be able to destroy the thing it backs up. A failure is logged
 * and swallowed, because an archive missing one strip is still worth writing, and
 * the caller records whether the strip succeeded.
 */
function stripConversationSnapshots(snapshot: string): boolean {
  let db: Db | null = null;
  try {
    db = openDatabase(snapshot);
    db.exec('DELETE FROM task_messages');
    return true;
  } catch (error) {
    log.warn(`could not strip conversation snapshots from the backup copy: ${String(error)}`);
    return false;
  } finally {
    db?.close();
  }
}

/** Add a directory tree to the zip under `prefix`, skipping symlinks. */
function addTree(zip: AdmZip, root: string, prefix: string): number {
  let files = 0;
  if (!fs.existsSync(root)) return 0;

  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue; // never follow links out of the root
      if (entry.isDirectory()) {
        // Installed dependency trees are deliberately not backed up. They are
        // large, they are machine-specific (a venv hard-codes absolute paths, so
        // it would not even work on the restoring machine), and they are exactly
        // reproducible from the manifests that *are* in the archive. The registry
        // notices they are missing after a restore and re-provisions.
        if (entry.name === '.venv' || entry.name === 'node_modules') continue;
        walk(abs, relPath);
      } else if (entry.isFile()) {

        // Skip our own staging area: half-uploaded skills are not worth
        // restoring and may be large.
        if (relPath.startsWith('.staging/')) continue;
        zip.addFile(prefix + relPath, fs.readFileSync(abs));
        files += 1;
      }
    }
  };

  walk(root, '');
  return files;
}

export function exportBackup(options: ExportOptions = {}): ExportResult {
  const now = Date.now();
  const includeKeys = options.includeKeys ?? false;
  const includeAttachments = options.includeAttachments ?? false;

  const filename = `hyperion-backup-${timestamp(now)}.zip`;
  const outFile = options.outFile ?? resolveInScope('backups', filename);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const zip = new AdmZip();
  const snapshot = snapshotDatabase();

  try {
    stripConversationSnapshots(snapshot);
    zip.addFile(DB_ENTRY, fs.readFileSync(snapshot));

    let mcpConfig = false;
    if (fs.existsSync(env.paths.mcpConfig)) {
      zip.addFile(MCP_ENTRY, fs.readFileSync(env.paths.mcpConfig));
      mcpConfig = true;
    }

    const skills = addTree(zip, getRoot('skills'), SKILLS_PREFIX);
    const attachments = includeAttachments
      ? addTree(zip, getRoot('attachments'), ATTACHMENTS_PREFIX)
      : 0;

    let encryptionKey = false;
    if (includeKeys && fs.existsSync(env.paths.secretKey)) {
      zip.addFile(KEY_ENTRY, fs.readFileSync(env.paths.secretKey));
      encryptionKey = true;
    }

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT_VERSION,
      app: 'Hyperion',
      createdAt: now,
      createdAtIso: new Date(now).toISOString(),
      schemaMigrations: appliedMigrations(),
      contents: { database: true, mcpConfig, skills, attachments, encryptionKey },
      counts: tableCounts(),
      ...(encryptionKey ? { warning: KEY_WARNING } : {}),
    };

    zip.addFile(MANIFEST_ENTRY, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
    zip.writeZip(outFile);

    const bytes = fs.statSync(outFile).size;
    log.info('backup exported', { filename, bytes, includeKeys, includeAttachments });

    return { file: outFile, filename: path.basename(outFile), bytes, manifest };
  } catch (error) {
    throw new AppError('storage_error', `Backup export failed: ${String(error)}`);
  } finally {
    fs.rmSync(snapshot, { force: true });
  }
}

/** Previously exported archives, newest first, for a "download again" list. */
export interface BackupFile {
  filename: string;
  bytes: number;
  createdAt: number;
}

export function listBackups(): BackupFile[] {
  const root = getRoot('backups');
  if (!fs.existsSync(root)) return [];

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.zip'))
    .map((e) => {
      const stat = fs.statSync(path.join(root, e.name));
      return { filename: e.name, bytes: stat.size, createdAt: stat.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function backupPath(filename: string): string {
  // Through the scope, so a filename from a query string can't walk out of the
  // backups directory.
  return resolveInScope('backups', path.basename(filename));
}
