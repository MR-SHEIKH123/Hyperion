/**
 * The Code Canvas — a task's file tree, one file, and its diff.
 *
 * Driven over real HTTP against the real app, because the things worth
 * asserting here are the ones a service-level call cannot see: the status code
 * and `code` a client branches on, the `details` a refusal carries, and that the
 * path on the wire went through the same seam the agent's reads do.
 *
 * The fixtures are real directories registered as real tasks. Most of them need
 * no git at all — provisioning degrades to `mode: 'direct'` for a directory that
 * is not a repository, which is the same shape a machine without git produces —
 * and the two cases that *are* about git (the diff, and a worktree-mode task)
 * carry a `gitOnly` skip.
 *
 * Nothing here starts the preview listener: the mint route is refused while
 * nothing is listening, and the listener's own behaviour belongs to
 * `canvaspreview.test.ts`.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

const projectsRoot = path.join(testHome, 'projects');

/** git is present on this machine or it is not, and both are legitimate. */
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

interface ApiResponse {
  status: number;
  body: string;
}

async function api(method: string, route: string): Promise<ApiResponse> {
  const response = await fetch(`${base}${route}`, { method });
  return { status: response.status, body: await response.text() };
}

function json<T>(response: ApiResponse): T {
  return JSON.parse(response.body) as T;
}

function errorOf(response: ApiResponse): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  return json<{ error: { code: string; message: string; details?: Record<string, unknown> } }>(
    response,
  ).error;
}

/**
 * A workspace directory registered as a task.
 *
 * `provisionWorktree` gives a non-repository directory `mode: 'direct'` with a
 * reason, which is exactly what a machine with no git produces — so most of this
 * suite runs on any machine, git or not.
 */
async function workspace(taskId: string, name = taskId): Promise<string> {
  const dir = path.join(projectsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const worktree = await worktrees.provisionWorktree(taskId, dir);
  return worktree.dir;
}

function write(root: string, relative: string, content: string | Buffer): string {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return absolute;
}

before(async () => {
  await freshDb();

  const { ensureDirectories } = await import('../src/config/env.ts');
  ensureDirectories();

  // Same reasoning as exports.test.ts: pin git at configuration files that do
  // not exist, so a developer's global config cannot change the answer.
  const absent = path.join(testHome, 'absent-gitconfig');
  process.env.GIT_CONFIG_GLOBAL = absent;
  process.env.GIT_CONFIG_SYSTEM = absent;

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
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  await cleanupHome();
});

beforeEach(() => {
  // The registry is in-memory and per-process, so each test provisions the task
  // it needs and starts from an empty one.
  worktrees.resetWorktrees();
});

// ---------------------------------------------------------------------------

describe('GET /api/code/tasks/:taskId/files', () => {
  it('lists the workspace breadth-first, with directories and sizes', async () => {
    const root = await workspace('tree-task');
    write(root, 'a.txt', 'alpha\n');
    write(root, 'dir/b.txt', 'bee\n');
    write(root, 'dir/nested/c.txt', 'see\n');

    const response = await api('GET', '/api/code/tasks/tree-task/files');
    assert.equal(response.status, 200);

    const tree = json<{
      taskId: string;
      mode: string;
      root: string;
      entries: { path: string; name: string; type: string; bytes: number | null }[];
      truncated: boolean;
      skipped: string[];
    }>(response);

    assert.equal(tree.taskId, 'tree-task');
    assert.equal(tree.mode, 'direct');
    assert.equal(tree.root, '.');
    assert.equal(tree.truncated, false);
    assert.deepEqual(tree.skipped, []);

    // Breadth-first: the root's children come before their own children, and
    // within a directory names are ordered. A depth-first walk would spend the
    // whole entry budget on the first branch.
    assert.deepEqual(
      tree.entries.map((entry) => entry.path),
      ['a.txt', 'dir', 'dir/b.txt', 'dir/nested', 'dir/nested/c.txt'],
    );
    assert.equal(tree.entries[0]?.bytes, 6);
    assert.equal(tree.entries[1]?.type, 'directory');
    assert.equal(tree.entries[1]?.bytes, null);
  });

  it('narrows to a subtree with ?path=, keeping workspace-relative names', async () => {
    const root = await workspace('subtree-task');
    write(root, 'top.txt', 'top\n');
    write(root, 'dir/b.txt', 'bee\n');
    write(root, 'dir/nested/c.txt', 'see\n');

    const tree = json<{ root: string; entries: { path: string }[] }>(
      await api('GET', '/api/code/tasks/subtree-task/files?path=dir'),
    );

    assert.equal(tree.root, 'dir');
    // Still named from the workspace root, so an entry can be handed straight
    // back to the file route.
    assert.deepEqual(
      tree.entries.map((entry) => entry.path),
      ['dir/b.txt', 'dir/nested', 'dir/nested/c.txt'],
    );
  });

  it('answers an unknown subtree with not_found and a file with bad_request', async () => {
    const root = await workspace('target-task');
    write(root, 'a.txt', 'alpha\n');

    const missing = await api('GET', '/api/code/tasks/target-task/files?path=nope');
    assert.equal(missing.status, 404);
    assert.equal(errorOf(missing).code, 'not_found');
    assert.equal(errorOf(missing).details?.path, 'nope');

    const file = await api('GET', '/api/code/tasks/target-task/files?path=a.txt');
    assert.equal(file.status, 400);
    assert.equal(errorOf(file).code, 'bad_request');
    assert.equal(errorOf(file).details?.path, 'a.txt');
  });

  it('omits .git from the listing and keeps .gitignore, .gitattributes and .github', async () => {
    const root = await workspace('dotgit-task');
    write(root, '.git/config', '[core]\n');
    write(root, '.git/hooks/post-checkout', '#!/bin/sh\n');
    write(root, '.gitignore', 'node_modules\n');
    write(root, '.gitattributes', '* text=auto\n');
    write(root, '.github/workflows/ci.yml', 'on: push\n');

    const tree = json<{ entries: { path: string }[]; skipped: string[] }>(
      await api('GET', '/api/code/tasks/dotgit-task/files'),
    );
    const paths = tree.entries.map((entry) => entry.path);

    // A tree that lists an entry the viewer refuses is a tree offering a 403.
    assert.equal(paths.includes('.git'), false);
    // And nowhere else either. Without the predicate the directory still does
    // not appear in `entries` — descending into it throws and the catch reports
    // it in `skipped` — so a mutation removing the check leaves this test green.
    // `.git` is omitted, not reported as skipped: `skipped` is for content the
    // caller might want (a build directory, an unreadable one), and `.git` is
    // content the caller may never have.
    assert.equal(
      tree.skipped.some((entry) => entry === '.git' || entry.startsWith('.git/')),
      false,
    );
    assert.equal(
      paths.some((entry) => entry === '.git/config' || entry.startsWith('.git/')),
      false,
    );
    assert.ok(paths.includes('.gitignore'));
    assert.ok(paths.includes('.gitattributes'));
    assert.ok(paths.includes('.github/workflows/ci.yml'));
  });

  it('skips the dependency and build directories, and reports them', async () => {
    const root = await workspace('skip-task');
    write(root, 'src/app.ts', 'export const x = 1;\n');
    for (const dir of ['node_modules', '.next', 'dist', 'build', '.venv', '__pycache__']) {
      write(root, `${dir}/inside.js`, 'generated\n');
    }

    const tree = json<{ entries: { path: string }[]; skipped: string[]; truncated: boolean }>(
      await api('GET', '/api/code/tasks/skip-task/files'),
    );

    assert.deepEqual(
      tree.skipped.sort(),
      ['.next', '.venv', '__pycache__', 'build', 'dist', 'node_modules'].sort(),
    );
    assert.equal(tree.truncated, false);
    for (const entry of tree.entries) {
      // The directory itself is not listed either: `skipped` is where it is
      // reported, so an empty `entries` list cannot be mistaken for an empty
      // directory.
      assert.equal(/^(node_modules|\.next|dist|build|\.venv|__pycache__)(\/|$)/.test(entry.path), false);
    }
  });

  it('caps the entry count and says it truncated', async () => {
    const root = await workspace('cap-task');
    for (let index = 0; index < 2005; index += 1) {
      write(root, `f${String(index).padStart(4, '0')}.txt`, 'x');
    }

    const tree = json<{ entries: { name: string }[]; truncated: boolean }>(
      await api('GET', '/api/code/tasks/cap-task/files'),
    );

    assert.equal(tree.entries.length, 2000);
    assert.equal(tree.truncated, true);
    assert.equal(tree.entries[0]?.name, 'f0000.txt');
  });

  it('caps the depth and says it truncated', async () => {
    const root = await workspace('deep-task');
    const deepest = Array.from({ length: 14 }, (_, index) => `d${String(index + 1)}`);
    write(root, `${deepest.join('/')}/leaf.txt`, 'leaf\n');

    const tree = json<{ entries: { path: string }[]; truncated: boolean }>(
      await api('GET', '/api/code/tasks/deep-task/files'),
    );
    const paths = new Set(tree.entries.map((entry) => entry.path));

    assert.ok(paths.has(deepest.slice(0, 12).join('/')), 'entry 12 levels down should be listed');
    assert.equal(paths.has(deepest.slice(0, 13).join('/')), false, 'depth 13 is past MAX_DEPTH');
    assert.equal(tree.truncated, true);
  });

  it('lists symlinks as symlinks and never follows them', async () => {
    const root = await workspace('link-task');
    const outside = path.join(testHome, 'outside-link-target');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET\n');

    fs.symlinkSync(outside, path.join(root, 'linked-dir'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'linked-file.txt'));
    write(root, 'plain.txt', 'plain\n');

    const tree = json<{ entries: { path: string; type: string; bytes: number | null }[] }>(
      await api('GET', '/api/code/tasks/link-task/files'),
    );
    const paths = tree.entries.map((entry) => entry.path);

    assert.deepEqual(paths, ['linked-dir', 'linked-file.txt', 'plain.txt']);
    assert.deepEqual(tree.entries.filter((entry) => entry.type === 'symlink').map((entry) => entry.bytes), [null, null]);
    assert.equal(tree.entries.some((entry) => entry.path.includes('secret.txt')), false);
  });
});

// ---------------------------------------------------------------------------

describe('GET /api/code/tasks/:taskId/file', () => {
  it('serves one file with its sha256 and byte count', async () => {
    const root = await workspace('file-task');
    const content = 'héllo\n';
    write(root, 'note.txt', content);

    const response = await api('GET', '/api/code/tasks/file-task/file?path=note.txt');
    assert.equal(response.status, 200);

    const file = json<{ path: string; content: string; sha256: string; bytes: number }>(response);
    assert.equal(file.path, 'note.txt');
    assert.equal(file.content, content);
    // Byte length, not string length: the é is two bytes in UTF-8.
    assert.equal(file.bytes, Buffer.byteLength(content, 'utf8'));
    assert.equal(file.sha256, createHash('sha256').update(content).digest('hex'));
  });

  it('requires ?path and refuses a repeated key instead of picking one', async () => {
    await workspace('param-task');

    const missing = await api('GET', '/api/code/tasks/param-task/file');
    assert.equal(missing.status, 400);
    assert.equal(errorOf(missing).code, 'bad_request');
    assert.equal(errorOf(missing).details?.field, 'path');

    // `?path=a&path=b` arrives as an array. Taking the first element would read
    // one of the two things the caller asked for and say nothing about it.
    const repeated = await api('GET', '/api/code/tasks/param-task/file?path=a&path=b');
    assert.equal(repeated.status, 400);
    assert.equal(errorOf(repeated).code, 'bad_request');
    assert.equal(errorOf(repeated).details?.field, 'path');
  });

  it('refuses a path that leaves the task workspace', async () => {
    await workspace('traverse-task');
    await workspace('sibling-task', 'sibling');
    fs.writeFileSync(path.join(projectsRoot, 'sibling', 'secret.txt'), 'TOP SECRET\n');

    // Inside the projects scope, outside *this task's* subtree: the check that
    // makes two parallel tasks independent rather than merely both-contained.
    const relative = await api(
      'GET',
      '/api/code/tasks/traverse-task/file?path=../sibling/secret.txt',
    );
    assert.equal(relative.status, 403);
    assert.equal(errorOf(relative).code, 'scope_violation');
    assert.equal(relative.body.includes('TOP SECRET'), false);

    const absolute = await api('GET', '/api/code/tasks/traverse-task/file?path=/etc/passwd');
    assert.equal(absolute.status, 403);
    assert.equal(errorOf(absolute).code, 'scope_violation');
  });

  it('refuses a symlink escape, at the file and through a directory', async () => {
    const root = await workspace('escape-task');
    const outside = path.join(testHome, 'outside-escape-target');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET\n');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    fs.symlinkSync(outside, path.join(root, 'escape-dir'));
    write(root, 'fine.txt', 'fine\n');

    // A symlink as the final component resolves outside and is refused by the
    // boundary revalidation.
    const direct = await api('GET', '/api/code/tasks/escape-task/file?path=escape.txt');
    assert.equal(direct.status, 403);
    assert.equal(errorOf(direct).code, 'scope_violation');
    assert.equal(direct.body.includes('TOP SECRET'), false);

    // A symlink as an intermediate component is refused before resolution can
    // erase the evidence.
    const through = await api('GET', '/api/code/tasks/escape-task/file?path=escape-dir/secret.txt');
    assert.equal(through.status, 403);
    assert.equal(errorOf(through).code, 'scope_violation');
    assert.equal(through.body.includes('TOP SECRET'), false);
  });

  it('answers .git with 403 — by spelling, as a file, and without naming a path', async () => {
    const root = await workspace('gitpath-task');

    // The worktree shape: `.git` is a *file* holding the gitdir pointer. Walking
    // `.git/hooks` with `lstat` raises raw ENOTDIR, which used to escape as a
    // 500 naming an absolute filesystem path.
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /tmp/elsewhere/.git/worktrees/x\n');
    fs.mkdirSync(path.join(root, '.GIT'), { recursive: true });
    fs.writeFileSync(path.join(root, '.GIT', 'config'), '[core]\n');

    for (const candidate of [
      '.git',
      '.git/hooks/post-checkout',
      './.git/config',
      'nested/../.git/config',
      '.git.',
      '.GIT/config',
    ]) {
      const response = await api(
        'GET',
        `/api/code/tasks/gitpath-task/file?path=${encodeURIComponent(candidate)}`,
      );
      assert.equal(response.status, 403, `expected ${candidate} to be a 403, got ${response.status}`);
      assert.equal(errorOf(response).code, 'scope_violation', `for ${candidate}`);
      assert.equal(response.body.includes(testHome), false, `${candidate} leaked a server path`);
    }

    // The ordinary dot-files stay readable.
    write(root, '.gitignore', 'node_modules\n');
    const ignore = await api('GET', '/api/code/tasks/gitpath-task/file?path=.gitignore');
    assert.equal(ignore.status, 200);
  });

  it('refuses binary content rather than mangling it', async () => {
    const root = await workspace('binary-task');
    write(root, 'blob.bin', Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]));

    const response = await api('GET', '/api/code/tasks/binary-task/file?path=blob.bin');
    assert.equal(response.status, 400);
    assert.equal(errorOf(response).code, 'bad_request');
  });

  it('refuses an oversized file with its size, before reading it', async () => {
    const root = await workspace('big-task');
    const bytes = 2 * 1024 * 1024 + 10;
    write(root, 'big.txt', Buffer.alloc(bytes, 0x61));

    const response = await api('GET', '/api/code/tasks/big-task/file?path=big.txt');
    assert.equal(response.status, 400);
    const error = errorOf(response);
    assert.equal(error.code, 'bad_request');
    // The size is in the refusal so the UI can say "2.0 MB, too large to show"
    // without re-statting anything.
    assert.equal(error.details?.bytes, bytes);
    assert.equal(error.details?.limitBytes, 2 * 1024 * 1024);
    assert.match(error.message, /2\.0 MB/);

    // …and the listing still reports it, with its size, rather than hiding it.
    const tree = json<{ entries: { path: string; bytes: number | null }[] }>(
      await api('GET', '/api/code/tasks/big-task/files'),
    );
    assert.equal(tree.entries.find((entry) => entry.path === 'big.txt')?.bytes, bytes);
  });
});

// ---------------------------------------------------------------------------

describe('GET /api/code/tasks/:taskId/diff', () => {
  it('exports a worktree task\u2019s changes with the base commit it diffs against', gitOnly, async () => {
    const repo = path.join(projectsRoot, 'diff-repo');
    fs.mkdirSync(repo, { recursive: true });
    git(['init', '-b', 'main'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'initial'], repo);

    const worktree = await worktrees.provisionWorktree('diff-task', repo);
    assert.equal(worktree.mode, 'worktree');
    fs.writeFileSync(path.join(worktree.dir, 'README.md'), '# fixture\n\nchanged by the agent\n');

    const response = await api('GET', '/api/code/tasks/diff-task/diff');
    assert.equal(response.status, 200);

    const diff = json<{ taskId: string; baseCommit: string; patch: string }>(response);
    assert.equal(diff.taskId, 'diff-task');
    assert.equal(diff.baseCommit, worktree.baseCommit);
    assert.match(diff.patch, /diff --git a\/README\.md b\/README\.md/);
    assert.match(diff.patch, /^\+changed by the agent$/m);
  });

  it('answers a direct-mode task with the exporter\u2019s reasoned 400', async () => {
    // No git isolation means no base commit, and an empty patch would read as
    // "this task changed nothing" — so the exporter's own refusal is reused,
    // wording and all, rather than a new one being invented here.
    await workspace('direct-diff-task');

    const response = await api('GET', '/api/code/tasks/direct-diff-task/diff');
    assert.equal(response.status, 400);
    const error = errorOf(response);
    assert.equal(error.code, 'bad_request');
    assert.equal(error.details?.mode, 'direct');
    assert.equal(typeof error.details?.reason, 'string');
    assert.match(error.message, /without git isolation/);
  });
});

// ---------------------------------------------------------------------------

describe('unknown tasks', () => {
  it('answer not_found on every canvas route', async () => {
    for (const route of [
      '/api/code/tasks/no-such-task/files',
      '/api/code/tasks/no-such-task/file?path=a.txt',
      '/api/code/tasks/no-such-task/diff',
    ]) {
      const response = await api('GET', route);
      assert.equal(response.status, 404, route);
      assert.equal(errorOf(response).code, 'not_found', route);
    }

    const revoked = await api('DELETE', '/api/code/tasks/no-such-task/preview');
    assert.equal(revoked.status, 404);
    assert.equal(errorOf(revoked).code, 'not_found');
  });
});
