/**
 * Forward-only migration runner.
 *
 * Each `migrations/NNN_name.sql` file is applied once, in filename order, inside
 * a transaction, and recorded in `_migrations`. Applied files are checksummed:
 * editing a migration that has already run is a mistake worth failing loudly on,
 * because the schema in the file no longer matches the schema on disk.
 *
 * Runnable directly (`npm run migrate`) and also called during bootstrap, so a
 * fresh checkout needs no manual setup step.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDb, type Db } from './adapter.ts';
import { ensureDirectories } from '../config/env.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('migrate');
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

interface MigrationRow {
  name: string;
  checksum: string;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Reads the connection's current foreign-key enforcement flag.
 * Returns true when unreadable, because adapter.ts turns FKs ON per connection
 * and restoring them is the safer guess.
 */
function foreignKeysOn(db: Db): boolean {
  try {
    const row = db.prepare<{ foreign_keys: number }>('PRAGMA foreign_keys').get();
    return (row?.foreign_keys ?? 1) !== 0;
  } catch {
    return true;
  }
}

interface ForeignKeyViolation {
  table: string;
  parent: string;
}

/**
 * Guards against the classic table-rebuild mistake: `ALTER TABLE x RENAME TO
 * x_old` rewrites every child table's REFERENCES clause to point at `x_old`,
 * so dropping `x_old` leaves the children referencing a table that no longer
 * exists. Nothing complains until the first INSERT into a child table, which
 * then fails with an opaque "no such table: main.x_old" at runtime. Checking
 * here turns that into a migration-time failure with a name attached.
 */
function assertForeignKeysIntact(db: Db): void {
  let rows: ForeignKeyViolation[];
  try {
    rows = db.prepare<ForeignKeyViolation>('PRAGMA foreign_key_check').all();
  } catch (err) {
    throw new Error(
      `Post-migration foreign-key check failed: ${(err as Error).message}. ` +
        'A migration probably rebuilt a table and left child REFERENCES clauses dangling.',
    );
  }
  if (rows.length === 0) return;
  const sample = rows
    .slice(0, 5)
    .map((r) => `${r.table} -> ${r.parent}`)
    .join(', ');
  throw new Error(
    `Post-migration foreign-key check found ${rows.length} violation(s): ${sample}` +
      (rows.length > 5 ? ', …' : ''),
  );
}


export function runMigrations(db: Db = getDb()): { applied: string[]; skipped: number } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const already = new Map<string, string>(
    db
      .prepare<MigrationRow>('SELECT name, checksum FROM _migrations')
      .all()
      .map((r) => [r.name, r.checksum]),
  );

  const files = fs.existsSync(migrationsDir)
    ? fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
    : [];

  const applied: string[] = [];
  let skipped = 0;

  // FK enforcement is disabled for the whole batch, out here rather than inside
  // a migration, because `PRAGMA foreign_keys` is a no-op inside a transaction
  // and every migration body runs in one. The concrete reason it is needed: a
  // table rebuild ends with `DROP TABLE <original>`, and with FKs ON that DROP
  // fires the children's referential actions — `ON DELETE SET NULL` on
  // chats/messages/chat_runs/usage_log and `ON DELETE CASCADE` on model_prices
  // would quietly wipe or blank rows the migration just copied forward.
  //
  // What this does NOT do (verified against SQLite 3.53.2): it does not stop
  // `ALTER TABLE p RENAME TO p_old` from rewriting every child's `REFERENCES p`
  // into `REFERENCES p_old`. Only `PRAGMA legacy_alter_table = ON` suppresses
  // that. So a rebuild must never rename the original out of the way — build
  // `<table>_new`, copy into it, drop the original, then rename the new table
  // into place. No child ever names `<table>_new`, so no clause is touched.
  //
  // adapter.ts turns FKs ON per connection, so turn them off here and restore
  // them afterwards. Nothing else shares this connection during bootstrap.
  const restoreForeignKeys = foreignKeysOn(db);
  if (restoreForeignKeys) db.exec('PRAGMA foreign_keys = OFF');

  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const checksum = sha256(sql);
      const previous = already.get(file);

      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `Migration "${file}" was modified after being applied ` +
              `(recorded ${previous.slice(0, 12)}, now ${checksum.slice(0, 12)}). ` +
              'Migrations are immutable — add a new migration file instead of editing this one.',
          );
        }
        skipped++;
        continue;
      }

      // Statement-level failure must not leave the schema half-built.
      db.transaction(() => {
        db.exec(sql);
        db.prepare(
          'INSERT INTO _migrations (name, checksum, applied_at) VALUES (?, ?, ?)',
        ).run(file, checksum, Date.now());
      })();  
      
      applied.push(file);
      log.info(`applied ${file}`);
    }

    // Only worth paying for when the schema actually moved.
    if (applied.length > 0) assertForeignKeysIntact(db);
  } finally {
    if (restoreForeignKeys) db.exec('PRAGMA foreign_keys = ON');
  }

  return { applied, skipped };
}


/** True when the schema has at least one migration applied. */
export function isInitialized(db: Db = getDb()): boolean {
  const row = db
    .prepare<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='_migrations'",
    )
    .get();
  if (!row || row.n === 0) return false;
  const count = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM _migrations').get();
  return (count?.n ?? 0) > 0;
}

// Direct invocation: `node src/db/migrate.ts`.
// pathToFileURL is required for correctness on Windows, where a naive
// `file://${argv[1]}` yields `file://C:/...` but import.meta.url is
// `file:///C:/...` — the comparison silently never matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureDirectories();
  const db = getDb();
  const result = runMigrations(db);
  log.info(
    `database ready via ${db.backend} — ${result.applied.length} applied, ${result.skipped} already current`,
  );
}
