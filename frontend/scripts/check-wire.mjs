/**
 * The frontend's wire schemas, checked against the backend that exists.
 *
 * `check-contracts.mjs` beside this file answers "does the frontend call a route
 * that is really there". It cannot answer the other half: **does the frontend
 * accept what the route actually sends**. That gap produced a real defect —
 * `wire/projects.ts` required an `updatedAt` the backend has never sent, so every
 * project response would have parsed as `invalid_response` the first time
 * anything called the module, and nothing did, so nothing noticed. A shape that
 * is wrong in the *other* direction (a required field the backend omits, or an
 * enum narrower than the backend's vocabulary) fails the same way and is just as
 * invisible: it surfaces at runtime, in whatever surface is unlucky enough to be
 * built on that module first.
 *
 * So this script boots the real app, seeds deep fixtures, and parses every real
 * response with the frontend's own schema:
 *
 *   - **the real server, not a mock of it** — the actual Express app on a real
 *     port, migrated from the real migration files, so a route's serialization is
 *     the thing under test;
 *   - **deep fixtures on purpose** — an empty feed, an empty approval queue and a
 *     run with no steps all parse, so they prove nothing. Every collection that
 *     can hold a row holds one here, and the checks assert the collection was
 *     non-empty so an empty answer cannot pass as a match;
 *   - **the frontend's schemas, not a copy of them** — the modules are bundled
 *     with esbuild (the frontend resolves extensionless imports; Node does not)
 *     and the real `safeParse` runs. A hand-written expectation here would drift
 *     from the frontend exactly as the schemas drift from the backend;
 *   - **coverage reported, not implied** — every exported response schema that no
 *     check exercised is printed at the end with the reason, so "nothing failed"
 *     can never be read as "everything was checked".
 *
 * A frontend module with no caller is the case this exists for: nothing else in
 * the build will ever look at its schema until a surface uses it.
 *
 * Usage: `npm run wire` (from `frontend/`), exit code 1 on any mismatch.
 */
import fs, { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const home = mkdtempSync(path.join(tmpdir(), 'hyperion-wire-'));

// Set before any backend module is imported: `config/env.ts` resolves every path
// once, at import time, so a script that imported first and configured second
// would read and write the developer's real ~/Hyperion. The three disable flags
// keep the booted app from starting background jobs that no assertion waits for.
process.env.NODE_ENV = 'test';
process.env.HYPERION_HOME = home;
process.env.HYPERION_LOG_LEVEL = 'error';
process.env.HYPERION_BIND = '127.0.0.1';
process.env.HYPERION_PORT = '0';
process.env.HYPERION_CLEANUP_DISABLED = '1';
process.env.HYPERION_SCHEDULER_DISABLED = '1';
process.env.HYPERION_MCP_DISABLED = '1';

const results = [];
let base = '';
const used = new Set();

/** Fail loudly rather than reporting a pass for a request that never ran. */
async function check(name, method, route, schemaName, { payload, expectStatus, requireNonEmpty, schemas } = {}) {
  const schema = schemas[schemaName];
  if (schema === undefined) {
    results.push({ name, ok: false, detail: `the frontend exports no schema named ${schemaName}` });
    return;
  }
  used.add(schemaName);

  let status = 0;
  let body;
  try {
    const response = await fetch(`${base}${route}`, {
      method,
      ...(payload === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    });
    status = response.status;
    body = await response.json();
  } catch (error) {
    results.push({ name, ok: false, detail: `request failed: ${String(error)}` });
    return;
  }

  if (status >= 300 && status !== expectStatus) {
    results.push({ name, ok: false, detail: `HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}` });
    return;
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    results.push({
      name,
      ok: false,
      detail: `schema rejected a real response: ${JSON.stringify(parsed.error.issues).slice(0, 1500)}`,
      schemaName,
    });
    return;
  }

  // A schema is only really exercised when the collection it validates has a row
  // in it. Checked against the body the schema was just given, not against a
  // later read — state moves, and a second request would measure something else.
  if (requireNonEmpty !== undefined) {
    const count = Array.isArray(body?.[requireNonEmpty]) ? body[requireNonEmpty].length : 0;
    if (count === 0) {
      results.push({
        name,
        ok: false,
        detail: `\`${requireNonEmpty}\` came back empty, so the nested schema was never exercised — the fixture is wrong, not the schema`,
      });
      return;
    }
  }

  results.push({ name, ok: true, schemaName });
}

/**
 * Value-level coverage, which is the half a response-level check cannot see.
 *
 * `requireNonEmpty` proves a collection had a row in it. It does not prove the
 * row carried the value that matters: an enum narrowed to one option still parses
 * every response a one-value fixture can produce, and then refuses a real one in
 * production — silently, in whichever surface is built on that module first. This
 * asserts the *values* a vocabulary allows were actually observed, and names each
 * one that was not.
 */
function requireValues(label, observed, expected) {
  const missing = expected.filter((value) => !observed.has(value));
  if (missing.length === 0) {
    results.push({ name: `values(${label})`, ok: true });
    return;
  }
  results.push({
    name: `values(${label})`,
    ok: false,
    detail: `no response in this run carried ${missing.map((value) => `\`${value}\``).join(', ')} — the fixture never produced it, so the frontend's enum was not exercised for that value`,
  });
}

/** The two halves of the frontend's wire modules, merged by export name. */
async function loadSchemas(outdir) {
  const wireDir = path.join(root, 'src', 'contracts', 'wire');
  const entries = readdirSync(wireDir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));

  await esbuild.build({
    entryPoints: entries.map((file) => path.join(wireDir, file)),
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });

  const schemas = {};
  for (const file of readdirSync(outdir)) {
    const module = await import(pathToFileURL(path.join(outdir, file)).href);
    for (const [key, value] of Object.entries(module)) {
      if (!key.endsWith('Schema')) continue;
      if (typeof value?.safeParse !== 'function') continue;
      if (schemas[key] !== undefined) throw new Error(`two wire modules export ${key}`);
      schemas[key] = value;
    }
  }
  return schemas;
}

/**
 * Schemas that are validated *inside* a checked response: zod runs them while
 * parsing the whole body, so a check on the response above is a check on these.
 * Named one by one rather than inferred, because the point of the list is that a
 * reader can see which shape is covered by which check.
 */
const NESTED = new Set([
  // inside activityPageSchema / attentionQueueSchema
  'activityEntrySchema', 'attentionItemSchema', 'attentionKindSchema', 'attentionSourceSchema',
  'attentionToolSchema', 'attentionResolveSchema',
  // inside the chat responses
  'chatRecordSchema', 'toolNameSchema', 'messageRoleSchema', 'messageStatusSchema',
  'messageRecordSchema', 'pauseReasonSchema', 'runStateSchema', 'runStateSnapshotSchema',
  // inside the error envelope
  'errorCodeSchema',
  // inside the project responses
  'projectSchema', 'projectTaskSchema',
  // inside the provenance responses
  'artifactVersionSchema', 'runKnowledgeSourceSchema',
  // inside the provider responses
  'egressClassSchema', 'egressProxySchema', 'modelSchema', 'providerSchema', 'providerTypeSchema',
  'zdrRequirementSchema', 'zdrStatusSchema',
  // inside the task responses
  'orphanedWorktreeSchema', 'taskApprovalSchema', 'taskRunStateSchema', 'taskStateResponseSchema',
  'taskStepSchema', 'taskStepSummarySchema', 'taskToolSchema', 'taskUsageSchema',
]);

/** The reason a stream payload cannot be exercised here, said once. */
const STREAM = 'a stream payload — exercising it needs a live model stream; it mirrors the `SseEvent` union in src/types/core.ts and is covered by the frontend decoder tests';

/**
 * Schemas this script cannot exercise, each with the reason it cannot. Two kinds:
 * a stream payload, which needs a model to emit one, and an input vocabulary,
 * which no response body carries.
 */
const NOT_EXERCISED = {
  chatSseOpenSchema: STREAM,
  chatSseTokenSchema: STREAM,
  chatSseUsageSchema: STREAM,
  chatSsePausedSchema: STREAM,
  chatSseResumedSchema: STREAM,
  chatSseErrorSchema: STREAM,
  chatSseDoneSchema: STREAM,
  approvalDecisionSchema: 'an input vocabulary `allow_once|allow_session|deny` — it validates what a client sends, and no response body carries it (the route it is sent to is checked through `approvalResultSchema`)',
};

async function main() {
  const bundling = mkdtempSync(path.join(tmpdir(), 'hyperion-wire-bundle-'));
  const schemas = await loadSchemas(bundling);

  const { openDatabase, setDb, closeDb } = await import('../../src/db/adapter.ts');
  const { runMigrations } = await import('../../src/db/migrate.ts');
  const { ensureDirectories } = await import('../../src/config/env.ts');
  ensureDirectories();
  const db = openDatabase(path.join(home, 'wire.db'));
  setDb(db);
  runMigrations(db);

  // A loopback provider that answers an OpenAI-shaped model list, because the
  // provider routes are otherwise a 502 — and a 502 proves nothing about a
  // response schema.
  const http = await import('node:http');
  const provider = http.createServer((req, res) => {
    if ((req.url ?? '').endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'wire-model', object: 'model', owned_by: 'wire' }] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerBase = `http://127.0.0.1:${provider.address().port}/v1`;

  const { createApp } = await import('../../src/http/app.ts');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  // --- fixtures -------------------------------------------------------------
  const { createProvider, enableProvider } = await import('../../src/providers/repository.ts');
  const { createChat, appendMessage } = await import('../../src/db/chats.ts');
  const { createRun, attachExecution, pauseRun } = await import('../../src/orchestrator/runState.ts');
  const { createProject, openProject } = await import('../../src/db/projects.ts');
  const { startTaskRun, updateTaskRunState } = await import('../../src/db/taskRuns.ts');
  const { recordStep } = await import('../../src/db/taskSteps.ts');
  const { recordApproval, listPendingApprovals } = await import('../../src/db/approvals.ts');
  const { saveKnowledgeSource } = await import('../../src/services/cowork/knowledge.ts');
  const { recordRunKnowledge } = await import('../../src/db/runKnowledge.ts');
  const { startSubagentRun, finishSubagentRun } = await import('../../src/db/subagents.ts');
  const { getRoot } = await import('../../src/security/fsScope.ts');

  const providerRow = createProvider({
    name: 'Wire provider',
    type: 'remote',
    baseUrl: providerBase,
    apiKey: 'wire-key',
    // Small on purpose: `resume-in-new-session` refuses a conversation that already
    // fits ("a new session would leave nothing behind"), and with an assumed 8192
    // every fixture here fits. A tiny window is what makes the route answer.
    maxContextTokens: 5,
  });
  enableProvider(providerRow.id);

  const chat = createChat({ tool: 'chat', title: 'Wire chat' });
  appendMessage({ chatId: chat.id, role: 'user', content: 'hello' });
  appendMessage({
    chatId: chat.id,
    role: 'assistant',
    content: 'hi',
    modelId: 'wire-model',
    providerId: providerRow.id,
    providerName: 'Wire provider',
    status: 'complete',
  });
  const chatRun = createRun({ chatId: chat.id, tool: 'chat', modelId: 'wire-model', providerId: providerRow.id });
  attachExecution(chatRun.runId, { modelId: 'wire-model' });
  // A reason from the backend's own `PauseReason` union: a value the type does not
  // allow would be a fixture asserting a state the product cannot reach.
  pauseRun({ runId: chatRun.runId, reason: 'provider_failure', code: 'provider_unreachable', message: 'wire' });

  const project = createProject({ name: 'Wire project', path: path.join(home, 'project'), managed: true });
  openProject(project.id);

  startTaskRun({ runId: 'wire-run', taskId: 'wire-task', tool: 'cowork', chatId: chat.id });
  updateTaskRunState('wire-run', 'blocked');
  recordStep({
    runId: 'wire-run', step: 1, kind: 'tool_call', mode: 'act', profile: 'act', toolName: 'read_file',
    ok: true, detail: 'read a file', tokensIn: 100, tokensOut: 20, reasoningTokens: 5,
    cacheReadTokens: 3, cacheWriteTokens: 1,
  });
  recordApproval({
    runId: 'wire-run', taskId: 'wire-task', tool: 'cowork', toolName: 'write_file',
    arguments: '{"path":"a.txt"}', permissionKey: 'write', matchedPattern: '*', matchedLayer: 'project',
    reason: 'wire',
  });
  const approvalId = listPendingApprovals('wire-task')[0]?.id ?? '';

  const knowledge = saveKnowledgeSource({
    filename: 'wire.md', buffer: Buffer.from('wire knowledge'), label: 'Wire source', mimeType: 'text/markdown',
  });
  recordRunKnowledge('wire-run', [
    { sourceId: knowledge.id, label: 'Wire source', filename: 'wire.md', bytes: 14, sha256: 'abc' },
  ]);
  // One paused chat run per `PauseReason`, because the enum is the part of the wire
  // contract that fails silently: a *narrowed* frontend enum still parses every
  // response a one-value fixture produces, and then refuses a real one in
  // production. Every value the backend's union allows appears in a real response
  // here, so dropping one is a failing check rather than a latent bug.
  const PAUSE_REASONS = ['provider_failure', 'provider_switch', 'model_switch', 'no_healthy_provider', 'capability_mismatch', 'user_request'];
  for (const reason of PAUSE_REASONS) {
    const each = createChat({ tool: 'chat', title: `Wire chat ${reason}` });
    const run = createRun({ chatId: each.id, tool: 'chat', modelId: 'wire-model', providerId: providerRow.id });
    pauseRun({ runId: run.runId, reason, code: 'wire', message: 'wire' });
  }

  // Every message role and status, for the same reason.
  const rolesChat = createChat({ tool: 'chat', title: 'Wire roles' });
  for (const role of ['system', 'user', 'assistant', 'tool']) {
    appendMessage({ chatId: rolesChat.id, role, content: `${role} message` });
  }
  const statusChat = createChat({ tool: 'chat', title: 'Wire statuses' });
  for (const status of ['streaming', 'paused', 'complete', 'error']) {
    appendMessage({ chatId: statusChat.id, role: 'assistant', content: `${status} message`, status });
  }

  // A version row for `GET /api/artifacts/versions`. Inserted directly: this check
  // is about the route's serialization, and the writer path (`writeCodeFile`) needs
  // a real git worktree to produce the same row.
  db.prepare(
    `INSERT INTO artifact_versions (id, artifact_key, tool, version, content, label, bytes, sha256, created_at)
     VALUES ('wire-av-1', 'wire/artifact.txt', 'code', 1, 'wire content', 'Wire artifact', 13, 'abc', ?)`,
  ).run(Date.now());

  // An orphaned checkout for the one destructive storage route: a directory in the
  // worktrees root that no task owns, with no git in it, so the discard takes its
  // filesystem path — and `force` is what a caller sends after reading the refusal.
  const worktreesRoot = getRoot('worktrees');
  fs.mkdirSync(path.join(worktreesRoot, 'wire-orphan'), { recursive: true });
  writeFileSync(path.join(worktreesRoot, 'wire-orphan', 'leftover.txt'), 'leftover');

  const subagent = startSubagentRun({
    parentRunId: 'wire-run', parentTaskId: 'wire-task', childTaskId: 'wire-child', sequence: 1, prompt: 'go',
  });
  finishSubagentRun(subagent.id, 'complete', { summary: 'done' });

  // --- checks ---------------------------------------------------------------
  // Reads that depend on `wire-run` still being parked come first; the decision
  // at the end finalises it, which is also why nothing below re-reads it.
  const r = (name, method, route, schemaName, extra = {}) =>
    check(name, method, route, schemaName, { ...extra, schemas });

  await r('health.liveness', 'GET', '/api/health', 'livenessSchema');
  await r('health.summary', 'GET', '/api/health/summary', 'healthSummarySchema');
  await r('settings.capabilities', 'GET', '/api/settings/capabilities', 'capabilitiesResponseSchema');
  await r('settings.preferences', 'GET', '/api/settings/preferences', 'preferencesResponseSchema');
  await r('settings.limits', 'GET', '/api/settings/limits', 'limitsResponseSchema');
  await r('projects.registry', 'GET', '/api/projects', 'projectsResponseSchema', { requireNonEmpty: 'projects' });
  await r('projects.tasks', 'GET', `/api/projects/${project.id}/tasks`, 'projectTasksResponseSchema', { requireNonEmpty: 'tasks' });
  await r('providers.list', 'GET', '/api/providers', 'providersResponseSchema', { requireNonEmpty: 'providers' });
  await r('providers.active', 'GET', '/api/providers/active', 'activeProviderResponseSchema');
  await r('providers.activeModels', 'GET', '/api/providers/active/models', 'activeModelsResponseSchema', { requireNonEmpty: 'models' });
  await r('tasks.lane', 'GET', '/api/code/tasks', 'codeLaneSchema');
  await r('tasks.state', 'GET', '/api/cowork/tasks/wire-task/state', 'taskStateWithUsageResponseSchema');
  // One run per state: `running`, `paused`, `blocked`, `ready_for_review` are active
  // and the other four are terminal, and the frontend has to accept all eight —
  // this vocabulary has been widened four times (migrations 010, 012, 020).
  for (const state of ['running', 'paused', 'blocked', 'ready_for_review', 'complete', 'error', 'stopped', 'interrupted']) {
    const taskId = `wire-state-${state}`;
    startTaskRun({ runId: `wire-run-${state}`, taskId, tool: 'code' });
    if (state === 'blocked' || state === 'ready_for_review' || state === 'paused') {
      updateTaskRunState(`wire-run-${state}`, state);
    } else if (state !== 'running') {
      const { finishTaskRun } = await import('../../src/db/taskRuns.ts');
      finishTaskRun(`wire-run-${state}`, state, { code: 'internal_error' });
    }
    await r(`tasks.state(${state})`, 'GET', `/api/code/tasks/${taskId}/state`, 'taskStateWithUsageResponseSchema');
  }
  await r('tasks.approvals', 'GET', '/api/cowork/tasks/wire-task/approvals', 'taskApprovalsResponseSchema', { requireNonEmpty: 'approvals' });
  await r('tasks.recovery', 'GET', '/api/cowork/tasks/wire-task/recovery', 'recoveryReportSchema');
  await r('provenance.runKnowledge', 'GET', '/api/cowork/tasks/wire-task/provenance', 'runKnowledgeResponseSchema', { requireNonEmpty: 'knowledgeSources' });
  await r('chat.list', 'GET', '/api/chat', 'chatsResponseSchema', { requireNonEmpty: 'chats' });
  await r('chat.detail', 'GET', `/api/chat/${chat.id}`, 'chatDetailResponseSchema');
  await r('chat.messages', 'GET', `/api/chat/${chat.id}/messages`, 'messagesPageSchema', { requireNonEmpty: 'messages' });
  await r('chat.open', 'POST', `/api/chat/${chat.id}/open`, 'openChatResponseSchema', { payload: {}, requireNonEmpty: 'messages' });
  await r('chat.runs', 'GET', `/api/chat/${chat.id}/runs`, 'chatRunsResponseSchema', { requireNonEmpty: 'paused' });
  await r('chat.pausedRuns', 'GET', '/api/chat/runs/paused', 'pausedRunsResponseSchema', { requireNonEmpty: 'runs' });
  await r('chat.context', 'GET', `/api/chat/${chat.id}/context`, 'chatContextSchema');
  await r('chat.fork', 'POST', `/api/chat/${chat.id}/fork`, 'forkChatResponseSchema', { payload: {} });
  await r('chat.pin', 'POST', `/api/chat/${chat.id}/pin`, 'chatResponseSchema', { payload: { pinned: true } });
  await r('chat.patch', 'PATCH', `/api/chat/${chat.id}`, 'chatResponseSchema', { payload: { title: 'Renamed' } });
  await r('chat.archive', 'POST', `/api/chat/${chat.id}/archive`, 'chatResponseSchema', { payload: {} });
  await r('chat.unarchive', 'POST', `/api/chat/${chat.id}/unarchive`, 'chatResponseSchema', { payload: {} });
  await r('activity.feed', 'GET', '/api/activity', 'activityPageSchema', { requireNonEmpty: 'entries' });
  await r('attention.queue', 'GET', '/api/attention', 'attentionQueueSchema', { requireNonEmpty: 'items' });
  await r('projects.create', 'POST', '/api/projects', 'projectResponseSchema', { payload: { name: 'Wire project 2' }, expectStatus: 201 });
  await r('projects.open', 'POST', `/api/projects/${project.id}/open`, 'openedProjectResponseSchema', { payload: {} });
  await r('providers.enable', 'POST', `/api/providers/${providerRow.id}/enable`, 'providerResponseSchema', { payload: {} });
  await r('error.envelope(404)', 'GET', '/api/wire-check-does-not-exist', 'errorEnvelopeSchema', { expectStatus: 404 });
  await r('error.envelope(400)', 'GET', '/api/artifacts/versions', 'errorEnvelopeSchema', { expectStatus: 400 });
  await r('attention.decide', 'POST', '/api/cowork/tasks/wire-task/approve', 'approvalResultSchema', {
    payload: { approvalId, decision: 'deny' },
  });
  await r('artifacts.versions', 'GET', '/api/artifacts/versions?key=wire/artifact.txt', 'artifactVersionsResponseSchema', { requireNonEmpty: 'versions' });
  await r('chat.resumeInNewSession', 'POST', `/api/chat/${chat.id}/resume-in-new-session`, 'resumeInNewSessionResponseSchema', { payload: {} });
  await r('storage.discardWorktree', 'POST', '/api/storage/worktrees/wire-orphan/discard', 'discardWorktreeResponseSchema', { payload: { force: true } });
  await r('chat.delete', 'DELETE', `/api/chat/${chat.id}`, 'deletedResponseSchema');

  // --- value coverage -------------------------------------------------------
  const readJson = async (route) => (await fetch(`${base}${route}`)).json();
  const pausedRuns = await readJson('/api/chat/runs/paused');
  requireValues('pauseReason', new Set(pausedRuns.runs.map((run) => run.pauseReason)), PAUSE_REASONS);
  const roleMessages = await readJson(`/api/chat/${rolesChat.id}/messages`);
  requireValues('messageRole', new Set(roleMessages.messages.map((message) => message.role)), ['system', 'user', 'assistant', 'tool']);
  const statusMessages = await readJson(`/api/chat/${statusChat.id}/messages`);
  requireValues('messageStatus', new Set(statusMessages.messages.map((message) => message.status)), ['streaming', 'paused', 'complete', 'error']);
  const runStates = new Set();
  for (const state of ['running', 'paused', 'blocked', 'ready_for_review', 'complete', 'error', 'stopped', 'interrupted']) {
    const body = await readJson(`/api/code/tasks/wire-state-${state}/state`);
    if (typeof body?.run?.state === 'string') runStates.add(body.run.state);
  }
  requireValues('taskRunState', runStates, ['running', 'paused', 'blocked', 'ready_for_review', 'complete', 'error', 'stopped', 'interrupted']);
  // Reported rather than required: producing all eleven attention kinds needs
  // fixtures for sources this script has none of (a failed scheduled run, a
  // disconnected MCP server), and a check that cannot be satisfied is not a check.
  const queue = await readJson('/api/attention');
  console.log(`\nAttention kinds observed: ${[...new Set(queue.items.map((item) => item.kind))].sort().join(', ') || 'none'}`);

  // --- report ---------------------------------------------------------------
  const failed = results.filter((entry) => !entry.ok);
  const checked = results.length - failed.length;
  console.log(`Wire schemas against the real backend: ${checked}/${results.length} matched.`);
  for (const entry of failed) console.log(`  FAIL ${entry.name}\n       ${entry.detail}`);

  // Every exported schema is either exercised by a check above, or named in one of
  // these two lists with a reason. A schema in none of the three fails the run: a
  // new module added to the frontend must be given a fixture or a stated reason,
  // which is the only thing that keeps "nothing failed" from reading as "everything
  // was checked" as the wire surface grows.
  const unexercised = Object.keys(schemas).filter((name) => !used.has(name));
  const unexplained = unexercised.filter((name) => !NESTED.has(name) && !NOT_EXERCISED[name]);
  if (unexplained.length > 0) {
    console.log(`\nSchemas with neither a check nor a stated reason (${unexplained.length}):`);
    for (const name of unexplained) console.log(`  - ${name}`);
    console.log('  Add a check above, or a reason in NOT_EXERCISED.');
    failed.push({ name: 'coverage', ok: false, detail: `${unexplained.length} unclassified schema(s)` });
  }

  const nested = unexercised.filter((name) => NESTED.has(name));
  const skipped = unexercised.filter((name) => NOT_EXERCISED[name] !== undefined);
  console.log(
    `\nOf the ${Object.keys(schemas).length} exported schemas: ${used.size} answered by a route and`
    + ` parsed directly across ${results.length} responses, ${nested.length} validated inside those`
    + ` responses, ${skipped.length} not exercised.`,
  );
  for (const name of skipped) console.log(`  - ${name}: ${NOT_EXERCISED[name]}`);

  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => provider.close(resolve));
  closeDb();
  rmSync(bundling, { recursive: true, force: true });

  if (failed.length > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  rmSync(home, { recursive: true, force: true });
}
