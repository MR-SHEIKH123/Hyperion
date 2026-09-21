/**
 * Model-aware context windows (Master Plan v4 section 6.1).
 *
 * All three agents used to call resolveContextWindow({}) — every run got the
 * 8,192-token default and every compaction decision was wrong for every real
 * model. The window now resolves from the provider's cached model list at run
 * start (cache-only: a run start must never wait on the network), with the
 * honest `assumed` default kept for models nobody has listed yet.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { AgentContext, CompletionRequest, ModelInfo, StreamChunk, TaskInput } from '../src/types/core.ts';
import type { ContextWindow } from '../src/services/agent/compaction.ts';

const { cleanupHome, freshDb, testHome, startMockProvider } = await import('./helpers.ts');
const { findCachedModel } = await import('../src/providers/registry.ts');
const { createProvider, saveModelCache } = await import('../src/providers/repository.ts');
const { resolveContextWindow: realResolveContextWindow } = await import('../src/services/agent/compaction.ts');
const { runCoworkTask } = await import('../src/services/cowork/agent.ts');
const { runCodeTask } = await import('../src/services/code/agent.ts');
const { runDesignTask } = await import('../src/services/design/agent.ts');
const { saveArtifactVersion } = await import('../src/services/code/files.ts');
const { AppError } = await import('../src/util/errors.ts');

function token(text: string): StreamChunk { return { type: 'token', text }; }
function call(id: string, name: string, args: Record<string, unknown>): StreamChunk {
  return { type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } };
}

let counter = 0;

interface SeenWindow {
  model?: ModelInfo | undefined;
  /** The provider's declared ceiling, when one is in force (Part 1.28). */
  override?: number | undefined;
}

/** One scripted ctx for whichever agent is under test. */
function harness(turns: { chunks?: StreamChunk[]; error?: unknown }[]) {
  counter += 1;
  const root = path.join(testHome, 'window-workspace');
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const requests: CompletionRequest[] = [];
  const seen: SeenWindow[] = [];
  const taskId = `window-task-${counter}`;
  const runId = `window-run-${counter}`;

  const ctx = {
    taskId,
    runId,
    emit: (event: string, data: Record<string, unknown>) => { events.push({ event, data }); },
    llm: {
      async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
        requests.push(request);
        const turn = turns.shift() ?? { chunks: [token('(no scripted turn left)')] };
        if (turn.error !== undefined) throw turn.error;
        for (const chunk of turn.chunks ?? []) yield chunk;
      },
      async complete() { return { text: '', usage: { tokensIn: 0, tokensOut: 0 } }; },
    },
    executeCommand: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    saveArtifactVersion: (artifact: Parameters<typeof saveArtifactVersion>[0]) =>
      saveArtifactVersion(artifact, {
        resolvePath: (candidate: string) => path.resolve(root, candidate),
        emit: (artifactKey: string, version: number) => { events.push({ event: 'artifact', data: { artifactKey, version } }); },
      }),
    readFile: async () => { throw new AppError('not_found', 'no files here'); },
    writeFile: async () => { throw new AppError('capability_disabled', 'unused'); },
    restoreArtifactVersion: async () => { throw new AppError('capability_disabled', 'unused'); },
    getSkillsSummary: () => [],
    resolvePath: (candidate: string) => path.resolve(root, candidate),
    signal: new AbortController().signal,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as AgentContext;

  const input: TaskInput = {
    tool: 'code',
    chatId: `window-chat-${counter}`,
    modelId: 'model-1',
    prompt: 'Do the work.',
    mode: 'act',
  };

  const windowSpy = (value: { model?: ModelInfo; override?: number }): ContextWindow => {
    seen.push(value);
    return realResolveContextWindow(value);
  };

  return { ctx, input, events, requests, seen, windowSpy };
}

const codeDeps = {
  loadProjectRules: async () => ({ source: 'none' as const, scopeEnforced: false, rules: [] }),
  loadAgentProfile: async () => { throw new AppError('not_found', 'no project profiles here'); },
  loadProjectProfiles: async () => [],
  loadProjectPermissions: async () => ({}),
  sessionPermissionRules: () => ({}),
};

const coworkDeps = {
  listKnowledgeSources: () => [],
  findWigolo: () => null,
  recallForTurn: async () => null,
  rememberTurn: () => {},
};

before(async () => {
  await freshDb();
});

beforeEach(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

describe('findCachedModel', () => {
  it('answers from the active provider first, then failover order, and never fetches', async () => {
    const mock = await startMockProvider();
    try {
      const active = createProvider({ name: 'Active', type: 'remote', baseUrl: mock.baseUrl, enabled: true });
      const standby = createProvider({ name: 'Standby', type: 'remote', baseUrl: mock.baseUrl, enabled: false });
      saveModelCache(active.id, [{ id: 'm-small', contextLength: 8_192 }]);
      saveModelCache(standby.id, [{ id: 'm-big', contextLength: 200_000 }]);

      assert.equal(findCachedModel('m-small')?.contextLength, 8_192);
      assert.equal(findCachedModel('m-big')?.contextLength, 200_000);
      assert.equal(findCachedModel('m-absent'), null);
      // The cache-only promise: not one model list was fetched to answer these.
      assert.equal(mock.modelCalls, 0);
    } finally {
      await mock.close();
    }
  });
});

describe('the agents resolve the real window at run start', () => {
  const foundModel = () => ({ id: 'model-1', contextLength: 123_456 });

  it('Code passes the cached model to the window resolution', async () => {
    const run = harness([{ chunks: [token('done')] }]);
    const result = await runCodeTask(run.input, run.ctx, {
      dependencies: { ...codeDeps, findModel: foundModel, resolveContextWindow: run.windowSpy },
    });
    assert.equal(result.ok, true);
    assert.equal(run.seen[0]?.model?.contextLength, 123_456);
  });

  it('Cowork passes the cached model to the window resolution', async () => {
    const run = harness([{ chunks: [token('done')] }]);
    const result = await runCoworkTask({ ...run.input, tool: 'cowork' }, run.ctx, {
      dependencies: { ...coworkDeps, findModel: foundModel, resolveContextWindow: run.windowSpy },
    });
    assert.equal(result.ok, true);
    assert.equal(run.seen[0]?.model?.contextLength, 123_456);
  });

  it('Design passes the cached model to the window resolution', async () => {
    const run = harness([{ chunks: [token('done')] }]);
    const result = await runDesignTask({ ...run.input, tool: 'design' }, run.ctx, {
      dependencies: { findModel: foundModel, resolveContextWindow: run.windowSpy },
    });
    assert.equal(result.ok, true);
    assert.equal(run.seen[0]?.model?.contextLength, 123_456);
  });
});

describe('a declared ceiling is the ladder\'s first rung', () => {
  const foundModel = () => ({ id: 'model-1', contextLength: 123_456 });

  it('every agent passes the active provider\'s ceiling into the resolution', async () => {
    // 1.28 documented the ladder as "an explicit override, then what the provider
    // reported, then the default" — and until this test existed, no caller ever
    // supplied the first rung: `providers.max_context_tokens` had no reader. One
    // loop per agent, because the three agents resolve their window independently
    // and asserting one of them would leave the other two free to drift.
    const declared = createProvider({
      name: 'Declared',
      type: 'remote',
      baseUrl: 'https://example.test/v1',
      enabled: true,
      maxContextTokens: 40_000,
    });
    assert.equal(findCachedModel('model-1'), null, 'the model itself is unknown to the cache');

    const code = harness([{ chunks: [token('done')] }]);
    assert.equal((await runCodeTask(code.input, code.ctx, {
      dependencies: { ...codeDeps, findModel: foundModel, resolveContextWindow: code.windowSpy },
    })).ok, true);
    assert.equal(code.seen[0]?.override, 40_000);

    const cowork = harness([{ chunks: [token('done')] }]);
    assert.equal((await runCoworkTask({ ...cowork.input, tool: 'cowork' }, cowork.ctx, {
      dependencies: { ...coworkDeps, findModel: foundModel, resolveContextWindow: cowork.windowSpy },
    })).ok, true);
    assert.equal(cowork.seen[0]?.override, 40_000);

    const design = harness([{ chunks: [token('done')] }]);
    assert.equal((await runDesignTask({ ...design.input, tool: 'design' }, design.ctx, {
      dependencies: { findModel: foundModel, resolveContextWindow: design.windowSpy },
    })).ok, true);
    assert.equal(design.seen[0]?.override, 40_000);

    // And the ladder honours it: the declaration wins over the model's own number.
    const { resolveContextWindow } = await import('../src/services/agent/compaction.ts');
    assert.equal(resolveContextWindow({ model: { id: 'model-1', contextLength: 123_456 }, override: declared.maxContextTokens ?? undefined }).tokens, 40_000);
  });

  it('a provider that declares nothing leaves the ladder to the model and the default', async () => {
    createProvider({ name: 'Silent', type: 'remote', baseUrl: 'https://example.test/v1', enabled: true });
    const run = harness([{ chunks: [token('done')] }]);
    assert.equal((await runCodeTask(run.input, run.ctx, {
      dependencies: { ...codeDeps, findModel: () => null, resolveContextWindow: run.windowSpy },
    })).ok, true);
    // Absent, not zero: a `0` here would be read as "compact everything", which is
    // the one way this field could do harm.
    assert.equal(run.seen[0]?.override, undefined);
  });
});

describe('the resolved window drives compaction for real', () => {
  const big = 'x'.repeat(1_600);
  const script = () => [
    { chunks: [call('g1', 'design.generate_html', { content: big })] },
    { chunks: [call('r1', 'design.revise', { content: big, note: 'second pass' })] },
    { chunks: [token('done')] },
  ];

  it('a known model compacts at its real window, reported not-assumed', async () => {
    const run = harness(script());
    const result = await runDesignTask({ ...run.input, tool: 'design' }, run.ctx, {
      dependencies: { findModel: () => ({ id: 'model-1', contextLength: 1_200 }) },
    });

    assert.equal(result.ok, true);
    const compacted = run.events.filter((entry) => entry.event === 'context_compacted');
    assert.equal(compacted.length, 1, 'compaction fired at the model-sized window');
    assert.equal(compacted[0]?.data.windowTokens, 1_200);
    assert.equal(compacted[0]?.data.windowAssumed, false);
  });

  it('an unknown model keeps the honest default and does not compact here', async () => {
    const run = harness(script());
    const result = await runDesignTask({ ...run.input, tool: 'design' }, run.ctx, {
      dependencies: { findModel: () => null },
    });

    assert.equal(result.ok, true);
    assert.equal(
      run.events.filter((entry) => entry.event === 'context_compacted').length,
      0,
      'the same conversation fits the default window, so nothing fires',
    );
  });
});
