import './helpers.ts';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { AgentContext, ToolCall } from '../src/types/core.ts';

const { freshDb, cleanupHome } = await import('./helpers.ts');
const { startTaskRun, getTaskRun } = await import('../src/db/taskRuns.ts');
const { listSteps } = await import('../src/db/taskSteps.ts');
const { getDb } = await import('../src/db/adapter.ts');
const { AppError } = await import('../src/util/errors.ts');
const {
  dispatchToolCall,
  parkOnRedaction,
  parkRun,
  runAgentLoop,
  RepeatGuard,
  DEFAULT_REPEAT_LIMIT,
} = await import('../src/services/agent/loop.ts');

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

describe('an unattended redaction finding', () => {
  it('parks the run instead of failing it when no one is watching', () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    const flagged = new AppError('redaction_flagged', 'looks like a key');

    assert.throws(
      () => parkOnRedaction(ctx, runId, flagged, true),
      (error: unknown) =>
        error instanceof AppError && error.code === 'redaction_flagged' && /no one was watching/.test(error.message),
    );
    assert.equal(getTaskRun(runId)?.state, 'blocked');
  });

  it('never quotes the original finding, which may contain the credential', () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    const flagged = new AppError('redaction_flagged', 'found sk-live-SUPERSECRET in the prompt');

    try {
      parkOnRedaction(ctx, runId, flagged, true);
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
      () => parkOnRedaction(ctx, runId, flagged, false),
      (error: unknown) => error === flagged,
    );
    assert.equal(getTaskRun(runId)?.state, 'running', 'an attended finding must not park the run');
  });

  it('does not swallow an unrelated failure', () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    const other = new AppError('provider_unreachable', 'the gateway is down');

    assert.throws(
      () => parkOnRedaction(ctx, runId, other, true),
      (error: unknown) => error === other,
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

  it('parks a run that keeps making the same call', async () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    const repeated = call('read_file', '{"path":"a"}');
    const { input } = loopArgs(runId, 'act', [[repeated], [repeated], [repeated], [repeated], [repeated]]);

    const result = await runAgentLoop({ ...input, iterationCeiling: 20, repeatLimit: 2 }, ctx);

    assert.equal(result.parked, 'loop_detected');
    assert.equal(result.completed, false);
    assert.equal(getTaskRun(runId)?.state, 'blocked');
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
      (error: unknown) => error instanceof AppError && /no one was watching/.test(error.message),
    );

    assert.equal(getTaskRun(runId)?.state, 'blocked');
  });
});
