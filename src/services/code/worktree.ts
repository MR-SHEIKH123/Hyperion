/**
 * Per-task git worktrees — the filesystem half of Code task parallelism.
 *
 * The lane in `orchestrator/lock.ts` decides *how many* Code tasks may run at
 * once. That alone is not enough to make them parallel in any useful sense: two
 * tasks editing the same repository through the same working directory would see
 * each other's half-written files, and the loser of the race gets a diff it never
 * asked for. This module gives each task its own checkout instead:
 *
 *   ~/Hyperion/worktrees/<task-id>/     a real git worktree of the project
 *
 * A git worktree is the right primitive because it is not a copy. It shares the
 * repository's object store, so provisioning costs one checkout rather than one
 * clone, and a commit made in a task's worktree is immediately a commit in the
 * user's repository — reviewable with plain `git log` once the task is done.
 *
 * Three behaviours are deliberate:
 *
 *   - **Falling back is normal, not an error.** A project that is not a git
 *     repository, has no commits yet, or sits on a machine with no `git` on PATH
 *     still has to be workable. In those cases the task runs directly in the
 *     project directory (`mode: 'direct'`) with the reason recorded. Parallelism
 *     degrades to "sharing the directory" rather than the feature failing.
 *   - **Cleanup never destroys work.** The worktree is scratch space, so it is
 *     removed when a task ends — but only after checking that removing it cannot
 *     lose anything. Uncommitted changes, or commits that no branch would keep
 *     reachable, mean the directory stays on disk and says why. The asymmetry is
 *     the point: a leftover directory costs disk, a deleted diff costs work.
 *   - **Containment is enforced per task, not per scope.** Every worktree lives
 *     under one root, so scope membership cannot distinguish task A's files from
 *     task B's. `containAgentCwd` uses `resolveInSubtree` for that reason.
 *
 * Known limitation: the registry here is in-memory, so a crash mid-task leaves
 * the directory behind with nothing tracking it. That is the safe direction to
 * fail, and `provisionWorktree` works around a stale directory by picking the
 * next free path rather than reusing or deleting it.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { env } from '../../config/env.ts';
import { getRoot, resolveInScope, resolveInSubtree } from '../../security/fsScope.ts';
import { assertNoSymlinkedTraversal, assertStillInside } from '../../security/toctou.ts';
import { AppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';

const log = createLogger('code:worktree');

/**
 * `worktree` means the task got its own checkout and is isolated from every
 * other task. `direct` means it is working in the project directory itself,
 * because a worktree could not be made — see `Worktree.reason`.
 */
export type WorktreeMode = 'worktree' | 'direct';

export interface Worktree {
  taskId: string;
  mode: WorktreeMode;
  /** Absolute directory the task must work in. The only path an agent needs. */
  dir: string;
  /** The repository this came from. Equals `dir` in direct mode. */
  repo: string;
  /** Branch checked out in the worktree; null when detached or direct. */
  branch: string | null;
  /** Commit the checkout started at, so we can tell later if work was added. */
  baseCommit: string | null;
  createdAt: number;
  /** Why isolation was not possible. Null when `mode` is `worktree`. */
  reason: string | null;
  /**
   * When this worktree stopped belonging to a running task and started being
   * kept for a parked one. Null while the task is active.
   *
   * A held worktree is the whole point of `holdWorktree`: before 1.27 a park
   * released the directory unconditionally, and re-submitting the parked task id
   * then got a *new* directory — `freePath` suffixes past what is already there,
   * and `worktree add -b` fails because the branch exists, so the retry fell back
   * to `--detach` and restarted from `baseCommit` with the prior edits orphaned.
   * That silently broke `plan_ready` and `redaction_blocked` before approvals
   * existed at all.
   *
   * Holding costs disk, not a lane slot: `withCodeLane` completes when the agent
   * returns, so the slot is already free.
   */
  heldSince: number | null;
}

export interface WorktreeRelease {
  taskId: string;
  /** True when the directory is gone from disk. */
  removed: boolean;
  /** Why it was left in place, or null when it was removed. */
  keptReason: string | null;
  /** Branch that still holds the task's commits, if any. */
  branch: string | null;
  /** Absolute path, so a caller can tell the user where to look. */
  dir: string;
}

/**
 * Timeouts are split because the two kinds of git call have nothing in common.
 * A `rev-parse` that has not answered in ten seconds is broken, while the
 * checkout inside `worktree add` is genuinely proportional to repository size.
 */
const QUERY_TIMEOUT_MS = 15_000;
const CHECKOUT_TIMEOUT_MS = 180_000;

/** Enough to step past a stale directory or two without looping forever. */
const MAX_PATH_ATTEMPTS = 5;

/**
 * Live worktrees, keyed by task id.
 *
 * This is the lookup that makes per-task containment possible: given a task,
 * `containAgentCwd` needs to know which subtree that task is allowed to touch.
 */
const worktrees = new Map<string, Worktree>();

// --- provisioning -----------------------------------------------------------

/**
 * Gives a task somewhere isolated to work.
 *
 * Never throws for an environmental reason — no git, not a repository, no
 * commits, a git that refuses — because none of those should stop a Code task
 * from running. Each returns `mode: 'direct'` with the reason attached. It does
 * throw for bad input: an unusable task id, or a `repoDir` outside the projects
 * scope, are things to reject rather than degrade around. Both surface as
 * `bad_request`, since both arrive from the client.
 */
export async function provisionWorktree(taskId: string, repoDir: string): Promise<Worktree> {
  const id = safeTaskId(taskId);

  const existing = worktrees.get(id);
  if (existing) {
    // A continuation lands here, and this is what makes it a *continuation*: the
    // same directory, the same branch, the prior edits still on disk. The hold is
    // cleared because the task is running again.
    if (existing.heldSince !== null) {
      const resumed: Worktree = { ...existing, heldSince: null };
      worktrees.set(id, resumed);
      log.info(`task ${id}: resuming the held worktree at ${resumed.dir}`);
      return resumed;
    }
    return existing;
  }

  // Validated before anything else runs: everything downstream is a git command
  // with this path in it, and the scope check is what makes that safe.
  const project = resolveInScope('projects', repoDir);

  const worktree = await create(id, project);
  worktrees.set(id, worktree);

  if (worktree.mode === 'worktree') {
    log.info(`task ${id}: worktree at ${worktree.dir} on ${worktree.branch ?? 'a detached HEAD'}`);
  } else {
    log.info(`task ${id}: working directly in ${worktree.dir} (${worktree.reason ?? 'no reason'})`);
  }
  return worktree;
}

async function create(taskId: string, project: string): Promise<Worktree> {
  const direct = (reason: string): Worktree => ({
    taskId,
    mode: 'direct',
    dir: project,
    repo: project,
    branch: null,
    baseCommit: null,
    createdAt: Date.now(),
    reason,
    heldSince: null,
  });

  const top = await git(['rev-parse', '--show-toplevel'], { cwd: project });
  if (!top.ok) {
    return direct(
      missingGit(top)
        ? 'git was not found on PATH, so this task shares the project directory'
        : 'this project is not a git repository, so this task shares the project directory',
    );
  }

  const root = path.resolve(top.stdout.trim());
  if (root === '') return direct('the repository root could not be determined');

  // A repository whose root is outside `projects` is not ours to add worktrees
  // to — it would mean the projects directory is itself nested in someone
  // else's checkout, and we would be writing to a repository the user never
  // pointed us at.
  let repo: string;
  try {
    repo = resolveInScope('projects', root);
  } catch {
    return direct(
      'the enclosing git repository lives outside the projects directory, so no worktree was made',
    );
  }

  const head = await git(['rev-parse', 'HEAD'], { cwd: repo });
  if (!head.ok) {
    return direct('the repository has no commits yet, so there is nothing to branch from');
  }
  const baseCommit = head.stdout.trim();

  const dir = freePath(taskId);
  if (dir === null) {
    return direct('no free worktree directory was available');
  }

  const branch = `hyperion-task-${taskId}`;
  // `-b` first, so the task's commits stay reachable by name after the scratch
  // directory is gone. Detaching is the fallback, not the goal.
  let added = await git(['worktree', 'add', '-b', branch, dir, baseCommit], {
    cwd: repo,
    timeoutMs: CHECKOUT_TIMEOUT_MS,
  });
  let named = added.ok;

  if (!added.ok) {
    added = await git(['worktree', 'add', '--detach', dir, baseCommit], {
      cwd: repo,
      timeoutMs: CHECKOUT_TIMEOUT_MS,
    });
    named = false;
  }

  if (!added.ok) {
    // Half-created worktrees leave administrative files behind; pruning keeps
    // the next attempt from tripping over them.
    await git(['worktree', 'prune'], { cwd: repo });
    return direct(`the worktree could not be created (${firstLine(added.output)})`);
  }

  return {
    taskId,
    mode: 'worktree',
    dir,
    repo,
    branch: named ? branch : null,
    baseCommit,
    createdAt: Date.now(),
    reason: null,
    heldSince: null,
  };
}

/**
 * Picks a directory for the task, stepping past anything already there.
 *
 * `git worktree add` requires a path that does not exist, and a leftover
 * directory from a crashed run is the one case where that bites. Suffixing is
 * the non-destructive answer: deleting whatever is there would risk throwing
 * away exactly the diff somebody is looking for.
 */
function freePath(taskId: string): string | null {
  for (let attempt = 0; attempt < MAX_PATH_ATTEMPTS; attempt += 1) {
    const name = attempt === 0 ? taskId : `${taskId}-${attempt + 1}`;
    const candidate = resolveInScope('worktrees', name);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// --- release ----------------------------------------------------------------

/**
 * Ends a task's claim on its worktree, removing the directory when that is
 * provably safe.
 *
 * "Provably safe" is doing real work here. Removal is skipped when the tree has
 * uncommitted changes, and when commits exist that no branch would keep
 * reachable. Either way the task is deregistered — it is finished, so it must
 * lose its filesystem permissions — but the files stay put.
 */
export async function releaseWorktree(taskId: string): Promise<WorktreeRelease> {
  const id = safeTaskId(taskId);
  const worktree = worktrees.get(id);
  worktrees.delete(id);

  if (!worktree) {
    return { taskId: id, removed: false, keptReason: 'no worktree was registered', branch: null, dir: '' };
  }

  const base: WorktreeRelease = {
    taskId: id,
    removed: false,
    keptReason: null,
    branch: worktree.branch,
    dir: worktree.dir,
  };

  // Direct mode never owned a directory, so there is nothing to take away.
  if (worktree.mode === 'direct') {
    return { ...base, keptReason: 'the task ran in the project directory, which is not removed' };
  }

  if (env.codeKeepWorktrees) {
    log.info(`task ${id}: keeping ${worktree.dir} (HYPERION_CODE_KEEP_WORKTREES)`);
    return { ...base, keptReason: 'HYPERION_CODE_KEEP_WORKTREES is set' };
  }

  const keep = await workAtRisk(worktree);
  if (keep !== null) {
    log.info(`task ${id}: keeping ${worktree.dir} — ${keep}`);
    return { ...base, keptReason: keep };
  }

  // No `--force`: without it git refuses to remove a worktree it considers
  // unsafe to remove, which is a second opinion worth having on top of our own.
  const removed = await git(['worktree', 'remove', worktree.dir], {
    cwd: worktree.repo,
    timeoutMs: CHECKOUT_TIMEOUT_MS,
  });
  if (!removed.ok) {
    log.warn(`task ${id}: git declined to remove ${worktree.dir}: ${firstLine(removed.output)}`);
    return { ...base, keptReason: `git declined to remove it (${firstLine(removed.output)})` };
  }

  await git(['worktree', 'prune'], { cwd: worktree.repo });

  // A branch pointing at exactly the commit we started from records nothing, so
  // deleting it cannot lose anything and keeps `git branch` readable. Anything
  // ahead of the base is kept, which is the whole reason `-b` came first.
  if (worktree.branch !== null) {
    const tip = await git(['rev-parse', worktree.branch], { cwd: worktree.repo });
    if (tip.ok && tip.stdout.trim() === worktree.baseCommit) {
      await git(['branch', '-D', worktree.branch], { cwd: worktree.repo });
      return { ...base, removed: true, branch: null };
    }
  }

  return { ...base, removed: true };
}

/**
 * Returns the reason this worktree must survive, or null when it holds nothing.
 *
 * Two questions, and they are not the same. `status --porcelain` catches edits
 * that were never committed. The commit comparison catches the detached case,
 * where commits exist but no ref points at them, so removing the worktree would
 * leave them collectable garbage.
 */
async function workAtRisk(worktree: Worktree): Promise<string | null> {
  const status = await git(['status', '--porcelain'], { cwd: worktree.dir });
  if (!status.ok) {
    return `its state could not be checked (${firstLine(status.output)})`;
  }
  if (status.stdout.trim() !== '') {
    return 'it has uncommitted changes';
  }

  if (worktree.branch === null) {
    const head = await git(['rev-parse', 'HEAD'], { cwd: worktree.dir });
    if (head.ok && head.stdout.trim() !== worktree.baseCommit) {
      return 'it has commits on a detached HEAD that no branch would keep';
    }
  }

  return null;
}

// --- holding for a parked task ----------------------------------------------

/**
 * Keep a parked task's worktree instead of releasing it.
 *
 * The task stays registered, so `containAgentCwd` still resolves its subtree and a
 * continuation gets the identical directory back from `provisionWorktree`. Only the
 * clock starts: `heldSince` is what the reaper measures against.
 *
 * Called for the non-terminal states — `blocked` and `ready_for_review`. Terminal
 * states still release, because a finished task has no continuation to protect and
 * a directory nobody will return to is a leak.
 */
export function holdWorktree(taskId: string): Worktree | null {
  const id = safeTaskId(taskId);
  const worktree = worktrees.get(id);
  if (!worktree) return null;
  if (worktree.mode === 'direct') return worktree; // owns no directory to hold
  if (worktree.heldSince !== null) return worktree;

  const held: Worktree = { ...worktree, heldSince: Date.now() };
  worktrees.set(id, held);
  log.info(`task ${id}: holding ${held.dir} for a parked run`);
  return held;
}

/** Worktrees currently held for a parked task, oldest hold first. */
export function heldWorktrees(): Worktree[] {
  return [...worktrees.values()]
    .filter((worktree) => worktree.heldSince !== null)
    .sort((a, b) => (a.heldSince ?? 0) - (b.heldSince ?? 0));
}

/**
 * Release worktrees held past their TTL.
 *
 * The counterweight to D12: holding indefinitely turns a safety feature into a
 * disk leak, and the failure is invisible because a held directory looks exactly
 * like a leaked one. Run on boot beside `reconcileOrphanedTaskRuns` and on the
 * cleanup timer.
 *
 * `releaseWorktree`'s own safety checks still apply, so a held tree with
 * uncommitted work is *kept on disk* and merely deregistered — the reaper cannot
 * destroy a diff, only stop tracking it. That is the same asymmetry the module
 * header describes: a leftover directory costs disk, a deleted diff costs work.
 */
export async function reapHeldWorktrees(options: { ttlMs: number; now?: number } = { ttlMs: 0 }): Promise<
  WorktreeRelease[]
> {
  const now = options.now ?? Date.now();
  const expired = heldWorktrees().filter(
    (worktree) => now - (worktree.heldSince ?? now) >= options.ttlMs,
  );

  const released: WorktreeRelease[] = [];
  for (const worktree of expired) {
    released.push(await releaseWorktree(worktree.taskId));
    log.info(`task ${worktree.taskId}: releasing a worktree held since ${new Date(worktree.heldSince ?? now).toISOString()}`);
  }
  return released;
}

// --- containment ------------------------------------------------------------

/**
 * Resolves a working directory an agent asked for, refusing anything outside
 * what its task owns.
 *
 * The `taskId` argument is what makes two parallel tasks independent rather
 * than merely both-contained: with it, the boundary is that task's own subtree,
 * so `../<other-task>/src` is rejected even though both paths sit in the same
 * scope. Without it the historical rule applies — the projects scope — plus the
 * narrow allowance for a path inside a *registered* worktree, so an agent that
 * was handed a worktree path can still use it.
 */
export function containAgentCwd(cwd: string, taskId?: string): string {
  // The traversal check runs on the spelling, before anything canonicalises it,
  // and deliberately outside the fallback attempts below: "this path goes through
  // a symlink" is a refusal, not a reason to look for a wider scope that would
  // accept it. See `security/toctou.ts` for why the two checks are separate.
  if (taskId !== undefined) {
    const worktree = worktrees.get(safeTaskId(taskId));
    if (worktree) {
      const scope = worktree.mode === 'worktree' ? 'worktrees' : 'projects';
      assertNoSymlinkedTraversal(worktree.dir, cwd);
      return assertStillInside(worktree.dir, resolveInSubtree(scope, worktree.dir, cwd));
    }
  }

  for (const worktree of worktrees.values()) {
    if (worktree.mode !== 'worktree') continue;
    assertNoSymlinkedTraversal(worktree.dir, cwd);
    let resolvedIn: string;
    try {
      resolvedIn = resolveInSubtree('worktrees', worktree.dir, cwd);
    } catch {
      // Not this task's directory. Try the next, then fall through to projects.
      continue;
    }
    return assertStillInside(worktree.dir, resolvedIn);
  }

  assertNoSymlinkedTraversal(getRoot('projects'), cwd);
  return assertStillInside(getRoot('projects'), resolveInScope('projects', cwd));
}

// --- inspection -------------------------------------------------------------

export function getWorktree(taskId: string): Worktree | undefined {
  return worktrees.get(safeTaskId(taskId));
}

export function listWorktrees(): Worktree[] {
  return [...worktrees.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Test hook. Drops the registry without touching the filesystem, so a test that
 * built real worktrees is responsible for its own temporary directory.
 */
export function resetWorktrees(): void {
  worktrees.clear();
}

// --- git plumbing -----------------------------------------------------------

interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  /** Merged stdout and stderr, for messages. git says most things on stderr. */
  output: string;
  spawnError: boolean;
}

/**
 * Runs one git command.
 *
 * Arguments are passed as an array with no shell, so a branch name or path can
 * never be read as a command — the same reason `provision.ts` avoids a shell
 * everywhere it can. Three environment variables matter: git must not prompt
 * for credentials (nobody can answer, so it would hang until the timeout), must
 * not take optional locks we do not need, and must not have its output
 * translated, since some of these messages get parsed.
 */
function git(
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_ASKPASS: '',
        LC_ALL: 'C',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let output = '';
    let settled = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += chunk.toString();
      if (output.length < 64 * 1024) output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (output.length < 64 * 1024) output += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      output += `\ngit ${args[0] ?? ''} timed out after ${Math.round(timeoutMs / 1000)}s.`;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    const finish = (result: GitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on('error', (error) => {
      finish({
        ok: false,
        code: null,
        stdout,
        output: `${output}\n${error.message}`.trim(),
        spawnError: true,
      });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, code, stdout, output: output.trim(), spawnError: false });
    });
  });
}

function missingGit(result: GitResult): boolean {
  return (
    result.spawnError ||
    /ENOENT|not recognized as an internal or external command|command not found/i.test(result.output)
  );
}

function firstLine(output: string): string {
  const line = output
    .split('\n')
    .map((entry) => entry.replace(/^fatal:\s*/i, '').trim())
    .find((entry) => entry !== '');
  return line === undefined ? 'git failed without producing any output' : line.slice(0, 300);
}

/**
 * Task ids become a directory name and a git ref, so they are checked rather
 * than sanitised. Silently rewriting a bad id would let two different tasks
 * collapse onto one directory, which is the failure this whole module exists to
 * prevent.
 *
 * This is `bad_request`, not an internal fault: `taskId` arrives from the client
 * in the `POST /api/code/run-task` body, so a rejected id is something the user
 * can fix by retyping. It threw a plain `Error` until an audit sent `../escape`
 * over HTTP and got back `internal_error` — which told the user we were broken
 * when the input was.
 */
function safeTaskId(taskId: string): string {
  const id = taskId.trim();
  if (id === '' || id.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes('..')) {
    throw new AppError(
      'bad_request',
      'taskId must start with a letter or digit and contain only letters, digits, dot, dash or underscore.',
      { details: { field: 'taskId' } },
    );
  }
  return id;
}
