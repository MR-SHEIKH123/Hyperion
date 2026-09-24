/**
 * The outbound credential gate on the task-run path.
 *
 * `assertOutboundSafe` was called from `orchestrator/chat.ts` and nowhere else, so
 * a Code, Cowork or Design run reached a remote provider unscanned: with the
 * redaction check switched on, a credential-shaped prompt in a task went out and
 * the usage row recorded that it had. The receiving half of the mechanism already
 * existed — `parkOnBlockedSend`, and its `redaction_blocked` branch — and was
 * unreachable, because nothing on this path called the scan.
 *
 * Three claims are tested, and they are the whole of the change:
 *
 *   1. **A task run is scanned, and parks rather than sending.** The provider is a
 *      real HTTP server, so "the send did not happen" is a count of the requests
 *      it received and not a claim about a mock.
 *   2. **An approved ticket lets the identical resume through.** This is the "parks
 *      forever" failure the register flagged, and the reason the ticket is checked
 *      before the gate refuses rather than after: the resumed run sends the same
 *      conversation, finds the same credential, and must not park again.
 *   3. **A denied or unanswered question still blocks.** An approval is not a
 *      blanket waiver of the scan, and a park with no answer is still a park.
 *
 * Plus the two facts those depend on: the gate is opt-in, and a continuation
 * records the lineage its ticket is settled against. The last one is a real gap,
 * not a formality — `task_runs.continued_from` was added by migration `026`, read
 * by `ticketContext`, and written by nobody, so *every* replayed approval was one
 * edit away from being refused as `run_replaced`.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Server } from 'node:http';
import type { AgentContext, ChatMessage, TaskInput, TaskResult, ToolCall } from '../src/types/core.ts';
import type { MockProvider } from './helpers.ts';

const { cleanupHome, freshDb, startMockProvider } = await import('./helpers.ts');
const { createApp } = await import('../src/http/app.ts');
const { registerAgent, resetModules } = await import('../src/orchestrator/agents.ts');
const { resetCodeLane, resetLock } = await import('../src/orchestrator/lock.ts');
const { createAgentContext } = await import('../src/orchestrator/agentContext.ts');
const { createProvider } = await import('../src/providers/repository.ts');
const { createChat } = await import('../src/db/chats.ts');
const { REDACTION_CHECK_KEY, setSetting } = await import('../src/db/settings.ts');
const { startTaskRun, getTaskRun, updateTaskRunState } = await import('../src/db/taskRuns.ts');
const { listPendingApprovals, resolveApproval } = await import('../src/db/approvals.ts');
const { listTickets } = await import('../src/db/approvalTickets.ts');
const { snapshotConversation } = await import('../src/db/taskMessages.ts');
const { runAgentLoop } = await import('../src/services/agent/loop.ts');
const { OUTBOUND_SEND_TOOL } = await import('../src/services/safety/outboundGate.ts');

import type { AgentLoopInput } from '../src/services/agent/loop.ts';

let server: Server;
let base: string;
let mock: MockProvider;

const MODEL = 'mock-model';
/** Matches `PREFIXED_KEY` in `util/redact.ts` without being a real credential. */
const SECRET = 'sk-live-ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';

before(async () => {
  await freshDb();
  mock = await startMockProvider({ models: [MODEL], tokens: ['done'] });
  createProvider({ name: 'Mock', type: 'remote', baseUrl: mock.baseUrl, enabled: true });
  createChat({ id: 'chat-gate', tool: 'code' });

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
  await mock.close();
  await cleanupHome();
});

beforeEach(() => {
  resetModules();
  resetLock();
  resetCodeLane(2);
  setSetting(REDACTION_CHECK_KEY, true);
});

/** The conversation a task run sends: one user turn carrying a credential. */
function conversation(): ChatMessage[] {
  return [
    { role: 'system', content: 'You are Code.' },
    { role: 'user', content: `Deploy it with ${SECRET} as the key.` },
  ];
}

/**
 * One loop iteration through the real agent context: the request is made by the
 * same seam every agent uses, so the scan is the one production runs.
 */
function loopFor(options: { taskId: string; runId: string; messages: ChatMessage[] }) {
  const ctx = createAgentContext({
    tool: 'code',
    chatId: 'chat-gate',
    modelId: MODEL,
    sse: {
      signal: new AbortController().signal,
      emit: () => {},
      sendError: () => {},
      close: () => {},
    } as unknown as Parameters<typeof createAgentContext>[0]['sse'],
    taskId: options.taskId,
    runId: options.runId,
  });

  const input: AgentLoopInput = {
    runId: options.runId,
    taskId: options.taskId,
    tool: 'code',
    mode: 'act',
    policy: { effect: () => 'read' },
    // No permission resolver and no resolver revision, so no tool-call ticket is
    // in play: anything that authorises this send can only be a send ticket.
    run: async () => 'ran',
    unattended: false,
    turn: async () => {
      for await (const _chunk of ctx.llm.stream({ modelId: MODEL, messages: options.messages })) {
        // Consuming the stream is what makes the request; the chunks are not the
        // subject here.
      }
      return [] as ToolCall[];
    },
    iterationCeiling: 1,
    context: {
      messages: () => options.messages,
      replace: () => {},
      window: { tokens: 8_000, source: 'model', assumed: true },
    },
  };

  return { ctx, input };
}

/** Drive one run and report whether it sent, parked, or failed. */
async function runOnce(taskId: string, runId: string, messages: ChatMessage[]): Promise<{
  sent: boolean;
  parked: string | undefined;
  error: string | undefined;
}> {
  const { ctx, input } = loopFor({ taskId, runId, messages });
  try {
    const result = await runAgentLoop(input, ctx);
    return { sent: true, parked: result.parked, error: undefined };
  } catch (error) {
    const app = error as { code?: string; parked?: string };
    return { sent: false, parked: app.parked, error: app.code ?? 'unknown' };
  }
}

let counter = 0;

/** A parked run plus the conversation a continuation would replay. */
function parkRunForContinuation(): { taskId: string; runId: string } {
  counter += 1;
  const taskId = `gate-task-${counter}`;
  const runId = `gate-run-${counter}`;
  startTaskRun({ runId, taskId, tool: 'code', chatId: 'chat-gate' });
  snapshotConversation(taskId, conversation());
  updateTaskRunState(runId, 'blocked', { pauseReason: 'redaction_blocked' });
  return { taskId, runId };
}

describe('a task run bound for a remote provider', () => {
  it('parks on a credential-shaped payload instead of sending it', async () => {
    counter += 1;
    const taskId = `scan-task-${counter}`;
    const runId = `scan-run-${counter}`;
    startTaskRun({ runId, taskId, tool: 'code', chatId: 'chat-gate' });
    const before = mock.streamCalls.length;

    const { sent, error } = await runOnce(taskId, runId, conversation());

    // The point of the gate: the request never left the machine.
    assert.equal(sent, false);
    assert.equal(error, 'redaction_flagged');
    assert.equal(mock.streamCalls.length, before, 'the provider must not have been called');

    const run = getTaskRun(runId);
    assert.equal(run?.state, 'blocked');
    assert.equal(run?.pauseReason, 'redaction_blocked');
  });

  it('records the finding as a question the user can answer, without quoting it', async () => {
    counter += 1;
    const taskId = `ask-task-${counter}`;
    const runId = `ask-run-${counter}`;
    startTaskRun({ runId, taskId, tool: 'code', chatId: 'chat-gate' });

    await runOnce(taskId, runId, conversation());

    const pending = listPendingApprovals(taskId);
    assert.equal(pending.length, 1, 'a park waiting on an answer needs an approval row behind it');
    const approval = pending[0];
    assert.equal(approval?.toolName, OUTBOUND_SEND_TOOL);
    // Offsets and rule names, never the matched text: this row is listed by the
    // approvals route and rendered in the task.
    assert.doesNotMatch(JSON.stringify(approval), /SECRET|sk-live-ABCDEFGH/);
    assert.match(approval?.arguments ?? '', /vendor_prefixed_key/);
    assert.match(approval?.arguments ?? '', /"index":\d+/);

    const tickets = listTickets(taskId);
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0]?.state, 'pending');
    assert.equal(tickets[0]?.toolName, OUTBOUND_SEND_TOOL);
  });

  it('parks the same finding once, rather than stacking a second question', async () => {
    counter += 1;
    const taskId = `dedupe-task-${counter}`;
    const runId = `dedupe-run-${counter}`;
    startTaskRun({ runId, taskId, tool: 'code', chatId: 'chat-gate' });

    await runOnce(taskId, runId, conversation());
    // A second run against the same task and the same finding: the continuation
    // the user has not made yet, in the shape the reaper sees first.
    await runOnce(taskId, `${runId}-b`, conversation());

    assert.equal(listPendingApprovals(taskId).length, 1, 'one question, asked once');
  });

  it('sends nothing at all when the check is switched off', async () => {
    setSetting(REDACTION_CHECK_KEY, false);
    counter += 1;
    const taskId = `off-task-${counter}`;
    const runId = `off-run-${counter}`;
    startTaskRun({ runId, taskId, tool: 'code', chatId: 'chat-gate' });
    const before = mock.streamCalls.length;

    const { sent, parked } = await runOnce(taskId, runId, conversation());

    // Opt-in means opt-in: the run proceeds, it is just not scanned.
    assert.equal(sent, true);
    assert.equal(parked, undefined);
    assert.equal(mock.streamCalls.length, before + 1);
    assert.equal(listPendingApprovals(taskId).length, 0);
  });
});

describe('resuming a redaction_blocked park', () => {
  it('lets the identical payload through once the finding is allowed once', async () => {
    const { taskId, runId } = parkRunForContinuation();
    // Park it for real, so the approval and the ticket exist.
    await runOnce(taskId, runId, conversation());
    const approval = listPendingApprovals(taskId)[0];
    assert.ok(approval);
    const before = mock.streamCalls.length;

    resolveApproval(approval.id, 'allow_once');
    assert.equal(listTickets(taskId)[0]?.state, 'armed');

    // The continuation, exactly as `POST .../continue` creates it: a second run
    // id that records the parked one as its predecessor.
    const continuationRunId = `${runId}-continue`;
    startTaskRun({ runId: continuationRunId, taskId, tool: 'code', chatId: 'chat-gate', continuedFrom: runId });

    const { sent, parked, error } = await runOnce(taskId, continuationRunId, conversation());

    assert.equal(parked, undefined, 'an approved finding must not park again');
    assert.equal(error, undefined);
    assert.equal(sent, true);
    assert.equal(mock.streamCalls.length, before + 1, 'the resumed send went out');
    // Not consumed: the next turn of the same run sends the same conversation.
    assert.equal(listTickets(taskId)[0]?.state, 'armed');
  });

  it('still blocks when the same question was denied', async () => {
    const { taskId, runId } = parkRunForContinuation();
    await runOnce(taskId, runId, conversation());
    const approval = listPendingApprovals(taskId)[0];
    assert.ok(approval);
    const before = mock.streamCalls.length;

    resolveApproval(approval.id, 'deny');
    assert.equal(listTickets(taskId)[0]?.state, 'void');

    const continuationRunId = `${runId}-continue`;
    startTaskRun({ runId: continuationRunId, taskId, tool: 'code', chatId: 'chat-gate', continuedFrom: runId });

    const { sent, error } = await runOnce(taskId, continuationRunId, conversation());

    assert.equal(sent, false);
    assert.equal(error, 'redaction_flagged');
    assert.equal(mock.streamCalls.length, before, 'a denied finding authorises nothing');
    assert.equal(getTaskRun(continuationRunId)?.pauseReason, 'redaction_blocked');
  });

  it('still blocks when the question has not been answered at all', async () => {
    const { taskId, runId } = parkRunForContinuation();
    await runOnce(taskId, runId, conversation());
    const before = mock.streamCalls.length;

    // Continue without deciding: the ticket is still `pending`.
    const continuationRunId = `${runId}-continue`;
    startTaskRun({ runId: continuationRunId, taskId, tool: 'code', chatId: 'chat-gate', continuedFrom: runId });

    const { sent, error } = await runOnce(taskId, continuationRunId, conversation());

    assert.equal(sent, false);
    assert.equal(error, 'redaction_flagged');
    assert.equal(mock.streamCalls.length, before);
  });

  it('does not honour an approval for a different finding', async () => {
    const { taskId, runId } = parkRunForContinuation();
    await runOnce(taskId, runId, conversation());
    const approval = listPendingApprovals(taskId)[0];
    assert.ok(approval);
    resolveApproval(approval.id, 'allow_once');
    const before = mock.streamCalls.length;

    // A *different* credential, in a different place: the same question this is
    // not. The approved span was the user's key in turn 1, not this one.
    const other: ChatMessage[] = [
      { role: 'system', content: 'You are Code.' },
      { role: 'user', content: 'Deploy it with sk-live-ZZZZZZZZZZZZZZZZZZZZ9999999999 as the key.' },
    ];
    const continuationRunId = `${runId}-continue`;
    startTaskRun({ runId: continuationRunId, taskId, tool: 'code', chatId: 'chat-gate', continuedFrom: runId });

    const { sent, error } = await runOnce(taskId, continuationRunId, other);

    assert.equal(sent, false);
    assert.equal(error, 'redaction_flagged');
    assert.equal(mock.streamCalls.length, before, 'an approval binds the finding it was granted for');
  });
});

describe('the lineage a resumed approval is settled against', () => {
  it('records the parked run on the continuation, over HTTP', async () => {
    const { taskId, runId } = parkRunForContinuation();
    let observed: string | undefined;

    registerAgent('code', {
      async runTask(_input: TaskInput, ctx: AgentContext): Promise<TaskResult> {
        observed = ctx.runId;
        return { ok: true, summary: 'continued' };
      },
    });

    const response = await fetch(`${base}/api/code/tasks/${taskId}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 200);
    await response.text();

    assert.ok(observed, 'the continuation ran');
    // Migration `026` added this column for the check `ticketContext` performs,
    // and nothing wrote it: without it every replayed approval is `run_replaced`.
    assert.equal(getTaskRun(observed)?.continuedFrom, runId);
  });
});
