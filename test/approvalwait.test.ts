/**
 * The interactive wait has a deadline (1.31).
 *
 * `pending_approvals` documented an `expired` state and named the reason it
 * exists — "the reaper" — while no reaper existed. A prompt therefore stayed
 * `pending` forever: it kept being listed as something the user could act on, and
 * a click on a week-old one still authorised its call, against a conversation and
 * a checkout from a week ago. Two readers were already written expecting the
 * deadline to exist (`approvals.ts`'s own comment, and the attention queue's
 * "what is this task waiting on"), which is how the gap stayed invisible.
 *
 * Each claim below is a way the fix could be worse than the bug:
 *
 *   - **The question expires; the task does not.** A parked run whose prompt
 *     expired stays parked and stays continuable — continuing replays the
 *     conversation, re-emits the gated call and asks again. A timer that ended the
 *     run would be the thing that destroyed a recoverable task, so the case is
 *     pinned rather than left to the sweep's implementation.
 *   - **Only `pending` is touched.** `allow_session` is a standing rule, not a
 *     wait, and `closeApprovals` is what clears those at the task's terminal
 *     transition (1.27 §1). A sweep that expired them would silently revoke a
 *     permission the user granted.
 *   - **An answer beats the reaper.** The update is guarded on the row still being
 *     `pending`, so a decision landing at the same moment as the sweep wins.
 *   - **The deadline a client is told about is the deadline enforced.** The route
 *     computes `expiresAt` from the same setting the sweep reads.
 *   - **A restart closes its own questions.** Boot reconciliation demotes a
 *     `blocked` run to `interrupted` with the message "it can no longer receive an
 *     answer" — leaving that run's prompt `pending` was the same bug one layer
 *     down, and it is what the reconciliation case below pins.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

import type { ChatMessage } from '../src/types/core.ts';
import type { Server } from 'node:http';

const {
  expireStaleApprovals,
  listPendingApprovals,
  recordApproval,
  resolveApproval,
  sessionPermissionRules,
} = await import('../src/db/approvals.ts');
const { approvalExpiresAt, approvalWaitTtlMs, expireWaitingApprovals } = await import(
  '../src/services/agent/approvalWait.ts'
);
const { approvalWaitTtlHours, getSetting, setSetting } = await import('../src/db/settings.ts');
const { getDb } = await import('../src/db/adapter.ts');
const { finishTaskRun, latestRunForTask, reconcileOrphanedTaskRuns, startTaskRun } = await import(
  '../src/db/taskRuns.ts'
);
const { snapshotConversation } = await import('../src/db/taskMessages.ts');
const { attentionQueue } = await import('../src/services/attention/queue.ts');
const { registerAgent, resetModules } = await import('../src/orchestrator/agents.ts');

const HOUR = 3_600_000;

let server: Server;
let base = '';
let counter = 0;
/** Set by the registered stub: a continuation that reaches an agent is a failure. */
let agentStarted = false;

function nextTask(prefix = 'wait'): string {
  counter += 1;
  return `${prefix}-task-${counter}`;
}

function conversation(): ChatMessage[] {
  return [
    { role: 'system', content: 'You are Code.' },
    { role: 'user', content: 'Rewrite the parser.' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'write', arguments: '{"path":"src/parser.ts"}' }],
    },
  ];
}

/** A task parked on an approval, the way the loop leaves one. */
function parkedOnApproval(taskId = nextTask()): { taskId: string; runId: string; approvalId: string } {
  const runId = `run-${taskId}`;
  startTaskRun({ runId, taskId, tool: 'code' });
  const approval = recordApproval({
    runId,
    taskId,
    tool: 'code',
    toolName: 'write',
    arguments: '{"path":"src/parser.ts"}',
    permissionKey: 'write',
    matchedLayer: 'project',
    matchedPattern: 'src/**',
    reason: 'Writing to src/parser.ts needs a decision.',
  });
  finishTaskRun(runId, 'blocked', { pauseReason: 'approval_required' });
  snapshotConversation(taskId, conversation());
  return { taskId, runId, approvalId: approval.id };
}

/** Age a prompt, because the deadline is a fact about `created_at`. */
function ageApproval(approvalId: string, ageMs: number): void {
  getDb()
    .prepare('UPDATE pending_approvals SET created_at = ? WHERE id = ?')
    .run(Date.now() - ageMs, approvalId);
}

async function send(
  method: 'GET' | 'POST',
  path: string,
  payload?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, never> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, never> };
}

before(async () => {
  const { createApp } = await import('../src/http/app.ts');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  await freshDb();
  // A continuation that gets as far as an agent would stream a run; the stub exists
  // so the guard tests can assert it never happened.
  resetModules();
  agentStarted = false;
  registerAgent('code', {
    async runTask(): Promise<{ ok: true; summary: string }> {
      agentStarted = true;
      return { ok: true, summary: 'the agent should not have been reached' };
    },
  });
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await cleanupHome();
});

describe('how long a prompt waits', () => {
  it('defaults to three days', () => {
    assert.equal(approvalWaitTtlHours(), 72);
    assert.equal(approvalWaitTtlMs(), 72 * HOUR);
    assert.equal(getSetting('approval_wait_ttl_hours'), null);
  });

  it('honours a configured deadline', () => {
    setSetting('approval_wait_ttl_hours', 8);
    assert.equal(approvalWaitTtlHours(), 8);
    assert.equal(approvalExpiresAt(1_000_000), 1_000_000 + 8 * HOUR);
  });

  it('reads zero and negatives as the default rather than as expire-immediately', () => {
    setSetting('approval_wait_ttl_hours', 0);
    assert.equal(approvalWaitTtlHours(), 72);
    setSetting('approval_wait_ttl_hours', -5);
    assert.equal(approvalWaitTtlHours(), 72);
  });
});

describe('the sweep closes prompts that waited too long', () => {
  it('expires a prompt past the deadline and reports it', () => {
    const { taskId, approvalId } = parkedOnApproval();
    ageApproval(approvalId, 73 * HOUR);
    const now = Date.now();

    const expired = expireStaleApprovals({ ttlMs: 72 * HOUR, now });

    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.id, approvalId);
    assert.equal(expired[0]?.taskId, taskId);
    assert.equal(expired[0]?.state, 'expired', 'the returned row is the post-update row');
    assert.equal(expired[0]?.resolvedAt, now);
    assert.deepEqual(listPendingApprovals(taskId), []);
  });

  it('leaves a prompt inside the deadline alone', () => {
    const { approvalId } = parkedOnApproval();
    ageApproval(approvalId, 71 * HOUR);

    assert.deepEqual(expireStaleApprovals({ ttlMs: 72 * HOUR }), []);
    assert.equal(listPendingApprovals(parkedOnApproval().taskId).length, 1);
  });

  it('treats the deadline itself as expired and one millisecond under as not', () => {
    const ttl = 72 * HOUR;
    const now = 1_000 * HOUR;
    const first = parkedOnApproval();
    const second = parkedOnApproval();
    // `created_at <= now - ttl` is the rule; the two rows sit either side of it.
    getDb()
      .prepare('UPDATE pending_approvals SET created_at = ? WHERE id = ?')
      .run(now - ttl, first.approvalId);
    getDb()
      .prepare('UPDATE pending_approvals SET created_at = ? WHERE id = ?')
      .run(now - ttl + 1, second.approvalId);

    const expired = expireStaleApprovals({ ttlMs: ttl, now });

    assert.deepEqual(
      expired.map((approval) => approval.id),
      [first.approvalId],
    );
    assert.equal(listPendingApprovals(second.taskId).length, 1);
  });

  it('never touches an answered prompt', () => {
    const { taskId, approvalId } = parkedOnApproval();
    resolveApproval(approvalId, 'allow_session');
    ageApproval(approvalId, 400 * HOUR);

    assert.deepEqual(expireStaleApprovals({ ttlMs: 72 * HOUR }), []);
    assert.equal(sessionPermissionRules(taskId).write !== undefined, true, 'the rule stands');
  });

  it('lets a decision that lands first win over the reaper', () => {
    // The guarded update is `WHERE id = ? AND state = 'pending'`, the same mutex
    // `resolveApproval` uses. Answered *after* the read that selects candidates and
    // before the update, the row must not be reported as expired — a prompt the user
    // just approved cannot also be one the sweep closed.
    const { taskId, approvalId } = parkedOnApproval();
    ageApproval(approvalId, 400 * HOUR);
    const candidates = listPendingApprovals(taskId);
    assert.equal(candidates.length, 1, 'the row is past the deadline');

    resolveApproval(approvalId, 'allow_once');
    const expired = expireStaleApprovals({ ttlMs: 72 * HOUR });

    assert.deepEqual(expired, [], 'the decision won');
    assert.equal(sessionPermissionRules(taskId).write, undefined, 'allow_once is not a rule');
  });

  it('is idempotent — a second pass has nothing to do', () => {
    const { approvalId } = parkedOnApproval();
    ageApproval(approvalId, 100 * HOUR);

    assert.equal(expireStaleApprovals({ ttlMs: 72 * HOUR }).length, 1);
    assert.deepEqual(expireStaleApprovals({ ttlMs: 72 * HOUR }), []);
  });

  it('leaves another task\'s fresh prompt alone', () => {
    const stale = parkedOnApproval();
    const fresh = parkedOnApproval();
    ageApproval(stale.approvalId, 100 * HOUR);

    const expired = expireWaitingApprovals();

    assert.deepEqual(
      expired.map((approval) => approval.taskId),
      [stale.taskId],
    );
    assert.equal(listPendingApprovals(fresh.taskId).length, 1);
  });
});

describe('the route tells a client when the wait ends', () => {
  it('reports the same deadline the sweep enforces', async () => {
    const { taskId, approvalId } = parkedOnApproval();

    const listed = await send('GET', `/api/code/tasks/${taskId}/approvals`);

    assert.equal(listed.status, 200);
    const approvals = listed.body.approvals as unknown as {
      id: string;
      createdAt: number;
      expiresAt: number;
    }[];
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.id, approvalId);
    assert.equal(approvals[0]?.expiresAt, (approvals[0]?.createdAt ?? 0) + approvalWaitTtlMs());
  });

  it('reports the configured deadline rather than the built-in one', async () => {
    // One number, three readers — the sweep, the deadline, and the log line that
    // says why a prompt disappeared. A route that computed `createdAt + 72h`
    // itself would be wrong for every user who changed the setting, and wrong
    // invisibly until a countdown reached zero at the wrong moment.
    setSetting('approval_wait_ttl_hours', 8);
    const { taskId } = parkedOnApproval();

    const listed = await send('GET', `/api/code/tasks/${taskId}/approvals`);
    const approvals = listed.body.approvals as unknown as { createdAt: number; expiresAt: number }[];

    assert.equal(approvals[0]?.expiresAt, (approvals[0]?.createdAt ?? 0) + 8 * HOUR);
  });

  it('stops listing a prompt the sweep expired, and says why the answer did not apply', async () => {
    const { taskId, approvalId } = parkedOnApproval();
    ageApproval(approvalId, 100 * HOUR);
    expireWaitingApprovals();

    const listed = await send('GET', `/api/code/tasks/${taskId}/approvals`);
    assert.equal(listed.body.count, 0);

    const approved = await send('POST', `/api/code/tasks/${taskId}/approve`, {
      approvalId,
      decision: 'allow_once',
    });
    assert.equal(approved.status, 200, 'answering an expired prompt is not an error');
    assert.equal(approved.body.applied, false);
    assert.equal(approved.body.state, 'expired');
    assert.equal(approved.body.continuable, false, 'nothing was authorised');
  });

  it('refuses a continuation that answers an expired prompt, in its own words', async () => {
    const { taskId, runId, approvalId } = parkedOnApproval();
    ageApproval(approvalId, 100 * HOUR);
    expireWaitingApprovals();

    const continued = await send('POST', `/api/code/tasks/${taskId}/continue`, {
      approvalId,
      decision: 'allow_once',
    });

    assert.equal(continued.status, 409);
    const error = continued.body.error as unknown as {
      message: string;
      details: { reason: string; waitHours: number };
    };
    assert.equal(error.details.reason, 'expired');
    assert.notEqual(error.details.reason, 'already_resolved', 'nobody answered this one');
    assert.equal(error.details.waitHours, 72);
    assert.match(error.message, /Continue the task to be asked again/);
    assert.equal(agentStarted, false, 'the refusal happens before any agent work');
    assert.equal(latestRunForTask('code', taskId)?.state, 'blocked', 'and the run is untouched');
    assert.equal(runId, `run-${taskId}`);
  });

  it('keeps saying "already resolved" for a prompt somebody answered', async () => {
    const { taskId, approvalId } = parkedOnApproval();
    resolveApproval(approvalId, 'allow_once');

    const continued = await send('POST', `/api/code/tasks/${taskId}/continue`, {
      approvalId,
      decision: 'allow_once',
    });

    assert.equal(continued.status, 409);
    const error = continued.body.error as unknown as { message: string; details: { reason: string } };
    assert.equal(error.details.reason, 'already_resolved');
    assert.match(error.message, /already been resolved/);
  });

  it('leaves the task continuable, so the prompt is a deadline and not a dead end', async () => {
    // The claim that matters most: an expired wait does not end the run. Continuing
    // without an approvalId is the documented way back — the loop replays the
    // conversation and asks again with fresh arguments.
    const { taskId, approvalId } = parkedOnApproval();
    ageApproval(approvalId, 100 * HOUR);
    expireWaitingApprovals();

    // A continuation is an SSE stream, so this one is read as text rather than
    // parsed: the point is that it was accepted and reached the agent at all.
    const response = await fetch(`${base}/api/code/tasks/${taskId}/continue`, { method: 'POST' });
    const stream = await response.text();

    assert.equal(response.status, 200, 'the task is still parked and still continuable');
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.match(stream, /"channel":"result"/);
    assert.equal(agentStarted, true, 'the continuation reached the agent');
    assert.equal(latestRunForTask('code', taskId)?.state, 'complete');
  });
});

describe('the sweep runs on the cleanup tick', () => {
  it('closes prompts and runs the storage sweep in the same pass', async () => {
    // The wiring itself, rather than the sweep in isolation: the timer calls
    // `runCleanupTick`, so calling it here is what the timer does. Without this the
    // sweep could be perfect and never run.
    const { runCleanupTick } = await import('../src/services/storage/cleanup.ts');
    const { taskId, approvalId } = parkedOnApproval();
    ageApproval(approvalId, 100 * HOUR);

    runCleanupTick();

    assert.deepEqual(listPendingApprovals(taskId), []);
    const logged = getDb().prepare<{ n: number }>('SELECT COUNT(*) AS n FROM cleanup_log').get();
    assert.equal(logged?.n, 1, 'and the storage half still ran alongside it');
  });
});

describe('a restart closes the questions it can no longer take', () => {
  it('expires the prompts of the runs it demotes', () => {
    const { taskId, runId } = parkedOnApproval();
    // A standing rule from the same park, for the terminal-transition half.
    const session = recordApproval({
      runId,
      taskId,
      tool: 'code',
      toolName: 'read',
      arguments: '{"path":"src/a.ts"}',
      permissionKey: 'read',
    });
    resolveApproval(session.id, 'allow_session');

    const demoted = reconcileOrphanedTaskRuns();

    assert.equal(demoted, 1);
    assert.equal(latestRunForTask('code', taskId)?.state, 'interrupted');
    assert.deepEqual(listPendingApprovals(taskId), [], 'a dead run keeps no answerable prompt');
    assert.equal(
      sessionPermissionRules(taskId).read,
      undefined,
      'and a session allowance ends with the task it was granted to',
    );
    const error = latestRunForTask('code', taskId)?.errorMessage ?? '';
    assert.match(error, /can no longer receive an answer/);
  });

  it('takes the prompt out of the attention queue instead of leaving a dead action', () => {
    const { taskId, approvalId } = parkedOnApproval();
    const before = attentionQueue();
    assert.equal(
      before.items.some((item) => item.id === `approval:${approvalId}`),
      true,
      'while it is answerable the prompt is an item',
    );

    reconcileOrphanedTaskRuns();

    const after = attentionQueue();
    assert.equal(
      after.items.some((item) => item.id === `approval:${approvalId}`),
      false,
      'a resolve action that can only fail must not stay in the queue',
    );
    assert.equal(
      after.items.some((item) => item.id.startsWith('interrupted:')),
      true,
      'the run itself is still reported — the restart is what the user needs to know',
    );
    assert.equal(
      after.sources.find((source) => source.source === 'pending_approvals')?.count,
      0,
    );
    assert.equal(listPendingApprovals(taskId).length, 0);
  });

  it('the sweep ends the wait and not the run', () => {
    const { taskId, approvalId } = parkedOnApproval();
    ageApproval(approvalId, 100 * HOUR);

    assert.equal(expireWaitingApprovals().length, 1);

    // Only a restart or a decision moves a run; a deadline on its question does
    // not, which is what keeps an expired prompt recoverable by continuing.
    assert.equal(latestRunForTask('code', taskId)?.state, 'blocked');
  });
});
