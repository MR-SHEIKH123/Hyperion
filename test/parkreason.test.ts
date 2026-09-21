/**
 * A parked run records *why*, and the two readers that were waiting for that
 * (1.31).
 *
 * `parkRun` wrote the state and nothing else. Two places were already written as
 * if it wrote a reason, which is how the gap stayed invisible:
 *
 *   - `attention/queue.ts` uses `run.pause_reason ?? <a generic sentence>` as the
 *     detail of its `blocked` / `paused` / `ready_for_review` items. A fallback
 *     sentence only makes sense if a sentence was expected — and because nothing
 *     wrote the column, the fallback is what every parked run actually showed.
 *   - the unattended-run notification worded itself from `result.ok`, so a
 *     scheduled run that parked *to ask a question* was announced as **failed**.
 *
 * Three claims are tested here, and each is a way the fix could be wrong:
 *
 *   - **The column holds a token, not a sentence.** Every other writer writes
 *     `cancelled` / `ceiling_reached` / `approval_denied`; putting prose in the
 *     same column would be unreadable by any of them later.
 *   - **A bare transition still clears nothing.** The old contract for
 *     `updateTaskRunState` — that it never rewrites reason columns — is preserved
 *     for callers that do not state a reason, so a run that becomes
 *     `ready_for_review` cannot lose an earlier, still-true `ceiling_reached`.
 *   - **A park is never announced as a failure**, and the words come from the
 *     reason rather than from a generic sentence.
 */
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

const { startTaskRun, finishTaskRun, latestRunForTask, getTaskRun, updateTaskRunState } =
  await import('../src/db/taskRuns.ts');
const { parkSummary, isParkReason } = await import('../src/services/agent/parkMessages.ts');
const { scheduledRunNotification } = await import('../src/services/cowork/scheduler.ts');
const { parkRun } = await import('../src/services/agent/loop.ts');

const TASK = { id: 'task-1', name: 'Nightly sweep' };

type ParkContext = Parameters<typeof parkRun>[0];

/** A ctx stub: `parkRun` only ever emits and logs. */
function parkCtx(): { ctx: ParkContext; events: { event: string; payload: unknown }[] } {
  const events: { event: string; payload: unknown }[] = [];
  const ctx = {
    emit: (event: string, payload: unknown) => {
      events.push({ event, payload });
    },
    log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
  } as unknown as ParkContext;
  return { ctx, events };
}

beforeEach(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

describe('the park reason is recorded as a token', () => {
  it('parkRun writes the state and the reason together', () => {
    startTaskRun({ runId: 'run-1', taskId: 'task-1', tool: 'cowork' });
    const { ctx } = parkCtx();

    parkRun(ctx, 'run-1', 'plan_ready', 'two steps planned');

    const run = getTaskRun('run-1');
    assert.equal(run?.state, 'ready_for_review', 'the state is unchanged from before');
    assert.equal(run?.pauseReason, 'plan_ready', 'and the reason now rides with it');
  });

  it('records the state-mapping reasons on the states they map to', () => {
    for (const [reason, state] of [
      ['redaction_blocked', 'blocked'],
      ['zdr_blocked', 'blocked'],
      ['iteration_ceiling', 'blocked'],
      ['approval_required', 'ready_for_review'],
      ['doom_loop', 'ready_for_review'],
    ] as const) {
      const runId = `run-${reason}`;
      startTaskRun({ runId, taskId: `task-${reason}`, tool: 'cowork' });
      parkRun(parkCtx().ctx, runId, reason, 'detail');
      const run = getTaskRun(runId);
      assert.equal(run?.state, state, reason);
      assert.equal(run?.pauseReason, reason);
    }
  });

  it('a bare transition still moves only the state', () => {
    // The contract this function had before 1.31, kept for callers that do not
    // state a reason: a run that becomes `ready_for_review` must not lose a
    // reason an earlier phase recorded.
    startTaskRun({ runId: 'run-2', taskId: 'task-2', tool: 'cowork' });
    updateTaskRunState('run-2', 'blocked', { pauseReason: 'redaction_blocked' });
    updateTaskRunState('run-2', 'ready_for_review');

    const run = getTaskRun('run-2');
    assert.equal(run?.state, 'ready_for_review');
    assert.equal(run?.pauseReason, 'redaction_blocked', 'an unstated reason is not a cleared one');
  });

  it('a state route reports the reason a parked run is parked for', () => {
    // The reason is what the frontend's task machine renders for `blocked`
    // (`{kind:'approval_required', reason}`), which was null for every park.
    startTaskRun({ runId: 'run-3', taskId: 'task-3', tool: 'code' });
    parkRun(parkCtx().ctx, 'run-3', 'context_exhausted', 'window full');

    const run = latestRunForTask('code', 'task-3');
    assert.equal(run?.pauseReason, 'context_exhausted');
  });
});

describe('the sentence for a reason belongs to the display, not the column', () => {
  it('translates the reasons a user can act on, and distinguishes them', () => {
    // `redaction_blocked` invites review and approval; `zdr_blocked` must not —
    // there is nothing to approve, and a sentence that suggested otherwise would
    // send the user looking for a button that does not exist.
    const redaction = parkSummary('redaction_blocked');
    const zdr = parkSummary('zdr_blocked');
    assert.ok(redaction && zdr);
    assert.notEqual(redaction, zdr);
    assert.match(redaction, /credential/i);
    assert.match(zdr, /zero-data-retention/i);
  });

  it('says nothing for a token it does not know, rather than guessing', () => {
    // The column is shared with stops that are not parks (`cancelled`,
    // `ceiling_reached`) and can hold a token from a newer build.
    for (const unknown of ['cancelled', 'ceiling_reached', 'approval_denied', '', 'a sentence']) {
      assert.equal(parkSummary(unknown), null, unknown);
      assert.equal(isParkReason(unknown), false, unknown);
    }
    assert.equal(parkSummary(null), null);
    assert.equal(parkSummary(undefined), null);
    assert.equal(isParkReason('plan_ready'), true);
  });
});

describe('an unattended run says what it needs, not that it failed', () => {
  const failed = { ok: false, summary: 'Stopped before it finished.' };

  it('a parked plan reads as waiting for review', () => {
    const payload = scheduledRunNotification(
      TASK,
      { state: 'ready_for_review', pauseReason: 'plan_ready' },
      failed,
    );
    assert.equal(payload.title, 'Nightly sweep is waiting for your review');
    assert.equal(payload.body, parkSummary('plan_ready'));
    assert.doesNotMatch(payload.body, /did not finish/i);
    assert.equal(payload.tag, 'scheduled-task:task-1', 'repeat notices collapse in the tray');
    assert.equal(payload.url, '/cowork');
  });

  it('a blocked run reads as paused, with the reason', () => {
    const payload = scheduledRunNotification(
      TASK,
      { state: 'blocked', pauseReason: 'zdr_blocked' },
      failed,
    );
    assert.equal(payload.title, 'Nightly sweep is paused');
    assert.equal(payload.body, parkSummary('zdr_blocked'));
  });

  it('a park with no recorded reason still reads as a park, never as a failure', () => {
    for (const state of ['blocked', 'ready_for_review'] as const) {
      const payload = scheduledRunNotification(TASK, { state, pauseReason: null }, failed);
      assert.match(payload.title, /waiting for your review|is paused/);
      assert.doesNotMatch(payload.title, /failed/);
      assert.doesNotMatch(payload.body, /did not finish/i);
    }
  });

  it('a stop that is not a park keeps the old wording', () => {
    // `cancelled` is the user's own decision and `ceiling_reached` is a rule they
    // set; neither is a park, and neither should borrow the park wording.
    const payload = scheduledRunNotification(
      TASK,
      { state: 'stopped', pauseReason: 'cancelled' },
      { ok: false, summary: 'Stopped before it finished.' },
    );
    assert.equal(payload.title, 'Nightly sweep failed');
    assert.equal(payload.body, 'Stopped before it finished.');
  });

  it('a completed run is unchanged', () => {
    const payload = scheduledRunNotification(TASK, { state: 'complete', pauseReason: null }, {
      ok: true,
      summary: 'Wrote three notes.',
    });
    assert.equal(payload.title, 'Nightly sweep finished');
    assert.equal(payload.body, 'Wrote three notes.');
  });

  it('a run with no row at all is reported by its result', () => {
    const payload = scheduledRunNotification(TASK, null, { ok: true, summary: '' });
    assert.equal(payload.title, 'Nightly sweep finished');
    assert.equal(payload.body, 'Completed with no summary.');
  });
});

describe('the reason reaches a run that really parked, through the scheduler', () => {
  it('a stub agent that parks leaves the reason the notification reads', async () => {
    const { createScheduledTask, requireScheduledTask, listScheduledTasks } = await import(
      '../src/services/cowork/scheduledTasks.ts'
    );
    const { runScheduledTask } = await import('../src/services/cowork/scheduler.ts');
    const { registerAgent, resetModules } = await import('../src/orchestrator/agents.ts');
    const { resetLock } = await import('../src/orchestrator/lock.ts');

    resetModules();
    resetLock();
    // The same shape `scheduledtasks.test.ts` uses: a schedule string in the
    // canonical `daily:HH:MM` form, and a creation time far enough back that the
    // never-run guard does not suppress the slot.
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const created = createScheduledTask({
      name: 'Nightly sweep',
      prompt: 'sweep',
      modelId: 'mock-model',
      schedule: `daily:${String(anHourAgo.getHours()).padStart(2, '0')}:${String(anHourAgo.getMinutes()).padStart(2, '0')}`,
    });
    const task = requireScheduledTask(created.id);
    const { getDb } = await import('../src/db/adapter.ts');
    getDb()
      .prepare('UPDATE scheduled_tasks SET created_at = ? WHERE id = ?')
      .run(Date.now() - 86_400_000, task.id);

    registerAgent('cowork', {
      async runTask(_input, ctx) {
        // The real park path, not a hand-written row: the point is that the
        // scheduler reads what `parkRun` wrote.
        parkRun(ctx, ctx.runId, 'plan_ready', 'a plan was produced');
        return { ok: false, summary: 'Stopped before it finished.' };
      },
    });

    await runScheduledTask(task.id);

    const listed = listScheduledTasks();
    assert.equal(listed.length, 1);
    const taskId = listed[0]?.id ?? task.id;
    const run = latestRunForTask('cowork', taskId);
    assert.equal(run?.state, 'ready_for_review');
    assert.equal(run?.pauseReason, 'plan_ready');
    const payload = scheduledRunNotification({ id: taskId, name: 'Nightly sweep' }, run, {
      ok: false,
      summary: 'Stopped before it finished.',
    });
    assert.equal(payload.title, 'Nightly sweep is waiting for your review');
    assert.doesNotMatch(payload.title, /failed/);
  });
});

describe('a finished run is not left with a stale park reason', () => {
  it('finishing rewrites the reason columns, as it always has', () => {
    startTaskRun({ runId: 'run-4', taskId: 'task-4', tool: 'cowork' });
    updateTaskRunState('run-4', 'blocked', { pauseReason: 'redaction_blocked' });
    finishTaskRun('run-4', 'complete');

    const run = getTaskRun('run-4');
    assert.equal(run?.state, 'complete');
    assert.equal(run?.pauseReason, null, 'the park is over; the reason describes nothing now');
  });
});
