import './helpers.ts';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { AgentContext, ChatMessage, ToolCall } from '../src/types/core.ts';
import type { ContextWindow } from '../src/services/agent/compaction.ts';
import type { LoopContextAccess } from '../src/services/agent/loop.ts';

const { freshDb, cleanupHome } = await import('./helpers.ts');
const { startTaskRun, getTaskRun } = await import('../src/db/taskRuns.ts');
const { listPendingApprovals } = await import('../src/db/approvals.ts');
const { listSteps } = await import('../src/db/taskSteps.ts');
const { getDb } = await import('../src/db/adapter.ts');
const { AppError } = await import('../src/util/errors.ts');
const {
  dispatchToolCall,
  parkOnBlockedSend,
  parkRun,
  runAgentLoop,
  RepeatGuard,
  DEFAULT_REPEAT_LIMIT,
} = await import('../src/services/agent/loop.ts');
const { TaskBudget } = await import('../src/services/limits/budget.ts');

import type { AgentMode, ToolEffect, ToolFeedback } from '../src/services/agent/loop.ts';

let counter = 0;

/**
 * A live run to hang steps off. No `chatId`: `task_runs.chat_id` is a real
 * foreign key into `chats`, and inventing one here would fail the constraint.
 */
function makeRun(): string {
  counter += 1;
  const runId = `loop-run-${counter}`;
  startTaskRun({ runId, tool: 'code', taskId: `task-${counter}` });
  return runId;
}

function call(name: string, args = '{}'): ToolCall {
  return { id: `call-${name}-${args.length}`, name, arguments: args };
}

/** Only what the loop actually touches, so a test failure points at the loop. */
function fakeCtx(signal?: AbortSignal): {
  ctx: AgentContext;
  events: { event: string; data: Record<string, unknown> }[];
} {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const ctx = {
    emit: (event: string, data: Record<string, unknown>) => {
      events.push({ event, data });
    },
    signal: signal ?? new AbortController().signal,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as AgentContext;
  return { ctx, events };
}

/** `read_file` reads, `write_file` writes, anything else is unclassified. */
const policy = {
  effect(toolName: string): ToolEffect | undefined {
    if (toolName === 'read_file') return 'read';
    if (toolName === 'write_file') return 'mutate';
    return undefined;
  },
};

before(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

beforeEach(() => {
  getDb().exec('DELETE FROM task_steps');
});

describe('the mode gate', () => {
  it('runs a mutating tool in act mode', async () => {
    const runId = makeRun();
    let ran = false;
    const result = await dispatchToolCall({
      runId,
      mode: 'act',
      policy,
      call: call('write_file'),
      run: async () => {
        ran = true;
        return 'written';
      },
    });

    assert.equal(ran, true);
    assert.equal(result.ran, true);
    assert.equal(result.output, 'written');
    assert.equal(result.refusedBecause, undefined);
  });

  it('runs nothing at all in ask mode, not even a read', async () => {
    const runId = makeRun();
    let ran = false;
    const result = await dispatchToolCall({
      runId,
      mode: 'ask',
      policy,
      call: call('read_file'),
      run: async () => {
        ran = true;
        return 'contents';
      },
    });

    assert.equal(ran, false, 'ask mode must not reach the runner');
    assert.equal(result.ran, false);
    assert.equal(result.refusedBecause, 'ask_mode');
    assert.match(result.output, /Ask mode/);
  });

  it('allows a read in plan mode', async () => {
    const runId = makeRun();
    let ran = false;
    const result = await dispatchToolCall({
      runId,
      mode: 'plan',
      policy,
      call: call('read_file'),
      run: async () => {
        ran = true;
        return 'contents';
      },
    });

    assert.equal(ran, true);
    assert.equal(result.ran, true);
    assert.equal(result.output, 'contents');
  });

  it('refuses a write in plan mode and records it as a planned action instead', async () => {
    const runId = makeRun();
    const plan: { toolName: string; arguments: string; reason: string }[] = [];
    let ran = false;

    const result = await dispatchToolCall({
      runId,
      mode: 'plan',
      policy,
      plan,
      call: call('write_file', '{"path":"a.txt"}'),
      run: async () => {
        ran = true;
        return 'written';
      },
    });

    assert.equal(ran, false, 'plan mode must not reach the runner for a mutating tool');
    assert.equal(result.refusedBecause, 'plan_mode');
    assert.equal(plan.length, 1);
    assert.equal(plan[0]?.toolName, 'write_file');
    assert.equal(plan[0]?.arguments, '{"path":"a.txt"}');
  });

  it('treats a tool it has never heard of as mutating', async () => {
    const runId = makeRun();
    let ran = false;
    const result = await dispatchToolCall({
      runId,
      mode: 'plan',
      policy,
      call: call('some_new_tool'),
      run: async () => {
        ran = true;
        return 'done';
      },
    });

    assert.equal(ran, false, 'an unclassified tool must not run in plan mode');
    assert.equal(result.refusedBecause, 'plan_mode');
  });

  it('records the mode alongside the step it gated', async () => {
    const runId = makeRun();
    await dispatchToolCall({
      runId,
      mode: 'act',
      policy,
      call: call('write_file'),
      run: async () => 'written',
    });

    const steps = listSteps(runId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.mode, 'act');
    assert.equal(steps[0]?.kind, 'tool_call');
    assert.equal(steps[0]?.ok, true);
  });

  it('records a failing tool as a failure and lets the error through', async () => {
    const runId = makeRun();
    await assert.rejects(
      dispatchToolCall({
        runId,
        mode: 'act',
        policy,
        call: call('write_file'),
        run: async () => {
          throw new Error('disk full');
        },
      }),
      /disk full/,
    );

    const steps = listSteps(runId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.ok, false);
    assert.equal(steps[0]?.detail, 'disk full');
  });

  it('counts a refusal as a step that succeeded, because refusing is what it was asked to do', async () => {
    const runId = makeRun();
    await dispatchToolCall({ runId, mode: 'ask', policy, call: call('read_file'), run: async () => 'x' });

    const steps = listSteps(runId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.ok, true);
    assert.equal(steps[0]?.detail, 'ask_mode');
  });
});

describe('the repeat guard', () => {
  it('permits a retry but not an endless one', () => {
    const guard = new RepeatGuard();
    const target = call('read_file', '{"path":"a"}');

    for (let i = 0; i < DEFAULT_REPEAT_LIMIT; i += 1) {
      assert.equal(guard.exceeded(target), false, `call ${i + 1} should be allowed`);
    }
    assert.equal(guard.exceeded(target), true, 'the call past the limit should trip');
  });

  it('treats different arguments to the same tool as different work', () => {
    const guard = new RepeatGuard(1);
    assert.equal(guard.exceeded(call('read_file', '{"path":"a"}')), false);
    assert.equal(guard.exceeded(call('read_file', '{"path":"b"}')), false);
  });

  it('treats the same arguments to different tools as different work', () => {
    const guard = new RepeatGuard(1);
    assert.equal(guard.exceeded(call('read_file', '{}')), false);
    assert.equal(guard.exceeded(call('write_file', '{}')), false);
  });
});

describe('parking a run', () => {
  it('writes the state before it announces it', () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    let stateWhenEmitted: string | null = null;

    const spyCtx = {
      ...ctx,
      emit: () => {
        stateWhenEmitted = getTaskRun(runId)?.state ?? null;
      },
    } as unknown as AgentContext;

    parkRun(spyCtx, runId, 'loop_detected', 'went in circles');

    assert.equal(
      stateWhenEmitted,
      'blocked',
      'the row must already say blocked by the time the client is told',
    );
  });

  it('parks a stuck run as blocked', () => {
    const runId = makeRun();
    const { ctx, events } = fakeCtx();

    parkRun(ctx, runId, 'loop_detected', 'went in circles');

    assert.equal(getTaskRun(runId)?.state, 'blocked');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, 'task_parked');
    assert.equal(events[0]?.data.reason, 'loop_detected');
  });

  it('parks a finished plan for review rather than as a failure', () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();

    parkRun(ctx, runId, 'plan_ready', '2 actions need approval');

    assert.equal(getTaskRun(runId)?.state, 'ready_for_review');
  });

  it('leaves a step behind saying why it stopped', () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();

    parkRun(ctx, runId, 'iteration_ceiling', 'stopped after 40 iterations');

    const steps = listSteps(runId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.kind, 'note');
    assert.match(steps[0]?.detail ?? '', /iteration_ceiling/);
  });
});

describe('an unattended blocked send', () => {
  it('parks the run instead of failing it when no one is watching', () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    const flagged = new AppError('redaction_flagged', 'looks like a key');

    assert.throws(
      () => parkOnBlockedSend(ctx, runId, flagged, true),
      (error: unknown) =>
        error instanceof AppError && error.code === 'redaction_flagged' && /approve it to let this/.test(error.message),
    );
    assert.equal(getTaskRun(runId)?.state, 'blocked');
  });

  it('never quotes the original finding, which may contain the credential', () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    const flagged = new AppError('redaction_flagged', 'found sk-live-SUPERSECRET in the prompt');

    try {
      parkOnBlockedSend(ctx, runId, flagged, true);
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof AppError);
      assert.doesNotMatch(error.message, /SUPERSECRET/);
      assert.doesNotMatch(JSON.stringify(error.toJSON()), /SUPERSECRET/);
    }
  });

  it('passes the finding through untouched when a user is there to answer it', () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    const flagged = new AppError('redaction_flagged', 'looks like a key');

    assert.throws(
      () => parkOnBlockedSend(ctx, runId, flagged, false),
      (error: unknown) => error === flagged,
    );
    assert.equal(getTaskRun(runId)?.state, 'running', 'an attended finding must not park the run');
  });

  it('does not swallow an unrelated failure', () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    const other = new AppError('provider_unreachable', 'the gateway is down');

    assert.throws(
      () => parkOnBlockedSend(ctx, runId, other, true),
      (error: unknown) => error === other,
    );
    assert.equal(getTaskRun(runId)?.state, 'running');
  });

  // Part 1.26. The same handler now covers a second refusal, and the two must not
  // be conflated: a ZDR block has nothing for the user to approve, so its wording
  // must not invite an approval that would do nothing.
  it('parks a ZDR refusal as zdr_blocked with a state of blocked', () => {
    const runId = makeRun();
    const { ctx, events } = fakeCtx();
    const barred = new AppError('zdr_requirement_unmet', 'no eligible provider');

    assert.throws(
      () => parkOnBlockedSend(ctx, runId, barred, true),
      (error: unknown) => error instanceof AppError && error.code === 'zdr_requirement_unmet',
    );

    assert.equal(getTaskRun(runId)?.state, 'blocked');
    const parked = events.find((event) => event.event === 'task_parked');
    assert.equal(parked?.data.reason, 'zdr_blocked');
    assert.equal(parked?.data.state, 'blocked');
  });

  it('does not tell the user to approve a ZDR block, because there is nothing to approve', () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();

    try {
      parkOnBlockedSend(ctx, runId, new AppError('zdr_requirement_unmet', 'barred'), true);
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /zero-data-retention/);
      assert.doesNotMatch(error.message, /credential/);
    }
  });

  it('re-throws a ZDR refusal untouched when a user is watching', () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    const barred = new AppError('zdr_requirement_unmet', 'no eligible provider');

    assert.throws(
      () => parkOnBlockedSend(ctx, runId, barred, false),
      (error: unknown) => error === barred,
    );
    assert.equal(getTaskRun(runId)?.state, 'running');
  });
});

describe('the loop', () => {
  function loopArgs(runId: string, mode: AgentMode, turns: ToolCall[][]) {
    let turn = 0;
    const seen: ToolFeedback[][] = [];
    return {
      seen,
      input: {
        runId,
        tool: 'code' as const,
        mode,
        policy,
        run: async (c: ToolCall) => `ran ${c.name}`,
        turn: async (feedback: readonly ToolFeedback[]) => {
          seen.push([...feedback]);
          const next = turns[turn] ?? [];
          turn += 1;
          return next;
        },
      },
    };
  }

  it('stops when the model stops asking for tools', async () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    const { input } = loopArgs(runId, 'act', [[call('read_file')], []]);

    const result = await runAgentLoop({ ...input, iterationCeiling: 10 }, ctx);

    assert.equal(result.completed, true);
    assert.equal(result.iterations, 2);
    assert.equal(result.parked, undefined);
  });

  it('feeds each tool result back into the next turn', async () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    const { input, seen } = loopArgs(runId, 'act', [[call('read_file')], []]);

    await runAgentLoop({ ...input, iterationCeiling: 10 }, ctx);

    assert.equal(seen[0]?.length, 0, 'the first turn has nothing to report yet');
    assert.equal(seen[1]?.length, 1);
    assert.equal(seen[1]?.[0]?.output, 'ran read_file');
    assert.equal(seen[1]?.[0]?.ran, true);
  });

  it('asks rather than killing a run that keeps making the same call', async () => {
    // Changed by 1.27 (D14). The guard used to park `loop_detected` outright,
    // which threw away every turn before the repetition — and a stuck model is not
    // always wrong: the common case is a tool that legitimately returns the same
    // answer twice. It now raises the same `ask` an `approval_required` verdict
    // does, and `loop_detected` is what a *denial* lands on instead.
    const runId = makeRun();
    const { ctx, events } = fakeCtx();
    const repeated = call('read_file', '{"path":"a"}');
    const { input } = loopArgs(runId, 'act', [[repeated], [repeated], [repeated], [repeated], [repeated]]);

    const result = await runAgentLoop({ ...input, iterationCeiling: 20, repeatLimit: 2 }, ctx);

    assert.equal(result.parked, 'doom_loop');
    assert.equal(result.completed, false);
    assert.equal(
      getTaskRun(runId)?.state,
      'ready_for_review',
      'a run waiting on a decision the user can make is exactly what ready_for_review means',
    );

    const asked = events.find((event) => event.event === 'approval_required');
    assert.equal(asked?.data.reason, 'doom_loop');
    assert.equal(asked?.data.toolName, 'read_file');
  });

  it('records the repeated call so a continuation has something to replay', async () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    const repeated = call('read_file', '{"path":"a"}');
    const { input } = loopArgs(runId, 'act', [[repeated], [repeated], [repeated]]);

    const result = await runAgentLoop(
      { ...input, taskId: 'doom-task', iterationCeiling: 20, repeatLimit: 1 },
      ctx,
    );

    assert.ok(result.pendingApprovalId, 'a park with nothing recorded cannot be continued');
    const pending = listPendingApprovals('doom-task');
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.toolName, 'read_file');
    assert.equal(pending[0]?.arguments, '{"path":"a"}', 'the arguments must be replayable verbatim');
  });

  it('parks a run that will not finish inside its iteration ceiling', async () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    let n = 0;
    const result = await runAgentLoop(
      {
        runId,
        tool: 'code',
        mode: 'act',
        policy,
        run: async () => 'ok',
        // Different arguments every time, so the repeat guard never trips and
        // only the ceiling can stop this.
        turn: async () => {
          n += 1;
          return [call('read_file', `{"n":${n}}`)];
        },
        iterationCeiling: 3,
      },
      ctx,
    );

    assert.equal(result.parked, 'iteration_ceiling');
    assert.equal(result.iterations, 3);
    assert.equal(getTaskRun(runId)?.state, 'blocked');
  });

  it('hands back the plan it collected and marks the run ready for review', async () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    const { input } = loopArgs(runId, 'plan', [[call('write_file', '{"path":"a"}')], []]);

    const result = await runAgentLoop({ ...input, iterationCeiling: 10 }, ctx);

    assert.equal(result.parked, 'plan_ready');
    assert.equal(result.plan.length, 1);
    assert.equal(result.plan[0]?.toolName, 'write_file');
    assert.equal(getTaskRun(runId)?.state, 'ready_for_review');
  });

  it('completes without a plan when plan mode only ever read', async () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    const { input } = loopArgs(runId, 'plan', [[call('read_file')], []]);

    const result = await runAgentLoop({ ...input, iterationCeiling: 10 }, ctx);

    assert.equal(result.completed, true);
    assert.equal(result.plan.length, 0);
    assert.equal(getTaskRun(runId)?.state, 'running', 'nothing to review means nothing to park');
  });

  it('stops between iterations when the run is cancelled', async () => {
    const runId = makeRun();
    const controller = new AbortController();
    const { ctx } = fakeCtx(controller.signal);
    let turns = 0;

    await assert.rejects(
      runAgentLoop(
        {
          runId,
          tool: 'code',
          mode: 'act',
          policy,
          run: async () => 'ok',
          turn: async () => {
            turns += 1;
            controller.abort();
            return [call('read_file', `{"n":${turns}}`)];
          },
          iterationCeiling: 10,
        },
        ctx,
      ),
      (error: unknown) => error instanceof AppError && error.code === 'aborted',
    );

    assert.equal(turns, 1, 'the loop must not ask for a second turn after being cancelled');
  });

  it('parks rather than throwing when an unattended turn is refused for a credential', async () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();

    await assert.rejects(
      runAgentLoop(
        {
          runId,
          tool: 'code',
          mode: 'act',
          policy,
          run: async () => 'ok',
          turn: async () => {
            throw new AppError('redaction_flagged', 'found sk-live-SECRET');
          },
          unattended: true,
          iterationCeiling: 10,
        },
        ctx,
      ),
      // Not "no one was watching": a task run parks this way whether or not a
      // browser is attached, so the sentence names the answer instead of the
      // audience.
      (error: unknown) => error instanceof AppError && /approve it to let this/.test(error.message),
    );

    assert.equal(getTaskRun(runId)?.state, 'blocked');
  });
});

describe('the loop keeping a conversation inside the context window', () => {
  const window: ContextWindow = { tokens: 1_000, source: 'model', assumed: false };

  /**
   * A conversation the agent owns, exposed to the loop through the seam. The
   * `replace` here is what a real agent's own array assignment would be, and
   * `messages()` reads live so the assertions see what the next turn would send.
   */
  function access(initial: ChatMessage[]): LoopContextAccess & { current: () => ChatMessage[] } {
    let messages = initial;
    return {
      messages: () => messages,
      replace: (next) => {
        messages = next;
      },
      window,
      current: () => messages,
    };
  }

  /** Wide enough to matter: ~40 tokens of content per message at 4 chars/token. */
  function chatter(count: number, from = 0): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `${'x'.repeat(160)} #${from + i}` });
    }
    return out;
  }

  it('shortens an oversized conversation before the model is asked, not after it is refused', async () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    // 30 messages of ~44 tokens is well past 80% of a 1000-token window.
    const ctxAccess = access([{ role: 'system', content: 'you are a careful agent' }, ...chatter(30)]);
    let tokensSeenByTurn = -1;

    await runAgentLoop(
      {
        runId,
        tool: 'code',
        mode: 'act',
        policy,
        run: async () => 'ok',
        turn: async () => {
          // The compaction must already have happened by the time turn runs.
          if (tokensSeenByTurn < 0) tokensSeenByTurn = ctxAccess.current().length;
          return [];
        },
        iterationCeiling: 5,
        context: ctxAccess,
      },
      ctx,
    );

    assert.ok(
      tokensSeenByTurn < 31,
      `the first turn must see a shortened conversation, saw ${tokensSeenByTurn} messages`,
    );
  });

  it('records a compression step and announces it, so a shortened memory is never silent', async () => {
    const runId = makeRun();
    const { ctx, events } = fakeCtx();
    const ctxAccess = access([{ role: 'system', content: 'system prompt' }, ...chatter(30)]);

    await runAgentLoop(
      {
        runId,
        tool: 'code',
        mode: 'act',
        policy,
        run: async () => 'ok',
        turn: async () => [],
        iterationCeiling: 5,
        context: ctxAccess,
      },
      ctx,
    );

    const compressions = listSteps(runId).filter((step) => step.kind === 'compression');
    assert.equal(compressions.length, 1);
    assert.equal(compressions[0]?.ok, true);

    const announced = events.filter((e) => e.event === 'context_compacted');
    assert.equal(announced.length, 1);
    assert.equal(announced[0]?.data.runId, runId);
    assert.ok(
      (announced[0]?.data.tokensAfter as number) < (announced[0]?.data.tokensBefore as number),
      'the event must report an actual reduction',
    );
  });

  it('keeps the system prompt and leaves a digest in place of what it dropped', async () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    const ctxAccess = access([
      { role: 'system', content: 'you are a careful agent' },
      ...chatter(30),
    ]);

    await runAgentLoop(
      {
        runId,
        tool: 'code',
        mode: 'act',
        policy,
        run: async () => 'ok',
        turn: async () => [],
        iterationCeiling: 5,
        context: ctxAccess,
      },
      ctx,
    );

    const after = ctxAccess.current();
    assert.ok(
      after.some((m) => m.role === 'system' && m.content === 'you are a careful agent'),
      'the system prompt must survive compaction',
    );
    assert.ok(
      after.some((m) => m.role === 'system' && /Earlier conversation removed/.test(m.content)),
      'the digest must be present, attributed to the system',
    );
  });

  it('leaves a conversation that fits completely alone, with nothing recorded and nothing emitted', async () => {
    const runId = makeRun();
    const { ctx, events } = fakeCtx();
    const original: ChatMessage[] = [
      { role: 'system', content: 'short prompt' },
      { role: 'user', content: 'hello' },
    ];
    const ctxAccess = access([...original]);

    const result = await runAgentLoop(
      {
        runId,
        tool: 'code',
        mode: 'act',
        policy,
        run: async () => 'ok',
        turn: async () => [],
        iterationCeiling: 5,
        context: ctxAccess,
      },
      ctx,
    );

    assert.equal(result.completed, true);
    assert.deepEqual(ctxAccess.current(), original, 'a conversation under the trigger must not be touched');
    assert.equal(listSteps(runId).filter((s) => s.kind === 'compression').length, 0);
    assert.equal(
      events.filter((e) => e.event === 'context_compacted').length,
      0,
      'an event meaning "no change" is worse than silence',
    );
  });

  it('parks the run when the conversation is too big and nothing may be dropped', async () => {
    const runId = makeRun();
    const { ctx, events } = fakeCtx();
    // Every message is a system message, so every one of them is pinned and
    // compaction has nothing it is allowed to give up.
    const pinned: ChatMessage[] = [];
    for (let i = 0; i < 30; i += 1) {
      pinned.push({ role: 'system', content: `${'y'.repeat(160)} #${i}` });
    }
    const ctxAccess = access(pinned);
    let asked = false;

    const result = await runAgentLoop(
      {
        runId,
        tool: 'code',
        mode: 'act',
        policy,
        run: async () => 'ok',
        turn: async () => {
          asked = true;
          return [];
        },
        iterationCeiling: 5,
        context: ctxAccess,
      },
      ctx,
    );

    assert.equal(result.parked, 'context_exhausted');
    assert.equal(result.completed, false);
    assert.equal(asked, false, 'a request known not to fit must never be sent');
    assert.equal(getTaskRun(runId)?.state, 'blocked');
    assert.equal(ctxAccess.current().length, 30, 'the conversation is left exactly as it was');

    const parked = events.filter((e) => e.event === 'task_parked');
    assert.equal(parked.length, 1);
    assert.equal(parked[0]?.data.reason, 'context_exhausted');
    assert.equal(parked[0]?.data.state, 'blocked');
  });

  it('runs exactly as before for an agent that manages its own context', async () => {
    const runId = makeRun();
    const { ctx, events } = fakeCtx();
    let turns = 0;

    // No `context` seam at all: the loop must not compact, must not park, and
    // must not care how long the conversation actually is.
    const result = await runAgentLoop(
      {
        runId,
        tool: 'code',
        mode: 'act',
        policy,
        run: async () => 'ok',
        turn: async () => {
          turns += 1;
          return turns === 1 ? [call('read_file')] : [];
        },
        iterationCeiling: 5,
      },
      ctx,
    );

    assert.equal(result.completed, true);
    assert.equal(result.parked, undefined);
    assert.equal(listSteps(runId).filter((s) => s.kind === 'compression').length, 0);
    assert.equal(events.filter((e) => e.event === 'context_compacted').length, 0);
  });
});

describe('the token budget', () => {
  it('stops as ceiling_reached once the charged tokens cross the ceiling', async () => {
    const runId = makeRun();
    const { ctx, events } = fakeCtx();
    const budget = new TaskBudget(runId, { tokenCeiling: 150 });
    let dispatched = 0;

    const result = await runAgentLoop(
      {
        runId,
        tool: 'code',
        mode: 'act',
        policy,
        run: async () => {
          dispatched += 1;
          return 'ran';
        },
        turn: async () => {
          // The charge is what trips the ceiling; the model still wants to call
          // a tool, and the stop must land before that call is dispatched.
          budget.charge(200, 0);
          return [call('read_file')];
        },
        budget,
        iterationCeiling: 10,
      },
      ctx,
    );

    assert.equal(result.completed, false);
    assert.equal(result.ceilingReached, true);
    assert.equal(result.parked, undefined, 'a spent budget is an ending, not a park');
    assert.equal(dispatched, 0, 'the same turn is never dispatched once the ceiling trips');
    assert.equal(getTaskRun(runId)?.state, 'stopped');
    assert.equal(getTaskRun(runId)?.pauseReason, 'ceiling_reached');
    assert.equal(events.filter((e) => e.event === 'ceiling_reached').length, 1);
  });

  it('lets a turn that ends the run complete even when its charge crosses the ceiling', async () => {
    // The ceiling exists to stop the next spend; a model that finished on the
    // very token that crossed it has nothing left to stop.
    const runId = makeRun();
    const { ctx, events } = fakeCtx();
    const budget = new TaskBudget(runId, { tokenCeiling: 100 });

    const result = await runAgentLoop(
      {
        runId,
        tool: 'code',
        mode: 'act',
        policy,
        run: async () => 'ran',
        turn: async () => {
          budget.charge(80, 20);
          return [];
        },
        budget,
        iterationCeiling: 10,
      },
      ctx,
    );

    assert.equal(result.completed, true);
    assert.equal(result.ceilingReached, undefined);
    assert.equal(getTaskRun(runId)?.state, 'running', 'the loop did not flatten the completion to a ceiling stop');
    assert.equal(events.filter((e) => e.event === 'ceiling_reached').length, 0);
  });
});
