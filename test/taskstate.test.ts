/**
 * Where a task got to, after nobody was watching.
 *
 * Code, Cowork and Design report themselves over SSE, and SSE is exactly the
 * kind of connection a phone drops when its screen locks. The stream is gone
 * and cannot be asked what happened, so `task_runs` is the durable answer and
 * `GET /api/{tool}/tasks/:taskId/state` is how a reconnecting client reads it.
 *
 * The row is deliberately coarse — state, timestamps, the reason it stopped.
 * A client that comes back needs to know whether to keep waiting, show a
 * result, or report a failure; it does not need the transcript, and persisting
 * one would make every token a write.
 *
 * Runs are awaited by draining the response body rather than by sleeping. The
 * state write happens in the `.then`/`.catch` that precedes `sse.close()`, so
 * the response ending is a guarantee the row is already final — whereas a
 * timer is a guess that fails on a loaded machine. The one test that needs to
 * observe a run *mid-flight* holds the agent open on a gate it controls
 * instead of racing it.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

import type { Server } from 'node:http';
import type { AgentModule, TaskResult } from '../src/types/core.ts';

const { ensureChat } = await import('../src/db/chats.ts');
const { latestRunForTask, reconcileOrphanedTaskRuns, startTaskRun, getTaskRun, updateTaskRunState } =
  await import('../src/db/taskRuns.ts');

const { registerAgent, resetModules } = await import('../src/orchestrator/agents.ts');
const { resetCodeLane, resetLock } = await import('../src/orchestrator/lock.ts');
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
});

/** An agent that succeeds immediately. */
function succeeds(summary = 'done'): AgentModule {
  return {
    async runTask(): Promise<TaskResult> {
      return { ok: true, summary };
    },
  };
}

/** An agent that throws, for the failure path. */
function throws(message: string): AgentModule {
  return {
    async runTask(): Promise<TaskResult> {
      throw new Error(message);
    },
  };
}

/**
 * An agent that will not finish until it is told to, so a test can look at the
 * run while it is genuinely in flight.
 */
function gated(): { module: AgentModule; release: () => void } {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    module: {
      async runTask(): Promise<TaskResult> {
        await gate;
        return { ok: true, summary: 'released' };
      },
    },
  };
}

interface RunBody {
  chatId: string;
  modelId?: string;
  prompt?: string;
  taskId?: string;
}

function post(tool: 'code' | 'cowork' | 'design', payload: RunBody): Promise<Response> {
  return fetch(`${base}/api/${tool}/run-task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: 'm-1', prompt: 'do the thing', ...payload }),
  });
}

/**
 * Run a task to completion.
 *
 * Draining the body is the synchronisation point: the server writes the final
 * state and only then closes the stream, so a response that has ended is a
 * response whose row is already written. Cancelling instead would abort the
 * request mid-run and test a different thing entirely.
 */
async function run(tool: 'code' | 'cowork' | 'design', payload: RunBody): Promise<string> {
  const res = await post(tool, payload);
  assert.equal(res.status, 200, 'the run should have been accepted');
  return res.text();
}

/** Poll until a run reaches `state`, for the cases that cannot drain the body. */
async function waitForState(
  tool: 'code' | 'cowork' | 'design',
  taskId: string,
  state: string,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = latestRunForTask(tool, taskId);
    if (run?.state === state) return;
    if (Date.now() > deadline) {
      throw new Error(`task ${taskId} was "${run?.state ?? 'absent'}", never "${state}"`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('a run journals how it ended', () => {
  test('a Cowork task that succeeds is recorded complete, against its chat', async () => {
    registerAgent('cowork', succeeds());
    ensureChat({ id: 'c-ok', tool: 'cowork' });

    await run('cowork', { chatId: 'c-ok' });

    const record = latestRunForTask('cowork', 'c-ok');
    assert.ok(record, 'the run left no row behind');
    assert.equal(record.tool, 'cowork');
    // Cowork has no task id of its own, so the chat is the handle the user has.
    assert.equal(record.taskId, 'c-ok');
    assert.equal(record.chatId, 'c-ok');
    assert.equal(record.state, 'complete');
    assert.equal(record.errorCode, null);
    assert.equal(record.errorMessage, null);
    assert.notEqual(record.completedAt, null);
    assert.ok(record.completedAt !== null && record.completedAt >= record.startedAt);
  });

  test('a Code task is recorded under the task id the client chose', async () => {
    registerAgent('code', succeeds('refactored'));
    ensureChat({ id: 'c-code', tool: 'code' });

    await run('code', { chatId: 'c-code', taskId: 'task-code-1' });

    const record = latestRunForTask('code', 'task-code-1');
    assert.ok(record);
    assert.equal(record.tool, 'code');
    assert.equal(record.taskId, 'task-code-1');
    assert.equal(record.chatId, 'c-code');
    assert.equal(record.state, 'complete');
  });

  test('an agent that throws is recorded as error, carrying the code and message', async () => {
    registerAgent('cowork', throws('the widget exploded'));
    ensureChat({ id: 'c-boom', tool: 'cowork' });

    await run('cowork', { chatId: 'c-boom' });

    const record = latestRunForTask('cowork', 'c-boom');
    assert.ok(record);
    assert.equal(record.state, 'error');
    // A bare Error becomes internal_error, which is what a reconnecting client
    // will branch on — it is the same code the stream would have delivered.
    assert.equal(record.errorCode, 'internal_error');
    assert.match(record.errorMessage ?? '', /widget exploded/);
    assert.notEqual(record.completedAt, null, 'a failure is an ending, and gets a time');
  });

  test('a run in flight says running, and only then says complete', async () => {
    const agent = gated();
    registerAgent('cowork', agent.module);
    ensureChat({ id: 'c-inflight', tool: 'cowork' });

    const pending = post('cowork', { chatId: 'c-inflight' });
    await waitForState('cowork', 'c-inflight', 'running');

    const midRun = latestRunForTask('cowork', 'c-inflight');
    assert.equal(midRun?.state, 'running');
    assert.equal(
      midRun?.completedAt,
      null,
      'a running task with a completion time would tell a client it had finished',
    );

    agent.release();
    await (await pending).text();
    assert.equal(latestRunForTask('cowork', 'c-inflight')?.state, 'complete');
  });

  test('a retry replaces the previous ending rather than shadowing it', async () => {
    ensureChat({ id: 'c-retry', tool: 'cowork' });

    registerAgent('cowork', throws('first attempt failed'));
    await run('cowork', { chatId: 'c-retry' });
    const failed = latestRunForTask('cowork', 'c-retry');
    assert.equal(failed?.state, 'error');

    registerAgent('cowork', succeeds('second attempt worked'));
    await run('cowork', { chatId: 'c-retry' });

    const record = latestRunForTask('cowork', 'c-retry');
    assert.ok(record);
    // The newest run is the answer: showing the old failure over a run that has
    // since succeeded is the specific bug `ORDER BY started_at DESC` prevents.
    assert.equal(record.state, 'complete');
    assert.equal(record.errorMessage, null);
    assert.notEqual(record.runId, failed?.runId, 'a retry is a new run, not an edited one');
  });

  test('a chat id with no chat behind it is stored as null, not refused', async () => {
    // chat_id is a real foreign key with PRAGMA foreign_keys on, so a chat the
    // frontend has not created yet would fail the whole insert and lose the
    // state row over a column that is only a convenience link.
    registerAgent('code', succeeds());

    await run('code', { chatId: 'c-never-created', taskId: 'task-no-chat' });

    const record = latestRunForTask('code', 'task-no-chat');
    assert.ok(record, 'the run must still be recorded');
    assert.equal(record.chatId, null);
    assert.equal(record.state, 'complete');
  });
});

describe('GET /api/{tool}/tasks/:taskId/state', () => {
  test('reports the run a reconnecting client is asking about', async () => {
    registerAgent('cowork', succeeds());
    ensureChat({ id: 'c-probe', tool: 'cowork' });
    await run('cowork', { chatId: 'c-probe' });

    const res = await fetch(`${base}/api/cowork/tasks/c-probe/state`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { run: Record<string, unknown> };
    assert.equal(body.run.taskId, 'c-probe');
    assert.equal(body.run.tool, 'cowork');
    assert.equal(body.run.state, 'complete');
    assert.equal(typeof body.run.runId, 'string');
    assert.equal(typeof body.run.startedAt, 'number');
    assert.equal(typeof body.run.updatedAt, 'number');
    assert.equal(typeof body.run.completedAt, 'number');
  });

  test('carries the failure the client missed when the stream dropped', async () => {
    registerAgent('cowork', throws('provider went away'));
    ensureChat({ id: 'c-missed', tool: 'cowork' });
    await run('cowork', { chatId: 'c-missed' });

    const res = await fetch(`${base}/api/cowork/tasks/c-missed/state`);
    const body = (await res.json()) as {
      run: { state: string; errorCode: string; errorMessage: string };
    };

    assert.equal(res.status, 200);
    assert.equal(body.run.state, 'error');
    assert.equal(body.run.errorCode, 'internal_error');
    assert.match(body.run.errorMessage, /provider went away/);
  });

  test('an unknown task is a 404, not an invented idle state', async () => {
    // "I have never heard of this task" and "this task is not doing anything"
    // are different answers, and only one of them means stop polling.
    const res = await fetch(`${base}/api/code/tasks/task-never-run/state`);
    const body = (await res.json()) as {
      error: { code: string; details?: { taskId?: string } };
    };

    assert.equal(res.status, 404);
    assert.equal(body.error.code, 'not_found');
    assert.equal(body.error.details?.taskId, 'task-never-run');
  });

  test('the tools do not read each other rows, even for the same id', async () => {
    registerAgent('code', succeeds('code side'));
    registerAgent('cowork', throws('cowork side failed'));
    ensureChat({ id: 'shared-id', tool: 'cowork' });

    await run('code', { chatId: 'shared-id', taskId: 'shared-id' });
    await run('cowork', { chatId: 'shared-id' });

    const codeRun = (await (await fetch(`${base}/api/code/tasks/shared-id/state`)).json()) as {
      run: { tool: string; state: string };
    };
    const coworkRun = (await (await fetch(`${base}/api/cowork/tasks/shared-id/state`)).json()) as {
      run: { tool: string; state: string };
    };

    assert.equal(codeRun.run.tool, 'code');
    assert.equal(codeRun.run.state, 'complete');
    assert.equal(coworkRun.run.tool, 'cowork');
    assert.equal(coworkRun.run.state, 'error');
  });

  test('design answers on its own path, before any design agent exists', async () => {
    // The route is mounted for all three tools. Design has no agent yet, so the
    // honest answer is 404 — not a 404 because the *path* is missing, which is
    // what a client would otherwise have to guess.
    const res = await fetch(`${base}/api/design/tasks/anything/state`);
    const body = (await res.json()) as { error: { code: string; message: string } };

    assert.equal(res.status, 404);
    assert.equal(body.error.code, 'not_found');
    assert.match(body.error.message, /design/, 'the message should name the tool that was asked');
  });
});

describe('a process that died leaves rows claiming to be running', () => {
  test('reconciliation demotes them to interrupted rather than leaving the lie', async () => {
    // Written directly, because that is exactly what a crash leaves behind: a
    // row with no process attached. Racing a live run to catch it mid-flight
    // would test the timing of the test, not the reconciliation.
    startTaskRun({ runId: 'orphan-1', taskId: 'task-orphan-1', tool: 'code' });
    startTaskRun({ runId: 'orphan-2', taskId: 'task-orphan-2', tool: 'cowork' });

    const demoted = reconcileOrphanedTaskRuns();
    assert.equal(demoted, 2);

    for (const runId of ['orphan-1', 'orphan-2']) {
      const record = getTaskRun(runId);
      assert.ok(record);
      // `interrupted`, not `paused`: unlike a chat run there is no resume path
      // for a task whose agent process is gone, so `paused` would be the same
      // lie in a different shape — a client would wait for a resume that cannot
      // come. And not `error` either: nothing about the task failed, the process
      // running it went away, and a state that cries error on every unclean
      // shutdown is a state users learn to ignore (migration 020).
      assert.equal(record.state, 'interrupted');
      assert.equal(record.errorCode, 'internal_error');
      assert.match(record.errorMessage ?? '', /restarted/);
      assert.notEqual(record.completedAt, null);
    }
  });

  test('a finished run is left exactly as it was', async () => {
    registerAgent('cowork', succeeds());
    ensureChat({ id: 'c-finished', tool: 'cowork' });
    await run('cowork', { chatId: 'c-finished' });

    const before = latestRunForTask('cowork', 'c-finished');
    assert.equal(before?.state, 'complete');

    assert.equal(reconcileOrphanedTaskRuns(), 0, 'nothing was running, so nothing to reconcile');

    const after = latestRunForTask('cowork', 'c-finished');
    assert.equal(after?.state, 'complete', 'a completed task was re-marked as failed');
    assert.equal(after?.updatedAt, before?.updatedAt, 'the row was rewritten needlessly');
  });

  test('the state endpoint reports the demotion, so a client stops waiting', async () => {
    startTaskRun({ runId: 'orphan-3', taskId: 'task-orphan-3', tool: 'cowork' });
    reconcileOrphanedTaskRuns();

    const res = await fetch(`${base}/api/cowork/tasks/task-orphan-3/state`);
    const body = (await res.json()) as { run: { state: string; errorMessage: string } };

    assert.equal(res.status, 200);
    assert.equal(body.run.state, 'interrupted');
    assert.match(body.run.errorMessage, /restarted/);
  });

  test('a blocked run is demoted too, because nothing can answer it any more', async () => {
    // The subtle half of reconciliation. `blocked` means the run is waiting for a
    // confirmation delivered into the *agent loop*, not into this table — so once
    // that process dies nothing can ever unblock it. Left alone, the row waits
    // forever behind a prompt whose answer now goes nowhere.
    startTaskRun({ runId: 'orphan-blocked', taskId: 'task-orphan-blocked', tool: 'code' });
    updateTaskRunState('orphan-blocked', 'blocked');

    assert.equal(reconcileOrphanedTaskRuns(), 1);

    const record = getTaskRun('orphan-blocked');
    assert.ok(record);
    assert.equal(record.state, 'interrupted');
    assert.equal(record.errorCode, 'internal_error');
    // Named for what the user actually lost: not just "it was running", but that
    // the question it asked can no longer be answered.
    assert.match(record.errorMessage ?? '', /waiting for you/);
    assert.notEqual(record.completedAt, null);
  });

  test('a run ready for review survives, because its work is already finished', async () => {
    // The dividing line: `blocked` needed a live process it no longer has, while
    // `ready_for_review` only wants a human to look at a result that already
    // exists. Demoting this one would report finished work as failed.
    startTaskRun({ runId: 'orphan-review', taskId: 'task-orphan-review', tool: 'code' });
    updateTaskRunState('orphan-review', 'ready_for_review');
    const before = getTaskRun('orphan-review');

    assert.equal(reconcileOrphanedTaskRuns(), 0, 'finished work waiting on a human was destroyed');

    const record = getTaskRun('orphan-review');
    assert.equal(record?.state, 'ready_for_review');
    assert.equal(record?.errorCode, null);
    assert.equal(record?.updatedAt, before?.updatedAt, 'the row was rewritten needlessly');
  });
});
