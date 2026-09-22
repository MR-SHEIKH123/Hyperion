/**
 * A path rule reaches the file the Code tools actually touch.
 *
 * The engine's own tests (`permissions.test.ts`) pin the rule: a subject is
 * canonicalized before it is matched, so every spelling of one file gets one
 * verdict. What they cannot see is the **seam** — `runCodeTask` has to hand the
 * engine the resolver its file tools use, and an adapter that quietly stopped
 * doing that would leave every engine test green while the hole reopened for
 * absolute paths, because a relative pattern cannot match an unrelativized path.
 *
 * So this file drives the real adapter: a real project directory with a real
 * `.hyperion/permissions.json`, the real `resolveInScope` as `ctx.resolvePath`, and
 * the real `writeCodeFile` writing to the real filesystem. The claim under test is
 * the one a user would state — "I told it not to write to `secrets/`, so it did not
 * write to `secrets/`" — and the evidence is that the file is not there afterwards
 * and that the refusal names their rule.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { AgentContext, CompletionRequest, StreamChunk, TaskInput } from '../src/types/core.ts';
import type { CodeDependencies } from '../src/services/code/agent.ts';

const { cleanupHome, freshDb, testHome } = await import('./helpers.ts');
const { runCodeTask } = await import('../src/services/code/agent.ts');
const { writeCodeFile } = await import('../src/services/code/files.ts');
const { loadProjectPermissions } = await import('../src/services/code/projectContext.ts');
const { resolveInScope } = await import('../src/security/fsScope.ts');
const { AppError } = await import('../src/util/errors.ts');

before(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

interface ScriptedTurn {
  chunks?: StreamChunk[];
}

function tokenChunk(text: string): StreamChunk {
  return { type: 'token', text };
}

function toolChunk(id: string, name: string, args: Record<string, unknown>): StreamChunk {
  return { type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } };
}

let counter = 0;

/**
 * One Code run over a real project directory.
 *
 * The turns are scripted from the workspace path, because the strongest case
 * writes an *absolute* path and that path is only known once the harness has made
 * one — which is also the honest shape of the problem: the model may name a file
 * any way it likes, including by absolute path.
 *
 * `requests` is the witness: the loop feeds a refusal back as ordinary tool output,
 * so the next request's message list is where "what the model was told" can be read
 * without a database query.
 */
function harness(
  script: (projectRoot: string) => ScriptedTurn[],
  permissions: string,
): {
  ctx: AgentContext;
  input: TaskInput;
  dependencies: CodeDependencies;
  requests: CompletionRequest[];
  projectRoot: string;
} {
  counter += 1;
  const name = `path-rules-${counter}`;
  const projectRoot = path.join(testHome, 'projects', name);
  fs.mkdirSync(path.join(projectRoot, '.hyperion'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.hyperion', 'permissions.json'), permissions, 'utf8');

  const turns = script(projectRoot);

  // The same containment the file tools run, and the same root: `path.join` here
  // plays the role of the project root the real adapter resolves, so
  // `ctx.resolvePath('.')` is the directory the patterns are authored against.
  // Relative candidates resolve against the project; absolute ones are passed
  // through, exactly as the real `ctx.resolvePath` accepts both.
  const resolvePath = (candidate: string): string =>
    path.isAbsolute(candidate)
      ? resolveInScope('projects', candidate)
      : resolveInScope('projects', path.join(name, candidate));
  const taskId = `path-rule-task-${counter}`;
  const services = { taskId, resolvePath };
  const requests: CompletionRequest[] = [];

  const ctx = {
    taskId,
    emit: () => {},
    llm: {
      async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
        // Snapshot rather than reference: the loop appends to the same array it
        // hands the provider, so a stored reference would describe the end of the
        // run rather than the moment this turn asked for.
        requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
        // An unscripted turn ends the run rather than masking a script bug.
        const turn = turns.shift() ?? { chunks: [tokenChunk('(no scripted turn left)')] };
        for (const chunk of turn.chunks ?? []) yield chunk;
      },
      async complete() {
        return { text: '', usage: { tokensIn: 0, tokensOut: 0 } };
      },
    },
    executeCommand: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    saveArtifactVersion: () => ({ version: 1 }),
    readFile: async () => {
      throw new AppError('not_found', 'this harness does not read');
    },
    writeFile: async (file: { path: string; content: string; expectedSha256: string | null }) =>
      writeCodeFile(file, services),
    restoreArtifactVersion: async () => {
      throw new Error('not used in these tests');
    },
    getSkillsSummary: () => [],
    resolvePath,
    signal: new AbortController().signal,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as AgentContext;

  const input: TaskInput = {
    tool: 'code',
    chatId: 'chat-path-rules',
    modelId: 'model-1',
    prompt: 'Write the file.',
    mode: 'act',
  };

  const dependencies: CodeDependencies = {
    loadProjectRules: async () => ({ source: 'none', scopeEnforced: false, rules: [] }),
    loadAgentProfile: async () => {
      throw new AppError('not_found', 'this harness has no project profiles');
    },
    loadProjectProfiles: async () => [],
    // The real loader, so the file on disk is what governs the run.
    loadProjectPermissions: (projectDir, resolver) => loadProjectPermissions(projectDir, resolver),
    sessionPermissionRules: () => ({}),
  };

  return { ctx, input, dependencies, requests, projectRoot };
}

/** The tool output the model received on the turn after `turn` (0-based). */
function toolOutputAfter(requests: CompletionRequest[], turn: number): string {
  const messages = (requests[turn + 1]?.messages ?? []) as { role: string; content: string }[];
  const last = messages[messages.length - 1];
  return last?.role === 'tool' ? last.content : '';
}

describe('a project rule denying a directory', () => {
  const denySecrets = '{"write":{"secrets/**":"deny","*":"allow"}}';

  it('refuses an absolute path to the denied directory, and nothing lands there', async () => {
    // The absolute spelling is the one that pins the *seam*: a relative
    // respelling is already closed by the engine's lexical pass, but a relative
    // pattern cannot match an absolute argument at all unless the adapter hands the
    // engine the resolver its file tools use. This is the assertion that fails if
    // that wiring is dropped.
    const run = harness(
      (projectRoot) => [
        { chunks: [toolChunk('w1', 'write', { path: './src/ok.ts', content: 'export {};\n', expectedSha256: null })] },
        {
          chunks: [
            toolChunk('w2', 'write', {
              path: path.join(projectRoot, 'secrets', 'key.txt'),
              content: 'PRIVATE\n',
              expectedSha256: null,
            }),
          ],
        },
        { chunks: [tokenChunk('done')] },
      ],
      denySecrets,
    );

    const result = await runCodeTask(run.input, run.ctx, { dependencies: run.dependencies });

    assert.equal(result.ok, true, 'a refusal is a result, not a failed run');
    // The control: the allowed path went through the same adapter, to disk.
    assert.equal(fs.readFileSync(path.join(run.projectRoot, 'src', 'ok.ts'), 'utf8'), 'export {};\n');
    // The claim: the denied directory is untouched, and what refused it was the
    // user's rule — named in the provenance the model was shown.
    assert.equal(fs.existsSync(path.join(run.projectRoot, 'secrets')), false);
    const refusal = toolOutputAfter(run.requests, 1);
    assert.match(refusal, /^Refused:/);
    assert.match(refusal, /project:secrets\/\*\*/, 'the refusal must name the rule that decided, not the catch-all');
  });

  it('still allows an ordinary respelling of an allowed file', async () => {
    // The other half of the contract. Canonicalising a subject must not turn a
    // spelling of an allowed file into a refusal, or the fix would be a regression
    // for every model that writes `./src/x.ts`.
    const run = harness(
      () => [
        { chunks: [toolChunk('w1', 'write', { path: './src/nested/../ok.ts', content: 'ok\n', expectedSha256: null })] },
        { chunks: [tokenChunk('done')] },
      ],
      denySecrets,
    );

    const result = await runCodeTask(run.input, run.ctx, { dependencies: run.dependencies });

    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(run.projectRoot, 'src', 'ok.ts'), 'utf8'), 'ok\n');
  });
});
