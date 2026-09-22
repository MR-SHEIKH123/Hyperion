/**
 * The orphaned-worktree check (1.31).
 *
 * The worktree registry is in-memory, so a restart makes every checkout on disk
 * an orphan: the directory survives, the knowledge of which task it belonged to
 * does not. Before this, nothing looked — which the module header recorded as a
 * known limitation rather than a bug — and the two consequences were both silent:
 *
 *   1. a leftover directory is indistinguishable from a leak, so a user has no
 *      way to know whether disk is being wasted or work is sitting there; and
 *   2. a task continued after a restart was given a **fresh** checkout, because
 *      `freePath` deliberately suffixes past anything already on disk — its prior
 *      edits stayed on disk with nothing pointing at them.
 *
 * Four claims are tested here, each a way the fix could be worse than the problem:
 *
 *   - **The scan reports and never deletes.** Including the bound: directories it
 *     did not inspect are *counted*, because a bounded scan that reports itself as
 *     complete is a lie about coverage.
 *   - **The risk check distinguishes work from no work.** An orphan with
 *     uncommitted changes and a clean orphan are the same fact to a scanner and
 *     different decisions for a person.
 *   - **Discarding needs an explicit second act.** The default refuses, naming what
 *     would be lost; `force` removes it and records what it cost. A directory a
 *     live task owns is refused outright, so this is never a way to break a run.
 *   - **Adoption gives the work back.** Provisioning the same task id after a
 *     restart re-attaches the directory it left, and only when the repository
 *     matches — adopting a stranger's checkout would hand a task write access it
 *     was never granted.
 *
 * Real repositories, real git: the interesting behaviour is git's (what
 * `status --porcelain` says, what `worktree remove` refuses, what
 * `--git-common-dir` resolves to) and a stub would only assert this file's
 * assumptions about it. Skips cleanly where git is absent, like the sibling
 * worktree tests.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, beforeEach, describe, it } from 'node:test';

import http from 'node:http';

import { cleanupHome, freshDb, testHome } from './helpers.ts';

type WorktreeModule = typeof import('../src/services/code/worktree.ts');
type QueueModule = typeof import('../src/services/attention/queue.ts');
type EnvModule = typeof import('../src/config/env.ts');

let worktrees: WorktreeModule;
let queue: QueueModule;
let env: EnvModule;
let server: http.Server;
let base: string;

const projectsRoot = path.join(testHome, 'projects');
const worktreesRoot = path.join(testHome, 'worktrees');

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const gitOnly = hasGit ? {} : { skip: 'git is not installed on this machine' };

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
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  git(['add', '-A'], dir);
  git(['commit', '-m', 'initial'], dir);
  return dir;
}

/**
 * A checkout a previous process left behind, with no registry entry for it.
 *
 * Built the way the server builds one — `git worktree add` from the project, into
 * the worktrees root — and then dropped from the registry, which is exactly the
 * state a restart produces.
 */
function leaveWorktreeBehind(repo: string, name: string, edits: Record<string, string> = {}): string {
  const dir = path.join(worktreesRoot, name);
  fs.mkdirSync(worktreesRoot, { recursive: true });
  git(['worktree', 'add', '-b', `hyperion/${name}`, dir, 'HEAD'], repo);
  for (const [relative, content] of Object.entries(edits)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

before(async () => {
  env = await import('../src/config/env.ts');
  env.ensureDirectories();

  const absent = path.join(testHome, 'absent-gitconfig');
  process.env.GIT_CONFIG_GLOBAL = absent;
  process.env.GIT_CONFIG_SYSTEM = absent;

  worktrees = await import('../src/services/code/worktree.ts');
  queue = await import('../src/services/attention/queue.ts');

  const { createApp } = await import('../src/http/app.ts');
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  worktrees.resetWorktrees();
  worktrees.resetOrphanedWorktreeSnapshot();
  // Isolated per test: the scan's whole subject is "what is on disk", so a
  // directory left by an earlier test is an orphan in the next one. Same reason
  // the database is fresh per test elsewhere.
  fs.rmSync(worktreesRoot, { recursive: true, force: true });
  fs.rmSync(projectsRoot, { recursive: true, force: true });
  fs.mkdirSync(worktreesRoot, { recursive: true });
  fs.mkdirSync(projectsRoot, { recursive: true });
  await freshDb();
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

// ---------------------------------------------------------------------------

describe('the scan', () => {
  it('finds directories no task owns, and not the ones it does', async () => {
    const repo = makeRepo('scan-repo');
    leaveWorktreeBehind(repo, 'left-behind');
    const owned = await worktrees.provisionWorktree('scan-owned', repo);

    const scan = await worktrees.scanOrphanedWorktrees();

    assert.deepEqual(
      scan.orphans.map((orphan) => orphan.name),
      ['left-behind'],
      'the directory of a live task is not an orphan',
    );
    assert.equal(scan.registered, 1);
    assert.equal(scan.root, worktreesRoot);
    assert.ok(owned.dir.endsWith('scan-owned'));
  });

  it('says whether each orphan holds work, because that is the decision', async () => {
    const repo = makeRepo('risk-repo');
    leaveWorktreeBehind(repo, 'holds-edits', { 'wip.ts': 'export const wip = true;\n' });
    leaveWorktreeBehind(repo, 'clean-tree');

    const scan = await worktrees.scanOrphanedWorktrees();
    const byName = new Map(scan.orphans.map((orphan) => [orphan.name, orphan]));

    assert.equal(byName.get('holds-edits')?.risk, 'it has uncommitted changes');
    assert.equal(byName.get('holds-edits')?.checked, true);
    assert.equal(byName.get('clean-tree')?.risk, null, 'a clean checkout holds nothing to lose');
    assert.equal(scan.holding, 1, 'the count is of orphans that hold work, not of orphans');
    assert.equal(byName.get('holds-edits')?.taskId, 'holds-edits');
  });

  it('reports an unverifiable directory as unchecked, never as clean', async () => {
    // Not a git checkout at all — a directory someone dropped here, or a worktree
    // whose repository is gone. "I could not look" and "there is nothing there"
    // are different facts, and only the second one is safe to delete.
    fs.mkdirSync(path.join(worktreesRoot, 'not-a-worktree'), { recursive: true });
    fs.writeFileSync(path.join(worktreesRoot, 'not-a-worktree', 'notes.txt'), 'work\n');

    const scan = await worktrees.scanOrphanedWorktrees();
    const orphan = scan.orphans.find((entry) => entry.name === 'not-a-worktree');
    assert.ok(orphan);
    assert.equal(orphan.checked, false);
    assert.match(orphan.risk ?? '', /could not be checked/);
    assert.equal(scan.holding, 1, 'an unverifiable directory is not an empty one');

    // And the destructive path fails closed on it: no force, no deletion, and the
    // answer says why rather than pretending it was risky-but-fine.
    await assert.rejects(worktrees.discardOrphanedWorktree('not-a-worktree'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'conflict');
      assert.match((error as Error).message, /could not be checked|already fits|not removed/);
      return true;
    });
    assert.ok(fs.existsSync(path.join(worktreesRoot, 'not-a-worktree', 'notes.txt')));

    const forced = await worktrees.discardOrphanedWorktree('not-a-worktree', { force: true });
    assert.equal(forced.method, 'filesystem', 'with no repository to act in, only the filesystem is left');
    assert.equal(fs.existsSync(path.join(worktreesRoot, 'not-a-worktree')), false);
  });

  it('counts what it did not inspect instead of reporting a complete scan', async () => {
    const repo = makeRepo('bounded-repo');
    leaveWorktreeBehind(repo, 'bounded-a');
    leaveWorktreeBehind(repo, 'bounded-b');
    leaveWorktreeBehind(repo, 'bounded-c');

    const scan = await worktrees.scanOrphanedWorktrees({ limit: 1 });
    assert.equal(scan.orphans.length, 1);
    assert.equal(scan.unchecked, 2, 'the directories it skipped are a fact about coverage');
  });

  it('keeps the task id apart from the free-path suffix', async () => {
    const repo = makeRepo('suffix-repo');
    leaveWorktreeBehind(repo, 'task-one');
    leaveWorktreeBehind(repo, 'task-one-2');

    const scan = await worktrees.scanOrphanedWorktrees();
    const ids = scan.orphans.map((orphan) => orphan.taskId).sort();
    assert.deepEqual(ids, ['task-one', 'task-one'], 'both belong to the same task');
    assert.deepEqual(
      scan.orphans.map((orphan) => orphan.name).sort(),
      ['task-one', 'task-one-2'],
    );
  });
});

describe('discarding an orphan', () => {
  it('refuses by default when the directory holds work, and deletes nothing', async () => {
    const repo = makeRepo('discard-repo');
    const dir = leaveWorktreeBehind(repo, 'has-work', { 'unsaved.ts': 'x\n' });

    await assert.rejects(worktrees.discardOrphanedWorktree('has-work'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'conflict');
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'it has uncommitted changes');
      return true;
    });
    assert.ok(fs.existsSync(dir), 'a refusal is not a partial delete');
  });

  it('removes it when forced, and records what that cost', async () => {
    const repo = makeRepo('forced-repo');
    const dir = leaveWorktreeBehind(repo, 'force-me', { 'unsaved.ts': 'x\n' });

    const result = await worktrees.discardOrphanedWorktree('force-me', { force: true });
    assert.equal(result.method, 'git', 'git removes it, so the parent repository keeps consistent metadata');
    assert.equal(result.lostReason, 'it has uncommitted changes');
    assert.equal(fs.existsSync(dir), false);
    assert.ok(
      !git(['worktree', 'list'], repo).includes(dir),
      'a filesystem delete alone would leave the registration behind in `git worktree list`',
    );
  });

  it('removes a clean orphan without a force, because there is nothing to decide', async () => {
    const repo = makeRepo('clean-repo');
    const dir = leaveWorktreeBehind(repo, 'tidy');

    const result = await worktrees.discardOrphanedWorktree('tidy');
    assert.equal(result.method, 'git');
    assert.equal(result.lostReason, null);
    assert.equal(fs.existsSync(dir), false);
  });

  it('refuses a directory a running task owns', async () => {
    const repo = makeRepo('live-repo');
    const owned = await worktrees.provisionWorktree('live-task', repo);

    await assert.rejects(worktrees.discardOrphanedWorktree('live-task'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'conflict');
      assert.match((error as Error).message, /in use by a running task/);
      return true;
    });
    assert.ok(fs.existsSync(owned.dir), 'a live task keeps its directory');
  });

  it('refuses an unknown name, and a name that is not a single segment', async () => {
    await assert.rejects(worktrees.discardOrphanedWorktree('never-existed'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'not_found');
      return true;
    });

    for (const name of ['../escape', 'a/b', '..', '']) {
      await assert.rejects(worktrees.discardOrphanedWorktree(name), (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'bad_request', `"${name}" must be rejected as a name`);
        return true;
      });
    }
  });
});

describe('adopting an orphan when a task continues', () => {
  it('re-attaches the directory a previous process left, edits and all', gitOnly, async () => {
    const repo = makeRepo('adopt-repo');
    const dir = leaveWorktreeBehind(repo, 'resumable-task', { 'half-done.ts': 'export const half = 1;\n' });

    // A restart: the registry is empty, the directory is not.
    worktrees.resetWorktrees();

    const adopted = await worktrees.provisionWorktree('resumable-task', repo);
    assert.equal(adopted.dir, fs.realpathSync(dir), 'the same directory, not a fresh checkout beside it');
    assert.equal(adopted.mode, 'worktree');
    assert.equal(adopted.reason, null, 'adoption is not a degraded fallback');
    assert.ok(adopted.branch?.startsWith('hyperion/'), `branch was ${adopted.branch}`);
    assert.ok(adopted.baseCommit !== null, 'the commit it started from is read back from git');
    assert.equal(
      fs.readFileSync(path.join(adopted.dir, 'half-done.ts'), 'utf8'),
      'export const half = 1;\n',
      'the work that was stranded is the point of adopting',
    );

    // And it is no longer reported as an orphan.
    const scan = await worktrees.scanOrphanedWorktrees();
    assert.deepEqual(scan.orphans.map((orphan) => orphan.name), []);
  });

  it('never adopts a directory from a different repository', gitOnly, async () => {
    const first = makeRepo('other-repo');
    const second = makeRepo('this-repo');
    leaveWorktreeBehind(first, 'clashing-id');

    const provisioned = await worktrees.provisionWorktree('clashing-id', second);
    const stranger = fs.realpathSync(path.join(worktreesRoot, 'clashing-id'));
    assert.notEqual(provisioned.dir, stranger, 'a fresh checkout, because this one is not ours');
    assert.ok(
      provisioned.dir.includes('clashing-id-2'),
      `the free path steps past the directory rather than reusing it (${provisioned.dir})`,
    );
    assert.equal(
      provisioned.branch,
      'hyperion-task-clashing-id',
      "a branch of this project, not the stranger's",
    );

    // The stranger's checkout is untouched and still reported: a task must never
    // be handed write access to a repository it was not pointed at.
    assert.ok(fs.existsSync(path.join(worktreesRoot, 'clashing-id')));
    const scan = await worktrees.scanOrphanedWorktrees();
    assert.ok(scan.orphans.some((orphan) => orphan.name === 'clashing-id'));
  });

  it('prefers the newest directory when a task left more than one', gitOnly, async () => {
    const repo = makeRepo('two-left-repo');
    leaveWorktreeBehind(repo, 'two-left-2', { 'newer.ts': 'newer\n' });
    const older = leaveWorktreeBehind(repo, 'two-left');
    // `freePath` only makes a second directory when the first was unusable, so the
    // later one is the one that was worked in. Make the ordering unambiguous.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(older, past, past);

    worktrees.resetWorktrees();
    const adopted = await worktrees.provisionWorktree('two-left', repo);
    assert.ok(adopted.dir.endsWith('two-left-2'), `adopted ${adopted.dir}`);
  });
});

describe('the routes', () => {
  it('lists orphans with their risk, and discards one on request', async () => {
    const repo = makeRepo('route-repo');
    leaveWorktreeBehind(repo, 'route-task', { 'stranded.ts': 'x\n' });

    const listing = await fetch(`${base}/api/storage/worktrees`);
    assert.equal(listing.status, 200);
    const scan = (await listing.json()) as {
      orphans: { name: string; risk: string | null }[];
      holding: number;
      registered: number;
    };
    assert.equal(scan.orphans[0]?.name, 'route-task');
    assert.equal(scan.holding, 1);

    // The default refuses and says why: the caller gets the decision, not a
    // half-done deletion.
    const refused = await fetch(`${base}/api/storage/worktrees/route-task/discard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(refused.status, 409);
    const refusal = (await refused.json()) as { error: { details?: Record<string, unknown> } };
    assert.equal(refusal.error.details?.reason, 'it has uncommitted changes');

    const forced = await fetch(`${base}/api/storage/worktrees/route-task/discard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(forced.status, 200);
    const result = (await forced.json()) as {
      method: string;
      lostReason: string | null;
      scan: { orphans: unknown[] };
    };
    assert.equal(result.method, 'git');
    assert.equal(result.lostReason, 'it has uncommitted changes', 'a forced removal states what it cost');
    assert.deepEqual(result.scan.orphans, [], 'the answer carries the registry as it now stands');
  });

  it('is a 404 for a name that is not there', async () => {
    const res = await fetch(`${base}/api/storage/worktrees/nothing-here/discard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
  });
});

describe('the queue reports the check', () => {
  it('says no scan has run rather than showing an empty source', () => {
    const report = queue.attentionQueue();
    const source = report.sources.find((entry) => entry.source === 'worktrees');
    assert.equal(source?.status, 'unavailable', 'an absent check and a clean check must not look alike');
    assert.match(source?.reason ?? '', /no scan has run/);
  });

  it('turns an orphan holding work into an item with the call that resolves it', async () => {
    const repo = makeRepo('queue-repo');
    leaveWorktreeBehind(repo, 'queue-task', { 'stranded.ts': 'x\n' });
    await worktrees.scanOrphanedWorktrees();

    const report = queue.attentionQueue();
    const item = report.items.find((entry) => entry.kind === 'orphaned_worktree');
    assert.ok(item, 'the orphan holding work is the thing waiting on a decision');
    assert.equal(item.taskId, 'queue-task');
    assert.equal(item.tool, 'code');
    assert.equal(item.resolve?.path, '/api/storage/worktrees/queue-task/discard');
    assert.match(item.detail, /it has uncommitted changes/);
    assert.match(item.detail, /Nothing was deleted/);
    assert.equal(report.counts.orphaned_worktree, 1);

    // Clean orphans are disk rather than a decision: counted by the storage route,
    // deliberately not queued.
    leaveWorktreeBehind(repo, 'queue-clean');
    await worktrees.scanOrphanedWorktrees();
    const second = queue.attentionQueue();
    assert.equal(second.counts.orphaned_worktree, 1);
    assert.equal(second.sources.find((entry) => entry.source === 'worktrees')?.status, 'ok');
  });
});
