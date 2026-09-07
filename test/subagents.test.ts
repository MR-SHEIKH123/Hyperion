import './helpers.ts';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const { cleanupHome, freshDb } = await import('./helpers.ts');
const {
  finishSubagentRun,
  getSubagentRun,
  listSubagentRuns,
  startSubagentRun,
} = await import('../src/db/subagents.ts');
const { AppError } = await import('../src/util/errors.ts');

before(async () => {
  await freshDb();
});
after(async () => {
  await cleanupHome();
});

describe('durable bounded subagent runs', () => {
  it('persists parent identity, child identity, order, and terminal result', () => {
    const started = startSubagentRun({
      parentRunId: 'parent-run',
      parentTaskId: 'parent-task',
      childTaskId: 'child-task-1',
      sequence: 1,
      prompt: 'Inspect the parser.',
    });
    assert.equal(started.state, 'running');
    assert.equal(started.depth, 1);
    assert.deepEqual(listSubagentRuns('parent-task').map((run) => run.childTaskId), ['child-task-1']);

    finishSubagentRun(started.id, 'complete', { summary: 'Parser inspected.' });
    const finished = getSubagentRun(started.id);
    assert.equal(finished?.state, 'complete');
    assert.equal(finished?.summary, 'Parser inspected.');
    assert.ok(finished?.completedAt);
  });

  it('enforces one sequence slot and unique child identity in the database', () => {
    startSubagentRun({ parentTaskId: 'bounded-parent', childTaskId: 'bounded-child-1', sequence: 1, prompt: 'One' });
    assert.throws(
      () => startSubagentRun({ parentTaskId: 'bounded-parent', childTaskId: 'bounded-child-2', sequence: 1, prompt: 'Duplicate order' }),
      /UNIQUE|constraint/i,
    );
    assert.throws(
      () => startSubagentRun({ parentTaskId: 'other-parent', childTaskId: 'bounded-child-1', sequence: 2, prompt: 'Duplicate child' }),
      /UNIQUE|constraint/i,
    );
  });

  it('rejects invalid starts and missing terminal updates as AppErrors', () => {
    assert.throws(
      () => startSubagentRun({ parentTaskId: '', childTaskId: 'child', sequence: 1, prompt: 'x' }),
      (error: unknown) => error instanceof AppError && error.code === 'bad_request',
    );
    // A complete error result on purpose: `finishSubagentRun` validates the
    // request before it touches the database, so an incomplete one reports
    // `bad_request` and never reaches the lookup this line is asserting.
    assert.throws(
      () =>
        finishSubagentRun('missing', 'error', {
          errorCode: 'internal_error',
          errorMessage: 'the child never started',
        }),
      (error: unknown) => error instanceof AppError && error.code === 'not_found',
    );
  });

  it('permits exactly one bounded terminal update', () => {
    const started = startSubagentRun({
      parentTaskId: 'terminal-parent',
      childTaskId: 'terminal-child',
      sequence: 1,
      prompt: 'Inspect the bounded lifecycle.',
    });
    finishSubagentRun(started.id, 'error', {
      summary: 'The child could not continue.',
      errorCode: 'aborted',
      errorMessage: 'The parent cancelled the run.',
    });

    assert.throws(
      () => finishSubagentRun(started.id, 'complete', { summary: 'This must not overwrite the error.' }),
      (error: unknown) => error instanceof AppError && error.code === 'conflict',
    );
    assert.equal(getSubagentRun(started.id)?.errorCode, 'aborted');
    assert.throws(
      () => startSubagentRun({ parentTaskId: 'long', childTaskId: 'long-child', sequence: 1, prompt: 'x'.repeat(16_001) }),
      (error: unknown) => error instanceof AppError && error.code === 'bad_request',
    );
  });
});