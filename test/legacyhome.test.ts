/**
 * The one-time ~/AIStudio -> ~/Hyperion data directory migration.
 *
 * Both paths are injectable, so every case here runs against throwaway
 * directories and never touches the real home.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { cleanupHome } from './helpers.ts';

const { migrateLegacyHome } = await import('../src/config/env.ts');

const scratchRoots: string[] = [];

/** A scratch parent per case, so cases cannot see each other's directories. */
function scratch(): { legacy: string; target: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-legacy-'));
  scratchRoots.push(base);
  return { legacy: path.join(base, 'AIStudio'), target: path.join(base, 'Hyperion') };
}

describe('legacy home migration', () => {
  after(async () => {
    for (const root of scratchRoots) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    await cleanupHome();
  });

  it('moves the legacy directory when only it exists', () => {
    const { legacy, target } = scratch();
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'secret.key'), 'key-material');

    const result = migrateLegacyHome(legacy, target);

    assert.equal(result.migrated, true);
    assert.equal(result.conflict, false);
    assert.equal(fs.existsSync(legacy), false, 'legacy directory should be gone');
    assert.equal(fs.readFileSync(path.join(target, 'secret.key'), 'utf8'), 'key-material');
  });

  it('renames the database and its WAL siblings', () => {
    const { legacy, target } = scratch();
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'aistudio.db'), 'main');
    fs.writeFileSync(path.join(legacy, 'aistudio.db-shm'), 'shm');
    fs.writeFileSync(path.join(legacy, 'aistudio.db-wal'), 'wal');

    const result = migrateLegacyHome(legacy, target);

    assert.equal(result.migrated, true);
    assert.equal(result.renamed.length, 3);
    assert.equal(fs.readFileSync(path.join(target, 'hyperion.db'), 'utf8'), 'main');
    assert.equal(fs.readFileSync(path.join(target, 'hyperion.db-shm'), 'utf8'), 'shm');
    // Dropping the WAL would silently discard committed-but-uncheckpointed writes.
    assert.equal(fs.readFileSync(path.join(target, 'hyperion.db-wal'), 'utf8'), 'wal');
    assert.equal(fs.existsSync(path.join(target, 'aistudio.db')), false);
  });

  it('does nothing when there is no legacy directory', () => {
    const { legacy, target } = scratch();

    const result = migrateLegacyHome(legacy, target);

    assert.equal(result.migrated, false);
    assert.equal(result.conflict, false);
    assert.equal(fs.existsSync(target), false, 'must not create the target as a side effect');
  });

  it('refuses to merge when both directories exist', () => {
    const { legacy, target } = scratch();
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'hyperion.db'), 'old');
    fs.writeFileSync(path.join(target, 'hyperion.db'), 'current');

    const result = migrateLegacyHome(legacy, target);

    assert.equal(result.migrated, false);
    assert.equal(result.conflict, true);
    assert.match(result.reason ?? '', /both/);
    // Neither side may be touched: burying a live database under a stale one is
    // exactly the loss this refusal exists to prevent.
    assert.equal(fs.readFileSync(path.join(legacy, 'hyperion.db'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(target, 'hyperion.db'), 'utf8'), 'current');
  });

  it('is a no-op when legacy and target are the same directory', () => {
    const { legacy } = scratch();
    fs.mkdirSync(legacy, { recursive: true });

    const result = migrateLegacyHome(legacy, legacy);

    assert.equal(result.migrated, false);
    assert.equal(result.conflict, false);
    assert.equal(fs.existsSync(legacy), true);
  });

  it('is safe to run twice', () => {
    const { legacy, target } = scratch();
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'aistudio.db'), 'main');

    const first = migrateLegacyHome(legacy, target);
    const second = migrateLegacyHome(legacy, target);

    assert.equal(first.migrated, true);
    assert.equal(second.migrated, false);
    assert.equal(second.conflict, false, 'second run sees no legacy dir, not a conflict');
    assert.equal(fs.readFileSync(path.join(target, 'hyperion.db'), 'utf8'), 'main');
  });
});
