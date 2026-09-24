/**
 * The daily automatic backup.
 *
 * `exportBackup` has always existed; what was missing is anything that calls it
 * without the user asking. A backup feature that only runs when someone
 * remembers to press the button is not a backup feature — the data loss it
 * exists to prevent happens on exactly the days nobody was thinking about it.
 *
 * Three decisions here:
 *
 *   1. **Same options as the default manual export**: no `secret.key`, no
 *      attachments. An unattended job that quietly wrote a plaintext credential
 *      store to disk every night would be a worse security posture than having
 *      no automatic backup at all, and bundling attachments would make the
 *      nightly job the largest disk consumer on the machine.
 *
 *   2. **Retention is enforced here, not by the cleanup sweep.** Automatic
 *      backups are the only files in the backups root this job is entitled to
 *      remove, so it only ever deletes archives matching its own naming and
 *      never touches an export the user took by hand.
 *
 *   3. **It takes the app-wide lock in queue mode.** `VACUUM INTO` on a
 *      database being written to by a live generation is the exact scenario the
 *      lock exists for, and a backup is patient — it would rather wait than
 *      collide, and rather be skipped than fail loudly at 3am.
 */

import fs from 'node:fs';

import { env } from '../../config/env.ts';

import { withLock } from '../../orchestrator/lock.ts';
import { getRoot } from '../../security/fsScope.ts';
import { createIntervalJob, type IntervalJob } from '../../util/intervalJob.ts';
import { createLogger } from '../../util/logger.ts';

import { backupPath, exportBackup, listBackups } from './export.ts';
import { maybeUploadToS3, mirrorToLocalDestination } from './destinations.ts';

const log = createLogger('backup:auto');

const DAY_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = DAY_MS;
/**
 * Five minutes rather than the cleanup job's one. Both fire near boot, and an
 * export competing with the first cleanup sweep for the same database is a
 * pointless collision that the lock would resolve by making one of them wait
 * anyway.
 */
const BOOT_DELAY_MS = 5 * 60_000;

/**
 * Marks an archive as this job's own. `exportBackup` names every file
 * `hyperion-backup-<timestamp>.zip`, so an automatic one needs its own prefix
 * to be distinguishable from a manual export — retention must never delete a
 * backup the user took deliberately.
 */
const AUTO_PREFIX = 'hyperion-auto-';

function isAutoBackup(filename: string): boolean {
  return filename.startsWith(AUTO_PREFIX) && filename.endsWith('.zip');
}

function timestamp(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

export interface AutoBackupResult {
  filename: string;
  bytes: number;
  /** Automatic archives removed by retention on this run. */
  pruned: string[];
  /** Absolute path of the off-machine copy, when one is configured. */
  mirrored: string | null;
  /** S3 object key of the uploaded copy, when S3 is enabled and configured. */
  s3Key: string | null;
}

/**
 * Take one automatic backup and apply retention. Exported so the tests (and a
 * future "back up now" button) can run it without waiting a day.
 *
 * Fan-out order is mirror, then S3, then retention: both destinations copy an
 * archive the pruner only ever deletes old versions of, and neither destination
 * can fail the run — the mirror degrades to `mirrored: null`, the S3 leg to
 * `s3Key: null` plus an `error_log` row.
 */
export async function runAutoBackup(): Promise<AutoBackupResult> {
  return await withLock({ tool: 'chat', label: 'automatic backup', mode: 'queue' }, async () => {
    const outFile = backupPath(`${AUTO_PREFIX}${timestamp(Date.now())}.zip`);
    const result = await exportBackup({ outFile });
    const mirrored = mirrorToLocalDestination(result.filename);
    const s3Key = await maybeUploadToS3(result.file, result.filename);
    const pruned = pruneAutoBackups();
    log.info('automatic backup complete', {
      filename: result.filename,
      bytes: result.bytes,
      ...(pruned.length > 0 ? { pruned: pruned.length } : {}),
      ...(mirrored === null ? {} : { mirrored }),
      ...(s3Key === null ? {} : { s3Key }),
    });
    return { filename: result.filename, bytes: result.bytes, pruned, mirrored, s3Key };

  });
}

/**
 * Keep the newest `autoBackupKeep` automatic archives, delete the rest.
 * Manual exports are filtered out before anything is considered for deletion.
 */
function pruneAutoBackups(keep = env.autoBackupKeep): string[] {
  if (keep <= 0) return [];

  const auto = listBackups().filter((file) => isAutoBackup(file.filename));
  // listBackups() is already newest-first, so everything past `keep` is old.
  const doomed = auto.slice(keep);
  const removed: string[] = [];

  for (const file of doomed) {
    try {
      fs.unlinkSync(backupPath(file.filename));
      removed.push(file.filename);
    } catch (error) {
      // A backup that cannot be pruned is untidy, not broken. Never let it
      // fail the run that just produced a good archive.
      log.warn('could not prune an old automatic backup', {
        filename: file.filename,
        error: String(error),
      });
    }
  }
  return removed;
}

const job: IntervalJob = createIntervalJob({
  name: 'backup scheduler',
  intervalMs: INTERVAL_MS,
  bootDelayMs: BOOT_DELAY_MS,
  disabled: env.schedulerDisabled,
  logContext: { keep: env.autoBackupKeep, root: getRoot('backups') },
  tick: runAutoBackup,
});

export function startBackupScheduler(): void {
  job.start();
}

export function stopBackupScheduler(): void {
  job.stop();
}

/** Test seam: run the daily job now and wait for it. */
export function runBackupSchedulerNow(): Promise<void> {
  return job.runNow();
}
