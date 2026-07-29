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
