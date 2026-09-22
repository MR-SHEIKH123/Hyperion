/**
 * A continuation that never becomes a run has to give the park back.
 *
 * `POST /continue` claims the parked run (`blocked`/`ready_for_review` → `running`)
 * *before* it waits for anything, because that claim is the mutex that stops two
 * clients starting two agents against one worktree. The run's own row is only
 * written later, inside the lane — so there is a window in which the claim exists
 * and the continuation does not: the Code lane is full and the mode is `reject`, or
 * the caller is queued and their stream drops (the SSE connection is the run's own
 * liveness, so `acquireCodeLane` drops its waiter with `aborted`).
 *
 * Both ends of that window are asserted here, and each was measured against the
 * tree before it was fixed: the park was left `running` with nothing behind it,
 * `requireContinuable` then refused it with `not parked`, and the next boot demoted
 * it to `interrupted` — a user who closed a tab lost their park, and a second click
 * got a 409 they could not act on.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

import type { Server } from 'node:http';
import type { AgentModule, ChatMessage, TaskResult } from '../src/types/core.ts';

const { createApp } = await import('../src/http/app.ts');
const { registerAgent, resetModules } = await import('../src/orchestrator/agents.ts');
const { acquireCodeLane, resetCodeLane, resetLock } = await import('../src/orchestrator/lock.ts');
const { concurrencyMode, setSetting } = await import('../src/db/settings.ts');
const { claimParkedRun, finishTaskRun, getTaskRun, latestRunForTask, releaseParkedRun, startTaskRun, updateTaskRunState } =
  await import('../src/db/taskRuns.ts');
const { snapshotConversation, loadConversation } = await import('../src/db/taskMessages.ts');

let server: Server;
let base: string;
let counter = 0;

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
  resetCodeLane(1);
  // A recording agent, so a continuation that *does* start cannot call a provider.
  // Nothing in this file reaches it: every case ends before the run row exists.
  registerAgent('code', {
    async runTask(): Promise<TaskResult> {
      return { ok: true, summary: 'a continuation ran' };
    },
  } satisfies AgentModule);
});

/** A parked Code task with a stored conversation — the shape `requireContinuable` accepts. */
function park(pauseReason = 'approval_required'): { runId: string; taskId: string } {
  counter += 1;
  const runId = `drop-run-${counter}`;
  const taskId = `drop-task-${counter}`;
  startTaskRun({ runId, taskId, tool: 'code' });
  updateTaskRunState(runId, 'blocked', { pauseReason });
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are Code.' },
    { role: 'user', content: 'Fix the failing test.' },
  ];
  snapshotConversation(taskId, messages);
  return { runId, taskId };
}

function startContinuation(taskId: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/api/code/tasks/${taskId}/continue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Wait for a condition, bounded — used where the claim is taken asynchronously. */
async function waitFor(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('the condition never became true');
}

describe('a continuation that never starts', () => {
  test('a full lane with no queue gives the park back instead of claiming it', async () => {
    // The holder is what makes the lane full. Its own handle is never released:
    // the point is the state another task is in while a slot is unavailable.
    // The mode is the premise of this case: with `queue` the request would wait for
    // a slot instead of failing, which is the second case below.
    assert.equal(concurrencyMode(), 'reject', 'the default mode must be reject');
    const holder = await acquireCodeLane({ tool: 'code', label: 'holder', taskId: 'holder-task' });
    try {
      const { runId, taskId } = park();
      const response = await startContinuation(taskId);
      const body = await response.text();

      // The refusal arrives as an SSE error frame and not as JSON: the route opens
      // the stream before it waits for the lane, which is exactly why the claim has
      // to be released rather than left to a client to notice.
      assert.equal(response.status, 200);
      assert.match(body, /"code":"busy"/);

      assert.equal(getTaskRun(runId)?.state, 'blocked', 'the park was left claimed');
      assert.equal(getTaskRun(runId)?.pauseReason, 'approval_required', 'the reason must survive');
      // No continuation row: the mutex moved the run, the run never existed.
      assert.equal(latestRunForTask('code', taskId)?.runId, runId);
      assert.equal(loadConversation(taskId).length, 2, 'the conversation must be untouched');
    } finally {
      holder.release();
    }
  });

  test('a stream abandoned while queued gives the park back', async () => {
    setSetting('concurrency_mode', 'queue');
    const holder = await acquireCodeLane({ tool: 'code', label: 'holder', taskId: 'holder-task' });
    try {
      const { runId, taskId } = park('plan_ready');
      const controller = new AbortController();
      const pending = startContinuation(taskId, controller.signal).catch(() => undefined);

      // The claim lands before the wait, which is the state the release has to undo:
      // observed rather than assumed, because the assertion below means nothing if
      // the request never got as far as claiming.
      await waitFor(() => getTaskRun(runId)?.state === 'running');
      controller.abort();
      await pending;

      await waitFor(() => getTaskRun(runId)?.state === 'blocked');
      assert.equal(getTaskRun(runId)?.pauseReason, 'plan_ready');
      assert.equal(latestRunForTask('code', taskId)?.runId, runId, 'no continuation was written');
    } finally {
      holder.release();
      setSetting('concurrency_mode', 'reject');
    }
  });

  test('the release cannot revive a run a continuation has already superseded', () => {
    // The guard, tested directly rather than through the route: the route only
    // reaches the release when no continuation row exists, so the interesting case
    // — a continuation that started, superseded the park, and then failed — cannot be
    // produced over HTTP without a real worktree and a real git repository. What the
    // guard prevents is a superseded attempt being written back to `blocked`, which
    // would make `latestRunForTask`'s ordering, not this row, the only thing keeping
    // the truth straight.
    const { runId } = park();
    assert.equal(claimParkedRun(runId), true);
    finishTaskRun(runId, 'complete', { pauseReason: 'continued_as:another-run' });

    assert.equal(
      releaseParkedRun(runId, { state: 'blocked', pauseReason: 'approval_required' }),
      false,
      'a run that is no longer running must not be parked again',
    );
    assert.equal(getTaskRun(runId)?.state, 'complete');
    assert.equal(getTaskRun(runId)?.pauseReason, 'continued_as:another-run');
  });

  test('a claim whose continuation does start is not released by it', async () => {
    // The other direction of the same guard, and the reason the release is
    // conditional: with a free lane the continuation runs, so the parked row must be
    // superseded (`complete`) rather than handed back to `blocked`. An unconditional
    // release would resurrect a park that a live run had already replaced.
    const { runId, taskId } = park();
    const response = await startContinuation(taskId);
    const body = await response.text();
    assert.match(body, /"channel":"result"/);

    assert.notEqual(latestRunForTask('code', taskId)?.runId, runId, 'the continuation is its own run');
    const superseded = getTaskRun(runId);
    assert.equal(superseded?.state, 'complete');
    assert.match(superseded?.pauseReason ?? '', /^continued_as:/);
  });
});
