/**
 * 020 — `interrupted` as a task run state (Prompt 1, item 1.31).
 *
 * A CHECK constraint is the kind of thing that fails at 3am rather than at
 * review: the state is written by boot reconciliation, on a database that has
 * been through some version of this schema, and if the constraint does not carry
 * the new value the update throws during startup — when the process is already
 * recovering from a crash. So this file does what no application test can:
 *
 *   1. builds a database at the pre-020 schema, with real rows in it (a
 *      `running` row, a legacy `error` + `internal_error` row, and a finished
 *      one), then applies **020 from the file on disk**, so the test cannot pass
 *      against a drifted copy of its SQL;
 *   2. asserts the rows survived the rebuild unchanged — a table rebuild that
 *      silently drops rows is the failure mode 010 and 012 were written to avoid;
 *   3. asserts the constraint is what makes the state safe: `interrupted` is
 *      accepted and an unknown word is still refused, so a future migration that
 *      widens the enum by accident fails here.
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

interface RunRow {
  run_id: string;
  state: string;
  error_code: string | null;
  error_message: string | null;
  completed_at: number | null;
}

describe('the 020 migration against a database that predates it', () => {
  it('keeps every row, and accepts the state it was written to allow', () => {
    const files = migrationFiles();
    const target = files.find((file) => file.startsWith('020_'));
    assert.ok(target, '020 must exist — this test is its guard');

    const legacy = openDatabase(':memory:');
    try {
      legacy.exec('PRAGMA foreign_keys = OFF');
      for (const file of files) {
        if (file === target) break;
        legacy.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      }

      // Rows an existing install would have. The two error rows are the point:
      // one is the shape 020 supersedes (a run the old code demoted to `error`),
      // the other a run that genuinely failed, and the rebuild must not
      // conflate them.
      const insert = legacy.prepare(
        `INSERT INTO task_runs (run_id, task_id, tool, state, pause_reason, error_code, error_message, started_at, updated_at, completed_at)
         VALUES (?, ?, 'code', ?, NULL, ?, ?, 1, 2, ?)`,
      );
      insert.run('legacy-running', 'task-1', 'running', null, null, null);
      insert.run(
        'legacy-demoted',
        'task-2',
        'error',
        'internal_error',
        'The server restarted while this task was running.',
        3,
      );
      insert.run('legacy-failed', 'task-3', 'error', 'provider_timeout', 'The provider timed out.', 4);
      insert.run('legacy-complete', 'task-4', 'complete', null, null, 5);

      // The state the migration adds is refused by the schema it replaces — which
      // is what boot reconciliation used to hit, and the reason this file exists.
      assert.throws(
        () => legacy.prepare(`UPDATE task_runs SET state = 'interrupted' WHERE run_id = 'legacy-running'`).run(),
        /CHECK constraint failed/i,
      );

      legacy.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, target), 'utf8'));

      const rows = legacy
        .prepare<RunRow>('SELECT run_id, state, error_code, error_message, completed_at FROM task_runs ORDER BY run_id')
        .all();
      assert.deepEqual(
        rows.map((row) => row.run_id),
        ['legacy-complete', 'legacy-demoted', 'legacy-failed', 'legacy-running'],
        'the rebuild copied every row, not just the ones the new state touches',
      );
      assert.deepEqual(
        rows.find((row) => row.run_id === 'legacy-demoted'),
        {
          run_id: 'legacy-demoted',
          state: 'error',
          error_code: 'internal_error',
          error_message: 'The server restarted while this task was running.',
          completed_at: 3,
        },
        'history is not rewritten: a pre-020 demotion stays `error` with its code',
      );

      // The reason the migration exists: reconciliation can write the new state.
      legacy
        .prepare(`UPDATE task_runs SET state = 'interrupted', completed_at = 6 WHERE run_id = 'legacy-running'`)
        .run();
      const demoted = legacy.prepare<RunRow>('SELECT run_id, state, error_code, error_message, completed_at FROM task_runs WHERE run_id = ?').get('legacy-running');
      assert.equal(demoted?.state, 'interrupted');

      // And the constraint is still a constraint.
      assert.throws(
        () => legacy.prepare(`UPDATE task_runs SET state = 'not_a_state' WHERE run_id = 'legacy-running'`).run(),
        /CHECK constraint failed/i,
      );
    } finally {
      legacy.close();
    }
  });
});
