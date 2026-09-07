/** Production terminal registration and policy are exercised over HTTP. */
import './helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

import type { Server } from 'node:http';
import { cleanupHome, freshDb, testHome } from './helpers.ts';

const { createApp } = await import('../src/http/app.ts');
const { setCapability } = await import('../src/db/settings.ts');
const { registerProductionModules } = await import('../src/services/agent/composition.ts');
const { resetModules } = await import('../src/orchestrator/agents.ts');

const fixturePath = path.join(testHome, 'projects', 'terminal-route-fixture.cjs');
let server: Server;
let base: string;

function fixtureCommand(mode: string): string {
  return `node ${path.basename(fixturePath)} ${mode}`;
}

function post(payload: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/code/execute-command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

before(async () => {
  await freshDb();
  fs.writeFileSync(
    fixturePath,
    "const mode = process.argv[2]; if (mode === 'print') process.stdout.write('live'); else setTimeout(() => {}, 10_000);\n",
  );
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

beforeEach(() => {
  resetModules();
  registerProductionModules();
  setCapability('code_execution', true);
});

describe('production terminal HTTP boundary', () => {
  test('reports Cowork, Code, and terminal live while leaving Design absent', async () => {
    const response = await fetch(`${base}/api/agents/status`);
    const payload = (await response.json()) as {
      agents: string[];
      terminal: boolean;
      registered: Record<string, boolean>;
    };

    assert.equal(response.status, 200);
    assert.deepEqual(payload.agents, ['cowork', 'code']);
    assert.equal(payload.terminal, true);
    assert.deepEqual(payload.registered, { code: true, cowork: true, design: false });
  });

  test('executes a real command through the registered terminal', async () => {
    const response = await post({ cwd: '.', command: fixtureCommand('print') });
    const payload = (await response.json()) as {
      result: { stdout: string; stderr: string; exitCode: number; timedOut: boolean };
    };

    assert.equal(response.status, 200);
    assert.deepEqual(payload.result, { stdout: 'live', stderr: '', exitCode: 0, timedOut: false });
  });

  test('rejects an invalid timeout with the complete validation envelope', async () => {
    const response = await post({ command: fixtureCommand('print'), timeoutMs: 0 });
    const payload = (await response.json()) as {
      error: { code: string; message: string; retryable: boolean; details?: { field?: string } };
    };

    assert.equal(response.status, 400);
    assert.deepEqual(payload.error, {
      code: 'bad_request',
      message: 'timeoutMs must be a positive integer.',
      retryable: false,
      details: { field: 'timeoutMs' },
    });
  });

  test('returns timeout as a command result rather than an HTTP failure', async () => {
    const response = await post({ command: fixtureCommand('sleep'), timeoutMs: 100 });
    const payload = (await response.json()) as {
      result: { exitCode: number; timedOut: boolean };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.result.timedOut, true);
    assert.equal(payload.result.exitCode, 124);
  });

  test('refuses a cwd outside the projects scope before launching a process', async () => {
    const response = await post({ cwd: '../../outside', command: fixtureCommand('print') });
    const payload = (await response.json()) as { error: { code: string; retryable: boolean } };

    assert.equal(response.status, 403);
    assert.equal(payload.error.code, 'scope_violation');
    assert.equal(payload.error.retryable, false);
  });

  test('checks the code-execution capability before cwd containment', async () => {
    setCapability('code_execution', false);

    const response = await post({ cwd: '../../outside', command: fixtureCommand('print') });
    const payload = (await response.json()) as {
      error: { code: string; retryable: boolean; details?: { capability?: string } };
    };

    assert.equal(response.status, 403);
    assert.equal(payload.error.code, 'capability_disabled');
    assert.equal(payload.error.retryable, false);
    assert.deepEqual(payload.error.details, { capability: 'code_execution' });
  });
});