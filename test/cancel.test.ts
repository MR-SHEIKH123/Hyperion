/**
 * Stopping a task, from the endpoint down to the row it leaves behind.
 *
 * Cancellation has three distinct shapes and each one fails differently, so
 * each is driven end-to-end over real HTTP rather than asserted against the
 * registry alone:
 *
 *   - **A live run.** The agent is held on a gate it controls, so the run is
 *     genuinely in flight when the cancel arrives — not racing a timer. What
 *     matters is that the agent's own signal fires, the stream survives long
 *     enough to say so, and the row ends up `stopped`/`cancelled` rather than
 *     `error`.
 *   - **A run with no live controller.** The row is left mid-flight by a process
 *     that is gone. There is nothing to signal, so the transition is made
 *     directly, and "no controller found" has to read as success — a 404 here
 *     would tell the user their own task does not exist.
 *   - **A run that already ended.** Idempotent success carrying the state it
 *     actually reached, because cancelling something that finished a moment ago
 *     is a race the user cannot avoid.
 *
 * The scheduler is covered separately because it has no `task_runs` row at all:
 * its history lives in `scheduled_task_runs`, and the specific thing worth
 * proving is that a stopped run does not come due again on the next tick.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

import type { Server } from 'node:http';
import type { AgentContext, AgentModule, TaskResult } from '../src/types/core.ts';

const { ensureChat } = await import('../src/db/chats.ts');
const { latestRunForTask, startTaskRun, updateTaskRunState, getTaskRun } = await import(
  '../src/db/taskRuns.ts'
);
const {
  createScheduledTask,
  isDue,
  listTaskRuns,
  requireScheduledTask,
} = await import('../src/services/cowork/scheduledTasks.ts');
const { runScheduledTask } = await import('../src/services/cowork/scheduler.ts');
const { getDb } = await import('../src/db/adapter.ts');
const { registerAgent, resetModules } = await import('../src/orchestrator/agents.ts');
const { resetCodeLane, resetLock } = await import('../src/orchestrator/lock.ts');
const { cancellableCount, cancelRun, isCancelled, registerCancellable, resetCancellations } =
  await import('../src/orchestrator/cancel.ts');
const { createApp } = await import('../src/http/app.ts');

let server: Server;
let base: string;

before(async () => {
  await freshDb();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo from listen(0)');
  }
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

beforeEach(() => {
  resetModules();
  resetLock();
  resetCodeLane(2);
  resetCancellations();
});

/**
 * An agent that waits until its own signal aborts, then returns what it had.
 *
 * This is the behaviour a cooperating agent is supposed to have — stop early
 * and hand back partial work rather than throwing — and it is also the case
 * most likely to be recorded wrongly, because from the route's point of view it
 * is indistinguishable from a run that finished normally.
 */
function stopsOnSignal(): { module: AgentModule; sawAbort: () => boolean; started: Promise<void> } {
  let aborted = false;
  let announce = (): void => {};
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  return {
    sawAbort: () => aborted,
    started,
    module: {
      async runTask(_input, ctx: AgentContext): Promise<TaskResult> {
        announce();
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            resolve();
            return;
          }
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        aborted = ctx.signal.aborted;
        return { ok: false, summary: 'stopped partway' };
      },
    },
  };
}

/** An agent that throws when its signal fires, the other plausible reaction. */
function throwsOnSignal(): { module: AgentModule; started: Promise<void> } {
  let announce = (): void => {};
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  return {
    started,
    module: {
      async runTask(_input, ctx: AgentContext): Promise<TaskResult> {
        announce();
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('aborted mid-edit');
      },
    },
  };
}

function cancel(tool: 'code' | 'cowork' | 'design', taskId: string): Promise<Response> {
  return fetch(`${base}/api/${tool}/tasks/${taskId}/cancel`, { method: 'POST' });
}

function startRunRequest(
  tool: 'code' | 'cowork' | 'design',
  payload: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${base}/api/${tool}/run-task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: 'm-1', prompt: 'do the thing', ...payload }),
  });
}

describe('the cancel registry', () => {
  test('cancelling a task raises the signal it handed out', () => {
    const entry = registerCancellable('run-1', 'cowork', 'task-1');
    assert.equal(entry.signal.aborted, false);
    assert.equal(entry.cancelled, false);

    assert.equal(cancelRun('cowork', 'task-1'), 'run-1');

    assert.equal(entry.signal.aborted, true);
    assert.equal(entry.cancelled, true);
    assert.equal(isCancelled('run-1'), true);
  });

  test('a task nobody is running answers null rather than throwing', () => {
    assert.equal(cancelRun('cowork', 'nothing-here'), null);
  });

  test('the same task id under a different tool is a different run', () => {
    const cowork = registerCancellable('run-cowork', 'cowork', 'shared-id');
    const design = registerCancellable('run-design', 'design', 'shared-id');

    cancelRun('cowork', 'shared-id');

    assert.equal(cowork.signal.aborted, true);
    // Tools share an id space only by accident of the user naming things; a stop
    // aimed at one must not reach into another's work.
    assert.equal(design.signal.aborted, false);
  });

  test('cancelling twice is a no-op the second time', () => {
    const entry = registerCancellable('run-2', 'code', 'task-2');
    assert.equal(cancelRun('code', 'task-2'), 'run-2');
    assert.equal(cancelRun('code', 'task-2'), 'run-2');
    assert.equal(entry.cancelled, true);
  });

  test('disposing forgets the run so a finished task cannot be cancelled', () => {
    const entry = registerCancellable('run-3', 'design', 'task-3');
    entry.dispose();
    assert.equal(cancelRun('design', 'task-3'), null);
    assert.equal(isCancelled('run-3'), false);
    assert.equal(cancellableCount(), 0);
  });

  test('disposing is idempotent', () => {
    const entry = registerCancellable('run-4', 'code', 'task-4');
    entry.dispose();
    entry.dispose();
    assert.equal(cancellableCount(), 0);
  });

  test('a retry under the same task id takes over, and the old run disposes cleanly', () => {
    const first = registerCancellable('run-old', 'code', 'task-5');
    const second = registerCancellable('run-new', 'code', 'task-5');

    // The run the user is looking at is the current one, so that is what "stop
    // this task" has to mean.
    assert.equal(cancelRun('code', 'task-5'), 'run-new');
    assert.equal(first.signal.aborted, false);
    assert.equal(second.signal.aborted, true);

    // The superseded registration must not drag the live one out of the index
    // when it finally ends.
    first.dispose();
    assert.equal(cancelRun('code', 'task-5'), 'run-new');
  });

  test('isCancelled is keyed by run, so a retry cannot make the old attempt look stopped', () => {
    registerCancellable('run-first', 'cowork', 'task-6');
    registerCancellable('run-second', 'cowork', 'task-6');

    cancelRun('cowork', 'task-6');

    assert.equal(isCancelled('run-second'), true);
    assert.equal(isCancelled('run-first'), false);
  });
});

describe('stopping a task over HTTP', () => {
  test('a live Cowork run is signalled, and records stopped rather than error', async () => {
    const agent = stopsOnSignal();
    registerAgent('cowork', agent.module);
    ensureChat({ id: 'c-live', tool: 'cowork' });

    const pending = startRunRequest('cowork', { chatId: 'c-live' });
    await agent.started;

    const res = await cancel('cowork', 'c-live');
    assert.equal(res.status, 200);
    const payload = (await res.json()) as Record<string, unknown>;
    // `stopping`, not `stopped`: the run is still unwinding and owns its own
    // transition to a terminal state.
    assert.equal(payload.state, 'stopping');
    assert.equal(payload.wasRunning, true);
    assert.equal(payload.taskId, 'c-live');

    // Draining the body is the synchronisation point — the row is written
    // before the stream closes.
    const body = await (await pending).text();
    assert.equal(agent.sawAbort(), true, 'the agent never saw its signal fire');

    const record = latestRunForTask('cowork', 'c-live');
    assert.ok(record);
    // Nothing broke, so this is not an error, and there is nothing to resume
    // into, so it is not paused.
    assert.equal(record.state, 'stopped');
    assert.equal(record.pauseReason, 'cancelled');
    assert.equal(record.errorCode, null);
    assert.ok(record.completedAt !== null, 'stopped is terminal and stamps completedAt');

    // The stream stayed open long enough to say what happened, and said it as
    // progress rather than as a failure.
    assert.match(body, /"channel":"stopped"/);
    assert.match(body, /"reason":"cancelled"/);
    assert.equal(body.includes('event: error'), false);
  });

  test('an agent that throws when stopped is still recorded as stopped', async () => {
    const agent = throwsOnSignal();
    registerAgent('design', agent.module);
    ensureChat({ id: 'c-throw', tool: 'design' });

    const pending = startRunRequest('design', { chatId: 'c-throw' });
    await agent.started;
    await cancel('design', 'c-throw');
    const body = await (await pending).text();

    const record = latestRunForTask('design', 'c-throw');
    assert.ok(record);
    // The exception is how this agent unwinds, not why the run ended. Recording
    // `error` would put a failure against work the user chose to stop.
    assert.equal(record.state, 'stopped');
    assert.equal(record.pauseReason, 'cancelled');
    assert.equal(record.errorMessage, null);
    assert.equal(body.includes('event: error'), false);
  });

  test('a live Code run in its own lane is stopped the same way', async () => {
    const agent = stopsOnSignal();
    registerAgent('code', agent.module);
    ensureChat({ id: 'c-code', tool: 'code' });

    const pending = startRunRequest('code', { chatId: 'c-code', taskId: 'task-code-1' });
    await agent.started;

    const res = await cancel('code', 'task-code-1');
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Record<string, unknown>).wasRunning, true);
    await (await pending).text();

    const record = latestRunForTask('code', 'task-code-1');
    assert.ok(record);
    assert.equal(record.state, 'stopped');
    assert.equal(record.pauseReason, 'cancelled');
  });

  test('a run left behind with no live controller is stopped by a state transition', async () => {
    // What a crash leaves: a row claiming to be live, with nothing in this
    // process able to receive a signal for it.
    startTaskRun({ runId: 'orphan-run', taskId: 'orphan-task', tool: 'cowork' });

    const res = await cancel('cowork', 'orphan-task');
    assert.equal(res.status, 200, 'no controller found is success, not 404');
    const payload = (await res.json()) as Record<string, unknown>;
    assert.equal(payload.state, 'stopped');
    assert.equal(payload.wasRunning, false);

    const record = getTaskRun('orphan-run');
    assert.ok(record);
    assert.equal(record.state, 'stopped');
    assert.equal(record.pauseReason, 'cancelled');
  });

  test('a blocked run can be stopped, since nothing live will ever unblock it', async () => {
    startTaskRun({ runId: 'blocked-run', taskId: 'blocked-task', tool: 'design' });
    updateTaskRunState('blocked-run', 'blocked');

    const res = await cancel('design', 'blocked-task');
    assert.equal(res.status, 200);

    const record = getTaskRun('blocked-run');
    assert.ok(record);
    assert.equal(record.state, 'stopped');
  });

  test('cancelling a run that already finished is idempotent success', async () => {
    registerAgent('cowork', {
      async runTask(): Promise<TaskResult> {
        return { ok: true, summary: 'done' };
      },
    });
    ensureChat({ id: 'c-done', tool: 'cowork' });
    await (await startRunRequest('cowork', { chatId: 'c-done' })).text();

    const res = await cancel('cowork', 'c-done');
    assert.equal(res.status, 200, 'a race the user cannot avoid must not read as an error');
    const payload = (await res.json()) as Record<string, unknown>;
    // The state it actually reached, not a claim that it was stopped.
    assert.equal(payload.state, 'complete');
    assert.equal(payload.wasRunning, false);

    const record = latestRunForTask('cowork', 'c-done');
    assert.ok(record);
    assert.equal(record.state, 'complete');
    assert.equal(record.pauseReason, null);
  });

  test('a task that was never heard of is a 404 with a coded envelope', async () => {
    const res = await cancel('cowork', 'never-existed');
    assert.equal(res.status, 404);
    const payload = (await res.json()) as { error?: { code?: string } };
    assert.equal(payload.error?.code, 'not_found');
  });

  test('a finished run leaves nothing registered behind', async () => {
    registerAgent('design', {
      async runTask(): Promise<TaskResult> {
        return { ok: true, summary: 'done' };
      },
    });
    ensureChat({ id: 'c-clean', tool: 'design' });
    await (await startRunRequest('design', { chatId: 'c-clean' })).text();

    // A registration that outlived its run would keep offering to cancel work
    // that has already ended, and would shadow the next attempt at this id.
    assert.equal(cancellableCount(), 0);
  });

  test('the state endpoint reports the stop, so a reconnecting client sees it too', async () => {
    const agent = stopsOnSignal();
    registerAgent('cowork', agent.module);
    ensureChat({ id: 'c-state', tool: 'cowork' });

    const pending = startRunRequest('cowork', { chatId: 'c-state' });
    await agent.started;
    await cancel('cowork', 'c-state');
    await (await pending).text();

    const res = await fetch(`${base}/api/cowork/tasks/c-state/state`);
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { run?: { state?: string; pauseReason?: string } };
    assert.equal(payload.run?.state, 'stopped');
    assert.equal(payload.run?.pauseReason, 'cancelled');
  });
});

/**
 * A scheduled run due an hour ago, backdated past the never-run guard.
 *
 * Mirrors the fixture in `scheduledtasks.test.ts` rather than importing it,
 * because the property under test here is the *interaction* between stopping a
 * run and the due calculation, and that only shows up on a task that really was
 * due a moment ago.
 */
function dueScheduledTask(name: string): ReturnType<typeof requireScheduledTask> {
  const anHourAgo = new Date(Date.now() - 60 * 60_000);
  const task = createScheduledTask({
    name,
    prompt: 'Summarise yesterday.',
    schedule: `daily:${String(anHourAgo.getHours()).padStart(2, '0')}:${String(anHourAgo.getMinutes()).padStart(2, '0')}`,
    modelId: 'mock-model',
  });
  getDb()
    .prepare('UPDATE scheduled_tasks SET created_at = ? WHERE id = ?')
    .run(Date.now() - 24 * 60 * 60_000, task.id);
  return requireScheduledTask(task.id);
}

describe('stopping a scheduled run', () => {
  test('a stopped scheduled run is skipped, and does not come due again immediately', async () => {
    const task = dueScheduledTask('Stoppable digest');
    assert.equal(isDue(task), true, 'the fixture was not due to begin with');

    const agent = stopsOnSignal();
    registerAgent('cowork', agent.module);

    const running = runScheduledTask(task.id);
    await agent.started;

    // The endpoint reaches a run nobody is watching, under the task's own id —
    // which is the only handle the user has for a scheduled task.
    const res = await cancel('cowork', task.id);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Record<string, unknown>).wasRunning, true);

    await running;
    assert.equal(agent.sawAbort(), true, 'the scheduled run never saw its signal fire');

    const history = listTaskRuns(task.id);
    assert.equal(history.length, 1);
    // `skipped`, not `failed`: the run was stopped on purpose, and a red mark
    // against a task working exactly as told is a lie the history would keep.
    assert.equal(history[0]?.status, 'skipped');

    // The whole point of stamping `last_run_at` on a stop: without it the task
    // is still due, and the very next tick restarts the work the user just
    // stopped.
    assert.equal(isDue(requireScheduledTask(task.id)), false);
  });

  test('a stopped scheduled run leaves nothing registered behind', async () => {
    const task = dueScheduledTask('Disposing digest');
    const agent = stopsOnSignal();
    registerAgent('cowork', agent.module);

    const running = runScheduledTask(task.id);
    await agent.started;
    await cancel('cowork', task.id);
    await running;

    assert.equal(cancellableCount(), 0);
    // A second stop finds nothing live — but the run is not forgotten. 1.27
    // allocates scheduled runs a task_runs row (see scheduler.ts), so the
    // recorded row answers "already stopped" as a 200. Only a task id this
    // process has never seen is a 404 (see CONTRACTS.md, "Every cancel outcome
    // is a 200"); phantom-success protection lives in `wasRunning`, not the
    // status.
    const again = await cancel('cowork', task.id);
    assert.equal(again.status, 200);
    const againPayload = (await again.json()) as Record<string, unknown>;
    assert.equal(againPayload.state, 'stopped');
    assert.equal(againPayload.wasRunning, false);
  });

  test('a scheduled run nobody stopped is still recorded as a success', async () => {
    const task = dueScheduledTask('Ordinary digest');
    registerAgent('cowork', {
      async runTask(): Promise<TaskResult> {
        return { ok: true, summary: 'all done' };
      },
    });

    await runScheduledTask(task.id);

    // The cancellation branches must not have changed the ordinary path.
    const history = listTaskRuns(task.id);
    assert.equal(history[0]?.status, 'success');
    assert.equal(cancellableCount(), 0);
  });
});
