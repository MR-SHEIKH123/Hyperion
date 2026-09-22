/**
 * The recovery read for an interrupted run (1.31).
 *
 * Item 1.31 lists a recovery surface beside the `interrupted` state, and the state
 * half landed on its own: boot reconciliation demotes a run the dead process left
 * mid-flight, and the state reaches the routes, the queue, the wire enum and the
 * banner. What did not land is everything a person needs *after* being told the
 * run ended — what it got as far as doing, whether its edits are still on disk,
 * and which of the three verbs (view / resume / discard) is actually available.
 *
 * This file tests the read that answers those three questions, and each claim is
 * one way the answer could be wrong in a way that costs somebody their work:
 *
 *   - **Coverage is stated, not implied.** The steps come back bounded, and the
 *     totals come from SQL over all of them, so a truncated list cannot read as a
 *     short run. Same rule the worktree scan's `unchecked` follows.
 *   - **The worktree answer is live.** One task's directory is looked up by name
 *     and risk-checked on the spot, because "your uncommitted edits are still
 *     there" is a fact about the disk now, not about the last scan.
 *   - **A checkout a live task owns is never offered for discard.** The registry is
 *     consulted, and the refusal says which of the two reasons it is: in use, or
 *     nothing there.
 *   - **Asking whether a resume is possible does not stop the run.** `cancelRun`
 *     both answers that question and aborts the run; the report uses a reader, and
 *     one of the cases below pins that the live run survives the question.
 *
 * Real git, real repositories — the interesting behaviour is git's (`status
 * --porcelain` deciding "uncommitted changes"), and a stub would only assert this
 * file's assumptions about it. Skips cleanly where git is absent.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, beforeEach, describe, it } from 'node:test';

import { cleanupHome, freshDb, testHome } from './helpers.ts';

type WorktreeModule = typeof import('../src/services/code/worktree.ts');
type CancelModule = typeof import('../src/orchestrator/cancel.ts');
type TaskRunsModule = typeof import('../src/db/taskRuns.ts');
type TaskStepsModule = typeof import('../src/db/taskSteps.ts');
type TaskMessagesModule = typeof import('../src/db/taskMessages.ts');

let worktrees: WorktreeModule;
let cancel: CancelModule;
let runs: TaskRunsModule;
let steps: TaskStepsModule;
let messages: TaskMessagesModule;
let server: http.Server;
let base = '';

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
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
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

/** A checkout a previous process left behind, the way the server builds one. */
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

/**
 * A run a dead process left mid-flight, through the production path.
 *
 * Starting a run writes `state = 'running'`, and `reconcileOrphanedTaskRuns()` is
 * what a restart does to it. Using the real pair rather than writing the terminal
 * row by hand means the report is tested against the rows that actually exist
 * after an unclean shutdown, `error_code` and `error_message` included.
 */
function interruptedRun(taskId: string, tool: 'code' | 'cowork' | 'design' = 'code') {
  // The run id carries the tool: `startTaskRun` is `INSERT OR REPLACE` on the run
  // id (a retried run is the same run restarting), so two tools sharing a task id
  // and a run id would leave only one row behind — which is the fixture's bug to
  // avoid, not the product's.
  runs.startTaskRun({ runId: `run-${tool}-${taskId}`, taskId, tool });
  const demoted = runs.reconcileOrphanedTaskRuns();
  assert.equal(demoted, 1, 'the reconciliation must have demoted exactly this run');
  const run = runs.latestRunForTask(tool, taskId);
  assert.ok(run, 'the run must exist');
  assert.equal(run.state, 'interrupted');
  return run;
}

async function report(tool: string, taskId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/${tool}/tasks/${taskId}/recovery`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

before(async () => {
  const env = await import('../src/config/env.ts');
  env.ensureDirectories();
  // Git in the sandbox must not read the developer's own config: a global
  // `commit.gpgsign` or an `init.defaultBranch` would change what these fixtures
  // produce. The orphan-worktree suite does the same.
  const absent = path.join(testHome, 'absent-gitconfig');
  process.env.GIT_CONFIG_GLOBAL = absent;
  process.env.GIT_CONFIG_SYSTEM = absent;

  worktrees = await import('../src/services/code/worktree.ts');
  cancel = await import('../src/orchestrator/cancel.ts');
  runs = await import('../src/db/taskRuns.ts');
  steps = await import('../src/db/taskSteps.ts');
  messages = await import('../src/db/taskMessages.ts');

  const { createApp } = await import('../src/http/app.ts');
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  worktrees.resetWorktrees();
  cancel.resetCancellations();
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

describe('the report answers for a task, or says it has never heard of it', () => {
  it('404s for a task with no run, naming the task', async () => {
    const missing = await report('code', 'never-ran');
    assert.equal(missing.status, 404);
    assert.deepEqual((missing.body.error as { details: unknown }).details, { taskId: 'never-ran' });
  });

  it('answers for a run that is not interrupted, instead of pretending it never existed', async () => {
    // The state a caller meant to ask about can have moved on between the list and
    // the click. "It completed, there is nothing to recover" is an answer; a 404
    // reads like the task was never there.
    runs.startTaskRun({ runId: 'run-done', taskId: 'finished', tool: 'code' });
    runs.finishTaskRun('run-done', 'complete');

    const done = await report('code', 'finished');
    assert.equal(done.status, 200);
    assert.equal(done.body.interrupted, false);
    assert.equal((done.body.run as { state: string }).state, 'complete');
    assert.equal(done.body.stop, null, 'a run that stopped cleanly has no stop to report');
  });
});

describe('why it stopped is reported the way the reconciliation wrote it', () => {
  it('carries the state, the cause and the moment', async () => {
    const run = interruptedRun('restarted');

    const result = await report('code', 'restarted');
    assert.equal(result.status, 200);
    const stop = result.body.stop as { code: string; message: string; at: number };
    assert.equal(stop.code, 'internal_error');
    // The message names the process, not a failure — that sentence is the whole
    // reason `interrupted` exists rather than `error`.
    assert.match(stop.message, /server restarted while this task was running/i);
    assert.equal(stop.at, run.completedAt);
  });

  it('reports the blocked flavour differently from the running one', async () => {
    // A run that died waiting for an answer gets the other sentence, because the
    // user's prompt went nowhere and that is what they need to know.
    runs.startTaskRun({ runId: 'run-waiting', taskId: 'waiting', tool: 'code' });
    runs.finishTaskRun('run-waiting', 'blocked', { pauseReason: 'approval' });
    // `blocked` is a parked state; the reconciliation is what a restart does to it.
    runs.reconcileOrphanedTaskRuns();

    const result = await report('code', 'waiting');
    const stop = result.body.stop as { code: string; message: string };
    assert.equal(stop.code, 'internal_error');
    assert.match(stop.message, /waiting for you/i);
  });
});

describe('the partial work is the run\'s own history, bounded and counted', () => {
  it('returns the tail of the steps with the totals over all of them', () => {
    const run = interruptedRun('long-run');
    for (let index = 1; index <= 60; index++) {
      steps.recordStep({
        runId: run.runId,
        step: index,
        kind: index % 2 === 0 ? 'tool_call' : 'turn',
        toolName: index % 2 === 0 ? 'read_file' : undefined,
        ok: index % 10 === 0 ? false : true,
        tokensIn: 10,
        tokensOut: 5,
      });
    }
    return report('code', 'long-run').then((result) => {
      const partial = result.body.partial as {
        steps: { step: number; kind: string; createdAt: number }[];
        summary: { steps: number; toolCalls: number; failures: number; tokensIn: number; complete: boolean };
        omitted: number;
        lastStepAt: number;
      };
      assert.equal(partial.steps.length, 50, 'the tail is bounded');
      assert.equal(partial.steps[0]?.step, 11, 'and it is the *last* fifty that come back');
      assert.equal(partial.omitted, 10);
      assert.equal(partial.summary.steps, 60, 'the totals come from the whole table');
      assert.equal(partial.summary.toolCalls, 30);
      assert.equal(partial.summary.failures, 6);
      assert.equal(partial.summary.tokensIn, 600);
      assert.equal(partial.summary.complete, true, 'every step reported a count');
      assert.equal(partial.lastStepAt, partial.steps[partial.steps.length - 1]?.createdAt,
        'the timestamp is the last step taken, not the first one listed');
    });
  });

  it('a run with no steps is empty, not an error', async () => {
    interruptedRun('did-nothing');
    const result = await report('code', 'did-nothing');
    const partial = result.body.partial as {
      steps: unknown[];
      omitted: number;
      lastStepAt: number | null;
      summary: { steps: number; complete: boolean };
    };
    assert.deepEqual(partial.steps, []);
    assert.equal(partial.omitted, 0);
    assert.equal(partial.lastStepAt, null);
    assert.equal(partial.summary.steps, 0);
    // No steps is vacuously complete: there is no unreported count to be missing.
    assert.equal(partial.summary.complete, true);
  });

  it('says whether the run\'s conversation survived the process', async () => {
    interruptedRun('talked');
    const before = await report('code', 'talked');
    assert.deepEqual(
      (before.body.partial as { conversation: unknown }).conversation,
      { durable: false, messages: 0 },
      'a killed run has no snapshot unless one was taken at a stopping point',
    );

    messages.snapshotConversation('talked', [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: 'doing it' },
    ]);
    const after = await report('code', 'talked');
    assert.deepEqual((after.body.partial as { conversation: unknown }).conversation, {
      durable: true,
      messages: 2,
    });
  });
});

describe('the leftover checkout is checked now, not as of the last scan', () => {
  it('reports the directory and what removing it would lose', gitOnly, async () => {
    const repo = makeRepo('app');
    interruptedRun('task-left');
    leaveWorktreeBehind(repo, 'task-left', { 'src/parser.ts': 'export const x = 1;\n' });

    const result = await report('code', 'task-left');
    const worktree = result.body.worktree as { name: string; taskId: string; risk: string; checked: boolean };
    assert.equal(worktree.name, 'task-left');
    assert.equal(worktree.taskId, 'task-left');
    assert.equal(worktree.checked, true);
    assert.equal(worktree.risk, 'it has uncommitted changes');

    const discard = (result.body.actions as { discard: { possible: boolean; name: string; requiresForce: boolean } })
      .discard;
    assert.equal(discard.possible, true);
    assert.equal(discard.name, 'task-left');
    assert.equal(discard.requiresForce, true, 'work is at stake, so the removal needs forcing');
  });

  it('a clean leftover needs no force', gitOnly, async () => {
    const repo = makeRepo('clean-app');
    interruptedRun('task-clean');
    leaveWorktreeBehind(repo, 'task-clean');

    const result = await report('code', 'task-clean');
    const worktree = result.body.worktree as { risk: string | null; checked: boolean };
    assert.equal(worktree.risk, null, 'a checkout with nothing in it provably holds nothing');
    assert.equal(worktree.checked, true);
    const discard = (result.body.actions as { discard: { requiresForce: boolean } }).discard;
    assert.equal(discard.requiresForce, false);
  });

  it('says "nothing to discard" rather than reporting an empty directory', async () => {
    interruptedRun('task-gone');
    const result = await report('code', 'task-gone');
    assert.equal(result.body.worktree, null);
    const discard = (result.body.actions as { discard: { possible: boolean; reason: string } }).discard;
    assert.equal(discard.possible, false);
    assert.match(discard.reason, /no leftover checkout/i);
  });

  it('never offers a checkout a live task owns', gitOnly, async () => {
    const repo = makeRepo('live-app');
    interruptedRun('task-live');
    // The registry is what makes a directory *not* an orphan, and a live
    // provisioning is how it gets there.
    const provisioned = await worktrees.provisionWorktree('task-live', repo);

    const result = await report('code', 'task-live');
    assert.equal(result.body.worktree, null, 'a registered checkout is not an orphan');
    const discard = (result.body.actions as { discard: { possible: boolean; reason: string } }).discard;
    assert.equal(discard.possible, false);
    assert.match(discard.reason, /running task owns this checkout/i);
  });

  it('prefers the newest directory when a task left more than one', gitOnly, async () => {
    const repo = makeRepo('twice');
    interruptedRun('task-twice');
    leaveWorktreeBehind(repo, 'task-twice');
    leaveWorktreeBehind(repo, 'task-twice-2', { 'notes.md': 'second attempt\n' });

    const result = await report('code', 'task-twice');
    // `freePath`'s suffix means the same preference a re-run's adoption makes, so
    // the report describes the directory the re-run would actually attach to.
    assert.equal((result.body.worktree as { name: string }).name, 'task-twice-2');
  });
});

describe('resuming is a question, and asking it must not stop the run', () => {
  it('a run that is live makes a re-run impossible, and survives being asked', async () => {
    interruptedRun('busy-task');
    const live = cancel.registerCancellable('run-code-busy-task', 'code', 'busy-task');
    try {
      const result = await report('code', 'busy-task');
      const resume = (result.body.actions as { resume: { possible: boolean; reason: string } }).resume;
      assert.equal(resume.possible, false);
      assert.match(resume.reason, /already running/);
      // The point of a reader rather than `cancelRun`: the run is still registered
      // and was not marked cancelled by a recovery *read*.
      assert.equal(cancel.isCancelled('run-code-busy-task'), false);
      assert.equal(cancel.cancellableCount(), 1);
    } finally {
      live.dispose();
    }
  });

  it('nothing live means a re-run is available', async () => {
    interruptedRun('idle-task');
    const result = await report('code', 'idle-task');
    const resume = (result.body.actions as { resume: { possible: boolean; reason: string | null } }).resume;
    assert.equal(resume.possible, true);
    assert.equal(resume.reason, null);
  });
});

describe('every tool that owns a task run answers on its own route', () => {
  it('serves code, cowork and design, and keeps their runs apart', async () => {
    interruptedRun('shared-id', 'code');
    interruptedRun('shared-id', 'cowork');

    for (const tool of ['code', 'cowork', 'design'] as const) {
      runs.startTaskRun({ runId: `run-${tool}-only`, taskId: 'only-here', tool });
      runs.finishTaskRun(`run-${tool}-only`, 'complete');
      const result = await report(tool, 'only-here');
      assert.equal(result.status, 200, tool);
      assert.equal((result.body.run as { tool: string }).tool, tool);
    }

    const code = await report('code', 'shared-id');
    const cowork = await report('cowork', 'shared-id');
    assert.equal((code.body.run as { tool: string }).tool, 'code');
    assert.equal((cowork.body.run as { tool: string }).tool, 'cowork');
  });
});
