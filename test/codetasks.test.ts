/**
 * Code task parallelism: the lane, the worktrees, and the boundary between them.
 *
 * Three separable claims are made by this feature, and each fails in a different
 * way, so each is tested on its own terms:
 *
 *   - **The lane counts.** Two Code tasks may run at once; a third is either
 *     refused with `busy` or parked in FIFO order. This is pure in-process
 *     bookkeeping, so it is tested directly and exhaustively — including the
 *     paths that only happen when a client goes away mid-wait.
 *   - **Worktrees isolate.** Two tasks editing the same repository must not see
 *     each other's files. The interesting assertion is not that task A can reach
 *     its own directory but that it *cannot* reach task B's, even though both sit
 *     in the same filesystem scope. That is the case a plain `resolveInScope`
 *     check would wave through.
 *   - **Cleanup never eats work.** A worktree is scratch space and is removed
 *     when a task ends, but only when removing it provably loses nothing.
 *     Uncommitted changes, or commits worth keeping, must survive.
 *
 * The git-backed sections use real repositories rather than a stubbed git. The
 * whole point of choosing worktrees over copies is how git behaves — which paths
 * it refuses to reuse, when it declines to remove a tree, what `status
 * --porcelain` reports — and a stub would assert our assumptions about git
 * instead of git. They skip cleanly on a machine with no git rather than failing,
 * since falling back to `direct` mode is a supported outcome there, not a bug.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, beforeEach, describe, it } from 'node:test';

import { cleanupHome, testHome } from './helpers.ts';

type LockModule = typeof import('../src/orchestrator/lock.ts');
type WorktreeModule = typeof import('../src/services/code/worktree.ts');
type ScopeModule = typeof import('../src/security/fsScope.ts');

let lock: LockModule;
let worktrees: WorktreeModule;
let scope: ScopeModule;

const projectsRoot = path.join(testHome, 'projects');
const worktreesRoot = path.join(testHome, 'worktrees');

/**
 * git is present on this machine or it is not, and both are legitimate. Probed
 * once: `git --version` costs a process spawn, and the answer cannot change
 * during a test run.
 */
const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const gitOnly = hasGit ? {} : { skip: 'git is not installed on this machine' };

/**
 * Runs a git command for the fixtures, with an identity supplied inline.
 *
 * The identity has to come from somewhere — `git commit` refuses without one —
 * and `-c` is the way to supply it that does not depend on, or write to, the
 * machine's real git configuration.
 */
function git(args: string[], cwd: string): string {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=AIStudio Test',
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
function makeRepo(name: string, files: Record<string, string> = { 'README.md': '# fixture\n' }): string {
  const dir = path.join(projectsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-b', 'main'], dir);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  git(['add', '-A'], dir);
  git(['commit', '-m', 'initial'], dir);
  return dir;
}

function mkdir(...segments: string[]): string {
  const dir = path.join(...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Every assertion about a resolved path has to compare against a real one. */
function real(target: string): string {
  return fs.realpathSync(target);
}

function violates(error: unknown): true {
  assert.equal((error as { code?: string }).code, 'scope_violation');
  return true;
}

function busy(error: unknown): true {
  assert.equal((error as { code?: string }).code, 'busy');
  return true;
}

before(async () => {
  const { ensureDirectories } = await import('../src/config/env.ts');
  ensureDirectories();

  // Point git at configuration files that do not exist, so the fixtures behave
  // the same here as on a machine with a heavily customised global config.
  // A missing config file is an empty one as far as git is concerned.
  const absent = path.join(testHome, 'absent-gitconfig');
  process.env.GIT_CONFIG_GLOBAL = absent;
  process.env.GIT_CONFIG_SYSTEM = absent;

  lock = await import('../src/orchestrator/lock.ts');
  worktrees = await import('../src/services/code/worktree.ts');
  scope = await import('../src/security/fsScope.ts');
});

after(async () => {
  await cleanupHome();
});

// ---------------------------------------------------------------------------

describe('the Code lane', () => {
  beforeEach(() => {
    lock.resetCodeLane(2);
    lock.resetLock();
  });

  it('runs up to the configured number of tasks at once', async () => {
    const first = await lock.acquireCodeLane({ tool: 'code', taskId: 'lane-a' });
    const second = await lock.acquireCodeLane({ tool: 'code', taskId: 'lane-b' });

    const status = lock.codeLaneStatus();
    assert.equal(status.running, 2);
    assert.equal(status.limit, 2);
    assert.equal(status.queued, 0);
    assert.deepEqual(
      status.active.map((slot) => slot.taskId).sort(),
      ['lane-a', 'lane-b'],
      'the task id is what joins a slot to its worktree, so it must be reported',
    );
    assert.equal(lock.codeLaneHasCapacity(), false);

    first.release();
    second.release();
    assert.equal(lock.codeLaneStatus().running, 0);
    assert.equal(lock.codeLaneHasCapacity(), true);
  });

  it('refuses the task that would exceed the limit rather than queueing it', async () => {
    const first = await lock.acquireCodeLane({ tool: 'code' });
    const second = await lock.acquireCodeLane({ tool: 'code' });

    await assert.rejects(lock.acquireCodeLane({ tool: 'code' }), (error: unknown) => {
      busy(error);
      // The numbers travel with the error so the UI can say *why* it is full
      // instead of only that it is.
      assert.deepEqual((error as { details?: unknown }).details, {
        running: 2,
        limit: 2,
        queued: 0,
      });
      return true;
    });

    first.release();
    second.release();
  });

  it('honours a limit of one, for a user who wants Code serialised after all', async () => {
    lock.resetCodeLane(1);
    assert.equal(lock.codeLaneLimit(), 1);

    const only = await lock.acquireCodeLane({ tool: 'code' });
    await assert.rejects(lock.acquireCodeLane({ tool: 'code' }), busy);
    only.release();

    // And the slot is genuinely free again, not merely reported as free.
    const next = await lock.acquireCodeLane({ tool: 'code' });
    next.release();
  });

  it('hands a freed slot to whoever has waited longest', async () => {
    const first = await lock.acquireCodeLane({ tool: 'code' });
    const second = await lock.acquireCodeLane({ tool: 'code' });

    const admitted: string[] = [];
    const third = lock
      .acquireCodeLane({ tool: 'code', mode: 'queue', taskId: 'lane-c' })
      .then((handle) => {
        admitted.push('c');
        return handle;
      });
    const fourth = lock
      .acquireCodeLane({ tool: 'code', mode: 'queue', taskId: 'lane-d' })
      .then((handle) => {
        admitted.push('d');
        return handle;
      });

    assert.equal(lock.codeLaneStatus().queued, 2);

    first.release();
    const handleC = await third;
    assert.deepEqual(admitted, ['c'], 'the earlier waiter goes first');
    assert.equal(lock.codeLaneStatus().queued, 1);

    second.release();
    const handleD = await fourth;
    assert.deepEqual(admitted, ['c', 'd']);

    handleC.release();
    handleD.release();
    assert.equal(lock.codeLaneStatus().running, 0);
  });

  it('does not let a fresh caller jump a queue that is already forming', async () => {
    const first = await lock.acquireCodeLane({ tool: 'code' });
    const second = await lock.acquireCodeLane({ tool: 'code' });
    const queued = lock.acquireCodeLane({ tool: 'code', mode: 'queue', taskId: 'lane-waiting' });

    // A slot is about to be free, but it belongs to the waiter. Someone arriving
    // now in reject mode must be told the lane is full, not handed the slot.
    first.release();
    const handle = await queued;
    await assert.rejects(lock.acquireCodeLane({ tool: 'code' }), busy);

    handle.release();
    second.release();
  });

  it('drops a queued task whose client disconnects, without spending a slot', async () => {
    const first = await lock.acquireCodeLane({ tool: 'code' });
    const second = await lock.acquireCodeLane({ tool: 'code' });

    const controller = new AbortController();
    const queued = lock.acquireCodeLane({
      tool: 'code',
      mode: 'queue',
      signal: controller.signal,
    });

    assert.equal(lock.codeLaneStatus().queued, 1);
    controller.abort();

    await assert.rejects(queued, (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'aborted');
      return true;
    });
    assert.equal(lock.codeLaneStatus().queued, 0);

    // The abandoned waiter must not hold a slot in reserve: releasing now has to
    // leave the lane genuinely empty.
    first.release();
    second.release();
    assert.equal(lock.codeLaneStatus().running, 0);
  });

  it('gives up with busy when the wait outlasts what the client will accept', async () => {
    const first = await lock.acquireCodeLane({ tool: 'code' });
    const second = await lock.acquireCodeLane({ tool: 'code' });

    await assert.rejects(
      lock.acquireCodeLane({ tool: 'code', mode: 'queue', waitMs: 40 }),
      busy,
    );
    assert.equal(lock.codeLaneStatus().queued, 0);

    first.release();
    second.release();
  });

  it('releases the slot however the task ends', async () => {
    await assert.rejects(
      lock.withCodeLane({ tool: 'code', taskId: 'lane-throws' }, async () => {
        throw new Error('the agent blew up');
      }),
      /the agent blew up/,
    );
    assert.equal(
      lock.codeLaneStatus().running,
      0,
      'a thrown task that kept its slot would wedge the lane',
    );
  });

  it('ignores a second release, so a stale handle cannot free somebody else', async () => {
    const handle = await lock.acquireCodeLane({ tool: 'code' });
    handle.release();
    const other = await lock.acquireCodeLane({ tool: 'code' });
    handle.release(); // late, and belongs to a slot that is long gone

    assert.equal(lock.codeLaneStatus().running, 1);
    other.release();
  });

  it('is independent of the app-wide job lock', async () => {
    // This is the whole reason the lane exists: a chat generation in flight must
    // not stand between the user and a Code task, or the other way round.
    const job = await lock.acquire({ tool: 'chat', label: 'chat:1' });
    const slot = await lock.acquireCodeLane({ tool: 'code', taskId: 'lane-parallel' });

    assert.equal(lock.isBusy(), true);
    assert.equal(lock.codeLaneStatus().running, 1);

    slot.release();
    assert.equal(lock.isBusy(), true, 'ending a Code task must not release the global lock');

    job.release();
    assert.equal(lock.codeLaneStatus().running, 0);
  });

  it('reports copies, so a caller cannot edit the lane by editing its status', async () => {
    const slot = await lock.acquireCodeLane({ tool: 'code', taskId: 'lane-frozen' });
    const status = lock.codeLaneStatus();
    const entry = status.active[0];
    assert.ok(entry);
    entry.taskId = 'tampered';

    assert.equal(lock.codeLaneStatus().active[0]?.taskId, 'lane-frozen');
    slot.release();
  });
});

// ---------------------------------------------------------------------------

describe('subtree containment', () => {
  it('accepts a path inside the named subtree and rejects its sibling', () => {
    const taskA = mkdir(worktreesRoot, 'subtree-a');
    const taskB = mkdir(worktreesRoot, 'subtree-b');

    assert.equal(
      scope.resolveInSubtree('worktrees', taskA, path.join(taskA, 'src', 'app.ts')),
      path.join(real(taskA), 'src', 'app.ts'),
    );

    // Both paths are in the `worktrees` scope, so a scope check alone would
    // allow this. Rejecting it is the entire point of the narrower check.
    assert.throws(
      () => scope.resolveInSubtree('worktrees', taskA, path.join(taskB, 'src', 'app.ts')),
      violates,
    );
    assert.throws(
      () => scope.resolveInSubtree('worktrees', taskA, path.join(taskA, '..', 'subtree-b')),
      violates,
    );
  });

  it('resolves a relative path against the subtree, not the scope root', () => {
    const taskA = mkdir(worktreesRoot, 'subtree-relative');
    assert.equal(
      scope.resolveInSubtree('worktrees', taskA, 'src/index.ts'),
      path.join(real(taskA), 'src', 'index.ts'),
    );
  });

  it('accepts the subtree itself, which is where a task starts', () => {
    const taskA = mkdir(worktreesRoot, 'subtree-self');
    assert.equal(scope.resolveInSubtree('worktrees', taskA, taskA), real(taskA));
  });

  it('refuses a boundary outside the scope, so a caller cannot widen its own reach', () => {
    // If naming a boundary were enough to be granted it, the check would be
    // decorative: a task would simply claim the whole filesystem as its subtree.
    assert.throws(() => scope.resolveInSubtree('worktrees', os.tmpdir(), os.tmpdir()), violates);
  });

  it('names the subtree in the error, not the wider root', () => {
    const taskA = mkdir(worktreesRoot, 'subtree-message');
    const taskB = mkdir(worktreesRoot, 'subtree-message-other');
    assert.throws(
      () => scope.resolveInSubtree('worktrees', taskA, taskB),
      // Reporting the scope root would describe a permission the caller never
      // had, which is worse than unhelpful when the message reaches a user.
      /subtree-message(?!-other)/,
    );
  });

  it('rejects a NUL byte, which can truncate a path inside a syscall', () => {
    const taskA = mkdir(worktreesRoot, 'subtree-nul');
    assert.throws(() => scope.resolveInSubtree('worktrees', taskA, `${taskA}\0.png`), violates);
  });

  it('is not fooled by a sibling whose name merely starts the same', () => {
    const taskA = mkdir(worktreesRoot, 'task');
    const lookalike = mkdir(worktreesRoot, 'task-backup');
    assert.throws(() => scope.resolveInSubtree('worktrees', taskA, lookalike), violates);
  });

  it('offers a non-throwing form for callers that expect misses', () => {
    const taskA = mkdir(worktreesRoot, 'subtree-check-a');
    const taskB = mkdir(worktreesRoot, 'subtree-check-b');
    assert.equal(scope.isInSubtree('worktrees', taskA, path.join(taskA, 'file.ts')), true);
    assert.equal(scope.isInSubtree('worktrees', taskA, taskB), false);
  });
});

// ---------------------------------------------------------------------------

describe('per-task worktrees', gitOnly, () => {
  let repo: string;

  before(() => {
    repo = makeRepo('worktree-repo');
  });

  beforeEach(() => {
    worktrees.resetWorktrees();
  });

  it('gives a task its own checkout on its own branch', async () => {
    const worktree = await worktrees.provisionWorktree('task-alpha', repo);

    assert.equal(worktree.mode, 'worktree');
    assert.equal(worktree.reason, null);
    assert.equal(worktree.dir, path.join(real(worktreesRoot), 'task-alpha'));
    assert.equal(worktree.branch, 'aistudio-task-task-alpha');
    assert.equal(worktree.baseCommit, git(['rev-parse', 'HEAD'], repo));
    assert.equal(worktree.repo, real(repo));

    // A real checkout, not an empty directory: the task has files to work on.
    assert.equal(fs.existsSync(path.join(worktree.dir, 'README.md')), true);

    await worktrees.releaseWorktree('task-alpha');
  });

  it('answers a repeated request with the same worktree', async () => {
    const first = await worktrees.provisionWorktree('task-repeat', repo);
    const second = await worktrees.provisionWorktree('task-repeat', repo);

    assert.strictEqual(second, first, 'a second checkout for one task would split its work');
    assert.deepEqual(
      worktrees.listWorktrees().map((entry) => entry.taskId),
      ['task-repeat'],
    );
    assert.equal(worktrees.getWorktree('task-repeat')?.dir, first.dir);

    await worktrees.releaseWorktree('task-repeat');
  });

  it('keeps two tasks out of each other\u2019s files', async () => {
    const one = await worktrees.provisionWorktree('task-one', repo);
    const two = await worktrees.provisionWorktree('task-two', repo);
    assert.notEqual(one.dir, two.dir);

    // Its own subtree: allowed, including paths that do not exist yet, because
    // that is what writing a new file looks like.
    assert.equal(
      worktrees.containAgentCwd(path.join(one.dir, 'src'), 'task-one'),
      path.join(real(one.dir), 'src'),
    );

    // The other task's subtree: refused, though both are in the same scope.
    assert.throws(() => worktrees.containAgentCwd(two.dir, 'task-one'), violates);
    assert.throws(
      () => worktrees.containAgentCwd(path.join(one.dir, '..', 'task-two'), 'task-one'),
      violates,
    );

    // And the project itself is off limits to a task that has a worktree —
    // otherwise the isolation would only be a suggestion.
    assert.throws(() => worktrees.containAgentCwd(repo, 'task-one'), violates);

    await worktrees.releaseWorktree('task-one');
    await worktrees.releaseWorktree('task-two');
  });

  it('still contains an unnamed caller, falling back to the projects rule', async () => {
    const worktree = await worktrees.provisionWorktree('task-unnamed', repo);

    // Without a task id, a path inside a registered worktree is still allowed:
    // an agent handed a worktree path must be able to use it.
    assert.equal(worktrees.containAgentCwd(worktree.dir), real(worktree.dir));
    // And an ordinary project path resolves the way it always did.
    assert.equal(worktrees.containAgentCwd(repo), real(repo));
    // Outside every root, nothing is allowed.
    assert.throws(() => worktrees.containAgentCwd(os.tmpdir()), violates);

    await worktrees.releaseWorktree('task-unnamed');
  });

  it('removes a worktree that holds nothing, and the branch with it', async () => {
    const worktree = await worktrees.provisionWorktree('task-clean', repo);
    const release = await worktrees.releaseWorktree('task-clean');

    assert.equal(release.removed, true);
    assert.equal(release.keptReason, null);
    assert.equal(fs.existsSync(worktree.dir), false);
    assert.equal(
      release.branch,
      null,
      'a branch still pointing at the base commit records nothing worth keeping',
    );
    assert.doesNotMatch(git(['branch', '--list'], repo), /aistudio-task-task-clean/);

    // Deregistered, so a finished task loses its filesystem permissions.
    assert.equal(worktrees.getWorktree('task-clean'), undefined);
    assert.throws(() => worktrees.containAgentCwd(worktree.dir, 'task-clean'), violates);
  });

  it('keeps a worktree with uncommitted changes, and says why', async () => {
    const worktree = await worktrees.provisionWorktree('task-dirty', repo);
    fs.writeFileSync(path.join(worktree.dir, 'scratch.ts'), 'export const wip = 1;\n');

    const release = await worktrees.releaseWorktree('task-dirty');

    assert.equal(release.removed, false);
    assert.match(release.keptReason ?? '', /uncommitted/);
    assert.equal(release.dir, worktree.dir, 'the caller has to be able to say where to look');
    assert.equal(
      fs.existsSync(path.join(worktree.dir, 'scratch.ts')),
      true,
      'a leftover directory costs disk; a deleted diff costs work',
    );
    assert.equal(worktrees.getWorktree('task-dirty'), undefined);
  });

  it('keeps the branch when the task committed something', async () => {
    const worktree = await worktrees.provisionWorktree('task-committed', repo);
    fs.writeFileSync(path.join(worktree.dir, 'feature.ts'), 'export const done = true;\n');
    git(['add', '-A'], worktree.dir);
    git(['commit', '-m', 'work from the task'], worktree.dir);

    const release = await worktrees.releaseWorktree('task-committed');

    // The scratch directory goes; the commits do not. They are reachable by
    // branch name in the user's own repository, reviewable with plain git log.
    assert.equal(release.removed, true);
    assert.equal(release.branch, 'aistudio-task-task-committed');
    assert.equal(fs.existsSync(worktree.dir), false);
    assert.match(git(['branch', '--list'], repo), /aistudio-task-task-committed/);
    assert.match(
      git(['log', '-1', '--format=%s', 'aistudio-task-task-committed'], repo),
      /work from the task/,
    );
  });

  it('steps past a directory left behind by an earlier crash', async () => {
    // The registry is in-memory, so a crash mid-task leaves a directory with
    // nothing tracking it. Reusing it would mix two tasks' work and deleting it
    // could destroy the diff somebody is looking for; stepping aside does neither.
    const stale = mkdir(worktreesRoot, 'task-stale');
    fs.writeFileSync(path.join(stale, 'evidence.txt'), 'from a crashed run\n');

    const worktree = await worktrees.provisionWorktree('task-stale', repo);

    assert.equal(worktree.mode, 'worktree');
    assert.equal(path.basename(worktree.dir), 'task-stale-2');
    assert.equal(fs.existsSync(path.join(stale, 'evidence.txt')), true);

    await worktrees.releaseWorktree('task-stale');
  });

  it('reports an unregistered task rather than throwing at the release site', async () => {
    // Release runs on the way out of a task that may have failed anywhere,
    // including before it ever got a worktree.
    const release = await worktrees.releaseWorktree('task-never-provisioned');
    assert.equal(release.removed, false);
    assert.match(release.keptReason ?? '', /no worktree/);
  });

  it('refuses a task id that could not be a directory or a ref', async () => {
    for (const bad of ['', '   ', '../escape', 'has space', '.hidden', 'a'.repeat(101)]) {
      await assert.rejects(
        worktrees.provisionWorktree(bad, repo),
        /Unusable Code task id/,
        `"${bad}" should have been refused`,
      );
    }
    // Sanitising instead would let two different tasks collapse onto one
    // directory, which is the failure this module exists to prevent.
    assert.throws(() => worktrees.containAgentCwd(worktreesRoot, '../escape'), /Unusable Code task id/);
  });

  it('refuses a project outside the projects root', async () => {
    await assert.rejects(worktrees.provisionWorktree('task-outside', os.tmpdir()), violates);
  });
});

// ---------------------------------------------------------------------------

describe('when a worktree cannot be made', () => {
  beforeEach(() => {
    worktrees.resetWorktrees();
  });

  it('works directly in a project that is not a git repository', async () => {
    const plain = mkdir(projectsRoot, 'not-a-repo');
    const worktree = await worktrees.provisionWorktree('task-plain', plain);

    // Degrading to a shared directory is the supported outcome, not a failure:
    // a project with no git still has to be workable.
    assert.equal(worktree.mode, 'direct');
    assert.equal(worktree.dir, real(plain));
    assert.equal(worktree.repo, real(plain));
    assert.equal(worktree.branch, null);
    assert.equal(worktree.baseCommit, null);
    assert.match(
      worktree.reason ?? '',
      /not a git repository|git was not found|outside the projects directory/,
    );
  });

  it('still contains a direct-mode task to its own project directory', async () => {
    const plain = mkdir(projectsRoot, 'direct-contained');
    await worktrees.provisionWorktree('task-direct', plain);

    assert.equal(
      worktrees.containAgentCwd(path.join(plain, 'src'), 'task-direct'),
      path.join(real(plain), 'src'),
    );
    // Losing worktree isolation must not also lose scope containment: a sibling
    // project is still not this task's business.
    const sibling = mkdir(projectsRoot, 'direct-sibling');
    assert.throws(() => worktrees.containAgentCwd(sibling, 'task-direct'), violates);
    assert.throws(() => worktrees.containAgentCwd(os.tmpdir(), 'task-direct'), violates);
  });

  it('never removes the project directory it was working in', async () => {
    const plain = mkdir(projectsRoot, 'direct-release');
    fs.writeFileSync(path.join(plain, 'source.ts'), 'export const kept = true;\n');
    await worktrees.provisionWorktree('task-direct-release', plain);

    const release = await worktrees.releaseWorktree('task-direct-release');

    assert.equal(release.removed, false);
    assert.match(release.keptReason ?? '', /project directory/);
    assert.equal(fs.existsSync(path.join(plain, 'source.ts')), true);
  });

  it('falls back for a repository with no commits to branch from', gitOnly, async () => {
    const fresh = mkdir(projectsRoot, 'empty-repo');
    git(['init', '-b', 'main'], fresh);

    const worktree = await worktrees.provisionWorktree('task-empty', fresh);

    assert.equal(worktree.mode, 'direct');
    assert.match(worktree.reason ?? '', /no commits yet/);
    assert.equal(worktree.dir, real(fresh));
  });
});
