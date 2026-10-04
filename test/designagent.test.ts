/**
 * The Design agent.
 *
 * Agent-level tests drive `runDesignTask` against a scripted stream, with
 * artifact persistence REAL (the genuine artifact_versions table) — the
 * version history, undo and preview ids are the feature, so faking the store
 * would test nothing. The HTTP section boots a real server and a socket-level
 * mock provider, per the house rule that behaviour claims go through real
 * servers.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { AgentContext, CompletionRequest, StreamChunk, TaskInput } from '../src/types/core.ts';
import type { DesignDependencies } from '../src/services/design/agent.ts';

const { cleanupHome, freshDb, testHome } = await import('./helpers.ts');
const { runDesignTask } = await import('../src/services/design/agent.ts');
const { designArtifactKey, latestDesignVersion } = await import('../src/services/design/tools.ts');
const { saveArtifactVersion } = await import('../src/services/code/files.ts');
const {
  listApprovedAssets,
  saveAsset,
  setAssetBrandApproved,
} = await import('../src/services/storage/gallery.ts');
const { getDb } = await import('../src/db/adapter.ts');
const { AppError } = await import('../src/util/errors.ts');

interface ScriptedTurn { chunks?: StreamChunk[]; error?: unknown }

function token(text: string): StreamChunk { return { type: 'token', text }; }
function call(id: string, name: string, args: Record<string, unknown>): StreamChunk {
  return { type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } };
}

let counter = 0;

function harness(turns: ScriptedTurn[], deps: DesignDependencies = {}) {
  counter += 1;
  const root = path.join(testHome, 'design-workspace');
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const requests: CompletionRequest[] = [];
  const commands: string[] = [];
  const taskId = `design-task-${counter}`;
  const runId = `design-run-${counter}`;

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
    executeCommand: async (_cwd: string, command: string) => {
      commands.push(command);
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    },
    saveArtifactVersion: (artifact: Parameters<typeof saveArtifactVersion>[0]) =>
      saveArtifactVersion(artifact, {
        resolvePath: (candidate: string) => path.resolve(root, candidate),
        emit: (artifactKey: string, version: number) => {
          events.push({ event: 'artifact', data: { artifactKey, version } });
        },
      }),
    readFile: async () => { throw new AppError('not_found', 'no files in the design harness'); },
    writeFile: async () => { throw new AppError('capability_disabled', 'design cannot write files'); },
    restoreArtifactVersion: async () => { throw new AppError('capability_disabled', 'unused in the design harness'); },
    getSkillsSummary: () => [],
    resolvePath: (candidate: string) => path.resolve(root, candidate),
    signal: new AbortController().signal,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as AgentContext;

  const input: TaskInput = {
    tool: 'design',
    chatId: `design-chat-${counter}`,
    modelId: 'model-1',
    prompt: 'Design a landing hero.',
    mode: 'act',
  };
  return { ctx, input, events, requests, commands, taskId, runId, deps };
}

/** The text of every tool result the loop fed back, in order. */
function toolOutputs(run: { requests: CompletionRequest[] }): string[] {
  const outputs: string[] = [];
  for (const request of run.requests) {
    for (const message of request.messages) {
      if (message.role === 'tool') outputs.push(message.content);
    }
  }
  return outputs;
}

before(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

describe('the design agent', () => {
  it('generates, revises, previews, undoes and saves — the iterative loop end to end', async () => {
    const run = harness([
      { chunks: [call('g1', 'design.generate_html', { content: '<html>v1</html>', title: 'first' })] },
      { chunks: [call('r1', 'design.revise', { content: '<html>v2</html>', note: 'quieter header' })] },
      { chunks: [call('p1', 'design.preview_snapshot', {})] },
      { chunks: [call('u1', 'design.undo', {})] },
      { chunks: [call('u2', 'design.undo', {})] },
      { chunks: [call('s1', 'design.save_asset', {})] },
      { chunks: [token('Done: the deliverable is the restored first draft.')] },
    ]);

    const result = await runDesignTask(run.input, run.ctx, { dependencies: run.deps });

    assert.equal(result.ok, true);
    const key = designArtifactKey(run.runId, 'draft.html');
    const latest = latestDesignVersion(key);
    // generate v1, revise v2, undo -> v3 restoring v1's content. The second
    // undo hit "first version" guidance and wrote nothing.
    assert.equal(latest?.version, 3);
    assert.equal(latest?.content, '<html>v1</html>');
    assert.deepEqual(result.artifacts, [{ key, version: 3 }]);

    const outputs = toolOutputs(run);
    assert.ok(outputs.some((text) => text.includes('/api/design/preview/')), 'preview URL surfaced');
    assert.ok(
      outputs.some((text) => /first version/.test(text)),
      'the second undo was told there is nothing earlier',
    );
    // Every version row persists — history is append-only, never overwritten.
    const count = getDb()
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_key = ?')
      .get(key);
    assert.equal(count?.n, 3);
  });

  it('revising before generating is guidance the run recovers from, not a fatal error', async () => {
    const run = harness([
      { chunks: [call('r1', 'design.revise', { content: '<html>x</html>', note: 'nothing to revise' })] },
      { chunks: [call('g1', 'design.generate_html', { content: '<html>recovered</html>' })] },
      { chunks: [token('Recovered and generated.')] },
    ]);

    const result = await runDesignTask(run.input, run.ctx, { dependencies: run.deps });

    assert.equal(result.ok, true);
    assert.ok(
      toolOutputs(run).some((text) => /Nothing exists at that target yet/.test(text)),
      'the revise got guidance back as tool output',
    );
    assert.equal(latestDesignVersion(designArtifactKey(run.runId, 'draft.html'))?.content, '<html>recovered</html>');
  });

  it('a tool call whose arguments are not a JSON object is refused, in one sentence', async () => {
    // The parser is shared with the Code and Cowork agents
    // (`services/agent/toolArguments.ts`), so these two sentences are the contract
    // for all three. Two runs, because the first refusal is fatal: a tool that
    // throws ends the run — `runTool` records the step and rethrows — which is what
    // these are, as distinct from a tool that returns guidance as its output.
    const badJson = harness([
      { chunks: [{ type: 'tool_call', call: { id: 'bad-json', name: 'design.generate_html', arguments: '{"content": ' } }] },
    ]);
    const unparseable = await runDesignTask(badJson.input, badJson.ctx, { dependencies: badJson.deps });
    assert.equal(unparseable.ok, false);
    assert.equal(unparseable.error?.code, 'bad_request');
    assert.equal(unparseable.error?.message, 'The model produced invalid JSON tool arguments.');

    // An array parses as JSON and is still not a set of tool arguments: the case a
    // bare `JSON.parse` would let through to `args.content` as undefined.
    const array = harness([
      { chunks: [{ type: 'tool_call', call: { id: 'bad-shape', name: 'design.generate_html', arguments: '["not", "an", "object"]' } }] },
    ]);
    const wrongShape = await runDesignTask(array.input, array.ctx, { dependencies: array.deps });
    assert.equal(wrongShape.ok, false);
    assert.equal(wrongShape.error?.code, 'bad_request');
    assert.equal(wrongShape.error?.message, 'Tool arguments must be a JSON object.');
  });

  it('a model that tries bash is refused and the run continues', async () => {
    const run = harness([
      { chunks: [call('b1', 'bash', { command: 'rm -rf ~' })] },
      { chunks: [call('w1', 'write', { path: 'x.ts', content: 'y' })] },
      { chunks: [call('g1', 'design.generate_html', { content: '<html>fine</html>' })] },
      { chunks: [token('Done.')] },
    ]);

    const result = await runDesignTask(run.input, run.ctx, { dependencies: run.deps });

    assert.equal(result.ok, true, 'one forbidden call must not cost the run');
    assert.deepEqual(run.commands, [], 'no command ever executed');
    const outputs = toolOutputs(run);
    // Neither name is in the design toolset, so the permission gate refuses
    // them as unknown tools before dispatch — with the refusal fed back to
    // the model as ordinary tool output, and the run carrying on.
    assert.ok(outputs.some((text) => /Refused: `bash`/.test(text)), 'bash was refused');
    assert.ok(outputs.some((text) => /Refused: `write`/.test(text)), 'write was refused');
    assert.equal(latestDesignVersion(designArtifactKey(run.runId, 'draft.html'))?.content, '<html>fine</html>');
  });

  it('the RepeatGuard parks a degenerate identical-revision loop', async () => {
    const same = { content: '<html>same</html>', note: 'same note' };
    const run = harness([
      { chunks: [call('g1', 'design.generate_html', { content: '<html>v1</html>' })] },
      { chunks: [call('r1', 'design.revise', same)] },
      { chunks: [call('r2', 'design.revise', same)] },
      { chunks: [call('r3', 'design.revise', same)] },
      { chunks: [call('r4', 'design.revise', same)] },
      { chunks: [token('never reached')] },
    ]);

    const result = await runDesignTask(run.input, run.ctx, { dependencies: run.deps });

    assert.equal(result.ok, false);
    assert.match(result.summary, /doom_loop/);
  });

  it('brand reads see only the approved set, and proposals never land approved', async () => {
    const approved = await saveAsset({ filename: 'logo.svg', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8'), mimeType: 'image/svg+xml', origin: 'uploaded' });
    const unapproved = await saveAsset({ filename: 'draft-mark.svg', buffer: Buffer.from('<svg/>', 'utf8'), mimeType: 'image/svg+xml', origin: 'uploaded' });
    setAssetBrandApproved(approved.id, true);

    const run = harness([
      { chunks: [call('br', 'design.brand_read', {})] },
      { chunks: [call('bp', 'design.brand_propose', { filename: 'candidate.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>' })] },
      { chunks: [token('Proposed.')] },
    ]);

    const result = await runDesignTask(run.input, run.ctx, { dependencies: run.deps });

    assert.equal(result.ok, true);
    const outputs = toolOutputs(run);
    const read = outputs.find((text) => text.includes('"approved"')) ?? '';
    assert.ok(read.includes(approved.id), 'the canonical asset was returned');
    assert.ok(read.includes('<svg xmlns'), 'SVG content came through inline');
    assert.ok(!read.includes(unapproved.id), 'the unapproved asset was invisible');

    const proposal = outputs.find((text) => /Proposed brand asset/.test(text)) ?? '';
    assert.match(proposal, /NOT approved/);
    // The proposal is in the gallery as a design-generated asset — and still
    // not canonical. Only the user flips that flag.
    assert.equal(listApprovedAssets().length, 1);
    const proposed = getDb()
      .prepare<{ is_brand_approved: number; tool: string | null; origin: string }>(
        "SELECT is_brand_approved, tool, origin FROM attachments WHERE filename = 'candidate.svg'",
      )
      .get();
    assert.deepEqual(proposed, { is_brand_approved: 0, tool: 'design', origin: 'generated' });
  });

  it('vision_verify is an honest stub: always unverified, always with its checklist', async () => {
    const run = harness([
      { chunks: [call('v1', 'design.vision_verify', {})] },
      { chunks: [token('Unverified, as stated.')] },
    ]);

    const result = await runDesignTask(run.input, run.ctx, { dependencies: run.deps });

    assert.equal(result.ok, true);
    const output = toolOutputs(run).find((text) => text.includes('unverified')) ?? '';
    const parsed = JSON.parse(output) as { status: string; checks: { name: string; status: string }[] };
    assert.equal(parsed.status, 'unverified');
    assert.deepEqual(parsed.checks.map((check) => check.status), ['pending', 'pending', 'pending']);
  });

  it('a Plan-mode run collects design mutations into the plan and writes nothing', async () => {
    const run = harness([
      { chunks: [call('g1', 'design.generate_html', { content: '<html>planned</html>' })] },
      { chunks: [token('Here is the plan.')] },
    ]);
    const input: TaskInput = { ...run.input, mode: 'plan' };

    const result = await runDesignTask(input, run.ctx, { dependencies: run.deps });

    // A Plan run with a collected plan parks for review rather than
    // completing: the mutation was gathered, never executed.
    assert.equal(result.ok, false);
    const parked = run.events.find((entry) => entry.event === 'task_parked');
    assert.equal(parked?.data.reason, 'plan_ready');
    assert.equal(
      getDb().prepare<{ n: number }>("SELECT COUNT(*) AS n FROM artifact_versions WHERE tool = 'design' AND artifact_key LIKE ?").get(`design:file:${run.runId}:%`)?.n,
      0,
      'no artifact row was written in Plan mode',
    );
    assert.deepEqual(result.plan?.map((entry) => entry.toolName), ['design.generate_html']);
  });
});

// --- over HTTP: real server, socket-level mock provider, real agent ---------

import type { Server } from 'node:http';
import type { MockProvider } from './helpers.ts';

const { startMockProvider } = await import('./helpers.ts');
const { createApp } = await import('../src/http/app.ts');
const { createDesignAgent } = await import('../src/services/design/agent.ts');
const { getDesignVersion } = await import('../src/services/design/tools.ts');
const { createProvider } = await import('../src/providers/repository.ts');
const { resetAllHealth } = await import('../src/providers/health.ts');
const { resetModules, registeredAgents } = await import('../src/orchestrator/agents.ts');
const { resetLock, resetCodeLane } = await import('../src/orchestrator/lock.ts');
const { registerProductionModules } = await import('../src/services/agent/composition.ts');

const POISON_DRAFT =
  '<html><head><script>alert(1)</script></head>' +
  '<body><img src="https://evil.example/beacon"><h1>draft</h1></body></html>';

describe('design over HTTP', () => {
  let server: Server;
  let base: string;
  let mock: MockProvider;

  before(async () => {
    mock = await startMockProvider();
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mock.close();
  });

  beforeEach(async () => {
    await freshDb();
    resetAllHealth();
    resetLock();
    resetCodeLane(2);
    resetModules();
    registerProductionModules();
    createProvider({ name: 'Mock', type: 'remote', baseUrl: mock.baseUrl, enabled: true });
    mock.behave({ models: ['mock-model'], tokens: ['Done.'] });
  });

  it('a run-task produces a versioned draft and the preview serves it inert', async () => {
    mock.behave({
      models: ['mock-model'],
      toolCalls: [
        { id: 'c1', name: 'design.generate_html', arguments: JSON.stringify({ content: POISON_DRAFT, title: 'poisoned' }) },
      ],
      thenBehave: { tokens: ['Done.'] },
    });

    const response = await fetch(`${base}/api/design/run-task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'design-http', modelId: 'mock-model', prompt: 'A landing hero.', taskId: 'design-http-1' }),
    });
    const stream = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.ok(stream.includes('design:file:'), 'the artifact event streamed');

    // The provider saw the design toolset advertised — and the run wrote a
    // real version row.
    const firstCall = mock.streamCalls[0]?.body;
    const toolsOffered = JSON.stringify(firstCall?.tools ?? []);
    assert.ok(toolsOffered.includes('design.generate_html'), 'design tools were advertised to the model');
    assert.ok(!toolsOffered.includes('"bash"'), 'bash was never advertised');

    const row = getDb()
      .prepare<{ id: string; artifact_key: string }>(
        "SELECT id, artifact_key FROM artifact_versions WHERE tool = 'design' ORDER BY created_at DESC LIMIT 1",
      )
      .get();
    assert.ok(row?.artifact_key.endsWith(':draft.html'), 'the draft version persisted');

    // The preview serves the poisoned draft verbatim — inertness comes from
    // the CSP + sandbox, not from rewriting the markup.
    const preview = await fetch(`${base}/api/design/preview/${row?.id}`);
    const served = await preview.text();
    assert.equal(preview.status, 200);
    assert.equal(
      preview.headers.get('content-security-policy'),
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    );
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    assert.match(preview.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(served, POISON_DRAFT);
  });

  it('the preview 404s without confirming what was missed', async () => {
    // Unknown id.
    const missing = await fetch(`${base}/api/design/preview/vsn_nope`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'not_found');

    // Another tool's artifact exists but is not previewable.
    getDb()
      .prepare(
        "INSERT INTO artifact_versions (id, artifact_key, tool, version, content, created_at) VALUES ('code-row-1', 'code:file:t:a.ts', 'code', 1, 'const a = 1;', 1)",
      )
      .run();
    const foreign = await fetch(`${base}/api/design/preview/code-row-1`);
    assert.equal(foreign.status, 404);

    // An SVG design version previews as an image under the same CSP.
    getDb()
      .prepare(
        "INSERT INTO artifact_versions (id, artifact_key, tool, version, content, created_at) VALUES ('design-svg-1', 'design:file:r1:logo.svg', 'design', 1, '<svg xmlns=\"http://www.w3.org/2000/svg\"/>>', 1)",
      )
      .run();
    const svg = await fetch(`${base}/api/design/preview/design-svg-1`);
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type') ?? '', /image\/svg\+xml/);
    assert.equal(svg.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  });

  it('the composition now includes design in the status surface', async () => {
    assert.deepEqual(registeredAgents(), ['cowork', 'code', 'design']);
    const response = await fetch(`${base}/api/agents/status`);
    const status = (await response.json()) as { registered: Record<string, boolean> };
    assert.deepEqual(status.registered, { code: true, cowork: true, design: true });
  });
});
