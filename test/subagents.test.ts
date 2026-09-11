import './helpers.ts';

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { AgentContext, CompletionRequest, StreamChunk, TaskInput } from '../src/types/core.ts';
import type { CodeDependencies } from '../src/services/code/agent.ts';

const { cleanupHome, freshDb, testHome } = await import('./helpers.ts');
const {
  finishSubagentRun,
  getSubagentRun,
  listSubagentRuns,
  startSubagentRun,
} = await import('../src/db/subagents.ts');
const { AppError } = await import('../src/util/errors.ts');
const { runCodeTask } = await import('../src/services/code/agent.ts');

before(async () => {
  await freshDb();
});
after(async () => {
  await cleanupHome();
});

describe('durable bounded subagent runs', () => {
  it('persists parent identity, child identity, order, and terminal result', () => {
    const started = startSubagentRun({
      parentRunId: 'parent-run',
      parentTaskId: 'parent-task',
      childTaskId: 'child-task-1',
      sequence: 1,
      prompt: 'Inspect the parser.',
    });
    assert.equal(started.state, 'running');
    assert.equal(started.depth, 1);
    assert.deepEqual(listSubagentRuns('parent-task').map((run) => run.childTaskId), ['child-task-1']);

    finishSubagentRun(started.id, 'complete', { summary: 'Parser inspected.' });
    const finished = getSubagentRun(started.id);
    assert.equal(finished?.state, 'complete');
    assert.equal(finished?.summary, 'Parser inspected.');
    assert.ok(finished?.completedAt);
  });

  it('enforces one sequence slot and unique child identity in the database', () => {
    startSubagentRun({ parentTaskId: 'bounded-parent', childTaskId: 'bounded-child-1', sequence: 1, prompt: 'One' });
    assert.throws(
      () => startSubagentRun({ parentTaskId: 'bounded-parent', childTaskId: 'bounded-child-2', sequence: 1, prompt: 'Duplicate order' }),
      /UNIQUE|constraint/i,
    );
    assert.throws(
      () => startSubagentRun({ parentTaskId: 'other-parent', childTaskId: 'bounded-child-1', sequence: 2, prompt: 'Duplicate child' }),
      /UNIQUE|constraint/i,
    );
  });

  it('rejects invalid starts and missing terminal updates as AppErrors', () => {
    assert.throws(
      () => startSubagentRun({ parentTaskId: '', childTaskId: 'child', sequence: 1, prompt: 'x' }),
      (error: unknown) => error instanceof AppError && error.code === 'bad_request',
    );
    // A complete error result on purpose: `finishSubagentRun` validates the
    // request before it touches the database, so an incomplete one reports
    // `bad_request` and never reaches the lookup this line is asserting.
    assert.throws(
      () =>
        finishSubagentRun('missing', 'error', {
          errorCode: 'internal_error',
          errorMessage: 'the child never started',
        }),
      (error: unknown) => error instanceof AppError && error.code === 'not_found',
    );
  });

  it('permits exactly one bounded terminal update', () => {
    const started = startSubagentRun({
      parentTaskId: 'terminal-parent',
      childTaskId: 'terminal-child',
      sequence: 1,
      prompt: 'Inspect the bounded lifecycle.',
    });
    finishSubagentRun(started.id, 'error', {
      summary: 'The child could not continue.',
      errorCode: 'aborted',
      errorMessage: 'The parent cancelled the run.',
    });

    assert.throws(
      () => finishSubagentRun(started.id, 'complete', { summary: 'This must not overwrite the error.' }),
      (error: unknown) => error instanceof AppError && error.code === 'conflict',
    );
    assert.equal(getSubagentRun(started.id)?.errorCode, 'aborted');
    assert.throws(
      () => startSubagentRun({ parentTaskId: 'long', childTaskId: 'long-child', sequence: 1, prompt: 'x'.repeat(16_001) }),
      (error: unknown) => error instanceof AppError && error.code === 'bad_request',
    );
  });
});
// --- path reservation between delegated children (Master Plan v4 section 6.6)

interface ScriptedTurn { chunks?: StreamChunk[]; error?: unknown }

function tokenChunk(text: string): StreamChunk { return { type: 'token', text }; }
function toolChunk(id: string, name: string, args: Record<string, unknown>): StreamChunk {
  return { type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } };
}

let harnessCounter = 0;

/**
 * A Code run against an in-memory workspace. One scripted stream serves parent
 * and child turns in call order — the loop dispatches serially, so the order
 * is deterministic. `reservations` is the test seam into the per-run map: a
 * test can seed it beforehand and observe it mid-run (from `writeFile`, at the
 * moment bytes would land) and after the run.
 */
function codeHarness(turns: ScriptedTurn[], reservations: Map<string, string>): {
  ctx: AgentContext;
  input: TaskInput;
  dependencies: CodeDependencies;
  events: { event: string; data: Record<string, unknown> }[];
  files: Map<string, string>;
  writes: { path: string; heldBy: string | undefined }[];
  resolve: (candidate: string) => string;
} {
  harnessCounter += 1;
  const root = path.join(testHome, `reservation-workspace-${harnessCounter}`);
  const files = new Map<string, string>();
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const writes: { path: string; heldBy: string | undefined }[] = [];
  const resolve = (candidate: string): string => path.resolve(root, candidate);

  const ctx = {
    taskId: `reservation-parent-${harnessCounter}`,
    emit: (event: string, data: Record<string, unknown>) => { events.push({ event, data }); },
    llm: {
      async *stream(_request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
        // An unscripted turn ends the run rather than masking a script bug.
        const turn = turns.shift() ?? { chunks: [tokenChunk('(no scripted turn left)')] };
        if (turn.error !== undefined) throw turn.error;
        for (const chunk of turn.chunks ?? []) yield chunk;
      },
      async complete() { return { text: '', usage: { tokensIn: 0, tokensOut: 0 } }; },
    },
    executeCommand: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    saveArtifactVersion: () => ({ version: 1 }),
    readFile: async (candidate: string) => {
      const content = files.get(resolve(candidate));
      if (content === undefined) throw new AppError('not_found', `no such file: ${candidate}`);
      return { path: candidate, content, sha256: '0'.repeat(64), bytes: content.length };
    },
    writeFile: async (file: { path: string; content: string; expectedSha256: string | null }) => {
      const absolute = resolve(file.path);
      writes.push({ path: file.path, heldBy: reservations.get(absolute) });
      files.set(absolute, file.content);
      return { path: file.path, sha256: '1'.repeat(64), bytes: file.content.length, version: 1 };
    },
    restoreArtifactVersion: async () => { throw new Error('not used in these tests'); },
    getSkillsSummary: () => [],
    resolvePath: resolve,
    signal: new AbortController().signal,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as AgentContext;

  const input: TaskInput = {
    tool: 'code',
    chatId: 'chat-reservation',
    modelId: 'model-1',
    prompt: 'Do the delegated work.',
    mode: 'act',
  };

  const dependencies: CodeDependencies = {
    loadProjectRules: async () => ({ source: 'none', scopeEnforced: false, rules: [] }),
    loadAgentProfile: async () => {
      throw new AppError('not_found', 'this harness has no project profiles');
    },
    loadProjectProfiles: async () => [],
    loadProjectPermissions: async () => ({}),
    sessionPermissionRules: () => ({}),
    pathReservations: reservations,
  };

  return { ctx, input, dependencies, events, files, writes, resolve };
}

describe('path reservation between delegated children', () => {
  it('a child holds its write path for exactly its own run', async () => {
    const reservations = new Map<string, string>();
    const run = codeHarness([
      { chunks: [toolChunk('d1', 'delegate', { prompt: 'child: write foo' })] },
      { chunks: [toolChunk('w1', 'write', { path: 'foo.md', content: 'a1', expectedSha256: null })] },
      { chunks: [toolChunk('w2', 'write', { path: 'foo.md', content: 'a2', expectedSha256: null })] },
      { chunks: [tokenChunk('child done')] },
      { chunks: [tokenChunk('parent done')] },
    ], reservations);

    const result = await runCodeTask(run.input, run.ctx, { dependencies: run.dependencies });

    assert.equal(result.ok, true);
    // The second write landed: rewriting your own reservation is not a conflict.
    assert.equal(run.files.get(run.resolve('foo.md')), 'a2');
    const childTaskId = run.events.find((entry) => entry.event === 'subagent_started')?.data.childTaskId;
    assert.equal(typeof childTaskId, 'string');
    assert.deepEqual(run.writes.map((write) => write.heldBy), [childTaskId, childTaskId]);
    // And the hold died with the child run.
    assert.equal(reservations.size, 0);
    assert.equal(listSubagentRuns(run.ctx.taskId)[0]?.state, 'complete');
  });

  it('a write that meets a live reservation fails before bytes land, naming the holder', async () => {
    const reservations = new Map<string, string>();
    const run = codeHarness([
      { chunks: [toolChunk('w1', 'write', { path: 'foo.md', content: 'parent content', expectedSha256: null })] },
      { chunks: [tokenChunk('unreachable: the run must already be over')] },
    ], reservations);
    reservations.set(run.resolve('foo.md'), 'child-holder-9');

    const result = await runCodeTask(run.input, run.ctx, { dependencies: run.dependencies });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'conflict');
    assert.match(result.error?.message ?? '', /child-holder-9/);
    assert.match(result.error?.message ?? '', /foo\.md/);
    assert.equal(run.files.has(run.resolve('foo.md')), false, 'the refusal came before the write');
  });

  it('a finished child releases its paths, so a later sibling can take them', async () => {
    const reservations = new Map<string, string>();
    const run = codeHarness([
      { chunks: [toolChunk('d1', 'delegate', { prompt: 'first child' })] },
      { chunks: [toolChunk('w1', 'write', { path: 'foo.md', content: 'first', expectedSha256: null })] },
      { chunks: [tokenChunk('first done')] },
      { chunks: [toolChunk('d2', 'delegate', { prompt: 'second child' })] },
      { chunks: [toolChunk('w2', 'write', { path: 'foo.md', content: 'second', expectedSha256: null })] },
      { chunks: [tokenChunk('second done')] },
      { chunks: [tokenChunk('parent done')] },
    ], reservations);

    const result = await runCodeTask(run.input, run.ctx, { dependencies: run.dependencies });

    assert.equal(result.ok, true);
    assert.equal(run.files.get(run.resolve('foo.md')), 'second');
    assert.deepEqual(listSubagentRuns(run.ctx.taskId).map((entry) => entry.state), ['complete', 'complete']);
    assert.equal(reservations.size, 0);
  });

  it('a parent that wrote a file can still hand it to a child', async () => {
    const reservations = new Map<string, string>();
    const run = codeHarness([
      { chunks: [toolChunk('w1', 'write', { path: 'skel.md', content: 'skeleton', expectedSha256: null })] },
      { chunks: [toolChunk('d1', 'delegate', { prompt: 'fill the skeleton' })] },
      { chunks: [toolChunk('w2', 'write', { path: 'skel.md', content: 'filled', expectedSha256: null })] },
      { chunks: [tokenChunk('child done')] },
      { chunks: [tokenChunk('parent done')] },
    ], reservations);

    const result = await runCodeTask(run.input, run.ctx, { dependencies: run.dependencies });

    assert.equal(result.ok, true);
    assert.equal(run.files.get(run.resolve('skel.md')), 'filled');
    // The parent's own write was checked but never held, or the handoff would
    // have collided with it.
    assert.equal(run.writes[0]?.heldBy, undefined);
  });

  it('a child that errors still releases its paths', async () => {
    const reservations = new Map<string, string>();
    const run = codeHarness([
      { chunks: [toolChunk('d1', 'delegate', { prompt: 'doomed child' })] },
      { chunks: [toolChunk('w1', 'write', { path: 'foo.md', content: 'first', expectedSha256: null })] },
      { error: new AppError('internal_error', 'the child provider turn exploded') },
      { chunks: [toolChunk('w2', 'write', { path: 'foo.md', content: 'parent takes over', expectedSha256: null })] },
      { chunks: [tokenChunk('parent done')] },
    ], reservations);

    const result = await runCodeTask(run.input, run.ctx, { dependencies: run.dependencies });

    assert.equal(result.ok, true);
    assert.equal(run.files.get(run.resolve('foo.md')), 'parent takes over');
    assert.equal(listSubagentRuns(run.ctx.taskId)[0]?.state, 'error');
    assert.equal(reservations.size, 0);
  });
});
