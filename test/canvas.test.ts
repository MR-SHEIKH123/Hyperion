/** Canvas's read-only Code workspace routes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, beforeEach, describe, it } from 'node:test';

import { cleanupHome, freshDb, testHome } from './helpers.ts';

import type { Server } from 'node:http';

type Worktrees = typeof import('../src/services/code/worktree.ts');

let server: Server;
let base: string;
let worktrees: Worktrees;
const projectsRoot = path.join(testHome, 'projects');
let sequence = 0;

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const gitOnly = hasGit ? {} : { skip: 'git is not installed' };
const symlinkOnly = process.platform === 'win32' ? { skip: 'symlink fixture needs POSIX permissions' } : {};

function git(args: string[], cwd: string): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=Canvas Test', '-c', 'user.email=canvas@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'git failed');
  return (result.stdout ?? '').trim();
}

function project(prefix: string): string {
  const dir = path.join(projectsRoot, `${prefix}-${++sequence}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function directTask(prefix = 'direct'): Promise<{ taskId: string; dir: string }> {
  const taskId = `${prefix}-${sequence + 1}`;
  const dir = project(prefix);
  const worktree = await worktrees.provisionWorktree(taskId, dir);
  assert.equal(worktree.mode, 'direct');
  return { taskId, dir };
}

async function gitTask(prefix = 'git'): Promise<{ taskId: string; dir: string; repo: string }> {
  const repo = project(prefix);
  git(['init', '-b', 'main'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# base\n');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'base'], repo);
  const taskId = `${prefix}-task-${sequence}`;
  const worktree = await worktrees.provisionWorktree(taskId, repo);
  assert.equal(worktree.mode, 'worktree');
  return { taskId, dir: worktree.dir, repo };
}

async function json(pathname: string): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${base}${pathname}`);
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text), text };
}

before(async () => {
  await freshDb();
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
  if (address === null || typeof address === 'string') throw new Error('expected TCP address');
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => worktrees.resetWorktrees());

after(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  await cleanupHome();
});

describe('Canvas files', () => {
  it('answers every route for an unknown task with not_found', async () => {
    for (const suffix of ['files', 'file?path=a.txt', 'diff']) {
      const result = await json(`/api/code/tasks/not-registered/${suffix}`);
      assert.equal(result.status, 404, suffix);
      assert.equal(result.body.error.code, 'not_found', suffix);
    }
  });

  it('lists breadth-first with stable relative paths and sizes', async () => {
    const task = await directTask('tree');
    fs.mkdirSync(path.join(task.dir, 'a', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(task.dir, 'b'), { recursive: true });
    fs.writeFileSync(path.join(task.dir, 'root.txt'), 'root');
    fs.writeFileSync(path.join(task.dir, 'a', 'inside.txt'), 'inside');
    fs.writeFileSync(path.join(task.dir, 'a', 'deep', 'last.txt'), 'last');

    const result = await json(`/api/code/tasks/${task.taskId}/files`);
    assert.equal(result.status, 200);
    assert.equal(result.body.taskId, task.taskId);
    assert.equal(result.body.mode, 'direct');
    assert.equal(result.body.root, '.');
    assert.equal(result.body.truncated, false);
    assert.deepEqual(result.body.entries.map((entry: { path: string }) => entry.path), [
      'a', 'b', 'root.txt', 'a/deep', 'a/inside.txt', 'a/deep/last.txt',
    ]);
    assert.equal(result.body.entries.find((entry: { path: string }) => entry.path === 'root.txt').bytes, 4);
  });

  it('?path narrows the listing to one subtree', async () => {
    const task = await directTask('subtree');
    fs.mkdirSync(path.join(task.dir, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(task.dir, 'outside.txt'), 'no');
    fs.writeFileSync(path.join(task.dir, 'src', 'inside.txt'), 'yes');

    const result = await json(`/api/code/tasks/${task.taskId}/files?path=src`);
    assert.equal(result.body.root, 'src');
    assert.deepEqual(result.body.entries.map((entry: { path: string }) => entry.path), [
      'src/inside.txt', 'src/nested',
    ]);
  });

  it('reads UTF-8 content with its SHA-256 and byte count', async () => {
    const task = await directTask('read');
    const content = 'hello, Canvas 🌌\n';
    fs.writeFileSync(path.join(task.dir, 'note.txt'), content);
    const result = await json(`/api/code/tasks/${task.taskId}/file?path=note.txt`);
    assert.equal(result.status, 200);
    assert.equal(result.body.path, 'note.txt');
    assert.equal(result.body.content, content);
    assert.equal(result.body.bytes, Buffer.byteLength(content));
    assert.equal(result.body.sha256, createHash('sha256').update(content).digest('hex'));
  });

  it('rejects a missing, blank, or repeated path query instead of choosing one', async () => {
    const task = await directTask('query');
    for (const suffix of ['file', 'file?path=', 'file?path=a&path=b', 'files?path=a&path=b']) {
      const result = await json(`/api/code/tasks/${task.taskId}/${suffix}`);
      assert.equal(result.status, 400, suffix);
      assert.equal(result.body.error.code, 'bad_request', suffix);
      assert.equal(result.body.error.details.field, 'path', suffix);
    }
  });

  it('refuses traversal outside the task subtree', async () => {
    const task = await directTask('traversal');
    const result = await json(`/api/code/tasks/${task.taskId}/file?path=${encodeURIComponent('../secret.txt')}`);
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'scope_violation');
  });

  it('refuses a symlink escape and omits symlinks from a listing', symlinkOnly, async () => {
    const task = await directTask('symlink');
    const outside = project('outside');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(outside, path.join(task.dir, 'escape'), 'dir');

    const read = await json(`/api/code/tasks/${task.taskId}/file?path=escape%2Fsecret.txt`);
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'scope_violation');
    const tree = await json(`/api/code/tasks/${task.taskId}/files`);
    assert.equal(tree.body.entries.some((entry: { name: string }) => entry.name === 'escape'), false);
  });

  it('refuses .git by spelling while leaving ordinary git-prefixed files accessible', async () => {
    const task = await directTask('git-spelling');
    fs.mkdirSync(path.join(task.dir, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(task.dir, '.git', 'config'), '[core]\n');
    fs.writeFileSync(path.join(task.dir, '.gitignore'), 'node_modules\n');
    fs.mkdirSync(path.join(task.dir, '.github'), { recursive: true });
    fs.writeFileSync(path.join(task.dir, '.github', 'README.md'), 'fine');

    for (const candidate of ['.git/config', '.GIT/config', '.git./config', 'sub/../.git/hooks/post-checkout']) {
      const result = await json(`/api/code/tasks/${task.taskId}/file?path=${encodeURIComponent(candidate)}`);
      assert.equal(result.status, 403, candidate);
      assert.equal(result.body.error.code, 'scope_violation', candidate);
    }
    assert.equal((await json(`/api/code/tasks/${task.taskId}/file?path=.gitignore`)).status, 200);
    assert.equal((await json(`/api/code/tasks/${task.taskId}/file?path=.github%2FREADME.md`)).status, 200);
  });

  it('also refuses a resolver whose canonical answer reaches .git', async () => {
    const { resolveCodePath } = await import('../src/services/code/files.ts');
    const root = project('resolved-git');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    assert.throws(
      () => resolveCodePath('alias', {
        taskId: 'resolved-check',
        resolvePath: (candidate) => candidate === '.' ? root : path.join(root, '.git', 'config'),
      }),
      (error: unknown) => (error as { code?: string }).code === 'scope_violation',
    );
  });

  it('returns 403 rather than ENOTDIR/500 for .git in a linked worktree', gitOnly, async () => {
    const task = await gitTask('git-file');
    assert.equal(fs.statSync(path.join(task.dir, '.git')).isFile(), true);
    const result = await json(`/api/code/tasks/${task.taskId}/file?path=.git%2Fhooks%2Fpost-checkout`);
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'scope_violation');
    assert.equal(result.text.includes(task.dir), false);
  });

  it('never lists .git in either direct or worktree mode', gitOnly, async () => {
    const direct = await directTask('git-list-direct');
    fs.mkdirSync(path.join(direct.dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(direct.dir, '.git', 'config'), 'x');
    let tree = await json(`/api/code/tasks/${direct.taskId}/files`);
    assert.equal(tree.body.entries.some((entry: { name: string }) => entry.name === '.git'), false);

    worktrees.resetWorktrees();
    const linked = await gitTask('git-list-linked');
    tree = await json(`/api/code/tasks/${linked.taskId}/files`);
    assert.equal(tree.body.entries.some((entry: { name: string }) => entry.name === '.git'), false);
  });

  it('reports intentionally skipped dependency/build directories', async () => {
    const task = await directTask('skips');
    for (const name of ['node_modules', '.next', 'dist', 'build', '.venv', '__pycache__']) {
      fs.mkdirSync(path.join(task.dir, name), { recursive: true });
      fs.writeFileSync(path.join(task.dir, name, 'hidden.txt'), 'not listed');
    }
    fs.writeFileSync(path.join(task.dir, 'shown.txt'), 'shown');
    const result = await json(`/api/code/tasks/${task.taskId}/files`);
    assert.equal(result.body.truncated, false);
    assert.deepEqual(result.body.skipped, ['.next', '.venv', '__pycache__', 'build', 'dist', 'node_modules']);
    assert.equal(result.body.entries.filter((entry: { skipped?: boolean }) => entry.skipped).length, 6);
    assert.equal(result.body.entries.some((entry: { path: string }) => entry.path.endsWith('hidden.txt')), false);
  });

  it('marks a depth-limited directory as skipped and the listing truncated', async () => {
    const task = await directTask('depth');
    let current = task.dir;
    for (let index = 1; index <= 13; index += 1) {
      current = path.join(current, `d${String(index).padStart(2, '0')}`);
      fs.mkdirSync(current);
    }
    fs.writeFileSync(path.join(current, 'too-deep.txt'), 'hidden');
    const result = await json(`/api/code/tasks/${task.taskId}/files`);
    assert.equal(result.body.truncated, true);
    assert.equal(result.body.skipped.length, 1);
    assert.equal(result.body.entries.at(-1).skipped, true);
    assert.equal(result.body.entries.some((entry: { name: string }) => entry.name === 'too-deep.txt'), false);
  });

  it('caps the listing at 2,000 entries and reports truncation', async () => {
    const task = await directTask('cap');
    for (let index = 0; index < 2_005; index += 1) {
      fs.writeFileSync(path.join(task.dir, `f-${String(index).padStart(4, '0')}.txt`), 'x');
    }
    const result = await json(`/api/code/tasks/${task.taskId}/files`);
    assert.equal(result.body.entries.length, 2_000);
    assert.equal(result.body.truncated, true);
    assert.ok(result.body.skipped.length > 0);
  });

  it('refuses an oversized viewer file and reports its size', async () => {
    const task = await directTask('large');
    const bytes = 2 * 1024 * 1024 + 1;
    fs.writeFileSync(path.join(task.dir, 'large.txt'), Buffer.alloc(bytes, 0x61));
    const result = await json(`/api/code/tasks/${task.taskId}/file?path=large.txt`);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'bad_request');
    assert.equal(result.body.error.details.bytes, bytes);
    assert.match(result.body.error.message, new RegExp(String(bytes)));
  });
});

describe('Canvas diff', () => {
  it('returns the base commit and the exporter patch', gitOnly, async () => {
    const task = await gitTask('diff');
    fs.writeFileSync(path.join(task.dir, 'README.md'), '# changed\n');
    const result = await json(`/api/code/tasks/${task.taskId}/diff`);
    assert.equal(result.status, 200);
    assert.equal(result.body.taskId, task.taskId);
    assert.equal(result.body.baseCommit, git(['rev-parse', 'HEAD'], task.repo));
    assert.match(result.body.patch, /diff --git a\/README\.md b\/README\.md/);
    assert.match(result.body.patch, /^\+# changed$/m);
  });

  it('reuses the exporter direct-mode 400 without pretending the patch is empty', async () => {
    const task = await directTask('direct-diff');
    const canvas = await json(`/api/code/tasks/${task.taskId}/diff`);
    const exported = await json(`/api/code/tasks/${task.taskId}/export`);
    assert.equal(canvas.status, 400);
    assert.deepEqual(canvas.body, exported.body);
    assert.equal(canvas.body.error.details.mode, 'direct');
  });
});
