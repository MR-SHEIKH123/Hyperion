import './helpers.ts';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const { freshDb, cleanupHome } = await import('./helpers.ts');
const { getDb } = await import('../src/db/adapter.ts');
const { startTaskRun } = await import('../src/db/taskRuns.ts');
const { listSteps, recordStep } = await import('../src/db/taskSteps.ts');

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
}

interface ForeignKeyRow {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

function columns(table: string): ColumnRow[] {
  return getDb().prepare<ColumnRow>(`PRAGMA table_info(${table})`).all();
}

function columnNames(table: string): string[] {
  return columns(table).map((column) => column.name);
}

before(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

/**
 * 017 rebuilt `task_steps`, and a rebuild is the one migration shape that can
 * pass every automatic check while quietly losing a guarantee.
 * `PRAGMA foreign_key_check` catches a dangling reference; it cannot catch a
 * *missing* `ON DELETE CASCADE`, because a table without one is perfectly valid
 * schema. 014's header calls that clause "a property of two separate pieces of
 * code agreeing", with nothing in `startTaskRun` saying so — which makes this
 * file the only guard.
 */
describe('the 017 task_steps rebuild', () => {
  it('kept ON DELETE CASCADE on the run reference', () => {
    const keys = getDb()
      .prepare<ForeignKeyRow>('PRAGMA foreign_key_list(task_steps)')
      .all();
    const runKey = keys.find((key) => key.from === 'run_id');

    assert.ok(runKey, 'task_steps must still reference task_runs');
    assert.equal(runKey.table, 'task_runs');
    assert.equal(runKey.to, 'run_id');
    assert.equal(
      runKey.on_delete.toUpperCase(),
      'CASCADE',
      'without CASCADE a retried run reads back the previous attempt’s steps as its own',
    );
  });

  it('still clears a superseded attempt when startTaskRun replaces the row', () => {
    // The property the CASCADE exists for, asserted end to end rather than by
    // reading the schema: startTaskRun is INSERT OR REPLACE, and the REPLACE
    // performs a real delete that fires the cascade.
    const runId = 'rebuild-retry';
    startTaskRun({ runId, taskId: 'rebuild-task', tool: 'code' });
    recordStep({ runId, step: 1, kind: 'tool_call', toolName: 'read', ok: true });
    assert.equal(listSteps(runId).length, 1);

    startTaskRun({ runId, taskId: 'rebuild-task', tool: 'code' });
    assert.deepEqual(listSteps(runId), []);
  });

  it('kept the primary key that makes a duplicate ordinal impossible', () => {
    const keyColumns = getDb()
      .prepare<{ name: string; pk: number }>('PRAGMA table_info(task_steps)')
      .all()
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);

    assert.deepEqual(keyColumns, ['run_id', 'step']);
  });

  it('kept every column it copied forward, in a readable order', () => {
    const names = columnNames('task_steps');
    for (const column of ['run_id', 'step', 'mode', 'kind', 'tool_name', 'ok', 'detail', 'tokens_in', 'tokens_out', 'created_at']) {
      assert.ok(names.includes(column), `${column} was lost in the rebuild`);
    }
  });

  it('added the profile, provenance and richer token columns', () => {
    const names = columnNames('task_steps');
    for (const column of ['profile', 'provenance', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
      assert.ok(names.includes(column), `${column} is missing`);
    }
  });

  it('left the new token columns nullable, so a missing count is not a zero', () => {
    // Same rule 014 applies to tokens_in/tokens_out: a sum over defaulted zeroes
    // reads as complete when it is not.
    const nullable = columns('task_steps').filter((column) => column.notnull === 0).map((column) => column.name);
    for (const column of ['reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens', 'profile', 'provenance']) {
      assert.ok(nullable.includes(column), `${column} must be nullable`);
    }
  });

  it('kept the mode CHECK, which a UI control maps onto', () => {
    const runId = 'rebuild-mode';
    startTaskRun({ runId, taskId: 'rebuild-mode-task', tool: 'code' });

    assert.throws(() => {
      getDb()
        .prepare('INSERT INTO task_steps (run_id, step, kind, mode) VALUES (?, ?, ?, ?)')
        .run(runId, 1, 'note', 'yolo');
    });
  });

  it('records a profile and its provenance on a step', () => {
    const runId = 'rebuild-provenance';
    startTaskRun({ runId, taskId: 'rebuild-provenance-task', tool: 'code' });
    recordStep({
      runId,
      step: 1,
      kind: 'tool_call',
      mode: 'act',
      profile: 'docs-only',
      provenance: 'allow (project:docs/**) for write',
      toolName: 'write',
      ok: true,
    });

    const step = listSteps(runId)[0];
    assert.equal(step?.profile, 'docs-only');
    assert.equal(step?.provenance, 'allow (project:docs/**) for write');
  });

  it('reads absent provenance back as null rather than an empty string', () => {
    const runId = 'rebuild-absent';
    startTaskRun({ runId, taskId: 'rebuild-absent-task', tool: 'code' });
    recordStep({ runId, step: 1, kind: 'note', detail: 'nothing decided this' });

    const step = listSteps(runId)[0];
    assert.equal(step?.profile, null);
    assert.equal(step?.provenance, null);
    assert.equal(step?.reasoningTokens, null);
  });
});

describe('the 017 column additions', () => {
  it('gave usage_log its task and cache columns, all nullable', () => {
    // Nullable with no CHECK and no default, for the reason 016's header gives:
    // recordUsage swallows its own errors, so a NOT NULL column converts a missing
    // value into a silently discarded spend row.
    const usage = columns('usage_log');
    for (const column of ['task_id', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
      const found = usage.find((entry) => entry.name === column);
      assert.ok(found, `${column} is missing`);
      assert.equal(found.notnull, 0, `${column} must be nullable`);
    }
  });

  it('gave chats their fork provenance', () => {
    const names = columnNames('chats');
    assert.ok(names.includes('forked_from'));
    assert.ok(names.includes('forked_at_message_id'));
  });

  it('points forked_from at chats with SET NULL, so deleting the original keeps the branch', () => {
    const keys = getDb().prepare<ForeignKeyRow>('PRAGMA foreign_key_list(chats)').all();
    const fork = keys.find((key) => key.from === 'forked_from');

    assert.ok(fork, 'forked_from must reference chats');
    assert.equal(fork.table, 'chats');
    assert.equal(fork.on_delete.toUpperCase(), 'SET NULL');
  });

  it('gave providers a recordable context window', () => {
    assert.ok(columnNames('providers').includes('max_context_tokens'));
  });
});

describe('the 017 new tables', () => {
  it('created pending_approvals with a CHECK on its lifecycle column', () => {
    const names = columnNames('pending_approvals');
    for (const column of ['id', 'run_id', 'task_id', 'tool', 'tool_name', 'arguments', 'permission_key', 'state']) {
      assert.ok(names.includes(column), `${column} is missing`);
    }

    assert.throws(() => {
      getDb()
        .prepare(
          `INSERT INTO pending_approvals
             (id, task_id, tool, tool_name, arguments, permission_key, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('bad-state', 'task', 'code', 'write', '{}', 'write', 'maybe', Date.now());
    }, 'state is a lifecycle, not a description, so it keeps its CHECK');
  });

  it('gave task_messages no foreign key, so a retried attempt cannot erase a snapshot', () => {
    // Follows 015 verbatim: task_runs is INSERT OR REPLACE, so a cascading relation
    // would delete the conversation during exactly the restart it must survive.
    const keys = getDb().prepare<ForeignKeyRow>('PRAGMA foreign_key_list(task_messages)').all();
    assert.deepEqual(keys, []);
  });

  it('keys task_messages by (task_id, seq), so ordering and identity cannot disagree', () => {
    const keyColumns = getDb()
      .prepare<{ name: string; pk: number }>('PRAGMA table_info(task_messages)')
      .all()
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);

    assert.deepEqual(keyColumns, ['task_id', 'seq']);
  });

  it('created context_handoffs with a CHECK naming which summary was produced', () => {
    const names = columnNames('context_handoffs');
    for (const column of ['id', 'task_id', 'summary', 'structured', 'summary_source']) {
      assert.ok(names.includes(column), `${column} is missing`);
    }

    assert.throws(() => {
      getDb()
        .prepare(
          `INSERT INTO context_handoffs (id, task_id, tool, summary, summary_source, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('bad-source', 'task', 'code', 'a summary', 'vibes', Date.now());
    });
  });
});
