/**
 * 027 — `task_runs.project_id`, the column a per-project task listing stands on.
 *
 * `ALTER TABLE ... ADD COLUMN` is the migration shape that cannot lose the
 * existing rows — but this one adds a **foreign key**, and it is the only
 * migration in this schema that does, so the interesting properties are all
 * about what that reference does to rows written before it existed:
 *
 *   1. legacy runs survive, and their `project_id` is NULL — not derived from
 *      whichever project happens to be open now. Migration 008's `active`
 *      pointer moves; a run's project must not;
 *   2. `ON DELETE SET NULL` keeps a run when its project is removed, because
 *      "take this off my list" must not erase the record that work happened —
 *      the run becomes unattributed, which the listing reports as such;
 *   3. the reference is enforced, so a run cannot be stamped with a project id
 *      that does not exist. Without that the listing could be asked to show work
 *      for a project that was never there.
 *
 * The database is built from the migration files on disk and 027 is applied from
 * its own file, so this cannot pass against a drifted copy of the SQL. The
 * `ON DELETE` behaviour is asserted with foreign keys **on**, which is how the
 * running app has them (`applyPragmas`).
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

/** A database at the schema the moment before 027, in memory. */
function preTwentySeven(files: string[]): { db: ReturnType<typeof openDatabase>; target: string } {
  const target = files.find((file) => file.startsWith('027_'));
  assert.ok(target, '027 must exist — this test is its guard');

  const db = openDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  for (const file of files) {
    if (file === target) break;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return { db, target };
}

function applyTarget(db: ReturnType<typeof openDatabase>, target: string): void {
  db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, target), 'utf8'));
  db.exec('PRAGMA foreign_keys = ON');
}

interface LegacyRun {
  run_id: string;
  task_id: string;
  tool: string;
  state: string;
  project_id: string | null;
}

describe('the 027 migration against a database that predates it', () => {
  it('adds the column without touching legacy runs, and leaves them unattributed', () => {
    const files = migrationFiles();
    const { db, target } = preTwentySeven(files);
    try {
      const now = Date.now();
      // A run mid-flight at the moment of upgrade: the exact row a listing would
      // be tempted to attribute to whatever project is open when it is read.
      db.prepare(
        `INSERT INTO task_runs (run_id, task_id, tool, state, started_at, updated_at)
         VALUES ('run-legacy', 'task-legacy', 'code', 'running', ?, ?)`,
      ).run(now, now);

      applyTarget(db, target);

      const row = db
        .prepare<LegacyRun>(
          `SELECT run_id, task_id, tool, state, project_id FROM task_runs
            WHERE run_id = 'run-legacy'`,
        )
        .get();

      assert.deepEqual(row, {
        run_id: 'run-legacy',
        task_id: 'task-legacy',
        tool: 'code',
        state: 'running',
        // NULL, deliberately: the run predates the column and its project is not
        // recoverable after the fact.
        project_id: null,
      });

      const columns = db
        .prepare<{ name: string; notnull: number }>('PRAGMA table_info(task_runs)')
        .all()
        .map((column) => column.name);
      assert.equal(columns.includes('project_id'), true);
      assert.equal(columns.includes('continued_from'), true, 'the 020 column is still there');

      const index = db
        .prepare<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_runs_project'`,
        )
        .get();
      assert.ok(index, 'the listing index is part of the migration, not a later fix');

      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
  });

  it('deleting a project un-attributes its runs instead of deleting them', () => {
    const files = migrationFiles();
    const { db, target } = preTwentySeven(files);
    try {
      applyTarget(db, target);

      const now = Date.now();
      db.prepare(
        `INSERT INTO projects (id, name, path, managed, created_at, last_opened_at)
         VALUES ('p-1', 'One', '/tmp/one', 1, ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO task_runs (run_id, task_id, tool, state, project_id, started_at, updated_at)
         VALUES ('run-1', 'task-1', 'cowork', 'running', 'p-1', ?, ?)`,
      ).run(now, now);

      db.prepare(`DELETE FROM projects WHERE id = 'p-1'`).run();

      const row = db
        .prepare<LegacyRun>(`SELECT run_id, project_id, state FROM task_runs WHERE run_id = 'run-1'`)
        .get();
      assert.equal(row?.project_id, null, 'the run outlives the project, unattributed');
      assert.equal(row?.state, 'running', 'and it is still the run it was');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
  });

  it('refuses a project id that names no project', () => {
    const files = migrationFiles();
    const { db, target } = preTwentySeven(files);
    try {
      applyTarget(db, target);
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO task_runs (run_id, task_id, tool, state, project_id, started_at, updated_at)
               VALUES ('run-ghost', 'task-ghost', 'code', 'running', 'p-ghost', 1, 1)`,
            )
            .run(),
        /FOREIGN KEY/i,
        'the column is a reference, not a free-text label',
      );
    } finally {
      db.close();
    }
  });
});
