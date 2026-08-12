/**
 * Scheduled tasks: schedule parsing, due-ness, and what happens when the app is
 * already busy.
 *
 * The busy case is the one worth the most care. A scheduled task that comes due
 * mid-run must queue rather than collide, and if it never gets the lock the run
 * is recorded as `skipped` — not `failed`, because nothing went wrong — with
 * `last_run_at` still stamped so it waits for its next slot instead of retrying
 * on every tick for the rest of the day.
 *
 * Everything here drives the real `runScheduledTask` against a registered stub
 * agent and the real job lock. A test that reimplemented the due calculation
 * would pass while the scheduler sat idle.
 */
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { cleanupHome, freshDb } from './helpers.ts';

import type { AgentModule, TaskResult } from '../src/types/core.ts';

// Must be set before config/env.ts is imported below, which resolves it once.
// The default is 15 minutes — the wait a real scheduled task is willing to
// spend queueing behind the user — which would hang the busy test for a quarter
// of an hour rather than exercising it.
process.env.HYPERION_SCHEDULED_TASK_WAIT_MS = '20';

// Imported after helpers.ts has set HYPERION_HOME.
const {
  createScheduledTask,
  deleteScheduledTask,
  dueScheduledTasks,
  finishRun,
  formatSchedule,
  isDue,
  listScheduledTasks,
  listTaskRuns,
  nextOccurrence,
  parseSchedule,
  previousOccurrence,
  requireScheduledTask,
  startRun,
  updateScheduledTask,
} = await import('../src/services/cowork/scheduledTasks.ts');
const { runDueTasks, runScheduledTask } = await import('../src/services/cowork/scheduler.ts');
const { registerAgent, resetModules } = await import('../src/orchestrator/agents.ts');
const { resetLock, withLock } = await import('../src/orchestrator/lock.ts');
const { getDb } = await import('../src/db/adapter.ts');

const DAY = 24 * 60 * 60 * 1000;

/** A task that came due an hour ago, so `isDue` is true without any clock games. */
function dueTask(overrides: { name?: string; enabled?: boolean } = {}) {
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const task = createScheduledTask({
    name: overrides.name ?? 'Morning digest',
    prompt: 'Summarise yesterday.',
    schedule: `daily:${String(anHourAgo.getHours()).padStart(2, '0')}:${String(anHourAgo.getMinutes()).padStart(2, '0')}`,
    modelId: 'mock-model',
    ...(overrides.enabled === undefined ? {} : { enabled: overrides.enabled }),
  });
  // Backdate creation so the never-run guard ("don't fire off a slot that
  // predates the task") does not suppress it.
  getDb()
    .prepare('UPDATE scheduled_tasks SET created_at = ? WHERE id = ?')
    .run(Date.now() - DAY, task.id);
  return requireScheduledTask(task.id);
}

/** Registers a cowork agent that reports `result` without touching a provider. */
function stubAgent(result: TaskResult, onRun?: () => void): void {
  const module: AgentModule = {
    async runTask() {
      onRun?.();
      return result;
    },
  };
  registerAgent('cowork', module);
}

beforeEach(async () => {
  await freshDb();
  resetModules();
  resetLock();
});

after(async () => {
  resetModules();
  resetLock();
  await cleanupHome();
});

// --- schedule parsing ------------------------------------------------------

test('a daily schedule round-trips into canonical zero-padded form', () => {
  assert.equal(formatSchedule(parseSchedule('DAILY:9:5')), 'daily:09:05');
  assert.equal(formatSchedule(parseSchedule('daily:09:05')), 'daily:09:05');
});

test('a weekly schedule keeps its weekday', () => {
  assert.equal(formatSchedule(parseSchedule('weekly:1:07:30')), 'weekly:1:07:30');
});

test('an unparseable schedule names the offending field', () => {
  for (const bad of ['', 'hourly:01:00', 'daily:24:00', 'daily:12:60', 'weekly:7:01:00', 'daily:12', '* * * * *']) {
    assert.throws(
      () => parseSchedule(bad),
      (error: unknown) => {
        const e = error as { code?: string; details?: { field?: string } };
        assert.equal(e.code, 'bad_request', `${bad} produced the wrong code`);
        assert.equal(e.details?.field, 'schedule');
        return true;
      },
      `"${bad}" was accepted`,
    );
  }
});

test('cron expressions are rejected rather than half-understood', () => {
  // v1 is deliberately daily/weekly only. Accepting something cron-shaped and
  // silently misreading it would be worse than refusing it.
  assert.throws(() => parseSchedule('0 9 * * 1'), /Invalid schedule/);
});

// --- occurrence arithmetic -------------------------------------------------

test('the previous occurrence is at or before now, and the next one strictly after', () => {
  const parsed = parseSchedule('daily:09:00');
  const now = Date.now();

  const prev = previousOccurrence(parsed, now);
  const next = nextOccurrence(parsed, now);

  assert.ok(prev <= now, 'previous occurrence was in the future');
  assert.ok(next > now, 'next occurrence was not in the future');
});

test('a weekly slot lands on the requested weekday', () => {
  const parsed = parseSchedule('weekly:3:14:30');
  const at = new Date(previousOccurrence(parsed, Date.now()));

  assert.equal(at.getDay(), 3);
  assert.equal(at.getHours(), 14);
  assert.equal(at.getMinutes(), 30);
});

test('a slot keeps its wall-clock time across a month of days', () => {
  // Local-time arithmetic rather than fixed-millisecond subtraction, so a DST
  // transition inside the window shifts the slot instead of dragging it an hour.
  const parsed = parseSchedule('daily:09:00');
  for (let back = 0; back < 30; back += 1) {
    const at = new Date(previousOccurrence(parsed, Date.now() - back * DAY));
    assert.equal(at.getHours(), 9, `day -${back} drifted off 09:00`);
    assert.equal(at.getMinutes(), 0);
  }
});

// --- due-ness --------------------------------------------------------------

test('a task saved for later today does not fire the moment it is created', () => {
  // The slot for "daily at 09:00" has already passed when you save it at 23:00.
  // Firing off it immediately reads as a bug to anyone watching.
  const task = createScheduledTask({
    name: 'Evening report',
    prompt: 'Report.',
    schedule: 'daily:00:01',
    modelId: 'mock-model',
  });

  assert.equal(isDue(task), false);
  assert.deepEqual(dueScheduledTasks(), []);
});

test('a task whose slot has passed since its last run is due', () => {
  const task = dueTask();
  assert.equal(isDue(task), true);
  assert.deepEqual(
    dueScheduledTasks().map((t) => t.id),
    [task.id],
  );
});

test('a disabled task is never due, however overdue it is', () => {
  const task = dueTask({ enabled: false });
  assert.equal(isDue(task), false);
  assert.deepEqual(dueScheduledTasks(), []);
});

test('a task that already ran this slot is not due again on the next tick', () => {
  const task = dueTask();
  const runId = startRun(task.id);
  finishRun(runId, task.id, { status: 'success', summary: 'done' });

  assert.equal(isDue(requireScheduledTask(task.id)), false);
});

// --- CRUD ------------------------------------------------------------------

test('an update leaves omitted fields alone', () => {
  const task = createScheduledTask({
    name: 'Digest',
    prompt: 'Summarise.',
    schedule: 'daily:09:00',
    modelId: 'mock-model',
    cwd: 'projects/site',
  });

  const updated = updateScheduledTask(task.id, { enabled: false });

  assert.equal(updated.enabled, false);
  assert.equal(updated.prompt, 'Summarise.');
  assert.equal(updated.schedule, 'daily:09:00');
  assert.equal(updated.cwd, 'projects/site');
});

test('an update canonicalises a new schedule rather than storing it as typed', () => {
  const task = dueTask();
  assert.equal(updateScheduledTask(task.id, { schedule: 'WEEKLY:2:7:5' }).schedule, 'weekly:2:07:05');
});

test('deleting a task takes its run history with it', () => {
  const task = dueTask();
  finishRun(startRun(task.id), task.id, { status: 'success', summary: 'done' });
  assert.equal(listTaskRuns(task.id).length, 1);

  deleteScheduledTask(task.id);

  assert.deepEqual(listScheduledTasks(), []);
  const orphans = getDb()
    .prepare<{ count: number }>('SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE task_id = ?')
    .get(task.id);
  assert.equal(orphans?.count, 0);
});

test('a run is recorded before the work starts, so a crash leaves evidence', () => {
  const task = dueTask();
  const runId = startRun(task.id);

  const [open] = listTaskRuns(task.id);
  assert.equal(open?.id, runId);
  assert.equal(open?.status, 'running');
  assert.equal(open?.finishedAt, null);
});

// --- running ---------------------------------------------------------------

test('a due task runs through the agent and records success', async () => {
  let ran = 0;
  stubAgent({ ok: true, summary: 'Digest ready.' }, () => { ran += 1; });

  const task = dueTask();
  const count = await runDueTasks();

  assert.equal(count, 1);
  assert.equal(ran, 1);

  const after = requireScheduledTask(task.id);
  assert.equal(after.lastStatus, 'success');
  assert.ok(after.lastRunAt !== null, 'last_run_at was not stamped');

  const [run] = listTaskRuns(task.id);
  assert.equal(run?.status, 'success');
  assert.equal(run?.summary, 'Digest ready.');
});

test('an agent that reports failure produces a failed run, not a thrown scheduler', async () => {
  stubAgent({ ok: false, summary: 'Could not reach the mailbox.' });
  const task = dueTask();

  await runScheduledTask(task.id);

  assert.equal(requireScheduledTask(task.id).lastStatus, 'failed');
  assert.equal(listTaskRuns(task.id)[0]?.status, 'failed');
});

test('an agent that throws is recorded as failed rather than crashing the tick', async () => {
  registerAgent('cowork', {
    async runTask() {
      throw new Error('the agent exploded');
    },
  });
  const task = dueTask();

  // The absence of a rejection here is the assertion: one bad task must not
  // abandon the rest of the sweep or kill the interval job.
  await runScheduledTask(task.id);

  const [run] = listTaskRuns(task.id);
  assert.equal(run?.status, 'failed');
  assert.match(String(run?.error?.message), /exploded/);
});

test('a run with no registered cowork agent fails cleanly', async () => {
  const task = dueTask();
  await runScheduledTask(task.id);

  assert.equal(listTaskRuns(task.id)[0]?.error?.code, 'agent_not_registered');
});

// --- the busy case ---------------------------------------------------------

test('a task that cannot get the lock is skipped, not failed', async () => {
  stubAgent({ ok: true, summary: 'never reached' });
  const task = dueTask();

  // Hold the lock for longer than the scheduler is willing to wait (20ms here,
  // set at the top of this file), so the queue times out into the busy path
  // deterministically rather than racing.
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const holder = withLock({ tool: 'chat', label: 'user is mid-run' }, async () => {
    await held;
  });

  await runScheduledTask(task.id);
  release();
  await holder;

  const [run] = listTaskRuns(task.id);
  assert.equal(run?.status, 'skipped', 'losing the queue race was reported as a failure');
  assert.match(String(run?.summary), /busy/i);
});

test('a skipped run still stamps last_run_at so it waits for its next slot', async () => {
  stubAgent({ ok: true, summary: 'never reached' });
  const task = dueTask();

  finishRun(startRun(task.id), task.id, {
    status: 'skipped',
    summary: 'Skipped: the app was busy with another job.',
  });

  const after = requireScheduledTask(task.id);
  assert.equal(after.lastStatus, 'skipped');
  assert.ok(after.lastRunAt !== null);
  // The point of stamping it: no retry storm for the rest of the day.
  assert.equal(isDue(after), false);
});
