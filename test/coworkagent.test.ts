import './helpers.ts';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  AgentContext,
  CompletionRequest,
  McpProcessManager,
  McpToolCallResult,
  McpToolDefinition,
  StreamChunk,
  TaskInput,
} from '../src/types/core.ts';
import type { KnowledgeSource } from '../src/services/cowork/knowledge.ts';

const { cleanupHome, freshDb } = await import('./helpers.ts');
const { AppError } = await import('../src/util/errors.ts');
const { createCoworkAgent, readKnowledgeSource, runCoworkTask } = await import('../src/services/cowork/agent.ts');
const { saveKnowledgeSource } = await import('../src/services/cowork/knowledge.ts');

type StreamPlan = { chunks?: StreamChunk[]; error?: unknown };

function input(mode: TaskInput['mode'] = 'act'): TaskInput {
  return { tool: 'cowork', chatId: 'chat-1', modelId: 'model-1', prompt: 'Research this topic.', mode };
}

function context(
  plans: StreamPlan[],
  options: { artifacts?: { version: number }[] } = {},
): { ctx: AgentContext; requests: CompletionRequest[]; events: { event: string; data: Record<string, unknown> }[] } {
  const requests: CompletionRequest[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  let artifactIndex = 0;
  const ctx = {
    taskId: 'task-1',
    emit: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
    llm: {
      async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
        requests.push(request);
        const plan = plans.shift() ?? { chunks: [] };
        if (plan.error !== undefined) throw plan.error;
        for (const chunk of plan.chunks ?? []) yield chunk;
      },
      async complete() { return { text: '', usage: { tokensIn: 0, tokensOut: 0 } }; },
    },
    saveArtifactVersion: () => ({ version: options.artifacts?.[artifactIndex++]?.version ?? 1 }),
    signal: new AbortController().signal,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as AgentContext;
  return { ctx, requests, events };
}

function token(text: string): StreamChunk { return { type: 'token', text }; }
function call(id: string, name: string, args: Record<string, unknown>): StreamChunk {
  return { type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } };
}

function source(filename: string, mimeType: string | null = 'text/plain'): KnowledgeSource {
  return { id: filename, label: filename, filename, relPath: filename, mimeType, bytes: 1, sha256: null, createdAt: 1 };
}

function makeManager(
  status: McpProcessManager['getStatus'] extends () => infer T ? T : never,
  result: McpToolCallResult,
): {
  manager: McpProcessManager;
  starts: string[];
  listed: string[];
  calls: { name: string; tool: string; args: Record<string, unknown> }[];
} {
  const starts: string[] = [];
  const listed: string[] = [];
  const calls: { name: string; tool: string; args: Record<string, unknown> }[] = [];
  const tools: McpToolDefinition[] = [{ name: 'search', inputSchema: { type: 'object' }, description: 'Search the web.' }];
  const value = {
    getStatus: () => status,
    start: async (name: string) => { starts.push(name); },
    stop: async () => {},
    listTools: async (name: string) => { listed.push(name); return tools; },
    callTool: async (name: string, tool: string, args: Record<string, unknown>) => {
      calls.push({ name, tool, args });
      return result;
    },
  } as McpProcessManager;
  return { manager: value, starts, listed, calls };
}

before(async () => { await freshDb(); });
after(async () => { await cleanupHome(); });

describe('the additive Cowork agent', () => {
  it('explains the exact Wigolo setup without starting anything', async () => {
    const run = context([{ chunks: [token('No server needed.')] }]);
    let starts = 0;
    const result = await runCoworkTask(input(), run.ctx, {
      dependencies: {
        listKnowledgeSources: () => [],
        recallForTurn: async () => null,
        findWigolo: () => null,
        getMcpProcessManager: () => ({ start: async () => { starts++; } } as unknown as McpProcessManager),
      },
    });

    assert.equal(result.ok, true);
    assert.match(run.requests[0]?.messages[0]?.content ?? '', /npx -y wigolo init/);
    assert.equal(starts, 0);
  });

  it('reports source failures but sends only verified usable text as evidence', async () => {
    const run = context([{ chunks: [token('Evidence reviewed.')] }]);
    const usable = source('guide.md');
    const missing = source('missing.md');
    const binary = source('binary.bin', 'application/octet-stream');
    const badHash = source('changed.txt');
    const result = await runCoworkTask(input(), run.ctx, {
      dependencies: {
        listKnowledgeSources: () => [usable, missing, binary, badHash],
        readKnowledge: async (item) => item === usable
          ? { status: 'usable', text: 'CONFIRMED REFERENCE' }
          : { status: item === missing ? 'missing' : item === binary ? 'binary' : 'hash_mismatch' },
        findWigolo: () => null,
        recallForTurn: async () => null,
      },
    });

    assert.equal(result.ok, true);
    const system = run.requests[0]?.messages[0]?.content ?? '';
    assert.match(system, /CONFIRMED REFERENCE/);
    assert.match(system, /missing; not used as evidence/);
    assert.match(system, /binary; not used as evidence/);
    assert.match(system, /hash_mismatch; not used as evidence/);
  });

  it('uses Wigolo only when enabled and running, and preserves MCP errors as results', async () => {
    const live = makeManager([{ name: 'WIGOLO', state: 'running' }], {
      content: [{ type: 'text', text: 'upstream rejected the query' }],
      isError: true,
    });
    const run = context([
      { chunks: [call('c1', 'wigolo.search', { query: 'Hyperion' })] },
      { chunks: [token('The supervised server returned a refusal.')] },
    ]);
    const result = await runCoworkTask(input(), run.ctx, {
      dependencies: {
        listKnowledgeSources: () => [],
        findWigolo: () => ({ enabled: true }),
        getMcpProcessManager: () => live.manager,
        recallForTurn: async () => null,
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(live.listed, ['wigolo']);
    assert.deepEqual(live.starts, []);
    assert.deepEqual(live.calls, [{ name: 'wigolo', tool: 'search', args: { query: 'Hyperion' } }]);
    assert.match(run.requests[1]?.messages.find((message) => message.role === 'tool')?.content ?? '', /MCP tool reported an error/);
  });

  it('keeps Ask refusal, Plan actions, and Act artifact versions on the shared loop', async () => {
    const ask = context([
      { chunks: [call('ask-1', 'cowork.save_artifact', { format: 'markdown', artifactKey: 'report', content: '# report' })] },
      { chunks: [token('I can describe the report, but Ask mode will not save it.')] },
    ]);
    const askResult = await runCoworkTask(input('ask'), ask.ctx, { dependencies: { findWigolo: () => null, recallForTurn: async () => null } });
    assert.equal(askResult.ok, true);
    assert.equal(askResult.artifacts, undefined);

    const plan = context([
      { chunks: [call('plan-1', 'cowork.save_artifact', { format: 'csv', artifactKey: 'rows', content: 'a,b' })] },
      { chunks: [token('The CSV is ready for approval.')] },
    ]);
    const planResult = await runCoworkTask(input('plan'), plan.ctx, { dependencies: { findWigolo: () => null, recallForTurn: async () => null } });
    assert.equal(planResult.ok, false);
    assert.equal(planResult.error, undefined);
    assert.equal(planResult.plan?.[0]?.toolName, 'cowork.save_artifact');

    const act = context([
      { chunks: [call('act-1', 'cowork.save_artifact', { format: 'markdown', artifactKey: 'report', content: '# report' })] },
      { chunks: [token('Saved the report.')] },
    ], { artifacts: [{ version: 4 }] });
    const actResult = await runCoworkTask(input('act'), act.ctx, { dependencies: { findWigolo: () => null, recallForTurn: async () => null } });
    assert.deepEqual(actResult.artifacts, [{ key: 'report', version: 4 }]);
    assert.equal(act.events.some((event) => event.event === 'artifact'), true);
  });

  it('recalls before the turn and remembers only completed output', async () => {
    const recalled: { prompt: string; tool: string }[] = [];
    const remembered: string[] = [];
    const run = context([{ chunks: [token('Completed answer.')] }]);
    const result = await runCoworkTask(input(), run.ctx, {
      dependencies: {
        findWigolo: () => null,
        recallForTurn: async (prompt, tool) => { recalled.push({ prompt, tool }); return 'Earlier answer'; },
        rememberTurn: (prompt, reply) => remembered.push(`${prompt}:${reply}`),
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(recalled, [{ prompt: 'Research this topic.', tool: 'cowork' }]);
    assert.deepEqual(remembered, ['Research this topic.:Completed answer.']);
    assert.match(run.requests[0]?.messages[0]?.content ?? '', /Earlier answer/);
  });

  it('returns partial text and artifacts when a later provider turn fails', async () => {
    const run = context([
      { chunks: [token('Partial answer '), call('partial-1', 'cowork.save_artifact', { format: 'csv', artifactKey: 'data', content: 'a,b' })] },
      { error: new AppError('spending_cap_reached', 'The spending cap was reached.') },
    ]);
    const result = await runCoworkTask(input(), run.ctx, {
      dependencies: { findWigolo: () => null, recallForTurn: async () => null },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'spending_cap_reached');
    assert.deepEqual(result.artifacts, [{ key: 'data', version: 1 }]);
    assert.match(result.summary, /Partial answer/);
  });
});

describe('Cowork knowledge reading', () => {
  it('reads a stored UTF-8 source through the scoped path and rejects unsupported bytes', async () => {
    const saved = saveKnowledgeSource({ filename: 'reference.md', buffer: Buffer.from('scoped text', 'utf8'), mimeType: 'text/markdown' });
    const usable = await readKnowledgeSource(saved);
    assert.deepEqual(usable, { status: 'usable', text: 'scoped text' });

    const unsupported = await readKnowledgeSource({ ...saved, filename: 'reference.exe', mimeType: 'application/octet-stream' });
    assert.deepEqual(unsupported, { status: 'unsupported' });
  });

  it('distinguishes unreadable files from missing files without hiding scope violations', async () => {
    const stored = source('protected.md');
    const unreadable = await readKnowledgeSource(stored, async () => {
      const error = new Error('permission denied') as Error & { code: string };
      error.code = 'EACCES';
      throw error;
    });
    assert.deepEqual(unreadable, { status: 'unreadable' });

    const missing = await readKnowledgeSource(stored, async () => {
      const error = new Error('not found') as Error & { code: string };
      error.code = 'ENOENT';
      throw error;
    });
    assert.deepEqual(missing, { status: 'missing' });

    await assert.rejects(
      () => readKnowledgeSource({ ...stored, relPath: '../outside.md' }),
      { name: 'ScopeViolationError' },
    );
  });
});