/**
 * The process ownership registry (S3).
 *
 * Two halves. The first pins the rules the registry is for — an opaque id, a
 * server-minted token, every read/status/abort gated on it, one-way lifecycle —
 * against the registry itself. The second runs **real child processes** through
 * the terminal module and checks that what the machine actually did is what the
 * entry says happened.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { cleanupHome, testHome } from './helpers.ts';

const { createProcessRegistry, processRegistry } = await import('../src/services/terminal/registry.ts');
const { createTerminalModule } = await import('../src/services/terminal/executor.ts');
const { AppError } = await import('../src/util/errors.ts');

import type { ProcessRegistry } from '../src/services/terminal/registry.ts';

const fixturePath = path.join(testHome, 'registry-fixture.cjs');

function fixtureCommand(mode: string, ...args: string[]): string {
  return ['node', path.basename(fixturePath), mode, ...args].join(' ');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The registry, plus the tokens the terminal module normally keeps to itself. */
function instrumented(): { registry: ProcessRegistry; tokens: Map<string, string> } {
  const real = createProcessRegistry();
  const tokens = new Map<string, string>();
  const registry: ProcessRegistry = {
    ...real,
    register: (input) => {
      const minted = real.register(input);
      tokens.set(minted.id, minted.token);
      return minted;
    },
  };
  return { registry, tokens };
}

function refused(error: unknown): boolean {
  assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
  assert.equal(error.code, 'not_found');
  assert.equal(error.retryable, false);
  return true;
}

before(() => {
  fs.writeFileSync(
    fixturePath,
    [
      "const fs = require('node:fs');",
      "const [mode, value] = process.argv.slice(2);",
      "if (mode === 'streams') { process.stdout.write('stdout'); process.stderr.write('stderr'); }",
      "else if (mode === 'exit') { process.exit(Number(value)); }",
      "else if (mode === 'sleep') { setTimeout(() => {}, 10_000); }",
      "else if (mode === 'write') { fs.writeFileSync(value, 'started'); }",
    ].join('\n'),
  );
});

after(async () => cleanupHome());

describe('the process registry', () => {
  test('mints the id and the token itself, and never twice the same', () => {
    const registry = createProcessRegistry();
    const first = registry.register({ pid: 1234, workspace: '/work', command: 'echo hi' });
    const second = registry.register({ pid: 1234, workspace: '/work', command: 'echo hi' });

    assert.notEqual(first.id, second.id, 'two processes are two processes');
    assert.notEqual(first.token, second.token, 'a token minted twice is not a token');
    assert.match(first.id, /^proc_[0-9a-f-]{36}$/, 'the id names a process; it is not the pid');
    assert.match(first.token, /^[0-9a-f]{64}$/);
    // The pid is bound, not reused as the identity — proved without looking
    // inside random content. Inspecting the UUID for the substring '1234'
    // failed ~1 run in 4000 whenever the random hex happened to contain it,
    // although nothing had leaked. The deterministic facts are these: the
    // same pid minted two different ids above, and the entry still reports
    // the pid it was registered with as a field.
    assert.equal(registry.status(first.id, first.token).pid, 1234, 'the pid is bound, not reused as the identity');
    // The id does not leak or encode the ownership token. This also cannot
    // depend on random content: the token is 64 characters and the whole id
    // is 41, so the token can never appear inside the id, whatever either
    // random value happens to be.
    assert.equal(first.id.includes(first.token), false, 'the id does not leak the ownership token');
    assert.notEqual(first.id, first.token, 'the id is not the ownership token');
  });

  test('refuses a read with a different token, a missing token, or a bare id', () => {
    const registry = createProcessRegistry();
    const { id, token } = registry.register({ pid: 4321, workspace: '/work', command: 'echo hi' });
    registry.append(id, token, 'stdout', 'output');
    const other = registry.register({ pid: 4322, workspace: '/work', command: 'echo hi' });

    assert.equal(registry.read(id, token).stdout, 'output', 'the owner can read it');
    assert.throws(() => registry.read(id, other.token), refused);
    assert.throws(() => registry.read(id, ''), refused);
    assert.throws(() => registry.read(id, undefined as unknown as string), refused);
    assert.throws(() => registry.read(id, null as unknown as string), refused);
    // A bare id is exactly what a list gives a caller, and it is not enough.
    assert.throws(() => registry.read(id, id), refused);
  });

  test('refuses status and abort the same way, so a bare id touches nothing', () => {
    const registry = createProcessRegistry();
    const described = new Map<string, number>();
    const { id, token } = registry.register({
      pid: 4321,
      workspace: '/work',
      command: 'sleep 10',
      terminate: () => described.set(id, (described.get(id) ?? 0) + 1),
    });
    const other = registry.register({ pid: 4322, workspace: '/work', command: 'sleep 10' });

    assert.throws(() => registry.status(id, other.token), refused);
    assert.throws(() => registry.abort(id, other.token), refused);
    assert.throws(() => registry.abort(id, ''), refused);
    assert.equal(described.get(id), undefined, 'a refused abort does not terminate anything');
    assert.equal(registry.status(id, token).state, 'running');

    assert.equal(registry.abort(id, token), true);
    assert.equal(described.get(id), 1, 'the owner aborts it exactly once');
    assert.equal(registry.status(id, token).state, 'aborted');
  });

  test('answers a wrong token and a nonexistent id identically', () => {
    const registry = createProcessRegistry();
    const { id, token } = registry.register({ pid: 1, workspace: '/work', command: 'echo hi' });

    let wrong: InstanceType<typeof AppError> | undefined;
    let missing: InstanceType<typeof AppError> | undefined;
    try {
      registry.status(id, 'f'.repeat(64));
    } catch (error) {
      wrong = error as InstanceType<typeof AppError>;
    }
    try {
      registry.status('proc_00000000-0000-0000-0000-000000000000', token);
    } catch (error) {
      missing = error as InstanceType<typeof AppError>;
    }

    assert.ok(wrong !== undefined && missing !== undefined);
    assert.equal(
      wrong.message,
      missing.message,
      'a wrong token must not confirm that the id exists',
    );
  });

  test('binds the workspace, command, task and run it was registered with', () => {
    const registry = createProcessRegistry();
    const { id, token } = registry.register({
      pid: 999,
      taskId: 'task-7',
      runId: 'run-9',
      workspace: '/home/user/Hyperion/worktrees/task-7',
      command: 'npm test',
      now: 1_700_000_000_000,
    });

    const entry = registry.status(id, token);

    assert.equal(entry.pid, 999);
    assert.equal(entry.taskId, 'task-7');
    assert.equal(entry.runId, 'run-9');
    assert.equal(entry.workspace, '/home/user/Hyperion/worktrees/task-7');
    assert.equal(entry.command, 'npm test');
    assert.equal(entry.startedAt, 1_700_000_000_000);
    assert.equal(entry.finishedAt, null);
    assert.equal(entry.state, 'running');
    assert.equal(entry.exitCode, null);
    assert.equal(entry.timedOut, false);
  });

  test('records an execution with no task, because one route has no task', () => {
    const registry = createProcessRegistry();
    const { id, token } = registry.register({ pid: 5, workspace: '/work', command: 'echo hi' });

    const entry = registry.status(id, token);

    assert.equal(entry.taskId, null, 'null is the honest value, not an invented task');
    assert.equal(entry.runId, null);
  });

  test('moves running → completed, failed and aborted, and never again after that', () => {
    const registry = createProcessRegistry();
    const completed = registry.register({ pid: 1, workspace: '/work', command: 'true' });
    const failed = registry.register({ pid: 2, workspace: '/work', command: 'false' });
    const aborted = registry.register({ pid: 3, workspace: '/work', command: 'sleep 1' });

    registry.finish(completed.id, completed.token, { state: 'completed', exitCode: 0, now: 1_000 });
    registry.finish(failed.id, failed.token, { state: 'failed', exitCode: 7, now: 1_001 });
    assert.equal(registry.abort(aborted.id, aborted.token), true);

    assert.equal(registry.status(completed.id, completed.token).state, 'completed');
    assert.equal(registry.status(failed.id, failed.token).exitCode, 7);
    assert.deepEqual(
      [completed, failed, aborted].map((entry) => registry.status(entry.id, entry.token).state),
      ['completed', 'failed', 'aborted'],
    );

    // The close event that follows a kill says nothing new.
    const after = registry.finish(aborted.id, aborted.token, { state: 'completed', exitCode: 0, now: 1_002 });
    assert.equal(after.state, 'aborted');
    assert.equal(after.exitCode, null, 'a terminated process has no exit code to report');
    assert.equal(registry.abort(aborted.id, aborted.token), false, 'nothing is left to terminate');
    assert.equal(registry.abort(completed.id, completed.token), false);
  });

  test('separates the two streams and bounds each one', () => {
    const registry = createProcessRegistry();
    const { id, token } = registry.register({ pid: 1, workspace: '/work', command: 'chatty' });

    registry.append(id, token, 'stdout', 'o'.repeat(300_000));
    registry.append(id, token, 'stderr', 'e');
    const snapshot = registry.read(id, token);

    assert.equal(snapshot.stderr, 'e', 'a truncated stdout does not touch stderr');
    assert.equal(snapshot.stdout.endsWith('\n[output truncated after 262144 bytes]\n'), true);
    assert.equal(Buffer.byteLength(snapshot.stdout), 262_144 + Buffer.byteLength('\n[output truncated after 262144 bytes]\n'));

    // The append path is owned too: no token, no write.
    assert.throws(() => registry.append(id, 'nope', 'stdout', 'x'), refused);
  });

  test('lists every entry newest first and strips the token', () => {
    const registry = createProcessRegistry();
    const first = registry.register({ pid: 1, workspace: '/work', command: 'first', taskId: 'task-1' });
    const second = registry.register({ pid: 2, workspace: '/work', command: 'second', runId: 'run-2' });

    const entries = registry.list();

    assert.deepEqual(
      entries.map((entry) => entry.command),
      ['second', 'first'],
      'newest first, the order every other list view in the app uses',
    );
    assert.equal(entries[0]?.runId, 'run-2');
    assert.equal(entries[1]?.taskId, 'task-1');
    for (const entry of entries) {
      assert.deepEqual(
        Object.keys(entry).includes('token'),
        false,
        'a listed process is precisely a caller who does not own it',
      );
    }
    assert.equal(JSON.stringify(entries).includes(first.token), false);
    assert.equal(JSON.stringify(entries).includes(second.token), false);
  });

  test('hands out copies, so a caller cannot reach back into the registry', () => {
    const registry = createProcessRegistry();
    const { id, token } = registry.register({ pid: 1, workspace: '/work', command: 'true' });

    const entry = registry.status(id, token);
    entry.state = 'completed';
    entry.command = 'rm -rf /';

    assert.equal(registry.status(id, token).state, 'running');
    assert.equal(registry.status(id, token).command, 'true');
    assert.equal(registry.list()[0]?.command, 'true');
  });

  test('keeps finished entries bounded and running ones unbounded in that budget', () => {
    const registry = createProcessRegistry();
    const longRunning = registry.register({ pid: 1, workspace: '/work', command: 'sleep 1000' });

    for (let index = 0; index < 205; index += 1) {
      const entry = registry.register({ pid: index + 2, workspace: '/work', command: `run-${index}` });
      registry.finish(entry.id, entry.token, { state: 'completed', exitCode: 0 });
    }

    const entries = registry.list();
    assert.ok(entries.length <= 201, `a registry that never forgets is a leak (${entries.length} entries)`);
    assert.equal(
      entries.some((entry) => entry.id === longRunning.id),
      true,
      'the registry never evicts a process that is still running',
    );
    assert.equal(entries[0]?.command, 'run-204', 'the newest finished entry survives');
  });

  test('the module singleton is the one the terminal registers into', () => {
    assert.equal(typeof processRegistry.register, 'function');
    assert.notEqual(processRegistry, createProcessRegistry(), 'a second registry answers a different question');
  });
});

describe('the terminal module, registering real processes', () => {
  test('binds the pid, task, run, workspace and command of a real execution', async () => {
    const { registry, tokens } = instrumented();
    const module = createTerminalModule({ registry });

    const result = await module.executeCommand(testHome, fixtureCommand('streams'), {
      taskId: 'task-reg-1',
      runId: 'run-reg-1',
    });

    assert.equal(result.stdout, 'stdout');
    assert.equal(result.stderr, 'stderr');
    const entries = registry.list();
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.taskId, 'task-reg-1');
    assert.equal(entry.runId, 'run-reg-1');
    assert.equal(entry.workspace, testHome, 'the canonical cwd the command actually ran in');
    assert.equal(entry.command, fixtureCommand('streams'));
    assert.equal(typeof entry.pid, 'number');
    assert.ok(entry.pid !== null && entry.pid > 0);
    assert.equal(entry.state, 'completed');
    assert.equal(entry.exitCode, 0);
    assert.equal(entry.timedOut, false);
    assert.ok(entry.finishedAt !== null && entry.finishedAt >= entry.startedAt);

    // The owner can still read the output afterwards; the list cannot leak it.
    const token = tokens.get(entry.id)!;
    assert.equal(registry.read(entry.id, token).stdout, 'stdout');
    assert.equal(JSON.stringify(registry.list()).includes(token), false);
  });

  test('records a nonzero exit as failed, not completed', async () => {
    const { registry, tokens } = instrumented();
    const module = createTerminalModule({ registry });

    const result = await module.executeCommand(testHome, fixtureCommand('exit', '7'), { taskId: 'task-7' });

    const entry = registry.list()[0]!;
    assert.equal(result.exitCode, 7);
    assert.equal(entry.state, 'failed');
    assert.equal(entry.exitCode, 7);
    assert.equal(registry.status(entry.id, tokens.get(entry.id)!).state, 'failed');
  });

  test('records a cancelled execution as aborted, before the kill lands', async () => {
    const { registry, tokens } = instrumented();
    const module = createTerminalModule({ registry });
    const controller = new AbortController();
    const pending = module.executeCommand(testHome, fixtureCommand('sleep'), { signal: controller.signal });
    controller.abort();

    await assert.rejects(pending, (error: unknown) => error instanceof AppError && error.code === 'aborted');

    const entry = registry.list()[0]!;
    assert.equal(entry.state, 'aborted');
    assert.equal(entry.timedOut, false, 'a cancellation is not a timeout');
    assert.ok(entry.finishedAt !== null);
    await delay(200);
    assert.equal(
      registry.status(entry.id, tokens.get(entry.id)!).state,
      'aborted',
      'the close event that follows the kill cannot rewrite the outcome',
    );
  });

  test('records a killed timeout as aborted and flagged, not as a failure of the command', async () => {
    const { registry, tokens } = instrumented();
    const module = createTerminalModule({ registry });

    const result = await module.executeCommand(testHome, fixtureCommand('sleep'), { timeoutMs: 75 });

    const entry = registry.list()[0]!;
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 124);
    assert.equal(entry.state, 'aborted');
    assert.equal(entry.timedOut, true);
    assert.equal(entry.exitCode, 124);
    assert.equal(registry.status(entry.id, tokens.get(entry.id)!).timedOut, true);
  });

  test('registers each execution separately, including a route-level one with no task', async () => {
    const { registry } = instrumented();
    const module = createTerminalModule({ registry });

    await module.executeCommand(testHome, fixtureCommand('streams'));
    await module.executeCommand(testHome, fixtureCommand('streams'), { taskId: 'task-two' });

    const entries = registry.list();
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.taskId, 'task-two');
    assert.equal(entries[1]?.taskId, null);
    assert.equal(entries[0]?.pid === entries[1]?.pid, false, 'two executions are two processes');
  });

  test('does not register a command it never started', async () => {
    const { registry } = instrumented();
    const module = createTerminalModule({ registry });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(module.executeCommand(testHome, fixtureCommand('streams'), { signal: controller.signal }));
    // An invalid timeout is rejected before anything is spawned, so it throws
    // rather than returning a rejected promise — hence the sync assertion.
    assert.throws(
      () => {
        void module.executeCommand(testHome, fixtureCommand('streams'), { timeoutMs: 0 });
      },
      (error: unknown) => error instanceof AppError && error.code === 'bad_request',
    );

    assert.equal(registry.list().length, 0, 'nothing ran, so there is nothing to track');
  });
});
