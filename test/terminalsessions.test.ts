/**
 * The structurally authenticated human-takeover bypass (S17).
 *
 * The rule under test is asymmetric, so the tests are: a command claiming the
 * exemption with a server-minted token of a *live* session runs without the
 * permission engine's evaluation, and **everything else** — no claim, an unknown
 * session, a wrong token, a closed session, an expired one, a token from another
 * session — is evaluated like any other automated command and is refused when the
 * engine says deny.
 *
 * The project rules are real files on disk (`.hyperion/permissions` in the test
 * project), because that is what "through normal permission evaluation" means: the
 * same layers, read the same way, as an agent's run.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

import { createApp } from '../src/http/app.ts';
import { cleanupHome, freshDb, testHome } from './helpers.ts';

const { terminalSessions, createSessionStore } = await import('../src/services/terminal/sessions.ts');
const { createTerminalModule } = await import('../src/services/terminal/executor.ts');
const { createProcessRegistry } = await import('../src/services/terminal/registry.ts');
const { registerTerminal } = await import('../src/orchestrator/agents.ts');
const { setCapability } = await import('../src/db/settings.ts');
const { provisionWorktree } = await import('../src/services/code/worktree.ts');

import type { Express } from 'express';

const projectDir = path.join(testHome, 'projects', 'bypass-project');
const permissionsFile = path.join(projectDir, '.hyperion', 'permissions.json');
/** The project whose rules the command route is asked to evaluate against. */
const projectQuery = '?project=bypass-project';

let app: Express;
let registry: ReturnType<typeof createProcessRegistry>;

/**
 * Write the project's permission rules. `null` removes the file, which is what a
 * default install has.
 */
function setProjectRules(rules: Record<string, string> | null): void {
  if (rules === null) {
    fs.rmSync(permissionsFile, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(permissionsFile), { recursive: true });
  fs.writeFileSync(permissionsFile, `${JSON.stringify(rules, null, 2)}\n`);
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A real project repository, so a task can have a real worktree of its own. */
function makeRepo(): string {
  const repo = path.join(testHome, 'projects', 'bypass-repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'tests@hyperion.local'], repo);
  git(['config', 'user.name', 'Hyperion Tests'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# bypass fixture\n');
  git(['add', '.'], repo);
  git(['commit', '-qm', 'fixture'], repo);
  return repo;
}

async function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function get(url: string) {
  const response = await fetch(`${base}${url}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

let server: ReturnType<Express['listen']>;
let base = '';
/** A task with a real worktree, so task ownership is checkable rather than claimed. */
let taskWorktree = '';

before(async () => {
  await freshDb();
  // A missing git config is an empty one, so the fixture does not depend on this
  // machine's global settings.
  const absent = path.join(testHome, 'absent-gitconfig');
  process.env.GIT_CONFIG_GLOBAL = absent;
  process.env.GIT_CONFIG_SYSTEM = absent;
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.mkdirSync(projectDir, { recursive: true });
  const worktree = await provisionWorktree('bypass-task', makeRepo());
  taskWorktree = worktree.dir;
  registry = createProcessRegistry();
  registerTerminal(createTerminalModule({ registry }));
  app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  base = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : '';
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

beforeEach(() => {
  setProjectRules(null);
  setCapability('code_execution', true);
  // A fresh registry per test: entries are the audit trail, and counting them
  // across tests would count somebody else's commands.
  registry = createProcessRegistry();
  registerTerminal(createTerminalModule({ registry }));
});

describe('opening a session', () => {
  test('mints the id and the token on the server, and returns the token once', async () => {
    const opened = await post('/api/terminal/sessions', { client: 'test-browser' });

    assert.equal(opened.status, 201);
    const session = opened.body.session as Record<string, unknown>;
    assert.match(String(session.id), /^tsess_[0-9a-f-]{36}$/);
    assert.match(String(opened.body.token), /^[0-9a-f]{64}$/);
    assert.equal(session.taskId, null);
    assert.equal(session.client, 'test-browser');
    assert.ok(typeof opened.body.expiresAt === 'number');

    const listed = await get('/api/terminal/sessions');
    assert.equal(listed.status, 200);
    const body = JSON.stringify(listed.body);
    assert.equal(body.includes(String(opened.body.token)), false, 'a listed token is a token anybody can use');
    assert.equal(body.includes(String(session.id)), true, 'the session itself is listed');
  });

  test('mints a different token every time, even for the same client', async () => {
    const first = await post('/api/terminal/sessions', { client: 'same-browser' });
    const second = await post('/api/terminal/sessions', { client: 'same-browser' });

    assert.notEqual(first.body.token, second.body.token);
    assert.notEqual((first.body.session as Record<string, unknown>).id, (second.body.session as Record<string, unknown>).id);
  });

  test('ends a session on close, and only for the token holder', async () => {
    const opened = await post('/api/terminal/sessions', {});
    const sessionId = String((opened.body.session as Record<string, unknown>).id);
    const token = String(opened.body.token);

    const stolen = await post(`/api/terminal/sessions/${sessionId}/close`, {}, { 'x-hyperion-session-token': 'f'.repeat(64) });
    assert.equal(stolen.status, 404, 'a wrong token cannot end somebody else’s session');

    const closed = await post(`/api/terminal/sessions/${sessionId}/close`, {}, { 'x-hyperion-session-token': token });
    assert.equal(closed.status, 200);
    assert.equal((closed.body.session as Record<string, unknown>).endedReason, 'closed');
    assert.equal(
      terminalSessions.authenticate({ sessionId, token }).ok,
      false,
      'a closed session cannot be reopened by presenting the same token again',
    );
  });

  test('answers an unknown session id the same way as a wrong token', async () => {
    const opened = await post('/api/terminal/sessions', {});
    const token = String(opened.body.token);

    const unknown = await post('/api/terminal/sessions/tsess_missing/close', {}, { 'x-hyperion-session-token': token });

    assert.equal(unknown.status, 404);
    assert.equal(
      (unknown.body.error as Record<string, unknown>).message,
      'No live terminal session with that id belongs to this caller.',
      'the answer must not reveal which session ids exist',
    );
  });
});

describe('a command that claims the exemption', () => {
  test('runs without the permission engine when a live session authenticates it', async () => {
    setProjectRules({ bash: 'deny' });
    const opened = await post('/api/terminal/sessions', {});
    const token = String(opened.body.token);
    const sessionId = String((opened.body.session as Record<string, unknown>).id);

    const ran = await post(
      '/api/code/execute-command' + projectQuery,
      { command: 'echo bypassed', cwd: projectDir },
      { 'x-hyperion-session': sessionId, 'x-hyperion-session-token': token },
    );

    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    assert.equal((ran.body.result as Record<string, unknown>).stdout, 'bypassed\n');
    assert.equal(ran.body.bypass, 'human_session');
    assert.equal(ran.body.sessionId, sessionId);
    // The registry is the audit trail, and it says which session ran it.
    assert.equal(registry.list()[0]?.sessionId, sessionId);
    assert.equal(registry.list()[0]?.state, 'completed');
  });

  test('is refused when no session is claimed, because the project denies bash', async () => {
    setProjectRules({ bash: 'deny' });

    const refusedCommand = await post(`/api/code/execute-command${projectQuery}`, { command: 'echo nope', cwd: projectDir });

    assert.equal(refusedCommand.status, 403);
    const error = refusedCommand.body.error as Record<string, unknown>;
    assert.equal(error.code, 'permission_denied');
    assert.match(String(error.message), /deny \(project\) for bash/, 'the refusal names the layer and the key that decided');
    assert.equal(registry.list().length, 0, 'nothing was executed');
  });

  test('is refused with approval_required when the project asks rather than denies', async () => {
    setProjectRules({ bash: 'ask' });
    const opened = await post('/api/terminal/sessions', {});

    const refusedCommand = await post(
      '/api/code/execute-command' + projectQuery,
      { command: 'echo nope', cwd: projectDir },
      // A session id that does not exist is not a session: still evaluated.
      { 'x-hyperion-session': 'tsess_missing', 'x-hyperion-session-token': String(opened.body.token) },
    );

    assert.equal(refusedCommand.status, 409);
    assert.equal((refusedCommand.body.error as Record<string, unknown>).code, 'approval_required');
    assert.equal(registry.list().length, 0);
  });

  test('an expired token no longer authenticates', async () => {
    setProjectRules({ bash: 'deny' });
    // A store with a clock the test controls, so "expired" is a fact rather than a
    // sleep. The idle deadline is the one that expires a session nobody is using.
    const store = createSessionStore();
    const opened = store.open({ now: 1_000 });
    assert.equal(store.authenticate({ sessionId: opened.session.id, token: opened.token, now: 60_000 }).ok, true);

    // 16 minutes after the last authenticated command: past the idle deadline,
    // nowhere near the absolute one.
    const afterIdle = store.authenticate({ sessionId: opened.session.id, token: opened.token, now: 1_000_000 });
    assert.equal(afterIdle.ok, false);
    assert.equal(afterIdle.refusal, 'missing_token');

    const session = store.list().find((entry) => entry.id === opened.session.id);
    assert.equal(session?.endedReason, 'idle');
    assert.equal(
      store.authenticate({ sessionId: opened.session.id, token: opened.token, now: 60_000 }).ok,
      false,
      'and a session that has ended cannot be revived by an earlier timestamp',
    );

    // The absolute cap: a session that keeps being used still ends eventually.
    const busy = store.open({ now: 2_000 });
    let now = 2_000;
    // Ten hours of ten-minute steps: past the eight-hour cap, and renewed every
    // step so the idle deadline never fires first.
    for (let index = 0; index < 60; index += 1) {
      now += 10 * 60_000;
      const renewed = store.authenticate({ sessionId: busy.session.id, token: busy.token, now });
      if (!renewed.ok) break;
    }
    assert.equal(store.authenticate({ sessionId: busy.session.id, token: busy.token, now }).ok, false);
    assert.equal(store.list().find((entry) => entry.id === busy.session.id)?.endedReason, 'expired');
  });

  test('a session-closed token no longer authenticates, and its command is evaluated', async () => {
    setProjectRules({ bash: 'deny' });
    const store = createSessionStore();
    const opened = store.open();
    assert.equal(store.close({ sessionId: opened.session.id, token: opened.token }).ok, true);

    const afterClose = store.authenticate({ sessionId: opened.session.id, token: opened.token });

    assert.equal(afterClose.ok, false);
    assert.equal(afterClose.refusal, 'missing_token', 'the token is destroyed on close, not merely marked');
  });

  test('a token from a different session does not authenticate either', async () => {
    setProjectRules({ bash: 'deny' });
    const mine = await post('/api/terminal/sessions', {});
    const theirs = await post('/api/terminal/sessions', {});
    const myId = String((mine.body.session as Record<string, unknown>).id);

    const refusedCommand = await post(
      '/api/code/execute-command' + projectQuery,
      { command: 'echo nope', cwd: projectDir },
      { 'x-hyperion-session': myId, 'x-hyperion-session-token': String(theirs.body.token) },
    );

    assert.equal(refusedCommand.status, 403);
    assert.equal(registry.list().length, 0, 'the command was evaluated, and the project denies bash');
  });

  test('a body field claiming a human session is not a bypass', async () => {
    setProjectRules({ bash: 'deny' });

    const refusedCommand = await post(`/api/code/execute-command${projectQuery}`, {
      command: 'echo nope',
      cwd: projectDir,
      // Everything a client could send that looks like the exemption. None of it
      // is read: the claim travels in the headers, and it is authenticated there.
      human: true,
      bypass: true,
      sessionId: 'tsess_whatever',
      sessionToken: 'whatever',
    });

    assert.equal(refusedCommand.status, 403);
    assert.equal(registry.list().length, 0);
  });

  test('skips evaluation when the project has no rules, which is the pre-S17 behaviour', async () => {
    const ran = await post(`/api/code/execute-command${projectQuery}`, { command: 'echo default', cwd: projectDir });

    assert.equal(ran.status, 200);
    assert.equal((ran.body.result as Record<string, unknown>).stdout, 'default\n');
    assert.equal(ran.body.bypass, undefined, 'an evaluated command does not claim the exemption');
    assert.equal(registry.list()[0]?.sessionId, null);
  });
});

describe('what the bypass does not exempt', () => {
  test('containment still applies: a session cannot name a directory outside the scope', async () => {
    const opened = await post('/api/terminal/sessions', {});
    const sessionId = String((opened.body.session as Record<string, unknown>).id);
    const token = String(opened.body.token);

    const escaped = await post(
      '/api/code/execute-command' + projectQuery,
      { command: 'echo nope', cwd: '/etc' },
      { 'x-hyperion-session': sessionId, 'x-hyperion-session-token': token },
    );

    assert.equal(escaped.status, 403);
    assert.equal((escaped.body.error as Record<string, unknown>).code, 'scope_violation');
    assert.equal(registry.list().length, 0, 'nothing ran outside the boundary');
  });

  test('task ownership still applies: a session bound to a task runs inside that task', async () => {
    const opened = await post('/api/terminal/sessions', { taskId: 'bypass-task' });
    const sessionId = String((opened.body.session as Record<string, unknown>).id);
    const token = String(opened.body.token);
    const headers = { 'x-hyperion-session': sessionId, 'x-hyperion-session-token': token };

    // The project directory is outside the task's own worktree.
    const outside = await post(
      `/api/code/execute-command${projectQuery}`,
      { command: 'echo nope', cwd: projectDir },
      headers,
    );
    assert.equal(outside.status, 403, 'a task-bound session is not a licence to run anywhere');
    assert.equal(registry.list().length, 0);

    const inside = await post(
      `/api/code/execute-command${projectQuery}`,
      { command: 'echo inside', cwd: taskWorktree },
      headers,
    );
    assert.equal(inside.status, 200, JSON.stringify(inside.body));
    assert.equal((inside.body.result as Record<string, unknown>).stdout, 'inside\n');
    assert.equal(registry.list()[0]?.taskId, 'bypass-task', 'and the execution belongs to that task');
  });

  test('the capability gate still applies: switching shell execution off stops a bypassed command too', async () => {
    const opened = await post('/api/terminal/sessions', {});
    const sessionId = String((opened.body.session as Record<string, unknown>).id);
    const token = String(opened.body.token);
    setCapability('code_execution', false);

    const refusedCommand = await post(
      `/api/code/execute-command${projectQuery}`,
      { command: 'echo nope', cwd: projectDir },
      { 'x-hyperion-session': sessionId, 'x-hyperion-session-token': token },
    );

    assert.equal(refusedCommand.status, 403);
    assert.equal((refusedCommand.body.error as Record<string, unknown>).code, 'capability_disabled');
    assert.equal(registry.list().length, 0, 'the exemption is from the permission engine, not from this gate');
  });

  test('the output bound still applies to a bypassed command', async () => {
    const opened = await post('/api/terminal/sessions', {});
    const sessionId = String((opened.body.session as Record<string, unknown>).id);
    const token = String(opened.body.token);

    const ran = await post(
      '/api/code/execute-command',
      {
        command: 'node -e "process.stdout.write(\'x\'.repeat(300000))"',
        cwd: projectDir,
        timeoutMs: 20_000,
      },
      { 'x-hyperion-session': sessionId, 'x-hyperion-session-token': token },
    );

    assert.equal(ran.status, 200);
    const stdout = String((ran.body.result as Record<string, unknown>).stdout);
    assert.equal(stdout.endsWith('\n[output truncated after 262144 bytes]\n'), true);
    assert.equal(Buffer.byteLength(stdout), 262_144 + Buffer.byteLength('\n[output truncated after 262144 bytes]\n'));
  });
});
