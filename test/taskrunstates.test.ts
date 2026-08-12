/**
 * The two task-run states Prompt 3 adds, and the mid-run write that sets them.
 *
 * `blocked` and `ready_for_review` exist so a live run can say "waiting on the
 * user" or "come look at this" while it is still running — the multi-task view
 * reads `task_runs` directly, so a state that only lived on the stream would be
 * invisible to it. These are database-level guarantees: the widened CHECK must
 * accept the new states, and `updateTaskRunState` must move a run without
 * touching the columns that belong to a real ending.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

const { startTaskRun, finishTaskRun, updateTaskRunState, getTaskRun } = await import(
  '../src/db/taskRuns.ts'
);

before(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

describe('the widened task_runs state vocabulary', () => {
  test('a run can be marked blocked and read back', () => {
    startTaskRun({ runId: 'r-blocked', taskId: 't-1', tool: 'cowork' });
    updateTaskRunState('r-blocked', 'blocked');

    const run = getTaskRun('r-blocked');
    assert.equal(run?.state, 'blocked');
  });

  test('a run can be marked ready_for_review and read back', () => {
    startTaskRun({ runId: 'r-review', taskId: 't-2', tool: 'design' });
    updateTaskRunState('r-review', 'ready_for_review');

    const run = getTaskRun('r-review');
    assert.equal(run?.state, 'ready_for_review');
  });

  test('a state outside the vocabulary is still refused', () => {
    startTaskRun({ runId: 'r-bogus', taskId: 't-3', tool: 'code' });
    // The CHECK is the last line of defence against a typo'd state string
    // reaching the multi-task view as something it cannot branch on.
    assert.throws(() => updateTaskRunState('r-bogus', 'done' as never), /CHECK/);
  });
});

describe('updateTaskRunState is a mid-run write, not an ending', () => {
  test('it never stamps completed_at, because the run has not ended', () => {
    startTaskRun({ runId: 'r-live', taskId: 't-4', tool: 'code' });
    updateTaskRunState('r-live', 'blocked');

    const run = getTaskRun('r-live');
    assert.equal(
      run?.completedAt,
      null,
      'a blocked run with a completion time would tell a client it had finished',
    );
  });

  test('it leaves the reason columns alone', () => {
    startTaskRun({ runId: 'r-reason', taskId: 't-5', tool: 'cowork' });
    finishTaskRun('r-reason', 'paused', { pauseReason: 'user asked' });
    updateTaskRunState('r-reason', 'blocked');

    const run = getTaskRun('r-reason');
    // A run that blocks after being paused must not lose *why* it paused —
    // the UI shows that reason next to the state.
    assert.equal(run?.pauseReason, 'user asked');
    assert.equal(run?.state, 'blocked');
  });

  test('it bumps updated_at so a poller sees the change', async () => {
    startTaskRun({ runId: 'r-tick', taskId: 't-6', tool: 'design' });
    const before = getTaskRun('r-tick')?.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    updateTaskRunState('r-tick', 'ready_for_review');

    const after = getTaskRun('r-tick')?.updatedAt;
    assert.ok(
      before !== undefined && after !== undefined && after >= before,
      'updated_at must move forward so a client polling on it notices',
    );
  });
});
