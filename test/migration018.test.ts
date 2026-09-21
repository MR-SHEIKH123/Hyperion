/**
 * 018 — per-task cost attribution, and the price-upsert repair it carries.
 *
 * Two things here need guarding, and neither is visible from the application code
 * that depends on them:
 *
 *   1. **The migration must apply to a database that already has the rows it
 *      repairs.** It *deletes* rows — the legacy duplicates `setPrice` created by
 *      accident (S15) — and applying it to a fresh database proves nothing about
 *      that. So this file builds a database at the pre-018 schema, puts a
 *      duplicated global price in it, and then applies 018 **from the migration
 *      file on disk**, so the test cannot pass against a copy of its SQL that has
 *      drifted from the real one.
 *   2. **The invariant has to be the schema's, not `setPrice`'s.** A second global
 *      price row for one model is now refused by the database, which is what makes
 *      the application-level upsert correct rather than merely well-intentioned.
 *      Asserted directly, so a future migration that drops the partial index fails
 *      here instead of silently reintroducing S15.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const { cleanupHome, freshDb } = await import('./helpers.ts');
const { getDb, openDatabase } = await import('../src/db/adapter.ts');
const { findPrice, setPrice } = await import('../src/db/usage.ts');

const MIGRATIONS_DIR = path.join(process.cwd(), 'src', 'db', 'migrations');

after(async () => {
  await cleanupHome();
});

/** Every migration file, in the order the runner applies them. */
function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

describe('the 018 migration against a database that predates it', () => {
  it('repairs duplicated global prices to the newest, and is idempotent about the index', () => {
    const files = migrationFiles();
    const target = files.find((file) => file.startsWith('018_'));
    assert.ok(target, '018 must exist — this test is its guard');

    const legacy = openDatabase(':memory:');
    try {
      // Pre-018 schema, exactly as an existing install would have it. FKs off
      // for the replay because that is how the runner batches migrations
      // (`runMigrations` explains why), and 001..017 create tables in dependency
      // order anyway.
      legacy.exec('PRAGMA foreign_keys = OFF');
      for (const file of files) {
        if (file === target) break;
        legacy.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      }

      // Two global prices for one model: what `setPrice` used to write, and what
      // the user's "update" left behind.
      const insert = legacy.prepare(
        `INSERT INTO model_prices (model_id, provider_id, input_per_1m_usd, output_per_1m_usd, updated_at)
         VALUES (?, NULL, ?, ?, ?)`,
      );
      insert.run('legacy-model', 1, 1, 1_000);
      insert.run('legacy-model', 9, 9, 2_000);
      assert.equal(
        legacy.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM model_prices').get()?.n,
        2,
        'the fixture must reproduce the duplicate state, or the repair is untested',
      );

      legacy.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, target), 'utf8'));

      const survivors = legacy
        .prepare<{ input_per_1m_usd: number; updated_at: number }>(
          'SELECT input_per_1m_usd, updated_at FROM model_prices WHERE model_id = ? ORDER BY id',
        )
        .all('legacy-model');
      assert.equal(survivors.length, 1, 'duplicates collapse to one row per model');
      assert.equal(survivors[0]?.updated_at, 2_000, 'the newest save is the one that survives');
      assert.equal(survivors[0]?.input_per_1m_usd, 9);

      // The new column is there, and the run attribution index with it.
      const columns = legacy
        .prepare<{ name: string }>("SELECT name FROM pragma_table_info('usage_log')")
        .all()
        .map((row) => row.name);
      assert.ok(columns.includes('run_id'), '018 adds usage_log.run_id');

      // The invariant, now enforced by the database rather than by the caller.
      assert.throws(
        () => insert.run('legacy-model', 3, 3, 3_000),
        'a second global price for one model must be refused by the schema',
      );

      // And the FK batch check the runner performs afterwards still passes.
      const violations = legacy.prepare('PRAGMA foreign_key_check').all();
      assert.equal(violations.length, 0, 'a migration that leaves dangling references must not ship');
    } finally {
      legacy.close?.();
    }
  });
});

describe('the invariant on a live database', () => {
  it('refuses a second global row and lets the upsert update the first', async () => {
    await freshDb();
    const db = getDb();

    setPrice({ modelId: 'invariant-model', providerId: null, inputPer1mUsd: 2, outputPer1mUsd: 2 });
    setPrice({ modelId: 'invariant-model', providerId: null, inputPer1mUsd: 7, outputPer1mUsd: 7 });

    const rows = db
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM model_prices WHERE model_id = ?')
      .get('invariant-model');
    assert.equal(rows?.n, 1);
    assert.equal(findPrice('invariant-model', null)?.outputPer1m, 7);

    // A provider-scoped price is a different row, and the index must not have
    // collapsed the two notions of "a price for this model".
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO model_prices (model_id, provider_id, input_per_1m_usd, output_per_1m_usd, updated_at)
           VALUES ('invariant-model', NULL, 1, 1, 1)`,
        )
        .run(),
    );
  });
});
