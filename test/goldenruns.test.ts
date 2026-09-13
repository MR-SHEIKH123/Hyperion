/**
 * Golden-run regression harness (Master Plan v4 section 6.8).
 *
 * Agent behavior drift — a reworded system prompt, a reordered tool list, a
 * changed message flow — is invisible to type checks and to most unit tests,
 * and it is exactly the class of change that silently alters what the model
 * sees. So one real run per agent is RECORDED: every request that went to the
 * provider, every event emitted, the result, and the artifact rows written.
 * The recordings live in `test/golden/*.json` and the replay asserts the run
 * still produces them byte-for-byte (ids normalized).
 *
 * When a drift is INTENTIONAL, re-record rather than hand-edit:
 *
 *   HYPERION_RECORD_GOLDEN=1 node --test test/goldenruns.test.ts
 *
 * and review the fixture diff like any other change. A golden that anyone can
 * edit to make a failing run pass is wallpaper; the diff review is the check.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import type { AgentContext, CompletionRequest, StreamChunk, TaskInput, TaskResult } from '../src/types/core.ts';

const { cleanupHome, freshDb, testHome } = await import('./helpers.ts');
const { saveArtifactVersion } = await import('../src/services/code/files.ts');
const { saveKnowledgeSource } = await import('../src/services/cowork/knowledge.ts');
const { getDb } = await import('../src/db/adapter.ts');
const { AppError } = await import('../src/util/errors.ts');
const { runCoworkTask } = await import('../src/services/cowork/agent.ts');
const { runCodeTask } = await import('../src/services/code/agent.ts');
const { runDesignTask } = await import('../src/services/design/agent.ts');

const RECORD = process.env.HYPERION_RECORD_GOLDEN === '1';
const GOLDEN_DIR = new URL('./golden/', import.meta.url);

interface ScriptedTurn { chunks: StreamChunk[] }

interface GoldenFixture {
  name: string;
  agent: string;
  input: Record<string, unknown>;
  turns: ScriptedTurn[];
  requests: unknown[];
  events: unknown[];
  result: Record<string, unknown>;
  artifacts: unknown[];
}

interface Harness {
  ctx: AgentContext;
  events: { event: string; data: Record<string, unknown> }[];
  requests: CompletionRequest[];
  taskId: string;
  runId: string;
}

function harness(): Harness {
  const root = path.join(testHome, 'golden-workspace');
  const events: Harness['events'] = [];
  const requests: CompletionRequest[] = [];
  const ctx = {
    taskId: 'golden-task',
    runId: 'golden-run',
    emit: (event: string, data: Record<string, unknown>) => { events.push({ event, data }); },
    llm: {
      async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
        requests.push(request);
        for (const chunk of currentTurns.shift()?.chunks ?? []) yield chunk;
      },
      async complete() { return { text: '', usage: { tokensIn: 0, tokensOut: 0 } }; },
    },
    executeCommand: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    saveArtifactVersion: (artifact: Parameters<typeof saveArtifactVersion>[0]) =>
      saveArtifactVersion(artifact, {
        resolvePath: (candidate: string) => path.resolve(root, candidate),
        emit: (artifactKey: string, version: number) => {
          events.push({ event: 'artifact', data: { artifactKey, version } });
        },
      }),
    readFile: async () => ({ path: 'note.md', content: 'seeded file content', sha256: '0'.repeat(64), bytes: 19 }),
    writeFile: async (file: { path: string; content: string }) =>
      ({ path: file.path, sha256: '1'.repeat(64), bytes: file.content.length, version: 1 }),
    restoreArtifactVersion: async () => { throw new AppError('capability_disabled', 'unused in golden runs'); },
    getSkillsSummary: () => [],
    resolvePath: (candidate: string) => path.resolve(root, candidate),
    signal: new AbortController().signal,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as AgentContext;
  return { ctx, events, requests, taskId: 'golden-task', runId: 'golden-run' };
}

let currentTurns: ScriptedTurn[] = [];

/** Ids that vary per run are normalized so the fixtures compare stable
 *  content: the run/task ids, and generated UUIDs (artifact row ids surface in
 *  tool feedback via the preview URL). */
const UUIDISH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function normalizeIds(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .split('golden-run').join('{runId}')
      .split('golden-task').join('{taskId}')
      .replace(UUIDISH, '{uuid}'),
  );
}

/** A request without its AbortSignal, which is a runtime object, not content. */
function snapRequest(request: CompletionRequest): Record<string, unknown> {
  const { signal: _signal, ...rest } = request as unknown as Record<string, unknown> & { signal?: unknown };
  return normalizeIds(rest) as Record<string, unknown>;
}

function artifactRows(): unknown[] {
  const rows = getDb()
    .prepare<{ artifact_key: string; tool: string; version: number; content: string | null; label: string | null }>(
      'SELECT artifact_key, tool, version, content, label FROM artifact_versions ORDER BY artifact_key, version',
    )
    .all();
  return normalizeIds(rows) as unknown[];
}

// --- the golden runs ---------------------------------------------------------

interface GoldenCase {
  file: string;
  name: string;
  input: TaskInput;
  setup?: () => Promise<void>;
  script: () => ScriptedTurn[];
  run: (h: Harness, input: TaskInput) => Promise<TaskResult>;
}

const baseInput = (tool: 'code' | 'cowork' | 'design', prompt: string): TaskInput => ({
  tool,
  chatId: 'golden-chat',
  modelId: 'model-1',
  prompt,
  mode: 'act',
});

const DESIGN_INPUT = baseInput('design', 'Design a small landing hero.');
const COWORK_INPUT = baseInput('cowork', 'What does the handbook say about scope?');
const CODE_INPUT = baseInput('code', 'Rename the note.');

const CASES: GoldenCase[] = [
  {
    file: 'design-draft.json',
    name: 'design: generate, revise, save the deliverable',
    input: DESIGN_INPUT,
    script: () => [
      { chunks: [{ type: 'tool_call', call: { id: 'g1', name: 'design.generate_html', arguments: JSON.stringify({ content: '<html><body><h1>Golden hero</h1></body></html>', title: 'golden hero' }) } }] },
      { chunks: [{ type: 'tool_call', call: { id: 'r1', name: 'design.revise', arguments: JSON.stringify({ content: '<html><body><h1>Golden hero</h1><p>Ship small.</p></body></html>', note: 'add the tagline' }) } }] },
      { chunks: [{ type: 'tool_call', call: { id: 's1', name: 'design.save_asset', arguments: '{}' } }] },
      { chunks: [{ type: 'token', text: 'The deliverable is version 2.' }] },
    ],
    run: (h, input) => runDesignTask(input, h.ctx),
  },
  {
    file: 'cowork-knowledge.json',
    name: 'cowork: knowledge-first answer, saved as an artifact',
    input: COWORK_INPUT,
    setup: async () => {
      saveKnowledgeSource({ filename: 'handbook.md', buffer: Buffer.from('# Handbook\nShip small.', 'utf8'), label: 'Handbook' });
    },
    script: () => [
      { chunks: [
        { type: 'token', text: 'The handbook says: ship small. ' },
        { type: 'tool_call', call: { id: 's1', name: 'cowork.save_artifact', arguments: JSON.stringify({ format: 'markdown', artifactKey: 'golden-summary', content: '# Summary\nShip small.' }) } },
      ] },
      { chunks: [{ type: 'token', text: 'Done — saved as golden-summary v1.' }] },
    ],
    run: (h, input) => runCoworkTask(input, h.ctx),
  },
  {
    file: 'code-edit.json',
    name: 'code: read, then a clobber-safe write',
    input: CODE_INPUT,
    script: () => [
      { chunks: [{ type: 'tool_call', call: { id: 'r1', name: 'read', arguments: JSON.stringify({ path: 'note.md' }) } }] },
      { chunks: [{ type: 'tool_call', call: { id: 'w1', name: 'write', arguments: JSON.stringify({ path: 'note.md', content: 'renamed content', expectedSha256: '0'.repeat(64) }) } }] },
      { chunks: [{ type: 'token', text: 'Renamed.' }] },
    ],
    run: (h, input) => runCodeTask(input, h.ctx, {
      dependencies: {
        loadProjectRules: async () => ({ source: 'none', scopeEnforced: false, rules: [] }),
        loadAgentProfile: async () => { throw new AppError('not_found', 'no project profiles in golden runs'); },
        loadProjectProfiles: async () => [],
        loadProjectPermissions: async () => ({}),
        sessionPermissionRules: () => ({}),
      },
    }),
  },
];

function resultSnapshot(result: TaskResult): Record<string, unknown> {
  return normalizeIds({
    ok: result.ok,
    summary: result.summary,
    ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }),
    ...(result.plan === undefined ? {} : { plan: result.plan }),
    ...(result.error === undefined ? {} : { error: result.error }),
  }) as Record<string, unknown>;
}

function fixturePath(file: string): URL {
  return new URL(file, GOLDEN_DIR);
}

function readFixture(file: string): GoldenFixture {
  const url = fixturePath(file);
  if (!fs.existsSync(url) && !RECORD) {
    throw new Error(`Missing golden fixture ${file} — record it with HYPERION_RECORD_GOLDEN=1 node --test test/goldenruns.test.ts`);
  }
  return JSON.parse(fs.readFileSync(url, 'utf8')) as GoldenFixture;
}

function writeFixture(file: string, fixture: Omit<GoldenFixture, 'file'>): void {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  fs.writeFileSync(fixturePath(file), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
}

beforeEach(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

describe('golden runs', () => {
  for (const goldenCase of CASES) {
    it(goldenCase.name, async () => {
      await goldenCase.setup?.();
      const run = harness();
      currentTurns = (RECORD ? goldenCase.script() : readFixture(goldenCase.file).turns)
        .map((turn) => ({ chunks: [...turn.chunks] }));

      const result = await goldenCase.run(run, goldenCase.input);

      const captured = {
        requests: run.requests.map(snapRequest),
        events: normalizeIds(run.events) as unknown[],
        result: resultSnapshot(result),
        artifacts: artifactRows(),
      };

      if (RECORD) {
        writeFixture(goldenCase.file, {
          name: goldenCase.name,
          agent: goldenCase.input.tool,
          input: normalizeIds(goldenCase.input) as Record<string, unknown>,
          turns: goldenCase.script(),
          ...captured,
        });
        console.log(`recorded ${goldenCase.file}`);
        return;
      }

      const fixture = readFixture(goldenCase.file);
      assert.deepEqual(captured.requests, fixture.requests, 'the requests to the provider drifted');
      assert.deepEqual(captured.events, fixture.events, 'the emitted event stream drifted');
      assert.deepEqual(captured.result, fixture.result, 'the run result drifted');
      assert.deepEqual(captured.artifacts, fixture.artifacts, 'the artifact rows drifted');
    });
  }
});
