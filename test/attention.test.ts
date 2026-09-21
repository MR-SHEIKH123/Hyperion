/**
 * `GET /api/attention` — the queue of things waiting on the user.
 *
 * An aggregation is where a unit test proves least, so everything here goes over
 * a socket against a real app, and every row is written by the writer production
 * uses: `recordApproval`, `createRun`/`pauseRun`/`reconcileOrphanedRuns`,
 * `startTaskRun`/`finishTaskRun`/`recordStep`, `createScheduledTask`/`finishRun`,
 * `logError`. A hand-written INSERT would test the query and not the contract.
 *
 * Three claims the assertions are built around, because they are what separate
 * this queue from the activity feed beside it:
 *
 *   - **Live state only.** A failed run the user already saw fail is not waiting
 *     on anyone, and a resolved approval leaves immediately. The tests below
 *     resolve things and re-poll rather than trusting the first read.
 *   - **One item per thing.** A run that produced a plan is one `plan_ready` item,
 *     not a plan item plus a review item.
 *   - **Honest sources.** Every source is reported as ok/empty/unavailable with a
 *     reason, so a category that cannot be read does not look like a category that
 *     is fine. The MCP source is unavailable in this harness and that is asserted
 *     rather than skipped.
 */

import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

import type { Server } from 'node:http';

const { createApp } = await import('../src/http/app.ts');
const { recordApproval, resolveApproval } = await import('../src/db/approvals.ts');
const { createChat } = await import('../src/db/chats.ts');
const { logError } = await import('../src/db/errorLog.ts');
const { setSetting } = await import('../src/db/settings.ts');
const { recordStep } = await import('../src/db/taskSteps.ts');
const { finishTaskRun, reconcileOrphanedTaskRuns: reconcileTaskRuns, startTaskRun } = await import('../src/db/taskRuns.ts');
const { setPrice } = await import('../src/db/usage.ts');
const { recordUsage } = await import('../src/db/usage.ts');
const { createRun, pauseRun, reconcileOrphanedRuns } = await import('../src/orchestrator/runState.ts');
const { createScheduledTask, finishRun, startRun } = await import(
  '../src/services/cowork/scheduledTasks.ts'
);

let server: Server;
let base: string;

interface AttentionItemJson {
  id: string;
  kind: string;
  tool: string;
  title: string;
  detail: string;
  createdAt: number;
  taskId?: string;
  runId?: string;
  chatId?: string;
  resolve?: { method: string; path: string; body?: Record<string, unknown> };
}

interface AttentionSourceJson {
  source: string;
  status: string;
  count: number;
  reason?: string;
}

interface AttentionJson {
  generatedAt: number;
  total: number;
  counts: Record<string, number>;
  items: AttentionItemJson[];
  sources: AttentionSourceJson[];
}

async function queue(): Promise<AttentionJson & { statusCode: number }> {
  const res = await fetch(`${base}/api/attention`);
  const body = (await res.json()) as AttentionJson;
  return { ...body, statusCode: res.status };
}

function kinds(page: AttentionJson): string[] {
  return page.items.map((item) => item.kind);
}

function source(page: AttentionJson, name: string): AttentionSourceJson {
  const found = page.sources.find((entry) => entry.source === name);
  assert.ok(found, `expected a source named ${name}`);
  return found;
}

function item(page: AttentionJson, id: string): AttentionItemJson {
  const found = page.items.find((entry) => entry.id === id);
  assert.ok(found, `expected an item ${id} in [${page.items.map((i) => i.id).join(', ')}]`);
  return found;
}

const RANK = [
  'approval_required',
  'blocked',
  'plan_ready',
  'interrupted',
  'paused',
  'ready_for_review',
  'scheduled_run_failed',
  'backup_failure',
  'spending_cap',
  'mcp_disconnected',
];

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

describe('what the queue contains, and in what order', () => {
  const approvalTaskId = 'task-attention-code';
  const approvals: { id: string }[] = [];
  const chatId = { value: '' };
  const pausedRun = { value: '' };
  const taskRuns = { plan: '', review: '', blocked: '', interrupted: '', legacyInterrupted: '', ordinaryFailure: '' };
  const scheduled = { id: '', failedRun: '' };

  before(() => {
    // A real chat row: `chat_runs.chat_id` is a foreign key and this database
    // enforces them, so an invented id is rejected rather than producing the
    // dangling link these items are supposed to deep-link away from.
    chatId.value = createChat({ tool: 'chat', title: 'Attention queue' }).id;

    approvals.push(
      recordApproval({
        taskId: approvalTaskId,
        tool: 'code',
        toolName: 'bash',
        arguments: JSON.stringify({ command: 'rm -rf build' }),
        permissionKey: 'bash',
        matchedLayer: 'project',
        matchedPattern: 'bash:*',
        reason: 'The project rules deny this command.',
      }),
    );

    // A paused run, and an interrupted one produced the way production produces
    // it: a run left `running` by a restart, then reconciled.
    const run = createRun({ chatId: chatId.value, tool: 'chat', modelId: 'mock-model' });
    pausedRun.value = run.runId;
    pauseRun({
      runId: run.runId,
      reason: 'provider_failure',
      code: 'provider_timeout',
      message: 'The provider timed out.',
    });
    createRun({ chatId: chatId.value, tool: 'chat', modelId: 'mock-model' });
    reconcileOrphanedRuns();

    // A task run that produced a plan and wants review; one that merely wants
    // review; one interrupted by a restart; one that failed for its own reasons.
    taskRuns.plan = 'run-attention-plan';
    startTaskRun({ runId: taskRuns.plan, taskId: 'task-attention-plan', tool: 'code' });
    finishTaskRun(taskRuns.plan, 'ready_for_review', { pauseReason: 'awaiting_plan_approval' });
    recordStep({
      runId: taskRuns.plan,
      step: 1,
      kind: 'plan',
      mode: 'plan',
      detail: 'Move the parser into src/parser/ and keep the old export.\nThen add tests.',
    });

    taskRuns.review = 'run-attention-review';
    startTaskRun({ runId: taskRuns.review, taskId: 'task-attention-review', tool: 'design' });
    // A token a *park* wrote, which is what the column holds once `parkRun`
    // records one (1.31) — the queue must translate it rather than show it.
    finishTaskRun(taskRuns.review, 'ready_for_review', { pauseReason: 'plan_ready' });

    // Two interruptions, because both shapes are real. The current one is
    // produced the way production produces it — a run left `running`, then boot
    // reconciliation (migration 020 writes `interrupted`). The other keeps the
    // pre-020 shape on purpose: `error` with `internal_error` is what every
    // existing database holds, and a queue that stopped reporting those would go
    // silent on exactly the items that have been waiting longest.
    taskRuns.interrupted = 'run-attention-interrupted';
    startTaskRun({ runId: taskRuns.interrupted, taskId: 'task-attention-interrupted', tool: 'cowork' });
    taskRuns.legacyInterrupted = 'run-attention-legacy-interrupted';
    startTaskRun({ runId: taskRuns.legacyInterrupted, taskId: 'task-attention-legacy-interrupted', tool: 'code' });
    reconcileTaskRuns();

    // A run blocked by something the user has to resolve, carrying the token a
    // park writes. The queue translates it: the sentence for this reason invites a
    // review of a flagged message, which is only useful if it says so.
    taskRuns.blocked = 'run-attention-blocked';
    startTaskRun({ runId: taskRuns.blocked, taskId: 'task-attention-blocked', tool: 'cowork' });
    finishTaskRun(taskRuns.blocked, 'blocked', { pauseReason: 'redaction_blocked' });

    taskRuns.ordinaryFailure = 'run-attention-failed';
    startTaskRun({ runId: taskRuns.ordinaryFailure, taskId: 'task-attention-failed', tool: 'code' });
    finishTaskRun(taskRuns.ordinaryFailure, 'error', {
      code: 'provider_timeout',
      message: 'The provider timed out.',
    });

    scheduled.id = createScheduledTask({
      name: 'Morning briefing',
      prompt: 'summarise the news',
      schedule: 'daily:07:00',
      modelId: 'mock-model',
    }).id;
    scheduled.failedRun = startRun(scheduled.id);
    finishRun(scheduled.failedRun, scheduled.id, {
      status: 'failed',
      error: { code: 'provider_unavailable', message: 'no provider could be reached' },
    });

    logError({
      timestamp: Date.now(),
      severity: 'error',
      method: 'POST',
      endpoint: '/api/backup/inspect',
      error_code: 'storage_error',
      error_message: 'The backup directory is not writable.',
    });
  });

  test('reports each waiting thing once, with the source it came from', async () => {
    const page = await queue();

    assert.equal(page.statusCode, 200, 'an empty queue and a full one are both answers');
    assert.equal(item(page, `approval:${approvals[0]?.id}`).kind, 'approval_required');
    assert.equal(item(page, `paused:${pausedRun.value}`).kind, 'paused');
    assert.equal(item(page, `plan:${taskRuns.plan}`).kind, 'plan_ready');
    assert.equal(item(page, `review:${taskRuns.review}`).kind, 'ready_for_review');
    // The reason token is translated into a sentence at display time: the column
    // holds `plan_ready`, and a queue that printed the column would put a token in
    // front of the user. This read used to fall through to its generic fallback for
    // every parked run, because `parkRun` wrote no reason at all.
    const reviewDetail = item(page, `review:${taskRuns.review}`).detail;
    assert.match(reviewDetail, /plan/i);
    assert.doesNotMatch(reviewDetail, /^plan_ready$/, 'the token itself is not the sentence');

    const blockedItem = item(page, `blocked:${taskRuns.blocked}`);
    assert.equal(blockedItem.kind, 'blocked');
    assert.match(blockedItem.detail, /credential/i, 'the reason is what the user needs here');
    assert.notEqual(blockedItem.detail, 'redaction_blocked', 'not the raw token');
    assert.notEqual(
      blockedItem.detail,
      'The run is waiting on something it cannot resolve alone.',
      'and not the generic fallback the queue showed while nothing wrote a reason',
    );
    assert.equal(item(page, `interrupted:${taskRuns.interrupted}`).kind, 'interrupted');
    assert.equal(
      item(page, `interrupted:${taskRuns.legacyInterrupted}`).kind,
      'interrupted',
      'a row written before the interrupted state existed is still a thing to restart',
    );
    assert.equal(
      kinds(page).filter((kind) => kind === 'interrupted').length,
      3,
      'two task runs and the chat run',
    );
    assert.equal(item(page, `schedule:${scheduled.id}`).kind, 'scheduled_run_failed');
    assert.equal(kinds(page).filter((kind) => kind === 'backup_failure').length, 1);

    // A failure the user already saw is not a wait, so it is absent on purpose —
    // that is the difference between this queue and the feed.
    assert.equal(
      page.items.some((entry) => entry.runId === taskRuns.ordinaryFailure),
      false,
      'a plain failed run belongs in the feed, not in the queue',
    );
    // One item for the plan run, not two.
    assert.equal(page.items.filter((entry) => entry.runId === taskRuns.plan).length, 1);
  });

  test('reads in priority order, oldest wait first inside a kind', async () => {
    const page = await queue();
    const ranks = page.items.map((entry) => {
      const index = RANK.indexOf(entry.kind);
      assert.notEqual(index, -1, `unknown kind ${entry.kind}`);
      return index;
    });
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'kinds must be grouped in rank order');
    assert.equal(page.items[0]?.kind, 'approval_required', 'a decision outranks a notification');

    for (let index = 1; index < page.items.length; index += 1) {
      const previous = page.items[index - 1];
      const current = page.items[index];
      if (previous?.kind !== current?.kind) continue;
      assert.ok(
        (previous?.createdAt ?? 0) <= (current?.createdAt ?? 0),
        `${current?.id} is newer than ${previous?.id} inside kind ${current?.kind}`,
      );
    }
  });

  test('points at the call that resolves the item, never at a frontend route', async () => {
    const page = await queue();
    const approval = item(page, `approval:${approvals[0]?.id}`);
    assert.deepEqual(approval.resolve, {
      method: 'POST',
      path: `/api/code/tasks/${approvalTaskId}/approve`,
    });
    assert.equal(approval.tool, 'code');
    assert.equal(approval.taskId, approvalTaskId);

    const paused = item(page, `paused:${pausedRun.value}`);
    assert.equal(paused.resolve?.path, '/api/chat/resume');
    assert.equal(paused.resolve?.body?.runId, pausedRun.value, 'the resume call needs the run');
    assert.equal(paused.chatId, chatId.value);
  });

  test('counts what it returns, by kind', async () => {
    const page = await queue();
    assert.equal(
      page.total,
      page.items.length,
      'the count is the list, so a UI cannot disagree with itself',
    );
    const summed = Object.values(page.counts).reduce((total, value) => total + value, 0);
    assert.equal(summed, page.total);
    assert.equal(page.counts.approval_required, 1);
    assert.equal(page.counts.plan_ready, 1);
    assert.equal(page.counts.interrupted, 3, 'two task runs and a chat run');
  });

  test('says which sources it could not read instead of omitting them', async () => {
    const page = await queue();

    assert.equal(source(page, 'pending_approvals').status, 'ok');
    assert.equal(source(page, 'task_runs').count, 5, 'plan, review, blocked, and two interruptions');
    assert.equal(source(page, 'chat_runs').count, 2);
    assert.equal(source(page, 'scheduled_task_runs').status, 'ok');

    // No MCP manager is installed in this harness, and no cap is configured, so
    // both are `unavailable` with the reason — the state that must not be
    // indistinguishable from "nothing to report".
    const mcp = source(page, 'mcp');
    assert.equal(mcp.status, 'unavailable');
    assert.ok(mcp.reason && mcp.reason.length > 0, 'unavailable must carry a reason');

    const spending = source(page, 'spending');
    assert.equal(spending.status, 'unavailable');
    assert.match(spending.reason ?? '', /no daily spending cap/);

    // And the one source that is detected rather than recorded says so.
    assert.match(source(page, 'backup_failures').reason ?? '', /error log/);
  });

  test('an answered prompt leaves the queue, and a later success clears a schedule', async () => {
    const before_ = await queue();
    assert.equal(item(before_, `approval:${approvals[0]?.id}`).kind, 'approval_required');

    resolveApproval(approvals[0]?.id ?? '', 'deny');
    const after_ = await queue();
    assert.equal(
      after_.items.some((entry) => entry.id === `approval:${approvals[0]?.id}`),
      false,
      'a resolved approval is not waiting on anyone',
    );
    assert.equal(after_.counts.approval_required, undefined);
    assert.equal(source(after_, 'pending_approvals').status, 'empty');
    assert.equal(after_.total, before_.total - 1, 'exactly one item left');

    const success = startRun(scheduled.id);
    finishRun(success, scheduled.id, { status: 'success', summary: 'Wrote up 6 stories.' });
    const cleared = await queue();
    assert.equal(
      cleared.items.some((entry) => entry.id === `schedule:${scheduled.id}`),
      false,
      'last_status is the scheduler verdict, so a success clears the failure with no window to expire',
    );
    assert.equal(source(cleared, 'scheduled_task_runs').status, 'empty');
  });
});

describe('the spending source, once a cap exists', () => {
  before(() => {
    setPrice({ modelId: 'mock-model', providerId: null, inputPer1mUsd: 1_000_000, outputPer1mUsd: 0 });
    recordUsage({ tool: 'chat', modelId: 'mock-model', tokensIn: 5, tokensOut: 0 });
    setSetting('daily_spend_cap_usd', 6);
  });

  test('warns before the cap refuses anything, and names the incomplete part', async () => {
    const page = await queue();
    const warning = item(page, 'spending:warning');
    assert.equal(warning.kind, 'spending_cap');
    assert.match(warning.detail, /autonomous runs are refused at the cap/i);
    assert.equal(source(page, 'spending').status, 'ok');
    assert.equal(
      page.items.some((entry) => entry.id === 'spending:cap'),
      false,
      'a warning is not the refusal: one item at 80%, a different one at the cap',
    );
  });

  test('becomes the refusal once the cap is reached', async () => {
    setSetting('daily_spend_cap_usd', 5);
    const page = await queue();
    const reached = item(page, 'spending:cap');
    assert.equal(reached.title, "Today's spending cap is reached");
    assert.equal(
      page.items.some((entry) => entry.id === 'spending:warning'),
      false,
      'one item, not two ways of saying the same thing',
    );
  });
});
