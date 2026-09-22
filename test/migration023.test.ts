/**
 * 023 — `puter` as a fifth provider type (Prompt 1 addendum 1.38).
 *
 * A CHECK constraint is the kind of thing that fails at 3am rather than at
 * review: the type is written by a hand-registered provider, on a database that
 * has been through some version of this schema, and if the constraint does not
 * carry the new value the insert throws while the user is adding it. And this
 * particular migration is a **table rebuild**, which is the operation that has
 * historically lost data here (010 and 012 were written to avoid exactly that).
 *
 * So this file does what no application test can:
 *
 *   1. builds a database at the pre-023 schema and applies **023 from the file on
 *      disk**, so the test cannot pass against a drifted copy of its SQL;
 *   2. puts real rows in first — a provider with every column set, including the
 *      ones four later migrations added (016's ZDR facts, 017's context window,
 *      022's egress proxy) — because a rebuild that copies an older column list
 *      drops those silently, and the only way to notice is to have values in them;
 *   3. asserts the child rows survive: `usage_log` references `providers`, and the
 *      rename dance 002/005 document is exactly where a `REFERENCES` clause gets
 *      repointed at a dropped table;
 *   4. asserts the constraint is what makes the type safe — `puter` is accepted,
 *      and a word this build does not know is still refused, so a future migration
 *      that widens the enum by accident fails here.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const { cleanupHome } = await import('./helpers.ts');
const { openDatabase } = await import('../src/db/adapter.ts');

const MIGRATIONS_DIR = path.join(process.cwd(), 'src', 'db', 'migrations');

after(async () => {
  await cleanupHome();
});

function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

interface ProviderRow {
  id: string;
  name: string;
  type: string;
  base_url: string;
  api_key_hint: string | null;
  priority: number;
  zdr_support: string;
  zdr_confirmed_note: string | null;
  max_context_tokens: number | null;
  egress_proxy: string | null;
}

describe('the 023 migration against a database that predates it', () => {
  it('keeps every provider row, every column, and every child reference', () => {
    const files = migrationFiles();
    const target = files.find((file) => file.startsWith('023_'));
    assert.ok(target, '023 must exist — this test is its guard');

    const legacy = openDatabase(':memory:');
    try {
      legacy.exec('PRAGMA foreign_keys = OFF');
      for (const file of files) {
        if (file === target) break;
        legacy.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      }

      const now = Date.now();
      legacy
        .prepare(
          `INSERT INTO providers (id, name, type, base_url, api_key_enc, api_key_hint, enabled,
             priority, health_status, zdr_support, zdr_flag_key, zdr_flag_value,
             zdr_confirmed_at, zdr_confirmed_note, max_context_tokens, egress_proxy,
             created_at, updated_at)
           VALUES ('p-old', 'Old', 'remote', 'https://old.test/v1', 'enc', 'abcd', 1,
             3, 'healthy', 'zdr_confirmed', 'X-ZDR', 'true', ?, 'checked by hand', 128000,
             'http://proxy.test:3128', ?, ?)`,
        )
        .run(now, now, now);

      // A child row, so the rename dance has something to repoint if it goes wrong.
      legacy
        .prepare(
          `INSERT INTO usage_log (tool, model_id, provider_id, provider_name, created_at)
           VALUES ('chat', 'old-model', 'p-old', 'Old', ?)`,
        )
        .run(now);

      // Enforcement stays OFF across the migration, exactly as the runner has it
      // (`migrate.ts` disables it around each batch, because `PRAGMA foreign_keys`
      // is a no-op inside a transaction). The second test below pins *why*.
      legacy.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, target), 'utf8'));
      legacy.exec('PRAGMA foreign_keys = ON');

      const row = legacy
        .prepare<ProviderRow>(
          `SELECT id, name, type, base_url, api_key_hint, priority, zdr_support,
                  zdr_confirmed_note, max_context_tokens, egress_proxy
             FROM providers WHERE id = 'p-old'`,
        )
        .get();

      assert.ok(row, 'the provider row survived the rebuild');
      assert.deepEqual(row, {
        id: 'p-old',
        name: 'Old',
        type: 'remote',
        base_url: 'https://old.test/v1',
        api_key_hint: 'abcd',
        priority: 3,
        // The four columns that a rebuild carrying 005's column list would drop.
        zdr_support: 'zdr_confirmed',
        zdr_confirmed_note: 'checked by hand',
        max_context_tokens: 128000,
        egress_proxy: 'http://proxy.test:3128',
      });

      // The child still points at `providers`, not at a renamed ghost.
      const child = legacy
        .prepare<{ provider_id: string }>(
          `SELECT provider_id FROM usage_log WHERE provider_name = 'Old'`,
        )
        .get();
      assert.equal(child?.provider_id, 'p-old');
      const dangling = legacy.prepare('PRAGMA foreign_key_check').all();
      assert.deepEqual(dangling, [], 'no REFERENCES clause was left dangling');
    } finally {
      legacy.close();
    }
  });

  it('accepts `puter` and still refuses a type this build does not know', () => {
    const files = migrationFiles();
    const target = files.find((file) => file.startsWith('023_'));
    assert.ok(target);

    const db = openDatabase(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = OFF');
      for (const file of files) db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));

      const insert = (type: string) =>
        db
          .prepare(
            `INSERT INTO providers (id, name, type, base_url, created_at, updated_at)
             VALUES (?, ?, ?, 'https://api.puter.com/puterai/openai/v1', 1, 1)`,
          )
          .run(`p-${type}`, `Puter ${type}`, type);

      assert.doesNotThrow(() => insert('puter'));
      assert.throws(() => insert('somefuturetype'), /CHECK/);
    } finally {
      db.close();
    }
  });
  it('needs foreign keys off, which is what makes the runner responsible for them', () => {
    // Not a wish: this asserts the hazard, so that a future change which enables
    // enforcement around migrations fails here rather than silently nulling every
    // child reference. `usage_log.provider_id` is ON DELETE SET NULL, so the
    // `DROP TABLE providers` at the heart of the rebuild would clear it — which
    // is data loss that no rebuild can undo afterwards.
    const files = migrationFiles();
    const target = files.find((file) => file.startsWith('023_'));
    assert.ok(target);

    const db = openDatabase(':memory:');
    try {
      for (const file of files) {
        if (file === target) break;
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      }
      db.prepare(
        `INSERT INTO providers (id, name, type, base_url, created_at, updated_at)
         VALUES ('p-fk', 'FK', 'remote', 'https://fk.test/v1', 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO usage_log (tool, model_id, provider_id, provider_name, created_at)
         VALUES ('chat', 'm', 'p-fk', 'FK', 1)`,
      ).run();

      db.exec('PRAGMA foreign_keys = ON');
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, target), 'utf8'));

      const child = db
        .prepare<{ provider_id: string | null }>(
          `SELECT provider_id FROM usage_log WHERE provider_name = 'FK'`,
        )
        .get();
      assert.equal(child?.provider_id, null, 'enforcement on would null the child');
    } finally {
      db.close();
    }
  });
});