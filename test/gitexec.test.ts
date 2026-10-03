/**
 * git configuration must not be an execution primitive.
 *
 * Hyperion runs git against repositories an agent has been editing. Several
 * git features are configured *commands* — `diff.<driver>.textconv`,
 * `diff.<driver>.command`, `filter.<driver>.clean` (on a diff),
 * `filter.<driver>.smudge` (on the checkout inside `git worktree add`),
 * `core.fsmonitor`, and the `post-checkout` hook — and git executes them as
 * Hyperion, at a moment when nothing is asking anybody to approve anything.
 *
 * This suite is the canary described in the Canvas brief, applied to the git
 * spawns that already exist. A repository is built whose config points all of
 * those at a script that writes a marker file; the real routes and services
 * are then driven, and the marker must never appear.
 *
 * **The first test proves the canary can fire.** A canary that cannot sing is
 * a test that passes because the fixture is broken, which is the failure mode
 * these are most prone to — so the unhardened commands are run against the
 * same fixture first, and the marker is asserted to appear. Only then does
 * "no marker" mean anything.
 *
 * Real git, real worktrees, real routes. A stub would assert our idea of what
 * git does with a config file, which is precisely the thing that was wrong —
 * this suite is how the smudge-on-checkout lever was found at all, and how an
 * earlier reading ("`--no-ext-diff` blocks the clean filter") was caught as
 * wrong: it does not, and `git --no-ext-diff diff` merely exits 129.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { after, before, beforeEach, describe } from 'node:test';

import { cleanupHome, freshDb, testHome } from './helpers.ts';

type WorktreeModule = typeof import('../src/services/code/worktree.ts');
type ExportModule = typeof import('../src/services/export/index.ts');
type FilesModule = typeof import('../src/services/code/files.ts');
type CanvasModule = typeof import('../src/services/code/canvas.ts');

let worktrees: WorktreeModule;
let exports_: ExportModule;
let files: FilesModule;
let canvas: CanvasModule;

const projectsRoot = path.join(testHome, 'projects');
const marker = path.join(testHome, 'PAYLOAD-RAN');
const payload = path.join(testHome, 'payload.sh');

/** git is present on this machine or it is not; both are legitimate. */
const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
// The payload is a shell script, so POSIX only. On Windows the same config
// lever exists but needs a .cmd, and skipping is honest.
const canRun = hasGit && process.platform !== 'win32';
const gitOnly = canRun ? {} : { skip: 'needs git on a POSIX machine' };

function git(args: string[], cwd: string): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout ?? '').trim();
}

function fired(): boolean {
  return fs.existsSync(marker);
}

/**
 * A repository whose configuration executes `payload` through every lever git
 * offers. Written with plain file writes, never `git config`, because that is
 * the point: no shell, approved or otherwise, is involved in arming this.
 */
function hostileRepo(name: string): string {
  const dir = path.join(projectsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-b', 'main'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'original\n');
  // Committed, so every worktree created from this repo carries it: the diff
  // and filter drivers are selected by .gitattributes, and an uncommitted one
  // would arm the project directory only.
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt diff=evil filter=evil\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);

  fs.appendFileSync(
    path.join(dir, '.git', 'config'),
    [
      '',
      '[diff "evil"]',
      `\ttextconv = ${payload}`,
      `\tcommand = ${payload}`,
      '[filter "evil"]',
      `\tclean = ${payload}`,
      `\tsmudge = ${payload}`,
      '[core]',
      `\tfsmonitor = ${payload}`,
      '',
    ].join('\n'),
  );
  const hooks = path.join(dir, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\nexec ${payload}\n`, { mode: 0o755 });

  // The file must differ from the index for a clean filter to be invoked.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed by the task\n');
  return dir;
}

before(async () => {
  await freshDb();
  const { ensureDirectories } = await import('../src/config/env.ts');
  ensureDirectories();

  // Same reasoning as exports.test.ts: pin git at config files that do not
  // exist, so a developer's global config cannot change the answer.
  const absent = path.join(testHome, 'absent-gitconfig');
  process.env.GIT_CONFIG_GLOBAL = absent;
  process.env.GIT_CONFIG_SYSTEM = absent;

  fs.writeFileSync(payload, `#!/bin/sh\necho ran >> ${marker}\ncat "$1" 2>/dev/null\nexit 0\n`, {
    mode: 0o755,
  });

  worktrees = await import('../src/services/code/worktree.ts');
  exports_ = await import('../src/services/export/index.ts');
  files = await import('../src/services/code/files.ts');
  canvas = await import('../src/services/code/canvas.ts');
});

beforeEach(() => {
  fs.rmSync(marker, { force: true });
});

after(async () => {
  await cleanupHome();
});

describe('the canary itself', () => {
  test('an unhardened git diff and status DO execute the configured commands', gitOnly, () => {
    // Without this, every assertion below could be passing because the fixture
    // never armed anything.
    const repo = hostileRepo('canary-control');
    const base = git(['rev-parse', 'HEAD'], repo);

    spawnSync('git', ['diff', base], { cwd: repo, windowsHide: true });
    assert.ok(fired(), 'expected a plain `git diff` to run textconv/ext-diff/clean filter');

    fs.rmSync(marker, { force: true });
    spawnSync('git', ['status', '--porcelain'], { cwd: repo, windowsHide: true });
    assert.ok(fired(), 'expected a plain `git status` to run core.fsmonitor');

    fs.rmSync(marker, { force: true });
    spawnSync('git', ['worktree', 'add', '--detach', path.join(repo, '..', 'canary-wt'), base], {
      cwd: repo,
      windowsHide: true,
    });
    assert.ok(fired(), 'expected `git worktree add` to run the post-checkout hook');
  });
});

describe('Hyperion\u2019s own git invocations', () => {
  test('provisioning a worktree runs no configured command', gitOnly, async () => {
    const repo = hostileRepo('canary-provision');
    const worktree = await worktrees.provisionWorktree('canary-task-1', repo);
    assert.equal(worktree.mode, 'worktree');
    assert.ok(!fired(), 'a configured hook or fsmonitor ran during provisioning');
  });

  test('exporting a task\u2019s patch runs no configured command', gitOnly, async () => {
    // The worktree shares the hostile repo's config through the common gitdir
    // and carries the committed .gitattributes, so this is the real scenario:
    // an agent edited a file, and the export route now diffs it.
    const worktree = worktrees.getWorktree('canary-task-1');
    assert.ok(worktree !== undefined);
    fs.writeFileSync(path.join(worktree.dir, 'a.txt'), 'edited by the agent\n');

    // Control, in the exact directory the route will run in: a plain diff here
    // fires. Without this the assertion below could pass on a limp fixture.
    spawnSync('git', ['diff', worktree.baseCommit ?? 'HEAD'], {
      cwd: worktree.dir,
      windowsHide: true,
    });
    assert.ok(fired(), 'the fixture did not arm the worktree');
    fs.rmSync(marker, { force: true });

    const exported = await exports_.exportCodeTask('canary-task-1');
    // Still a real diff — hardening must not silently empty it.
    assert.match(exported.content, /a\.txt/);
    assert.ok(!fired(), 'git diff executed a textconv, external diff or clean filter');
  });

  test('Canvas diff delegates to the same hardened exporter', gitOnly, async () => {
    const diff = await canvas.canvasDiff('canary-task-1');
    assert.match(diff.patch, /a\.txt/);
    assert.ok(!fired(), 'Canvas introduced or bypassed the hardened git diff path');
  });

  test('Canvas file reads and listings spawn no git command', gitOnly, async () => {
    const tree = await canvas.listCanvasFiles('canary-task-1');
    assert.ok(tree.entries.some((entry) => entry.path === 'a.txt'));
    const file = await canvas.canvasFile('canary-task-1', 'a.txt');
    assert.match(file.content, /edited by the agent/);
    assert.ok(!fired(), 'a read-only Canvas filesystem operation spawned git');
  });

  test('releasing the worktree runs no configured command', gitOnly, async () => {
    await worktrees.releaseWorktree('canary-task-1');
    assert.ok(!fired(), 'git status executed core.fsmonitor during release');
  });

  test('the orphan scan \u2014 which runs at boot, unattended \u2014 runs no configured command', gitOnly, async () => {
    const repo = hostileRepo('canary-orphan');
    await worktrees.provisionWorktree('canary-task-2', repo);
    fs.rmSync(marker, { force: true });
    await worktrees.scanOrphanedWorktrees();
    assert.ok(!fired(), 'the orphan scan executed a configured command');
    await worktrees.releaseWorktree('canary-task-2');
  });
});

describe('the write path that arms it', () => {
  const services = (taskId: string, root: string) => ({
    taskId,
    resolvePath: (candidate: string) => path.resolve(root, candidate),
  });

  // No git needed here: this is path logic, and it should hold on Windows too
  // — which is the platform the trailing-dot spellings below exist for.
  test('a Code file write cannot reach into .git', async () => {
    const repo = path.join(projectsRoot, 'write-target');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

    for (const candidate of [
      '.git/config',
      '.git/hooks/post-checkout',
      './.git/config',
      'sub/../.git/config',
      '.GIT/config',
      '.git.',
      '.git',
      'nested/.git/config',
    ]) {
      await assert.rejects(
        () =>
          files.writeCodeFile(
            { path: candidate, content: 'owned', expectedSha256: null },
            services('write-task', repo),
          ),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'scope_violation');
          return true;
        },
        `expected ${candidate} to be refused`,
      );
    }
  });

  test('reading through the same seam is refused too', async () => {
    const repo = path.join(projectsRoot, 'write-target');
    fs.writeFileSync(path.join(repo, '.git', 'config'), '[core]\n');
    await assert.rejects(
      () => files.readCodeFile('.git/config', services('write-task', repo)),
      (error: unknown) => (error as { code?: string }).code === 'scope_violation',
    );
  });

  test('ordinary dot-files that merely start with .git stay writable', async () => {
    const repo = path.join(projectsRoot, 'write-target');
    for (const candidate of ['.gitignore', '.gitattributes', '.github/workflows/ci.yml']) {
      const written = await files.writeCodeFile(
        { path: candidate, content: 'fine\n', expectedSha256: null },
        services('write-task', repo),
      );
      assert.equal(written.path, candidate.replace(/^\.\//, ''));
    }
  });
});
