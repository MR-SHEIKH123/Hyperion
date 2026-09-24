/**
 * The off-machine mirror copy of an automatic backup.
 *
 * `HYPERION_BACKUP_DEST` exists so an archive can survive the disk that held the
 * database. Two properties make it trustworthy, and neither was covered:
 *
 *   1. It is a **copy, not a move**. The backups root is what `listBackups`,
 *      `/api/backup/inspect`, import and retention all read, so an archive that
 *      relocated itself into a sync folder would quietly break every one of
 *      them — while still looking like a successful backup.
 *
 *   2. A **failed mirror is not a failed backup**. The archive is already
 *      written by the time the copy is attempted, so an unmounted network drive
 *      or a full destination must degrade to `mirrored: null` and leave the
 *      backup where it is. Failing the run would throw away a good archive over
 *      a secondary convenience.
 *
 * Both cases are driven through the exported `runAutoBackup` — which is also the
 * only path production uses — rather than calling `mirrorToLocalDestination`
 * directly, so the suite pins the wiring as well as the copy.
 *
 * Note the import order below. `env.backupDest` is resolved once, when
 * `config/env.ts` is first imported, so `HYPERION_BACKUP_DEST` is set in this
 * module's body: after `helpers.ts` has created the throwaway home (its own
 * import side effect) and before the first `await import()` of anything under
 * `src/`. Setting it inside `before()` would be too late, and a static `src/`
 * import here would be hoisted above the assignment and read an empty dest.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before, describe, it } from 'node:test';

import './helpers.ts';
import { cleanupHome, freshDb, testHome } from './helpers.ts';

/**
 * Deliberately not created here. The happy path asserts that mirroring creates
 * its own destination, and the failure path replaces this path with a *file* so
 * the `mkdirSync` inside `mirrorBackup` fails — a cross-platform way to make a
 * directory unusable, unlike permission bits, which Windows largely ignores on
 * directories.
 */
const mirrorDir = path.join(testHome, 'offsite-mirror');
process.env.HYPERION_BACKUP_DEST = mirrorDir;

let runAutoBackup: typeof import('../src/services/backup/schedule.ts').runAutoBackup;
let backupPath: typeof import('../src/services/backup/export.ts').backupPath;

before(async () => {
  await freshDb();
  ({ runAutoBackup } = await import('../src/services/backup/schedule.ts'));
  ({ backupPath } = await import('../src/services/backup/export.ts'));
});

after(async () => {
  await cleanupHome();
});

describe('the off-machine backup mirror', () => {
  it('copies the archive to the destination and leaves the original in place', async () => {
    const result = await runAutoBackup();

    assert.notEqual(result.mirrored, null, 'a configured destination should be reported');
    const mirrored = result.mirrored as string;

    assert.equal(
      path.dirname(mirrored),
      path.resolve(mirrorDir),
      'the copy belongs in the configured destination',
    );
    assert.equal(path.basename(mirrored), result.filename);
    assert.ok(fs.existsSync(mirrored), 'the mirrored copy should exist on disk');

    // The whole point of the second assertion: a move would satisfy the first.
    const original = backupPath(result.filename);
    assert.ok(fs.existsSync(original), 'the archive must remain in the backups root');

    assert.equal(
      fs.statSync(mirrored).size,
      fs.statSync(original).size,
      'the copy should be byte-for-byte the same size as the archive',
    );
    assert.ok(result.bytes > 0, 'a real archive was written');
  });

  it('reports no mirror but keeps the backup when the destination cannot be written', async () => {
    // Replace the destination directory with a file: mkdirSync then fails, which
    // is what an unmounted drive or an unwritable parent looks like from here.
    fs.rmSync(mirrorDir, { recursive: true, force: true });
    fs.writeFileSync(mirrorDir, 'not a directory');

    const result = await runAutoBackup();

    assert.equal(result.mirrored, null, 'an unusable destination reports no mirror');
    assert.ok(
      fs.existsSync(backupPath(result.filename)),
      'the backup itself must survive a failed mirror',
    );
    assert.ok(result.bytes > 0, 'the archive is complete despite the mirror failing');
    assert.equal(result.pruned.length, 0, 'nothing is pruned while under the retention limit');
  });
});
