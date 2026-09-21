/**
 * A path is revalidated at the point of use, and never used *through* a symlink.
 *
 * Two failure modes share one symptom — a write that lands where the task was not
 * allowed to write. This file pins both, on the two seams an agent actually
 * reaches: the Code file tools (`writeCodeFile` / `readCodeFile`) and the working
 * directory handed to a command (`containAgentCwd`).
 *
 *  1. **A link inside the workspace, re-pointed later.** `fsScope` canonicalises,
 *     so a link that pointed inward when the path was resolved is followed
 *     silently, and the model chooses when to re-point it. The rule is therefore
 *     "a path may not be used through a symlinked directory at all", which is
 *     checkable before canonicalisation and independent of where the link points.
 *     The first test below is the red check for it: the old behaviour followed the
 *     link and wrote to the real directory, which is a pass-through the model can
 *     re-aim at any time.
 *
 *  2. **An escape.** A link that resolves *outside* the task's subtree was already
 *     refused before this change, by the lexical prefix comparison in
 *     `files.ts::locate`; the tests here keep it refused, because the revalidation
 *     is a second caller-visible decision at the same instant and a rewrite of
 *     that decision is exactly how such a refusal gets lost. What is new is that
 *     the refusal now happens against the *task's own* boundary rather than the
 *     `projects` scope, which is the boundary two parallel tasks actually share.
 *
 * These are real runs against a real filesystem for the first block, and direct
 * calls into the two primitives for the second: the unit block is where the
 * boundary cases live (missing directories, `..`, a symlinked *file*, a sibling
 * whose name merely shares a prefix), and they are cheaper to read as such.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { AgentContext, CompletionRequest, StreamChunk, TaskInput } from '../src/types/core.ts';

const { cleanupHome, freshDb, testHome } = await import('./helpers.ts');
const { runCodeTask } = await import('../src/services/code/agent.ts');
const { writeCodeFile, readCodeFile } = await import('../src/services/code/files.ts');
const { containAgentCwd } = await import('../src/services/code/worktree.ts');
const { resolveInScope } = await import('../src/security/fsScope.ts');
const { assertNoSymlinkedTraversal, assertStillInside } = await import('../src/security/toctou.ts');

before(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

function tokenChunk(text: string): StreamChunk {
  return { type: 'token', text };
}

function toolChunk(id: string, name: string, args: Record<string, unknown>): StreamChunk {
  return { type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } };
}

let counter = 0;

interface RunHarness {
  projectRoot: string;
  outside: string;
  requests: CompletionRequest[];
  run: () => Promise<{ ok: boolean; error?: { code: string; message: string } }>;
}

/**
 * One Code run, with a hook that can touch the filesystem between turns.
 *
 * `beforeTurn(turn)` fires inside the provider stream, after the context exists
 * and before that turn's tool call is executed — the window a real model occupies
 * with `bash`. Both directories exist before the script runs, so the script closes
 * over real paths instead of guessing them.
 */
function harness(
  script: (paths: { projectRoot: string; outside: string }) => { chunks?: StreamChunk[] }[],
  beforeTurn: (turn: number, paths: { projectRoot: string; outside: string }) => void = () => {},
): RunHarness {
  counter += 1;
  const name = `toctou-${counter}`;
  const paths = {
    projectRoot: path.join(testHome, 'projects', name),
    outside: path.join(testHome, 'projects', `${name}-outside`),
  };
  fs.mkdirSync(paths.projectRoot, { recursive: true });
  fs.mkdirSync(paths.outside, { recursive: true });

  const turns = script(paths);
  const rootName = name;
  const resolvePath = (candidate: string): string =>
    path.isAbsolute(candidate)
      ? resolveInScope('projects', candidate)
      : resolveInScope('projects', path.join(rootName, candidate));
  const services = { taskId: `toctou-task-${counter}`, resolvePath };
  const requests: CompletionRequest[] = [];
  let turn = 0;

  const ctx = {
    taskId: services.taskId,
    emit: () => {},
    llm: {
      async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
        requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
        const index = turn;
        turn += 1;
        beforeTurn(index, paths);
        const next = turns.shift() ?? { chunks: [tokenChunk('(no scripted turn left)')] };
        for (const chunk of next.chunks ?? []) yield chunk;
      },
      async complete() {
        return { text: '', usage: { tokensIn: 0, tokensOut: 0 } };
      },
    },
    executeCommand: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    saveArtifactVersion: () => ({ version: 1 }),
    readFile: (candidate: string) => readCodeFile(candidate, services),
    writeFile: (file: { path: string; content: string; expectedSha256: string | null }) =>
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
    chatId: 'chat-toctou',
    modelId: 'model-1',
    prompt: 'Write the file.',
    mode: 'act',
  };

  return {
    ...paths,
    requests,
    run: () => runCodeTask(input, ctx, { dependencies: plainDependencies() }),
  };
}

function plainDependencies() {
  return {
    loadProjectRules: async () => ({ source: 'none' as const, scopeEnforced: false, rules: [] }),
    loadAgentProfile: async () => {
      throw new Error('no project profiles');
    },
    loadProjectProfiles: async () => [],
    loadProjectPermissions: async () => ({}),
    sessionPermissionRules: () => ({}),
  };
}

/** What the model was told after request `index` (0-based): its last tool output. */
function toolOutputAfter(requests: CompletionRequest[], index: number): string {
  const messages = (requests[index]?.messages ?? []) as { role: string; content: string }[];
  const last = messages[messages.length - 1];
  return last?.role === 'tool' ? last.content : '';
}

describe('a model uses a path through a symlink it created itself', () => {
  it('refuses the write into the linked directory, and the real directory stays untouched', async () => {
    // The red check for this change. `docs` is a real directory when the run
    // starts; the model replaces it with a link to `real` (both inside the
    // workspace, so every canonicalising check — scope and task boundary alike —
    // is satisfied by the target) and then writes through the link. Before the
    // traversal check that write succeeded, at `real/notes.md`.
    const run = harness(
      () => [
        { chunks: [toolChunk('w1', 'write', { path: 'docs/notes.md', content: 'notes\n', expectedSha256: null })] },
        { chunks: [tokenChunk('done')] },
      ],
      (turn, paths) => {
        if (turn !== 0) return;
        const docs = path.join(paths.projectRoot, 'docs');
        const real = path.join(paths.projectRoot, 'real');
        fs.mkdirSync(docs, { recursive: true });
        fs.rmSync(docs, { recursive: true, force: true });
        fs.mkdirSync(real, { recursive: true });
        fs.symlinkSync(real, docs);
      },
    );

    const result = await run.run();

    assert.equal(fs.existsSync(path.join(run.projectRoot, 'real', 'notes.md')), false, 'the link must not be traversed');
    assert.equal(result.ok, false, 'and the run stops rather than continuing past a path it could not honour');
    assert.equal(result.error?.code, 'scope_violation');
    assert.match(result.error?.message ?? '', /symbolic link/, 'the refusal names the condition, not "not found"');
  });

  it('accepts the canonical respelling of the same file, so the refusal costs a retry and not the task', async () => {
    // The other side of the rule: refusing the *link* must not refuse the file.
    // A refusal with no way forward is a regression; this is the way forward the
    // refusal message points at ("Name the directory it points at instead.").
    const run = harness(
      () => [
        { chunks: [toolChunk('w1', 'write', { path: 'real/notes.md', content: 'notes\n', expectedSha256: null })] },
        { chunks: [tokenChunk('done')] },
      ],
      (turn, paths) => {
        if (turn !== 0) return;
        const docs = path.join(paths.projectRoot, 'docs');
        const real = path.join(paths.projectRoot, 'real');
        fs.mkdirSync(docs, { recursive: true });
        fs.rmSync(docs, { recursive: true, force: true });
        fs.mkdirSync(real, { recursive: true });
        fs.symlinkSync(real, docs);
      },
    );

    const result = await run.run();

    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(run.projectRoot, 'real', 'notes.md'), 'utf8'), 'notes\n');
    assert.doesNotMatch(toolOutputAfter(run.requests, 1), /^Refused:/, 'and the retry produces no refusal');
  });

  it('keeps refusing a link that points out of the workspace, now against the task boundary', async () => {
    // The escape case, and a regression guard rather than a fix. `resolvePath`
    // canonicalises to the sibling project directory, which is legitimately inside
    // the `projects` *scope*, and the old lexical prefix comparison in `locate`
    // refused it — as `bad_request`, the spelling being what it inspected. The
    // claim here is that the revalidation is an *additional* decision at the same
    // instant and did not replace that one: the write still does not happen, and it
    // is now refused as what it is, a boundary violation naming the boundary.
    const run = harness(
      () => [
        { chunks: [toolChunk('w1', 'write', { path: 'src/out.ts', content: 'export {};\n', expectedSha256: null })] },
        { chunks: [tokenChunk('done')] },
      ],
      (turn, paths) => {
        if (turn !== 0) return;
        const src = path.join(paths.projectRoot, 'src');
        fs.mkdirSync(src, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
        fs.symlinkSync(paths.outside, src);
      },
    );

    const result = await run.run();

    assert.equal(fs.existsSync(path.join(run.outside, 'out.ts')), false, 'nothing may land outside the workspace');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'scope_violation');
  });

  it('writes through an ordinary directory, creating the ones that do not exist', async () => {
    // The no-collateral-damage case: the common write must be untouched by any of
    // the above, including the first write into a directory that does not exist.
    const run = harness(() => [
      {
        chunks: [
          toolChunk('w1', 'write', { path: 'src/new/deep/out.ts', content: 'export {};\n', expectedSha256: null }),
        ],
      },
      { chunks: [tokenChunk('done')] },
    ]);

    const result = await run.run();

    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(run.projectRoot, 'src', 'new', 'deep', 'out.ts'), 'utf8'), 'export {};\n');
    assert.match(toolOutputAfter(run.requests, 1), /src\/new\/deep\/out\.ts/, 'and the model is told what was written');
  });
});

describe('the working directory handed to a command', () => {
  it('refuses a directory reached through a symlink, and resolves an ordinary one', () => {
    const name = `toctou-cwd-${(counter += 1)}`;
    const root = path.join(testHome, 'projects', name);
    const real = path.join(root, 'real');
    const outside = path.join(testHome, 'projects', `${name}-outside`);
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'up'));
    fs.symlinkSync(real, path.join(root, 'in'));
    fs.mkdirSync(path.join(root, 'plain'), { recursive: true });

    assert.equal(containAgentCwd(name), root, 'the project directory itself resolves to itself');
    assert.equal(containAgentCwd(path.join(name, 'real')), real);
    assert.equal(containAgentCwd(path.join(name, 'plain')), path.join(root, 'plain'));

    // A link *at* the directory being named is canonicalised, not refused: it is
    // the target, and the policy this file states is about the components on the
    // way to it. The cwd it resolves to is still checked against the boundary, so
    // an outward link to somewhere out of scope is caught by `resolveInScope` and
    // one to a sibling project is allowed — the fallback boundary here is the
    // `projects` scope, because there is no task to be narrower than.
    assert.equal(containAgentCwd(path.join(name, 'in')), real);

    // The case the rule exists for: a link *on the way*.
    assert.throws(() => containAgentCwd(path.join(name, 'up', 'nested')), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'scope_violation');
      assert.equal((error as { details?: { reason?: string } }).details?.reason, 'intermediate_symlink');
      assert.match((error as Error).message, /Name the directory it points at instead/);
      return true;
    });
  });
});

describe('the two checks themselves', () => {
  const base = path.join(testHome, 'toctou-unit');

  function boundary(name: string): string {
    const root = path.join(base, name);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  it('walks only what exists, and stops at the first missing component', () => {
    const root = boundary('missing');
    // Nothing exists yet: the walk ends, and containment still has an answer
    // because `pathContains` tolerates a missing tail.
    assert.doesNotThrow(() => assertNoSymlinkedTraversal(root, 'a/b/c.txt'));
    assert.equal(assertStillInside(root, path.join(root, 'a', 'b', 'c.txt')), path.join(root, 'a', 'b', 'c.txt'));
  });

  it('leaves `..` and out-of-boundary spellings to the containment check', () => {
    const root = boundary('outside');
    // The walk cannot say anything useful about a path that leaves the boundary
    // lexically, so it does not pretend to; `assertStillInside` is the refusal.
    assert.doesNotThrow(() => assertNoSymlinkedTraversal(root, '../elsewhere/x.txt'));
    assert.throws(() => assertStillInside(root, path.resolve(root, '..', 'elsewhere', 'x.txt')), /resolves outside/);
  });

  it('does not refuse a symlinked *file*, only a symlinked directory on the way to it', () => {
    const root = boundary('file-link');
    fs.writeFileSync(path.join(root, 'real.txt'), 'in\n');
    fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'alias.txt'));
    assert.doesNotThrow(() => assertNoSymlinkedTraversal(root, 'alias.txt'));
    assert.equal(assertStillInside(root, path.join(root, 'alias.txt')), path.join(root, 'alias.txt'));
  });

  it('refuses a *file* link that points outside, where containment can see it', () => {
    const root = boundary('file-escape');
    const elsewhere = boundary('file-escape-outside');
    fs.writeFileSync(path.join(elsewhere, 'secret.txt'), 'secret\n');
    const escape = path.join(root, 'escape.txt');
    fs.symlinkSync(path.join(elsewhere, 'secret.txt'), escape);
    assert.doesNotThrow(() => assertNoSymlinkedTraversal(root, 'escape.txt'));
    assert.throws(() => assertStillInside(root, escape), /resolves outside/);
  });

  it('refuses a directory link even when it points back inside the boundary', () => {
    const root = boundary('inward');
    fs.mkdirSync(path.join(root, 'real'), { recursive: true });
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    // Containment alone allows this. The refusal is a policy about traversal, and
    // this assertion is what keeps it from being quietly relaxed to containment.
    assert.throws(() => assertNoSymlinkedTraversal(root, 'link/file.txt'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'scope_violation');
      assert.equal((error as { details?: { reason?: string } }).details?.reason, 'intermediate_symlink');
      return true;
    });
  });

  it('does not mistake a sibling sharing a name prefix for a child', () => {
    const root = boundary('prefix');
    assert.throws(() => assertStillInside(root, `${root}-sibling/x.txt`), /resolves outside/);
  });
});
