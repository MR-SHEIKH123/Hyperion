/**
 * Storage/cleanup engine.
 *
 * Two timers, from the spec:
 *   - assets untouched for 3 months are deleted (`last_accessed_at`)
 *   - chats not opened for 4 months are deleted (`last_opened_at`)
 *
 * And one absolute rule that overrides both: **a pinned item never expires.**
 * Pinning is the user saying "keep this" — it is not a hint or a sort order, so
 * pinned rows are excluded in SQL rather than filtered afterwards, where a
 * future refactor could quietly drop the check.
 *
 * Archived chats get the same protection. Archiving means "keep this, just out
 * of my way" — an intentional filing decision, not a step toward deletion — so
 * it would be a betrayal for the sweep to treat it as neglect.
 *
 * Design notes worth keeping:
 *
 *   - This code deletes user data, so every run writes a `cleanup_log` row
 *     (including dry runs). If the user ever asks "where did my file go", the
 *     answer is in the database, not lost in stdout.
 *
 *   - `dryRun` is a first-class mode, not a debug flag. The Settings UI can
 *     preview exactly what a real run would remove before anything happens.
 *
 *   - Deleting a chat cascades to its messages (FK ON DELETE CASCADE) but its
 *     attachments are ON DELETE SET NULL — deliberately. A generated image is
 *     still the user's file after they delete the conversation that produced
 *     it; it becomes an orphan asset and lives out its own 3-month timer.
 *
 *   - Rows whose file has already vanished from disk are reaped regardless of
 *     age. They are not assets, they're litter; keeping them would show broken
 *     tiles in the gallery forever.
 *
 *   - The scheduler is a plain `setInterval`, not a cron dependency. It is
 *     unref'd so it can never hold the process open during shutdown, and it
 *     runs shortly after boot as well as on the interval, because a machine
 *     that gets rebooted daily would otherwise never reach a 24h tick.
 */

import fs from 'node:fs';
import path from 'node:path';

import { env } from '../../config/env.ts';
import { getDb } from '../../db/adapter.ts';
import { getRoot } from '../../security/fsScope.ts';
import { createLogger } from '../../util/logger.ts';
import { pruneStaging } from '../skills/intake.ts';

import { deleteAsset, type AssetRow } from './gallery.ts';

const log = createLogger('cleanup');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Run daily; also runs once shortly after boot (see `startCleanupScheduler`). */
const INTERVAL_MS = DAY_MS;
const BOOT_DELAY_MS = 60_000;

export interface CleanupOptions {
  dryRun?: boolean;
  /** Overrides for testing / manual runs; default to the env config. */
  assetTtlDays?: number;
  chatTtlDays?: number;
  /** Injectable clock so tests don't have to wait three months. */
  now?: number;
}

export interface CleanupResult {
  ranAt: number;
  dryRun: boolean;
  assetTtlDays: number;
  chatTtlDays: number;
  chatsDeleted: number;
  assetsDeleted: number;
  bytesFreed: number;
  emptyDirsRemoved: number;
  stagingPruned: number;
  /** Names/ids kept for the log row so a deletion is explainable afterwards. */
  detail: {
    chats: { id: string; title: string | null; lastOpenedAt: number }[];
    assets: { id: string; filename: string; bytes: number; reason: 'expired' | 'file_missing' }[];
  };
}

/**
 * The core sweep. Synchronous and single-pass: the DB is local, the volumes are
 * tiny, and doing it inline means we never interleave with a live request in a
 * way that half-deletes something.
 */
export function runCleanup(options: CleanupOptions = {}): CleanupResult {
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun ?? false;
  const assetTtlDays = options.assetTtlDays ?? env.assetTtlDays;
  const chatTtlDays = options.chatTtlDays ?? env.chatTtlDays;

  const assetCutoff = now - assetTtlDays * DAY_MS;
  const chatCutoff = now - chatTtlDays * DAY_MS;

  const db = getDb();
  const detail: CleanupResult['detail'] = { chats: [], assets: [] };
  let bytesFreed = 0;

  // --- assets -------------------------------------------------------------
  // `pinned = 0` in the WHERE clause, not a post-filter: exemption is a
  // property of the query, so no code path can forget it.
  const expiredAssets = db
    .prepare<AssetRow>(
      `SELECT * FROM attachments
        WHERE pinned = 0 AND last_accessed_at < ?
        ORDER BY last_accessed_at ASC`,
    )
    .all(assetCutoff);

  for (const row of expiredAssets) {
    detail.assets.push({
      id: row.id,
      filename: row.filename,
      bytes: row.bytes,
      reason: 'expired',
    });
    if (!dryRun) {
      bytesFreed += deleteAsset(row.id);
    } else {
      bytesFreed += row.bytes;
    }
  }

  // Rows whose bytes are already gone: reap at any age, but still respect the
  // pin — a pinned-but-missing row is something the user asked us to keep, and
  // its absence is worth showing them rather than silently tidying away.
  const survivors = db
    .prepare<{ id: string; filename: string; bytes: number; rel_path: string }>(
      'SELECT id, filename, bytes, rel_path FROM attachments WHERE pinned = 0',
    )
    .all();

  for (const row of survivors) {
    const abs = path.join(getRoot('attachments'), row.rel_path);
    if (fs.existsSync(abs)) continue;
    detail.assets.push({
      id: row.id,
      filename: row.filename,
      bytes: row.bytes,
      reason: 'file_missing',
    });
    if (!dryRun) deleteAsset(row.id, { keepFile: true });
  }

  // --- chats --------------------------------------------------------------
  const expiredChats = db
    .prepare<{ id: string; title: string | null; last_opened_at: number }>(
      `SELECT id, title, last_opened_at FROM chats
        WHERE pinned = 0 AND archived = 0 AND last_opened_at < ?
        ORDER BY last_opened_at ASC`,
    )
    .all(chatCutoff);

  for (const row of expiredChats) {
    detail.chats.push({ id: row.id, title: row.title, lastOpenedAt: row.last_opened_at });
  }

  if (!dryRun && expiredChats.length > 0) {
    // One transaction: either the whole batch of conversations goes or none
    // does. A half-applied sweep is much harder to explain than a failed one.
    const deleteChats = db.transaction(() => {
      const stmt = db.prepare('DELETE FROM chats WHERE id = ?');
      for (const row of expiredChats) stmt.run(row.id);
    });
    deleteChats();
  }

  // --- housekeeping -------------------------------------------------------
  const emptyDirsRemoved = dryRun ? 0 : removeEmptyMonthDirs();
  const stagingPruned = dryRun ? 0 : pruneStaging();

  const result: CleanupResult = {
    ranAt: now,
    dryRun,
    assetTtlDays,
    chatTtlDays,
    chatsDeleted: detail.chats.length,
    assetsDeleted: detail.assets.length,
    bytesFreed,
    emptyDirsRemoved,
    stagingPruned,
    detail,
  };

  recordCleanup(result);

  if (result.chatsDeleted > 0 || result.assetsDeleted > 0) {
    log.info(dryRun ? 'cleanup preview' : 'cleanup complete', {
      chats: result.chatsDeleted,
      assets: result.assetsDeleted,
      bytesFreed: result.bytesFreed,
    });
  } else {
    log.debug('cleanup found nothing to remove');
  }

  return result;
}

/**
 * Prune the yyyy-mm buckets left behind once their contents expire. Only ever
 * removes directories that are *empty*, and only one level under the
 * attachments root, so there is no recursive-delete surface here at all.
 */
function removeEmptyMonthDirs(): number {
  const root = getRoot('attachments');
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        removed += 1;
      }
    } catch {
      // A directory that's busy or already gone is not a cleanup failure.
    }
  }
  return removed;
}

function recordCleanup(result: CleanupResult): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO cleanup_log
           (ran_at, chats_deleted, assets_deleted, bytes_freed, dry_run, detail_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.ranAt,
        result.chatsDeleted,
        result.assetsDeleted,
        result.bytesFreed,
        result.dryRun,
        JSON.stringify(result.detail),
      );
  } catch (error) {
    // Failing to write the audit row must not turn into a failed cleanup.
    log.warn('could not write cleanup_log row', { error: String(error) });
  }
}

export interface CleanupLogEntry {
  id: number;
  ranAt: number;
  chatsDeleted: number;
  assetsDeleted: number;
  bytesFreed: number;
  dryRun: boolean;
  detail: unknown;
}

export function listCleanupLog(limit = 50): CleanupLogEntry[] {
  const rows = getDb()
    .prepare<{
      id: number;
      ran_at: number;
      chats_deleted: number;
      assets_deleted: number;
      bytes_freed: number;
      dry_run: number;
      detail_json: string | null;
    }>('SELECT * FROM cleanup_log ORDER BY ran_at DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 500));

  return rows.map((row) => {
    let detail: unknown = null;
    if (row.detail_json) {
      try {
        detail = JSON.parse(row.detail_json);
      } catch {
        detail = null;
      }
    }
    return {
      id: row.id,
      ranAt: row.ran_at,
      chatsDeleted: row.chats_deleted,
      assetsDeleted: row.assets_deleted,
      bytesFreed: row.bytes_freed,
      dryRun: row.dry_run === 1,
      detail,
    };
  });
}

// --- scheduler -------------------------------------------------------------

let bootTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

/**
 * Start the background job. Safe to call twice (the second call is ignored),
 * and a no-op when HYPERION_CLEANUP_DISABLED is set — which is the switch to
 * reach for while debugging, rather than commenting this out.
 */
export function startCleanupScheduler(): void {
  if (env.cleanupDisabled) {
    log.info('cleanup scheduler disabled by configuration');
    return;
  }
  if (intervalTimer || bootTimer) return;

  const tick = (): void => {
    try {
      runCleanup();
    } catch (error) {
      // A crashed sweep must not take the server with it; it'll try again
      // tomorrow.
      log.error('cleanup run failed', { error: String(error) });
    }
  };

  bootTimer = setTimeout(() => {
    bootTimer = null;
    tick();
  }, BOOT_DELAY_MS);
  bootTimer.unref();

  intervalTimer = setInterval(tick, INTERVAL_MS);
  intervalTimer.unref();

  log.info('cleanup scheduler started', {
    assetTtlDays: env.assetTtlDays,
    chatTtlDays: env.chatTtlDays,
    everyHours: INTERVAL_MS / 3_600_000,
  });
}

export function stopCleanupScheduler(): void {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}
