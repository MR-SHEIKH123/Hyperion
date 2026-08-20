import './helpers.ts';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

const { freshDb, cleanupHome } = await import('./helpers.ts');
const { startTaskRun, finishTaskRun } = await import('../src/db/taskRuns.ts');
const { recordStep, listSteps, nextStepNumber, summarizeSteps } = await import(
  '../src/db/taskSteps.ts'
);
const { getDb } = await import('../src/db/adapter.ts');

let counter = 0;

/** A live run to hang steps off, with a unique id per call. */
function makeRun(): string {
  counter += 1;
  const runId = `run-${counter}`;
  startTaskRun({ runId, taskId: `task-${counter}`, tool: 'code' });
  return runId;
}

describe('task step history', () => {
  before(async () => {
    await freshDb();
  });

  after(async () => {
    await cleanupHome();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM task_steps').run();
  });

  it('records what a run did, in the order it did it', () => {
    const runId = makeRun();

    recordStep({ runId, step: 1, kind: 'plan', mode: 'plan', detail: 'read the config, then patch it' });
    recordStep({ runId, step: 2, kind: 'tool_call', mode: 'act', toolName: 'read_file', ok: true });
    recordStep({ runId, step: 3, kind: 'tool_call', mode: 'act', toolName: 'write_file', ok: false, detail: 'permission denied' });

    const steps = listSteps(runId);
    assert.deepEqual(
      steps.map((s) => [s.step, s.kind, s.toolName, s.ok]),
      [
        [1, 'plan', null, null],
        [2, 'tool_call', 'read_file', true],
        [3, 'tool_call', 'write_file', false],
      ],
    );
    assert.equal(steps[0]?.mode, 'plan');
    assert.equal(steps[0]?.detail, 'read the config, then patch it');
  });

  it('a step with no outcome reads back as null, not as a failure', () => {
    // `Boolean(row.ok)` would make this `false`, which claims the plan failed.
    // A plan has no outcome to report at all, and the difference is what the UI
    // uses to decide whether to draw a failure marker.
    const runId = makeRun();
    recordStep({ runId, step: 1, kind: 'plan' });
    recordStep({ runId, step: 2, kind: 'note', detail: 'retrying after a provider timeout' });

    for (const step of listSteps(runId)) {
      assert.equal(step.ok, null, `${step.kind} must not report an outcome it never had`);
    }
  });

  it('orders by the ordinal even when the clock disagrees with it', () => {
    // Two steps can land inside the same millisecond, and a clock can be moved
    // backwards under a running process. Either way, ordering by the timestamp
    // would hand back a sequence the run never took. Writing these rows with
    // created_at deliberately inverted against the ordinal is what makes the
    // guarantee testable: relying on same-millisecond ties passed even with
    // ORDER BY created_at, because the tie happened to resolve in index order.
    const runId = makeRun();
    const insert = getDb().prepare(
      'INSERT INTO task_steps (run_id, step, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    insert.run(runId, 1, 'note', 'first', 3_000);
    insert.run(runId, 2, 'note', 'second', 2_000);
    insert.run(runId, 3, 'note', 'third', 1_000);

    assert.deepEqual(
      listSteps(runId).map((s) => s.detail),
      ['first', 'second', 'third'],
    );
  });

  it('the steps of one run are invisible to another', () => {
    const first = makeRun();
    const second = makeRun();
    recordStep({ runId: first, step: 1, kind: 'tool_call', toolName: 'read_file', ok: true });

    assert.equal(listSteps(first).length, 1);
    assert.deepEqual(listSteps(second), []);
  });

  it('a duplicate ordinal is refused without killing the run that reported it', () => {
    // recordStep swallows its failures on purpose: it describes work that has
    // already happened, so a bookkeeping error must not propagate into the loop
    // and abort work the user is waiting on.
    const runId = makeRun();
    recordStep({ runId, step: 1, kind: 'tool_call', toolName: 'read_file', ok: true });

    assert.doesNotThrow(() => {
      recordStep({ runId, step: 1, kind: 'tool_call', toolName: 'write_file', ok: false });
    });

    const steps = listSteps(runId);
    assert.equal(steps.length, 1, 'the duplicate must not have been stored');
    assert.equal(steps[0]?.toolName, 'read_file', 'the original must not have been overwritten');
  });

  it('a step for a run that does not exist is refused without throwing', () => {
    // The realistic path: a restart reconciles the run away, and a straggler
    // still tries to describe a step against the id.
    assert.doesNotThrow(() => {
      recordStep({ runId: 'never-existed', step: 1, kind: 'note', detail: 'orphan' });
    });
    assert.deepEqual(listSteps('never-existed'), []);
  });

  it('an oversized detail is clipped and says so', () => {
    const runId = makeRun();
    recordStep({ runId, step: 1, kind: 'note', detail: 'x'.repeat(5_000) });

    const detail = listSteps(runId)[0]?.detail ?? '';
    assert.ok(detail.length < 5_000, 'a step row must not store a whole transcript');
    assert.ok(detail.endsWith('… (truncated)'), 'a clipped line must be distinguishable from a complete one');
  });

  describe('the next ordinal', () => {
    it('starts at 1 for a run with no steps', () => {
      assert.equal(nextStepNumber(makeRun()), 1);
    });

    it('continues past the highest ordinal rather than counting rows', () => {
      // A gap left by a refused insert must not hand back an ordinal that is
      // already taken, which is what COUNT(*) + 1 would do here.
      const runId = makeRun();
      recordStep({ runId, step: 1, kind: 'note' });
      recordStep({ runId, step: 7, kind: 'note' });

      assert.equal(nextStepNumber(runId), 8);
    });
  });

  describe('the run summary', () => {
    it('counts calls, failures and compressions separately', () => {
      const runId = makeRun();
      recordStep({ runId, step: 1, kind: 'plan' });
      recordStep({ runId, step: 2, kind: 'tool_call', toolName: 'read_file', ok: true, tokensIn: 10, tokensOut: 5 });
      recordStep({ runId, step: 3, kind: 'tool_call', toolName: 'write_file', ok: false, tokensIn: 3, tokensOut: 1 });
      recordStep({ runId, step: 4, kind: 'compression', detail: 'compressed 12 messages', tokensIn: 0, tokensOut: 0 });

      const summary = summarizeSteps(runId);
      assert.equal(summary.steps, 4);
      assert.equal(summary.toolCalls, 2);
      assert.equal(summary.failures, 1);
      assert.equal(summary.compressions, 1);
    });

    it('a plan is not counted as a failure just because it has no outcome', () => {
      const runId = makeRun();
      recordStep({ runId, step: 1, kind: 'plan', tokensIn: 0, tokensOut: 0 });

      assert.equal(summarizeSteps(runId).failures, 0);
    });

    it('token totals report themselves as incomplete when a provider gave no count', () => {
      // The flag is the whole point: a partial sum that presents itself as
      // authoritative silently understates what the run cost.
      const runId = makeRun();
      recordStep({ runId, step: 1, kind: 'tool_call', toolName: 'read_file', ok: true, tokensIn: 10, tokensOut: 5 });
      recordStep({ runId, step: 2, kind: 'tool_call', toolName: 'write_file', ok: true });

      const summary = summarizeSteps(runId);
      assert.equal(summary.tokensIn, 10);
      assert.equal(summary.tokensOut, 5);
      assert.equal(summary.complete, false, 'a floor must not present itself as the real figure');
    });

    it('token totals are complete when every step reported one', () => {
      const runId = makeRun();
      recordStep({ runId, step: 1, kind: 'tool_call', toolName: 'read_file', ok: true, tokensIn: 10, tokensOut: 5 });
      recordStep({ runId, step: 2, kind: 'tool_call', toolName: 'write_file', ok: true, tokensIn: 2, tokensOut: 1 });

      const summary = summarizeSteps(runId);
      assert.equal(summary.tokensIn, 12);
      assert.equal(summary.tokensOut, 6);
      assert.equal(summary.complete, true);
    });

    it('a run with no steps summarizes to zero rather than throwing', () => {
      // SUM() over no rows is NULL, not 0, so every total here comes from a
      // coalesce rather than from SQLite.
      const summary = summarizeSteps(makeRun());
      assert.deepEqual(summary, {
        steps: 0,
        toolCalls: 0,
        failures: 0,
        compressions: 0,
        tokensIn: 0,
        tokensOut: 0,
        complete: true,
      });
    });
  });

  describe('lifetime', () => {
    it('steps outlive the end of the run they describe', () => {
      // The history exists to be read *after* the run ends. If finishing a run
      // dropped its steps there would be nothing left to explain what it did.
      const runId = makeRun();
      recordStep({ runId, step: 1, kind: 'tool_call', toolName: 'read_file', ok: true });

      finishTaskRun(runId, 'stopped', { pauseReason: 'ceiling_reached' });

      assert.equal(listSteps(runId).length, 1);
    });

    it('restarting a run clears the steps of the attempt it supersedes', () => {
      // Two separate pieces of code have to agree for this to hold: task_steps
      // declares ON DELETE CASCADE, and startTaskRun is INSERT OR REPLACE, which
      // performs a real delete that fires the cascade. Nothing in startTaskRun
      // says so, so this is asserted rather than assumed — otherwise a retried
      // run would read back the previous attempt's steps as its own.
      const runId = 'retried-run';
      startTaskRun({ runId, taskId: 'task-retry', tool: 'code' });
      recordStep({ runId, step: 1, kind: 'tool_call', toolName: 'read_file', ok: true });
      assert.equal(listSteps(runId).length, 1);

      startTaskRun({ runId, taskId: 'task-retry', tool: 'code' });

      assert.deepEqual(listSteps(runId), [], 'a superseded attempt must not leave its steps behind');
    });

    it('deleting a run takes its steps with it', () => {
      const runId = makeRun();
      recordStep({ runId, step: 1, kind: 'note', detail: 'something' });

      getDb().prepare('DELETE FROM task_runs WHERE run_id = ?').run(runId);

      assert.deepEqual(listSteps(runId), [], 'no orphaned step may survive its run');
    });
  });

  describe('the schema refuses nonsense', () => {
    it('rejects a kind that is not one of the four', () => {
      const runId = makeRun();
      assert.throws(() => {
        getDb()
          .prepare('INSERT INTO task_steps (run_id, step, kind) VALUES (?, ?, ?)')
          .run(runId, 1, 'freestyle');
      });
    });

    it('rejects a mode outside ask/plan/act while still allowing none at all', () => {
      const runId = makeRun();
      assert.throws(() => {
        getDb()
          .prepare('INSERT INTO task_steps (run_id, step, kind, mode) VALUES (?, ?, ?, ?)')
          .run(runId, 1, 'note', 'yolo');
      });

      assert.doesNotThrow(() => {
        getDb()
          .prepare('INSERT INTO task_steps (run_id, step, kind, mode) VALUES (?, ?, ?, NULL)')
          .run(runId, 2, 'note');
      });
    });

    it('rejects an ok that is neither 0, 1 nor absent', () => {
      const runId = makeRun();
      assert.throws(() => {
        getDb()
          .prepare('INSERT INTO task_steps (run_id, step, kind, ok) VALUES (?, ?, ?, ?)')
          .run(runId, 1, 'tool_call', 2);
      });
    });
  });
});
