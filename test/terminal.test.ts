/** The terminal module is exercised through real local child processes. */
import './helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { cleanupHome, testHome } from './helpers.ts';

const { createTerminalModule } = await import('../src/services/terminal/executor.ts');
const { AppError } = await import('../src/util/errors.ts');

const fixturePath = path.join(testHome, 'terminal-fixture.cjs');
const sentinelPath = path.join(testHome, 'terminal-descendant-finished.txt');

function fixtureCommand(mode: string, ...args: string[]): string {
  return ['node', path.basename(fixturePath), mode, ...args].join(' ');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

before(() => {
  fs.writeFileSync(
    fixturePath,
    [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const [mode, value] = process.argv.slice(2);",
      "if (mode === 'streams') { process.stdout.write('stdout'); process.stderr.write('stderr'); }",
      "else if (mode === 'exit') { process.exit(Number(value)); }",
      "else if (mode === 'sleep') { setTimeout(() => {}, 10_000); }",
      "else if (mode === 'output') { process.stdout.write('o'.repeat(300_000)); process.stderr.write('e'.repeat(300_000)); }",
      "else if (mode === 'write') { fs.writeFileSync(value, 'started'); }",
      "else if (mode === 'sentinel') { setTimeout(() => fs.writeFileSync(value, 'finished'), 800); }",
      "else if (mode === 'tree') { spawn(process.execPath, [__filename, 'sentinel', value], { stdio: 'ignore' }); setTimeout(() => {}, 10_000); }",
    ].join('\n'),
  );
});

after(async () => cleanupHome());

describe('local terminal execution', () => {
  test('keeps stdout and stderr separate', async () => {
    const result = await createTerminalModule().executeCommand(testHome, fixtureCommand('streams'));

    assert.deepEqual(result, { stdout: 'stdout', stderr: 'stderr', exitCode: 0, timedOut: false });
  });

  test('returns a nonzero exit as a command result', async () => {
    const result = await createTerminalModule().executeCommand(testHome, fixtureCommand('exit', '7'));

    assert.equal(result.exitCode, 7);
    assert.equal(result.timedOut, false);
  });

  test('times out with exit code 124 and terminates descendants', async () => {
    fs.rmSync(sentinelPath, { force: true });

    const result = await createTerminalModule().executeCommand(
      testHome,
      fixtureCommand('tree', path.basename(sentinelPath)),
      { timeoutMs: 100 },
    );

    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 124);
    await delay(1_000);
    assert.equal(fs.existsSync(sentinelPath), false, 'a descendant survived the timed-out command');
  });

  test('rejects cancellation with the coded aborted error', async () => {
    fs.rmSync(sentinelPath, { force: true });
    const controller = new AbortController();
    const pending = createTerminalModule().executeCommand(
      testHome,
      fixtureCommand('tree', path.basename(sentinelPath)),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'aborted');
      assert.equal(error.retryable, false);
      return true;
    });
    await delay(1_000);
    assert.equal(fs.existsSync(sentinelPath), false, 'a descendant survived the cancelled command');
  });

  test('does not launch a command when cancellation is already requested', async () => {
    fs.rmSync(sentinelPath, { force: true });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      createTerminalModule().executeCommand(testHome, fixtureCommand('write', path.basename(sentinelPath)), {
        signal: controller.signal,
      }),
      (error: unknown) => error instanceof AppError && error.code === 'aborted',
    );
    assert.equal(fs.existsSync(sentinelPath), false);
  });

  test('bounds stdout and stderr independently', async () => {
    const result = await createTerminalModule().executeCommand(testHome, fixtureCommand('output'));
    const marker = '\n[output truncated after 262144 bytes]\n';

    assert.equal(result.stdout.endsWith(marker), true);
    assert.equal(result.stderr.endsWith(marker), true);
    assert.equal(Buffer.byteLength(result.stdout), 262_144 + Buffer.byteLength(marker));
    assert.equal(Buffer.byteLength(result.stderr), 262_144 + Buffer.byteLength(marker));
  });

  test('rejects an invalid timeout as bad input for direct callers', async () => {
    await assert.rejects(
      Promise.resolve().then(() => createTerminalModule().executeCommand(testHome, fixtureCommand('streams'), { timeoutMs: 0 })),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'bad_request');
        assert.deepEqual(error.details, { field: 'timeoutMs' });
        return true;
      },
    );
  });

  test('keeps process launch diagnostics out of the public error', async () => {
    const missingCwd = path.join(testHome, 'missing-cwd');

    await assert.rejects(
      createTerminalModule().executeCommand(missingCwd, fixtureCommand('streams')),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'internal_error');
        assert.equal(error.message, 'The terminal process could not be started.');
        assert.deepEqual(error.toJSON(), {
          error: {
            code: 'internal_error',
            message: 'The terminal process could not be started.',
            retryable: false,
          },
        });
        assert.equal(typeof error.privateDetails?.cause, 'string');
        return true;
      },
    );
  });
});