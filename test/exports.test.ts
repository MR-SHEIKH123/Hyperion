/**
 * Per-item export — Prompt 1.18.
 *
 * Three download endpoints, each turning data that already exists into a file:
 *   - GET /api/chat/:id/export             Markdown by default, ?format=json
 *   - GET /api/artifacts/:id/export        one artifact version
 *   - GET /api/code/tasks/:taskId/export   a code task's changes as a patch
 *
 * Driven over real HTTP because the product of these routes is a *download*:
 * the Content-Type and Content-Disposition headers and the raw body are the
 * feature, and a service-level call asserts none of them. The 404 and 400 paths
 * are only reachable through the router at all.
 *
 * The code-task section provisions a real git worktree rather than faking the
 * registry. Worktrees live in an in-memory Map, not a table, so there is no row
 * to insert; and the export is a `git diff` against the recorded base commit,
 * so a fake worktree would test our idea of git instead of git.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Server } from 'node:http';

import { cleanupHome, freshDb, testHome } from './helpers.ts';

type WorktreeModule = typeof import('../src/services/code/worktree.ts');

let server: Server;
let base: string;
let worktrees: WorktreeModule;

let createChat: typeof import('../src/db/chats.ts').createChat;
let appendMessage: typeof import('../src/db/chats.ts').appendMessage;
let getDb: typeof import('../src/db/adapter.ts').getDb;

const projectsRoot = path.join(testHome, 'projects');

/**
 * git is present on this machine or it is not, and both are legitimate. Probed
 * once: the answer cannot change during a run, and it costs a process spawn.
 */
const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const gitOnly = hasGit ? {} : { skip: 'git is not installed on this machine' };

/** git for the fixtures, with an identity supplied inline so `commit` works. */
function git(args: string[], cwd: string): string {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Hyperion Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout ?? '').trim();
}

/** A repository under the projects root with one commit in it. */
function makeRepo(name: string): string {
  const dir = path.join(projectsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-b', 'main'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'initial'], dir);
  return dir;
}

/**
 * `artifact_versions` has no db module — the orchestrator writes it directly —
 * so the fixture does too.
 */
function insertArtifact(input: {
  artifactKey: string;
  version: number;
  content?: string;
  relPath?: string;
}): string {
  const id = `artifact-${input.artifactKey.replace(/\W+/g, '-')}-${input.version}`;
  getDb()
    .prepare(
      `INSERT INTO artifact_versions
         (id, artifact_key, tool, version, content, rel_path, label, bytes, sha256, created_at)
       VALUES (?, ?, 'code', ?, ?, ?, NULL, NULL, NULL, ?)`,
    )
    .run(
      id,
      input.artifactKey,
      input.version,
      input.content ?? null,
      input.relPath ?? null,
      Date.now(),
    );
  return id;
}

before(async () => {
  await freshDb();

  const { ensureDirectories } = await import('../src/config/env.ts');
  ensureDirectories();

  // Point git at configuration files that do not exist, so the fixtures behave
  // the same here as on a machine with a heavily customised global config.
  const absent = path.join(testHome, 'absent-gitconfig');
  process.env.GIT_CONFIG_GLOBAL = absent;
  process.env.GIT_CONFIG_SYSTEM = absent;

  ({ createChat, appendMessage } = await import('../src/db/chats.ts'));
  ({ getDb } = await import('../src/db/adapter.ts'));
  worktrees = await import('../src/services/code/worktree.ts');

  const { createApp } = await import('../src/http/app.ts');
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

// ---------------------------------------------------------------------------

describe('chat export', () => {
  function seedChat(title: string): string {
    const chat = createChat({ tool: 'chat', title });
    appendMessage({ chatId: chat.id, role: 'user', content: 'Hello' });
    appendMessage({ chatId: chat.id, role: 'assistant', content: 'Hi there' });
    return chat.id;
  }

  it('defaults to Markdown, as a download, with the transcript in it', async () => {
    const id = seedChat('A  Test Chat');
    const res = await fetch(`${base}/api/chat/${id}/export`);

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/markdown/);
    assert.match(
      res.headers.get('content-disposition') ?? '',
      /^attachment; filename="A-Test-Chat\.md"$/,
    );

    const body = await res.text();
    assert.match(body, /^# A {2}Test Chat/);
    assert.match(body, /## User\n\nHello/);
    assert.match(body, /## Assistant\n\nHi there/);
  });

  it('renders an interrupted turn as nothing rather than an empty heading', async () => {
    const chat = createChat({ tool: 'chat', title: 'Interrupted' });
    appendMessage({ chatId: chat.id, role: 'user', content: 'Are you there' });
    // What a cancelled or failed stream leaves behind: a row with no content.
    appendMessage({ chatId: chat.id, role: 'assistant', content: '' });

    const body = await (await fetch(`${base}/api/chat/${chat.id}/export`)).text();

    assert.match(body, /## User/);
    assert.equal(/## Assistant/.test(body), false, 'a heading with no body reads as a broken export');
  });

  it('returns the structured transcript for ?format=json', async () => {
    const id = seedChat('JSON Chat');
    const res = await fetch(`${base}/api/chat/${id}/export?format=json`);

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
    assert.match(res.headers.get('content-disposition') ?? '', /filename="JSON-Chat\.json"/);

    const parsed = JSON.parse(await res.text()) as {
      chat: { id: string; title: string; tool: string };
      messages: { role: string; content: string }[];
    };
    assert.equal(parsed.chat.id, id);
    assert.equal(parsed.chat.title, 'JSON Chat');
    assert.equal(parsed.chat.tool, 'chat');
    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.messages[0]?.role, 'user');
    assert.equal(parsed.messages[1]?.content, 'Hi there');
  });

  it('answers an unknown chat with 404 rather than an empty transcript', async () => {
    const res = await fetch(`${base}/api/chat/does-not-exist/export`);

    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'not_found');
  });

  it('rejects an unsupported ?format, naming the field', async () => {
    const id = seedChat('Format Chat');
    const res = await fetch(`${base}/api/chat/${id}/export?format=pdf`);

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string; details: { field: string } } };
    assert.equal(body.error.code, 'bad_request');
    assert.equal(body.error.details.field, 'format');
  });
});

// ---------------------------------------------------------------------------

describe('artifact export', () => {
  it('downloads an inline artifact under its key and version', async () => {
    const id = insertArtifact({
      artifactKey: 'src/main.ts',
      version: 3,
      content: 'export const x = 1;',
    });
    const res = await fetch(`${base}/api/artifacts/${id}/export`);

    assert.equal(res.status, 200);
    // res.send(string) appends ; charset=utf-8 to whatever type we set.
    assert.match(res.headers.get('content-type') ?? '', /^application\/octet-stream/);
    assert.match(res.headers.get('content-disposition') ?? '', /filename="src-main-v3\.ts"/);
    assert.equal(await res.text(), 'export const x = 1;');
  });

  it('reads a file-backed artifact from disk instead of returning nothing', async () => {
    // The case that motivated the test: 001_init.sql stores large artifacts by
    // reference with content NULL, so an export that trusted the column alone
    // would hand back an empty file and look like a success.
    fs.mkdirSync(path.join(projectsRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectsRoot, 'src', 'notes.txt'), 'from the working tree');

    const id = insertArtifact({ artifactKey: 'notes.txt', version: 1, relPath: 'src/notes.txt' });
    const res = await fetch(`${base}/api/artifacts/${id}/export`);

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /filename="notes-v1\.txt"/);
    assert.equal(await res.text(), 'from the working tree');
  });

  it('reports a vanished backing file as 404 rather than an empty download', async () => {
    const id = insertArtifact({ artifactKey: 'ghost.txt', version: 1, relPath: 'no/such/file.txt' });
    const res = await fetch(`${base}/api/artifacts/${id}/export`);

    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'not_found');
  });

  it('never lets a stored path leak the server\u2019s filesystem layout', async () => {
    const id = insertArtifact({ artifactKey: 'ghost2.txt', version: 1, relPath: 'no/such/file.txt' });
    const raw = await (await fetch(`${base}/api/artifacts/${id}/export`)).text();

    // The absolute path is privateDetails: diagnosable in the log, not on the wire.
    assert.equal(raw.includes(testHome), false, 'the resolved absolute path must stay server-side');
  });

  it('answers an unknown artifact with 404', async () => {
    const res = await fetch(`${base}/api/artifacts/does-not-exist/export`);

    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'not_found');
  });
});

// ---------------------------------------------------------------------------

describe('code task export', () => {
  beforeEach(() => {
    worktrees.resetWorktrees();
  });

  it('exports the task\u2019s changes as a patch', gitOnly, async () => {
    const repo = makeRepo('export-repo');
    const worktree = await worktrees.provisionWorktree('task-export-1', repo);

    // Uncommitted work counts: the diff is taken against the base commit, so it
    // covers what the agent did whether or not it got around to committing.
    fs.writeFileSync(path.join(worktree.dir, 'README.md'), '# fixture\n\nchanged by the agent\n');

    const res = await fetch(`${base}/api/code/tasks/task-export-1/export`);

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/x-patch/);
    assert.match(res.headers.get('content-disposition') ?? '', /filename="task-export-1\.patch"/);

    const patch = await res.text();
    assert.match(patch, /diff --git a\/README\.md b\/README\.md/);
    assert.match(patch, /^\+changed by the agent$/m);

    await worktrees.releaseWorktree('task-export-1');
  });

  it('answers an unknown task with 404', async () => {
    const res = await fetch(`${base}/api/code/tasks/no-such-task/export`);

    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'not_found');
  });

  it('refuses a task that ran without git isolation, and says why', async () => {
    // No git, or a project that is not a repository, degrades to direct mode.
    // There is genuinely no base commit to diff against, and an empty patch
    // would read as "this task changed nothing" — so it is a 400 with a reason.
    const plain = path.join(projectsRoot, 'not-a-repo');
    fs.mkdirSync(plain, { recursive: true });
    await worktrees.provisionWorktree('task-direct-mode', plain);

    const res = await fetch(`${base}/api/code/tasks/task-direct-mode/export`);

    assert.equal(res.status, 400);
    const body = (await res.json()) as {
      error: { code: string; details: { mode: string; reason: string | null } };
    };
    assert.equal(body.error.code, 'bad_request');
    assert.equal(body.error.details.mode, 'direct');
    assert.equal(typeof body.error.details.reason, 'string');
  });
});
