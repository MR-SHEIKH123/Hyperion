/**
 * The restore audit trail (Prompt 1.29), read and written.
 *
 * A restore replaces the database, so the row describing it is written **after**
 * the swap against the reopened handle — the record then lives inside the
 * database the restore produced (migration `024` argues this at length). Two
 * consequences worth stating where the code is, rather than only where the schema
 * is:
 *
 *   * A refused restore is recorded too, and it is recorded *before* anything is
 *     touched, because the interesting near-misses are the ones that did not
 *     happen: someone tried to restore a stale archive and was stopped.
 *   * The write is **best-effort on the refusal path and mandatory on the success
 *     path**. Refusal already has an error to raise, and a failure to write a log
 *     row must not replace that message; a successful restore that cannot be
 *     recorded is a real problem, but the restore has already happened by then, so
 *     it is logged rather than thrown — the alternative is telling a user their
 *     completed restore failed.
 *
 * Nothing here takes a passphrase, and no column has room for one.
 */
import { getDb } from './adapter.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('restore');

export type RestoreOutcome = 'dry_run' | 'restored' | 'refused';

export interface RestoreAuditInput {
  /** What the caller called the archive, when it had a name. */
  filename?: string | null;
  bytes: number;
  /** Digest of the file as it arrived — the container, never a decrypted payload. */
  sha256: string;
  encrypted: boolean;
  dryRun: boolean;
  restored: boolean;
  outcome: RestoreOutcome;
  /** A short human-readable line; the refusal reason on the refusal path. */
  detail?: string | null;
  preRestoreBackup?: string | null;
}

export interface RestoreAuditEntry {
  id: number;
  createdAt: number;
  filename: string | null;
  bytes: number;
  sha256: string;
  encrypted: boolean;
  dryRun: boolean;
  restored: boolean;
  outcome: RestoreOutcome;
  detail: string | null;
  preRestoreBackup: string | null;
}

interface RestoreAuditRow {
  id: number;
  created_at: number;
  filename: string | null;
  bytes: number;
  sha256: string;
  encrypted: number;
  dry_run: number;
  restored: number;
  outcome: RestoreOutcome;
  detail: string | null;
  pre_restore_backup: string | null;
}

function toEntry(row: RestoreAuditRow): RestoreAuditEntry {
  return {
    id: row.id,
    createdAt: row.created_at,
    filename: row.filename,
    bytes: row.bytes,
    sha256: row.sha256,
    encrypted: row.encrypted === 1,
    dryRun: row.dry_run === 1,
    restored: row.restored === 1,
    outcome: row.outcome,
    detail: row.detail,
    preRestoreBackup: row.pre_restore_backup,
  };
}

/**
 * Record one restore attempt. Returns the new row id, or null when the write
 * failed — see the header for why that is a return value rather than a throw.
 */
export function recordRestoreAudit(input: RestoreAuditInput): number | null {
  try {
    const result = getDb()
      .prepare(
        `INSERT INTO restore_audit
           (created_at, filename, bytes, sha256, encrypted, dry_run, restored, outcome, detail,
            pre_restore_backup)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        input.filename ?? null,
        input.bytes,
        input.sha256,
        input.encrypted ? 1 : 0,
        input.dryRun ? 1 : 0,
        input.restored ? 1 : 0,
        input.outcome,
        input.detail ?? null,
        input.preRestoreBackup ?? null,
      );
    return Number(result.lastInsertRowid);
  } catch (error) {
    log.warn(`could not record a restore in the audit trail: ${String(error)}`);
    return null;
  }
}

/** Restores and dry runs, newest first. */
export function listRestoreAudit(limit = 50): RestoreAuditEntry[] {
  const rows = getDb()
    .prepare<RestoreAuditRow>(
      `SELECT id, created_at, filename, bytes, sha256, encrypted, dry_run, restored, outcome,
              detail, pre_restore_backup
         FROM restore_audit
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit);
  return rows.map(toEntry);
}
