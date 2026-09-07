/**
 * Agent HTTP contract tests.
 *
 * These drive the mounted Cowork route over a real loopback socket. A recording
 * agent is registered inside this test process to isolate the route contract;
 * production composition has separate coverage.
 */
import './helpers.ts';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import type { Server } from 'node:http';
import type { AgentContext, AgentModule, TaskInput, TaskResult } from '../src/types/core.ts';

import { cleanupHome, freshDb } from './helpers.ts';

const { createApp } = await import('../src/http/app.ts');
const { registerAgent, resetModules } = await import('../src/orchestrator/agents.ts');
const { resetCodeLane, resetLock } = await import('../src/orchestrator/lock.ts');

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

interface SeenRun {
  input: TaskInput;
  context: AgentContext;
}

function recordingAgent(seen: SeenRun[]): AgentModule {
  return {
    async runTask(input: TaskInput, context: AgentContext): Promise<TaskResult> {
      seen.push({ input, context });
      return { ok: true, summary: `${input.mode}:${context.taskId}` };
    },
  };
}

function post(payload: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/cowork/run-task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: 'chat-default', modelId: 'model-1', prompt: 'inspect', ...payload }),
  });
}

describe('POST /api/cowork/run-task', () => {
  test('defaults an omitted mode to act and uses chatId as taskId', async () => {
    const seen: SeenRun[] = [];
    registerAgent('cowork', recordingAgent(seen));

    const response = await post({});
    const stream = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.match(stream, /"channel":"result"/);
    assert.match(stream, /"summary":"act:chat-default"/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.input.mode, 'act');
    assert.equal(seen[0]?.context.taskId, 'chat-default');
  });

  test('preserves an explicit mode and taskId through the agent context', async () => {
    const seen: SeenRun[] = [];
    registerAgent('cowork', recordingAgent(seen));

    const response = await post({ mode: 'plan', taskId: 'task-plan-1' });
    const stream = await response.text();

    assert.equal(response.status, 200);
    assert.match(stream, /"summary":"plan:task-plan-1"/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.input.mode, 'plan');
    assert.equal(seen[0]?.input.chatId, 'chat-default');
    assert.equal(seen[0]?.context.taskId, 'task-plan-1');
  });

  test('rejects an invalid mode as JSON before starting an SSE run', async () => {
    let invoked = false;
    registerAgent('cowork', {
      async runTask(): Promise<TaskResult> {
        invoked = true;
        return { ok: true, summary: 'should not run' };
      },
    });

    const response = await post({ mode: 'yolo' });
    const body = (await response.json()) as {
      error: { code: string; details?: { field?: string } };
    };

    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'bad_request');
    assert.equal(body.error.details?.field, 'mode');
    assert.equal(invoked, false);
    assert.equal(response.headers.get('content-type')?.includes('text/event-stream'), false);
  });
});

describe('the run-task tail', () => {
  test('does not overwrite a state the agent already recorded', async () => {
    // Regression: the route tail used to stamp `complete` onto every run it
    // settled, including runs the agent had already parked. A run's `blocked`
    // or `paused` state was therefore unreachable over HTTP, and the same row
    // feeds the worktree hold in `settleWorktree`.
    registerAgent('cowork', {
      async runTask(_input: TaskInput, ctx: AgentContext): Promise<TaskResult> {
        const { updateTaskRunState } = await import('../src/db/taskRuns.ts');
        if (ctx.runId !== undefined) updateTaskRunState(ctx.runId, 'blocked');
        return { ok: true, summary: 'finished' };
      },
    });

    const response = await post({});
    assert.equal(response.status, 200);
    await response.text();

    const { latestRunForTask } = await import('../src/db/taskRuns.ts');
    assert.equal(latestRunForTask('cowork', 'chat-default')?.state, 'blocked');
  });

  test('still records complete for a run whose agent left the state alone', async () => {
    registerAgent('cowork', recordingAgent([]));

    const response = await post({});
    assert.equal(response.status, 200);
    await response.text();

    const { latestRunForTask } = await import('../src/db/taskRuns.ts');
    assert.equal(latestRunForTask('cowork', 'chat-default')?.state, 'complete');
  });
});