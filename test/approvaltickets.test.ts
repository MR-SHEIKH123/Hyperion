import './helpers.ts';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { AgentContext, ToolCall } from '../src/types/core.ts';

const { freshDb, cleanupHome } = await import('./helpers.ts');
const { startTaskRun, getTaskRun } = await import('../src/db/taskRuns.ts');
const { recordApproval, resolveApproval, listPendingApprovals } = await import('../src/db/approvals.ts');
const { mintTicket, settleTicket, ticketForCall, listTickets } = await import(
  '../src/db/approvalTickets.ts'
);
const { createPermissionResolver } = await import('../src/services/agent/permissions.ts');
const { dispatchToolCall, runAgentLoop } = await import('../src/services/agent/loop.ts');
const { getDb } = await import('../src/db/adapter.ts');

import type { ToolFeedback } from '../src/services/agent/loop.ts';

type TicketRefusal = 'not_approved' | 'denied' | 'already_consumed' | 'expired' | 'mismatch' | 'run_replaced';

let counter = 0;

interface Binding {
  toolName: string;
  permissionKey: string;
  arguments: string;
  workspace: string;
  taskId: string;
  runId: string | null;
  parentTaskId: string | null;
  revision: string;
}

/** The live binding a ticket is compared against, with one field swapped per test. */
function binding(overrides: Partial<Binding> = {}): Binding {
  return {
    toolName: 'bash',
    permissionKey: 'bash',
    arguments: '{"command":"rm -rf build"}',
    workspace: '/home/user/Hyperion/worktrees/task-1',
    taskId: 'task-1',
    runId: 'run-1',
    parentTaskId: null,
    revision: 'rev-a',
    ...overrides,
  };
}

/** A pending approval plus the ticket minted with it, exactly as the loop does it. */
function park(bind: Binding, expiresAt = Date.now() + 60_000) {
  counter += 1;
  const approval = recordApproval({
    runId: bind.runId ?? undefined,
    taskId: bind.taskId,
    tool: 'code',
    toolName: bind.toolName,
    arguments: bind.arguments,
    permissionKey: bind.permissionKey,
    matchedLayer: 'builtin',
    matchedPattern: '*:mutate',
    reason: 'ask (builtin:bash) for bash',
  });
  const ticket = mintTicket({ approvalId: approval.id, tool: 'code', binding: bind, expiresAt });
  return { approval, ticket };
}

function refusalOf(settlement: { kind: string; refusal?: string }): TicketRefusal | undefined {
  return settlement.refusal as TicketRefusal | undefined;
}

before(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

beforeEach(() => {
  getDb().exec('DELETE FROM approval_tickets');
  getDb().exec('DELETE FROM pending_approvals');
  getDb().exec('DELETE FROM task_runs');
  counter += 1;
});

describe('an approval ticket', () => {
  it('authorises nothing until the decision lands', () => {
    const bind = binding({ taskId: `task-${counter}` });
    park(bind);

    const settlement = settleTicket({ live: bind, runAccepts: () => true });

    assert.equal(settlement.kind, 'refused');
    assert.equal(refusalOf(settlement), 'not_approved');
    assert.equal(
      ticketForCall(bind.taskId, bind.toolName, bind.arguments)?.state,
      'pending',
      'a question with no answer is not an authorisation',
    );
  });

  it('is spent by exactly one execution', () => {
    const bind = binding({ taskId: `task-${counter}` });
    const { approval } = park(bind);
    resolveApproval(approval.id, 'allow_once');

    const first = settleTicket({ live: bind, runAccepts: () => true });
    assert.equal(first.kind, 'granted');
    assert.equal(ticketForCall(bind.taskId, bind.toolName, bind.arguments)?.state, 'spent');

    const second = settleTicket({ live: bind, runAccepts: () => true });
    assert.equal(second.kind, 'refused');
    assert.equal(refusalOf(second), 'already_consumed', 'one approval is one execution');
  });

  it('is void when the user declined', () => {
    const bind = binding({ taskId: `task-${counter}` });
    const { approval } = park(bind);
    resolveApproval(approval.id, 'deny');

    const settlement = settleTicket({ live: bind, runAccepts: () => true });

    assert.equal(settlement.kind, 'refused');
    assert.equal(refusalOf(settlement), 'denied');
  });

  it('stops authorising once its deadline passes, and says so afterwards', () => {
    const bind = binding({ taskId: `task-${counter}` });
    const { approval } = park(bind, Date.now() - 1);
    resolveApproval(approval.id, 'allow_once');

    const settlement = settleTicket({ live: bind, runAccepts: () => true });

    assert.equal(settlement.kind, 'refused');
    assert.equal(refusalOf(settlement), 'expired');
    const ticket = ticketForCall(bind.taskId, bind.toolName, bind.arguments);
    assert.equal(ticket?.state, 'void', 'an expired ticket is closed, not left to be spent later');
    assert.equal(settleTicket({ live: bind, runAccepts: () => true }).kind, 'refused');
  });

  it('does not cover a different command, even under the same tool', () => {
    const bind = binding({ taskId: `task-${counter}` });
    const { approval } = park(bind);
    resolveApproval(approval.id, 'allow_once');

    const settlement = settleTicket({ live: { ...bind, arguments: '{"command":"rm -rf src"}' }, runAccepts: () => true });

    assert.equal(
      settlement.kind,
      'absent',
      'a command the user never saw finds no ticket, so it parks for a fresh decision rather than being refused by — or authorised by — the old one',
    );
    assert.equal(
      ticketForCall(bind.taskId, bind.toolName, bind.arguments)?.state,
      'armed',
      'the approval for the call the user did see is untouched',
    );
  });

  it('does not cover a different task, and refuses a run that does not continue the asking run', () => {
    const bind = binding({ taskId: `task-${counter}` });
    const { approval } = park(bind);
    resolveApproval(approval.id, 'allow_once');

    const otherTask = settleTicket({ live: { ...bind, taskId: `${bind.taskId}-elsewhere` }, runAccepts: () => true });
    assert.equal(otherTask.kind, 'absent', 'a ticket belongs to the task that asked');

    const otherRun = settleTicket({ live: bind, runAccepts: () => false });
    assert.equal(otherRun.kind, 'refused');
    assert.equal(refusalOf(otherRun), 'run_replaced');
  });

  it('accepts a continuation of the asking run, which is the only reason the field is nullable', () => {
    const bind = binding({ taskId: `task-${counter}` });
    const { approval } = park(bind);
    resolveApproval(approval.id, 'allow_once');

    const settlement = settleTicket({ live: { ...bind, runId: 'run-2' }, runAccepts: (id) => id === 'run-1' });

    assert.equal(settlement.kind, 'granted');
  });

  it('is invalidated by a different workspace', () => {
    const bind = binding({ taskId: `task-${counter}` });
    const { approval } = park(bind);
    resolveApproval(approval.id, 'allow_once');

    const settlement = settleTicket({ live: { ...bind, workspace: '/home/user/Hyperion/worktrees/other' }, runAccepts: () => true });

    assert.equal(settlement.kind, 'refused');
    assert.equal(refusalOf(settlement), 'mismatch');
    assert.deepEqual(settlement.fields, ['workspace'], 'the refusal names what moved');
  });

  it('is invalidated by a different permission configuration', () => {
    const bind = binding({ taskId: `task-${counter}` });
    const { approval } = park(bind);
    resolveApproval(approval.id, 'allow_once');

    const settlement = settleTicket({ live: { ...bind, revision: 'rev-b' }, runAccepts: () => true });

    assert.equal(settlement.kind, 'refused');
    assert.equal(refusalOf(settlement), 'mismatch');
    assert.deepEqual(settlement.fields, ['revision']);
  });

  it('is invalidated by a different parent task, so a child cannot spend its sibling approval', () => {
    const bind = binding({ taskId: `task-${counter}`, parentTaskId: 'parent-1' });
    const { approval } = park(bind);
    resolveApproval(approval.id, 'allow_once');

    const settlement = settleTicket({ live: { ...bind, parentTaskId: 'parent-2' }, runAccepts: () => true });

    assert.equal(settlement.kind, 'refused');
    assert.equal(refusalOf(settlement), 'mismatch');
    assert.deepEqual(settlement.fields, ['parentTaskId']);
  });

  it('keeps the record of an approved session call without holding the authority itself', () => {
    const bind = binding({ taskId: `task-${counter}` });
    const { approval } = park(bind);
    resolveApproval(approval.id, 'allow_session');

    // The session *rule* is what authorises later calls — the engine re-reads it
    // every call — so the ticket records the approved execution and is spent by it.
    assert.equal(ticketForCall(bind.taskId, bind.toolName, bind.arguments)?.state, 'standing');
    assert.equal(settleTicket({ live: bind, runAccepts: () => true }).kind, 'granted');
    assert.equal(ticketForCall(bind.taskId, bind.toolName, bind.arguments)?.state, 'spent');
  });

  it('dedupes on the question, so a re-recorded park does not mint a second authorisation', () => {
    const bind = binding({ taskId: `task-${counter}` });
    const { approval, ticket } = park(bind);

    const again = park(bind);

    assert.equal(again.approval.id, approval.id, 'the same question is one question');
    assert.equal(again.ticket.id, ticket.id, 'and one question is one ticket');
    assert.equal(listTickets(bind.taskId).length, 1);
  });

  it('voids the ticket when the question is closed out with the task', async () => {
    const bind = binding({ taskId: `task-${counter}` });
    const { approval } = park(bind);
    resolveApproval(approval.id, 'allow_once');
    const { closeApprovals } = await import('../src/db/approvals.ts');

    closeApprovals(bind.taskId);

    assert.equal(ticketForCall(bind.taskId, bind.toolName, bind.arguments)?.state, 'void');
    assert.equal(settleTicket({ live: bind, runAccepts: () => true }).kind, 'refused');
    assert.equal(approval.id, approval.id);
  });
});

// --- the gate -------------------------------------------------------------

const policy = { effect: (name: string) => (name === 'bash' ? ('mutate' as const) : undefined) };

/** A resolver whose rules say `ask` for bash, with a revision the test can move. */
function askResolver(rules: Record<string, 'allow' | 'ask' | 'deny'> = { bash: 'ask' }) {
  return createPermissionResolver({
    layers: [{ layer: 'builtin', rules }],
    knownTools: new Set(['bash']),
  });
}

function fakeCtx(): { ctx: AgentContext; events: { event: string; data: Record<string, unknown> }[] } {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const ctx = {
    taskId: 'unused',
    emit: (event: string, data: Record<string, unknown>) => {
      events.push({ event, data });
    },
    signal: new AbortController().signal,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as AgentContext;
  return { ctx, events };
}

describe('the loop at the gate', () => {
  /**
   * A model that asks for this call once and then stops asking. Anything else
   * would re-request the same call on the next turn, which is a different test
   * (`refuses a second execution of a call whose one approval is spent`).
   */
  function turnsOf(call: ToolCall) {
    let turn = 0;
    return async () => {
      turn += 1;
      return turn === 1 ? [call] : [];
    };
  }

  /**
   * Park a real loop on a real `ask`, the way a Code run does: the gate returns
   * `approval_required`, the loop records the question and mints the ticket.
   */
  async function parkViaLoop(options: {
    call: ToolCall;
    workspace?: string;
    rules?: Record<string, 'allow' | 'ask' | 'deny'>;
  }) {
    counter += 1;
    const runId = `gate-run-${counter}`;
    const taskId = `gate-task-${counter}`;
    startTaskRun({ runId, tool: 'code', taskId });
    const { ctx, events } = fakeCtx();
    let ran = false;
    const result = await runAgentLoop(
      {
        runId,
        taskId,
        tool: 'code',
        mode: 'act',
        policy,
        permissions: askResolver(options.rules),
        ticketBinding: { workspace: options.workspace ?? '/work/task' },
        turn: turnsOf(options.call),
        iterationCeiling: 3,
        run: async () => {
          ran = true;
          return 'ran';
        },
      } as never,
      ctx,
    );
    return { runId, taskId, result, events, ran: () => ran };
  }

  /** The continuation: a second run that records the parked one as its predecessor. */
  async function replay(options: {
    runId: string;
    taskId: string;
    call: ToolCall;
    workspace?: string;
    rules?: Record<string, 'allow' | 'ask' | 'deny'>;
  }) {
    const continuationRunId = `${options.runId}-2`;
    startTaskRun({
      runId: continuationRunId,
      tool: 'code',
      taskId: options.taskId,
      continuedFrom: options.runId,
    });
    const { ctx, events } = fakeCtx();
    let ran = false;
    const result = await runAgentLoop(
      {
        runId: continuationRunId,
        taskId: options.taskId,
        tool: 'code',
        mode: 'act',
        policy,
        permissions: askResolver(options.rules),
        ticketBinding: { workspace: options.workspace ?? '/work/task' },
        turn: turnsOf(options.call),
        iterationCeiling: 3,
        run: async () => {
          ran = true;
          return 'ran';
        },
      } as never,
      ctx,
    );
    return { result, events, ran: () => ran };
  }

  it('parks the first time, and runs on the replay the approval was for', async () => {
    const call = { id: 'call-1', name: 'bash', arguments: '{"command":"make build"}' } as ToolCall;
    const parked = await parkViaLoop({ call });

    assert.equal(parked.result.parked, 'approval_required');
    assert.equal(parked.ran(), false);
    const pending = listPendingApprovals(parked.taskId);
    assert.equal(pending.length, 1);
    assert.equal(listTickets(parked.taskId).length, 1, 'the question and the ticket are written together');
    resolveApproval(pending[0]!.id, 'allow_once');

    const replayed = await replay({ runId: parked.runId, taskId: parked.taskId, call });

    assert.equal(replayed.ran(), true, 'the approved call is the one call that may run');
    assert.equal(replayed.result.completed, true);
    assert.equal(ticketForCall(parked.taskId, 'bash', call.arguments)?.state, 'spent');
  });

  it('refuses the call when the command changed under a valid-looking approval', async () => {
    const call = { id: 'call-1', name: 'bash', arguments: '{"command":"make build"}' } as ToolCall;
    const parked = await parkViaLoop({ call });
    resolveApproval(listPendingApprovals(parked.taskId)[0]!.id, 'allow_once');

    const replayed = await replay({
      runId: parked.runId,
      taskId: parked.taskId,
      // The model re-generated its call with a different command.
      call: { id: 'call-2', name: 'bash', arguments: '{"command":"make deploy"}' },
    });

    assert.equal(replayed.ran(), false, 'the approval covered `make build`, not `make deploy`');
    assert.equal(replayed.result.parked, 'approval_required');
    const fresh = listPendingApprovals(parked.taskId).filter((row) => row.state === 'pending');
    assert.equal(fresh.length, 1, 'the user is asked about the call actually in front of the run');
    assert.equal(fresh[0]?.arguments, '{"command":"make deploy"}');
    assert.ok(
      replayed.events.some((event) => event.event === 'approval_required'),
      'and the client is told there is a decision to make',
    );
  });

  it('refuses and re-asks when the workspace moved', async () => {
    const call = { id: 'call-1', name: 'bash', arguments: '{"command":"make build"}' } as ToolCall;
    const parked = await parkViaLoop({ call });
    resolveApproval(listPendingApprovals(parked.taskId)[0]!.id, 'allow_once');

    // The worktree this replay would run in is not the one that was approved.
    const replayed = await replay({ runId: parked.runId, taskId: parked.taskId, call, workspace: '/work/task-moved' });

    assert.equal(replayed.ran(), false);
    assert.equal(replayed.result.parked, 'approval_required');
    const asked = replayed.events.find((event) => event.event === 'approval_required');
    assert.equal(asked?.data.reason, 'approval_invalid', 'the client can tell a stale approval from a first ask');
  });

  it('refuses and re-asks when the permission configuration changed while parked', async () => {
    const call = { id: 'call-1', name: 'bash', arguments: '{"command":"make build"}' } as ToolCall;
    const parked = await parkViaLoop({ call });
    resolveApproval(listPendingApprovals(parked.taskId)[0]!.id, 'allow_once');

    // The same verdict for this call (`ask`), a different resolved stack: the user
    // edited a rule while the task was parked.
    const replayed = await replay({
      runId: parked.runId,
      taskId: parked.taskId,
      call,
      rules: { bash: 'ask', 'bash:read': 'deny' },
    });

    assert.equal(replayed.ran(), false, 'the approval was given under a different configuration');
    assert.equal(replayed.result.parked, 'approval_required');
  });

  it('refuses a second execution of a call whose one approval is spent', async () => {
    const call = { id: 'call-1', name: 'bash', arguments: '{"command":"make build"}' } as ToolCall;
    const parked = await parkViaLoop({ call });
    resolveApproval(listPendingApprovals(parked.taskId)[0]!.id, 'allow_once');

    // The same continuation asks twice: the ticket authorises one execution, so the
    // second ask is refused rather than quietly allowed.
    const first = await replay({ runId: parked.runId, taskId: parked.taskId, call });
    assert.equal(first.ran(), true);
    const second = await replay({ runId: parked.runId, taskId: parked.taskId, call });

    assert.equal(second.ran(), false);
    assert.equal(second.result.parked, 'approval_required');
  });

  it('leaves a run with nothing to bind exactly as it was before tickets existed', async () => {
    counter += 1;
    const runId = `gate-run-${counter}`;
    const taskId = `gate-task-${counter}`;
    startTaskRun({ runId, tool: 'code', taskId });

    const result = await dispatchToolCall({
      runId,
      taskId,
      mode: 'act',
      policy,
      permissions: askResolver(),
      call: { id: 'call-1', name: 'bash', arguments: '{"command":"make build"}' },
      run: async () => 'ran',
    } as never);

    assert.equal(result.refusedBecause, 'approval_required');
    assert.equal(
      listTickets(taskId).length,
      0,
      'an agent that cannot name its workspace gets no ticket rather than a binding it invented',
    );
  });

  it('carries the revision of the stack the engine actually consults', () => {
    const resolver = askResolver({ bash: 'ask' });
    const same = askResolver({ bash: 'ask' });
    const changed = askResolver({ bash: 'ask', 'bash:read': 'deny' });

    assert.equal(resolver.revision, same.revision);
    assert.notEqual(resolver.revision, changed.revision);
    assert.equal(typeof resolver.revision, 'string');
  });

  it('records the refusal on the step trail, so a refused execution is answerable afterwards', async () => {
    const call = { id: 'call-1', name: 'bash', arguments: '{"command":"make build"}' } as ToolCall;
    const parked = await parkViaLoop({ call });
    resolveApproval(listPendingApprovals(parked.taskId)[0]!.id, 'allow_once');
    const { listSteps } = await import('../src/db/taskSteps.ts');

    const result = await dispatchToolCall({
      runId: parked.runId,
      taskId: parked.taskId,
      mode: 'act',
      policy,
      permissions: askResolver(),
      ticketBinding: { workspace: '/work/moved' },
      ticket: {
        workspace: '/work/moved',
        revision: askResolver().revision!,
        runAccepts: () => true,
      },
      call,
      run: async () => 'ran',
    } as never);

    assert.equal(result.refusedBecause, 'approval_invalid');
    assert.match(result.output, /workspace/);
    const steps = listSteps(parked.runId);
    const refusal = steps.find((step) => step.detail === 'approval_invalid');
    assert.ok(refusal, 'the gate records the invalidation as the reason the call did not run');
    assert.equal(refusal?.kind, 'approval', 'and records it where a decision is recorded, not as a plan');
    assert.match(refusal?.provenance ?? '', /ask \(builtin\) for bash/, 'beside the verdict it was checked against');
  });
});

describe('the ticket trail', () => {
  it('is written with the field that moved, not a generic failure', async () => {
    const bind = binding({ taskId: `task-${counter}` });
    const { approval } = park(bind);
    resolveApproval(approval.id, 'allow_once');

    const settlement = settleTicket({ live: { ...bind, revision: 'rev-2' }, runAccepts: () => true });

    assert.deepEqual(settlement.fields, ['revision']);
    assert.notEqual(settlement.ticket?.digest, undefined);
  });

  it('never authorises a call whose stored digest does not match its stored fields', async () => {
    const bind = binding({ taskId: `task-${counter}` });
    const { approval, ticket } = park(bind);
    resolveApproval(approval.id, 'allow_once');
    // A row edited underneath the module — the digest is what catches it, which is
    // why it is stored beside the fields it covers.
    getDb().prepare('UPDATE approval_tickets SET workspace = ? WHERE id = ?').run('/somewhere/else', ticket.id);

    const settlement = settleTicket({ live: bind, runAccepts: () => true });

    assert.equal(settlement.kind, 'refused');
    assert.equal(settlement.refusal, 'mismatch');
  });
});
