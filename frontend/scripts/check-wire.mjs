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
 *   - **the frontend's schemas and decoders, not copies of them** — the modules are
 *     bundled with esbuild (the frontend resolves extensionless imports; Node does
 *     not) and the real `safeParse` runs. Stream frames go through the real
 *     `decodeChatEvent`/`decodeAgentEvent` as well, because a schema can be right
 *     while the decoder that feeds it picks a different one for that event name —
 *     which is exactly how the agent protocol's `error` frame came to be rejected
 *     (2026-09-22). A hand-written expectation here would drift from the frontend
 *     exactly as the schemas drift from the backend;
 *   - **coverage reported, not implied** — every exported response schema that no
 *     check exercised is printed at the end with the reason, so "nothing failed"
 *     can never be read as "everything was checked".
 *
 * It drives streams as well as request/response routes, which is what makes the
 * seven `chatSse*` payloads checkable at all: a real loopback provider streams a
 * completion, a real failover produces `paused` and `resumed`, and a real refusal
 * produces the run's `error` frame — on the chat route *and* on a task route, whose
 * protocol decodes it with the same schema.
 *
 * A frontend module with no caller is the case this exists for: nothing else in
 * the build will ever look at its schema until a surface uses it.
 *
 * Usage: `npm run wire` (from `frontend/`), exit code 1 on any mismatch.
 */
import fs, { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
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
async function check(name, method, route, schemaName, { payload, expectStatus, requireNonEmpty, requirePresent, schemas } = {}) {
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
  if (requirePresent !== undefined) {
    // The nullable arm of a schema is the one a fixture falls into by accident: a
    // `preview: null` would parse and prove nothing about the object inside.
    const value = requirePresent
      .split('.')
      .reduce((acc, key) => (acc === null || acc === undefined ? acc : acc[key]), body);
    if (value === null || value === undefined) {
      results.push({
        name,
        ok: false,
        detail: `\`${requirePresent}\` came back null, so the non-null arm of the schema was never exercised — the fixture is wrong, not the schema`,
      });
      return;
    }
  }

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
 * Read a streamed response into frames, the way a client's SSE parser does.
 *
 * Split on the blank line that terminates a frame, keep the event name, and join
 * the `data:` lines back together — multi-line data is legal and a frame that was
 * split by the transport must not be reported as malformed JSON.
 */
async function readFrames(response) {
  const text = await response.text();
  const frames = [];
  for (const block of text.split('\n\n')) {
    if (block.trim() === '') continue;
    const event = /^event: (.*)$/m.exec(block)?.[1];
    if (event === undefined) continue;
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    frames.push({ event, data });
  }
  return frames;
}

/**
 * Parse **every** frame of one event name with the frontend's schema for it.
 *
 * Every frame and not just the first: a schema can hold for the frame that opens
 * a stream and reject the one that ends it — a `usage` frame whose optional field
 * is present only at the end, a `token` frame carrying an empty string, a
 * `paused` frame from the failover path with a different reason. Counting the
 * frames is part of the check too: an absent frame proves nothing about the
 * schema that would have validated it, so a stream that quietly stopped emitting
 * one would report a pass here while the surface it feeds shows nothing.
 */
function checkFrames(name, frames, eventName, schemaName, { schemas, decode, atLeast = 1 } = {}) {
  const schema = schemas[schemaName];
  if (schema === undefined) {
    results.push({ name, ok: false, detail: `the frontend exports no schema named ${schemaName}` });
    return;
  }
  used.add(schemaName);
  const matching = frames.filter((frame) => frame.event === eventName);
  if (matching.length < atLeast) {
    results.push({
      name,
      ok: false,
      detail: `the stream produced ${matching.length} \`${eventName}\` frame(s) (wanted at least ${atLeast}); saw: ${[...new Set(frames.map((frame) => frame.event))].join(', ') || 'nothing'}`,
    });
    return;
  }
  for (const frame of matching) {
    let payload;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      results.push({ name, ok: false, detail: `a real \`${eventName}\` frame was not JSON: ${frame.data.slice(0, 200)}` });
      return;
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      results.push({
        name,
        ok: false,
        detail: `schema rejected a real \`${eventName}\` frame: ${JSON.stringify(parsed.error.issues).slice(0, 1200)}`,
        schemaName,
      });
      return;
    }
    // …and by the decoder the app actually runs. A schema can be right while the
    // decoder that feeds it picks a different one for this event name — which is
    // precisely the bug this pair of checks exists to catch.
    if (decode !== undefined) {
      const decoded = decode(frame);
      if (!decoded.ok) {
        results.push({
          name,
          ok: false,
          detail: `the frontend's own decoder rejected a real \`${eventName}\` frame: ${decoded.reason} ${JSON.stringify(decoded.issues ?? {}).slice(0, 900)}`,
          schemaName,
        });
        return;
      }
    }
  }
  results.push({ name, ok: true, schemaName });
}

/** Open one chat stream and collect its frames. */
async function openChatStream(payload) {
  const response = await fetch(`${base}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const frames = await readFrames(response);
  return { status: response.status, frames };
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

/**
 * The frontend's schemas, plus the decoders that use them.
 *
 * Both are bundled and imported for real: a check that reimplemented the decoding
 * would agree with whichever shape the *check* assumed, which is how a mismatch
 * survives a green suite. `decoders` is the same module the running app uses.
 */
async function loadSchemas(outdir) {
  const wireDir = path.join(root, 'src', 'contracts', 'wire');
  const entries = readdirSync(wireDir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
  // The SSE decoders: named events for chat, channels plus a run `error` frame for
  // agent runs. Bundled because they are the code path under test, not a convenience.
  entries.push(path.join(root, 'src', 'api', 'sse', 'events.ts'));

  await esbuild.build({
    entryPoints: entries.map((file) => (path.isAbsolute(file) ? file : path.join(wireDir, file))),
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });

  // esbuild mirrors the source layout under `outdir` (`contracts/wire/…`,
  // `api/sse/…`), so the walk is recursive rather than a flat listdir.
  const bundled = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) bundled.push(full);
    }
  };
  walk(outdir);

  const schemas = {};
  const decoders = {};
  for (const file of bundled) {
    const module = await import(pathToFileURL(file).href);
    for (const [key, value] of Object.entries(module)) {
      if (key === 'decodeChatEvent' || key === 'decodeAgentEvent') {
        decoders[key] = value;
        continue;
      }
      if (!key.endsWith('Schema')) continue;
      if (typeof value?.safeParse !== 'function') continue;
      if (schemas[key] !== undefined) throw new Error(`two wire modules export ${key}`);
      schemas[key] = value;
    }
  }
  if (decoders.decodeChatEvent === undefined || decoders.decodeAgentEvent === undefined) {
    throw new Error('the frontend exported no SSE decoders — the bundle is wrong, not the wire');
  }
  return { schemas, decoders };
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
  'egressClassSchema', 'egressProxySchema', 'modelSchema', 'providerSchema', 'providerTypeSchema', 'providerZdrSchema', 'zdrSupportSchema',
  'zdrRequirementSchema', 'zdrStatusSchema',
  // inside the Canvas tree — `canvasTreeSchema` is checked against a real
  // listing, and its `entries` are what exercise the entry schema
  'canvasEntrySchema',
  // inside the terminal session list — the list is checked against a real store
  // that holds one live and one ended session, which is what exercises both arms
  // of `endedAt`/`endedReason`
  'terminalSessionSchema', 'reloadProfileSchema',
  // inside the task responses
  'orphanedWorktreeSchema', 'taskApprovalSchema', 'taskRunStateSchema', 'taskStateResponseSchema',
  'taskStepSchema', 'taskStepSummarySchema', 'taskToolSchema', 'taskUsageSchema',
]);

/**
 * Schemas this script cannot exercise, each with the reason it cannot.
 *
 * One entry, and it is an input vocabulary rather than a response: the stream
 * payloads that used to be listed here are now driven for real (see the stream
 * section), which is the only way the agent protocol's `error` frame could be
 * caught being decoded with the wrong schema.
 */
const NOT_EXERCISED = {
  approvalDecisionSchema: 'an input vocabulary `allow_once|allow_session|deny` — it validates what a client sends, and no response body carries it (the route it is sent to is checked through `approvalResultSchema`)',
};

async function main() {
  const bundling = mkdtempSync(path.join(tmpdir(), 'hyperion-wire-bundle-'));
  const { schemas, decoders } = await loadSchemas(bundling);

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
  //
  // It also *streams* completions, which is what turns the seven stream payloads
  // from "cannot be exercised" into checks: `POST /api/chat/stream` is driven for
  // real below and every frame is parsed with the frontend's own decoders. Two
  // model ids exist only to fail — one the router can fail over from, one it
  // cannot — so `paused`, `resumed` and `error` are produced by the paths that
  // produce them rather than by a fixture that asserts the shape I expect.
  const http = await import('node:http');
  const MODEL_IDS = ['wire-model', 'wire-unstable', 'wire-dead'];
  const provider = http.createServer((req, res) => {
    if ((req.url ?? '').endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: MODEL_IDS.map((id) => ({ id, object: 'model', owned_by: 'wire' })) }));
      return;
    }
    if ((req.url ?? '').endsWith('/chat/completions')) {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        let requested = '';
        try { requested = JSON.parse(raw).model; } catch { /* an unparseable body is a client bug, not a stream */ }
        if (requested === 'wire-unstable' || requested === 'wire-dead') {
          // A 500, twice: the router's health threshold is two consecutive
          // failures, so one is retried on the same provider and two move on.
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'wire provider is unhappy', type: 'server_error' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const frame = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
        frame({ choices: [{ delta: { content: 'Wire ' } }] });
        frame({ choices: [{ delta: { content: 'stream' } }] });
        frame({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
        });
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerBase = `http://127.0.0.1:${provider.address().port}/v1`;

  // A second provider that answers where the first fails, so the failover path
  // has somewhere to fail *over* to. Failing both for `wire-dead` is what makes
  // the third stream a genuine dead end rather than a fixture.
  const alt = http.createServer((req, res) => {
    if ((req.url ?? '').endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: MODEL_IDS.map((id) => ({ id, object: 'model', owned_by: 'wire-alt' })) }));
      return;
    }
    if ((req.url ?? '').endsWith('/chat/completions')) {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        let requested = '';
        try { requested = JSON.parse(raw).model; } catch { /* as above */ }
        if (requested === 'wire-dead') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'wire backup is unhappy too', type: 'server_error' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'backup ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'took over' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => alt.listen(0, '127.0.0.1', resolve));
  const altBase = `http://127.0.0.1:${alt.address().port}/v1`;

  // The real boot registers the in-process agent modules (`src/index.ts` does the
  // same call). Skipping it made every task route answer `agent_not_registered`,
  // which is a fact about the check rather than about the app — and it is the task
  // routes whose error frame this script now drives.
  const { registerProductionModules } = await import('../../src/services/agent/composition.ts');
  registerProductionModules();

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
  const { REDACTION_CHECK_KEY } = await import('../../src/db/settings.ts');

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
  // Disposable, never enabled until the CRUD checks at the end: the provider
  // write routes (create/patch/zdr/enable/disable/test/models) are exercised
  // against it so the active fixture above is not mutated mid-run.
  const disposableProvider = createProvider({
    name: 'Wire disposable provider',
    type: 'remote',
    baseUrl: providerBase,
    apiKey: 'wire-key',
  });

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

  // --- the Canvas routes: a task holding a real checkout ---------------------
  // A real git repository, because `GET .../diff` delegates to the exporter and
  // the exporter needs a base commit. A directory that is not a repo would make
  // every Canvas check a refusal, which would prove nothing about the schemas —
  // the failure this script exists to catch is a schema that rejects a real
  // response, and a 400 has no body to reject.
  // Inside the projects scope, not beside it: `provisionWorktree` resolves a
  // repository through the same filesystem boundary every other path goes
  // through, and a path outside it is refused rather than diffed.
  const repoDir = path.join(getRoot('projects'), 'canvas-repo');
  fs.mkdirSync(repoDir, { recursive: true });
  writeFileSync(path.join(repoDir, 'README.md'), '# canvas\n');
  const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'wire@example.test');
  git('config', 'user.name', 'wire');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-qm', 'base');

  const { provisionWorktree } = await import('../../src/services/code/worktree.ts');
  const canvasWorktree = await provisionWorktree('wire-canvas', repoDir);
  // Written *after* the base commit, so the diff carries a real file: an empty
  // patch would parse and exercise nothing inside `canvasDiffSchema`.
  writeFileSync(path.join(canvasWorktree.dir, 'README.md'), '# canvas\nchanged\n');

  // The second listener, so mint answers with a session rather than with the
  // `capability_disabled` refusal — that refusal has its own check in the API
  // suite, and it would leave `mintedPreviewSchema` unexercised here.
  const { startPreviewServer, stopPreviewServer } = await import('../../src/http/previewServer.ts');
  const previewPort = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
  startPreviewServer({ port: previewPort });

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
  // Safety and limits writes (Settings 2.5 slice 2). Each payload names the
  // value the fixture already holds, so the checks leave the ephemeral wire
  // database as they found it; limitsPut sends 0, which clears a cap that was
  // never set.
  await r('settings.networkEgress', 'GET', '/api/settings/network-egress', 'networkEgressResponseSchema');
  await r('settings.networkEgressPut', 'PUT', '/api/settings/network-egress', 'networkEgressResponseSchema', { payload: { enabled: true } });
  await r('settings.redactionCheck', 'GET', '/api/settings/redaction-check', 'redactionCheckResponseSchema');
  await r('settings.redactionCheckPut', 'PUT', '/api/settings/redaction-check', 'redactionCheckResponseSchema', { payload: { enabled: false } });
  await r('settings.zdrPolicy', 'GET', '/api/settings/zdr', 'zdrPolicyResponseSchema');
  await r('settings.zdrPolicyPut', 'PUT', '/api/settings/zdr', 'zdrPolicyResponseSchema', { payload: { requirement: 'off' } });
  await r('settings.toolAccessMode', 'GET', '/api/settings/tool-access-mode', 'toolAccessModeResponseSchema');
  await r('settings.toolAccessModePut', 'PUT', '/api/settings/tool-access-mode', 'toolAccessModeResponseSchema', { payload: { mode: 'always_loaded' } });
  await r('settings.limitsPut', 'PUT', '/api/settings/limits', 'limitsResponseSchema', { payload: { dailySpendCapUsd: 0 } });
  await r('settings.reloadConfig', 'POST', '/api/settings/reload-config', 'reloadConfigResponseSchema', { payload: {} });
  await r('projects.registry', 'GET', '/api/projects', 'projectsResponseSchema', { requireNonEmpty: 'projects' });
  await r('projects.tasks', 'GET', `/api/projects/${project.id}/tasks`, 'projectTasksResponseSchema', { requireNonEmpty: 'tasks' });
  await r('providers.list', 'GET', '/api/providers', 'providersResponseSchema', { requireNonEmpty: 'providers' });
  await r('providers.active', 'GET', '/api/providers/active', 'activeProviderResponseSchema');
  await r('providers.activeModels', 'GET', '/api/providers/active/models', 'activeModelsResponseSchema', { requireNonEmpty: 'models' });
  await r('providers.puterAdvisory', 'GET', '/api/providers/puter/advisory', 'puterAdvisorySchema');
  await r('providers.colibriAdvisory', 'GET', '/api/providers/colibri/advisory', 'colibriAdvisorySchema');
  await r('providers.colibriProbe', 'POST', '/api/providers/colibri/probe', 'colibriProbeSchema', { payload: { baseUrl: providerBase } });
  await r('providers.detectLocal', 'POST', '/api/providers/detect-local', 'localDetectionSchema', { payload: { baseUrl: providerBase } });
  await r('providers.models', 'GET', `/api/providers/${disposableProvider.id}/models`, 'providerModelsResponseSchema', { requireNonEmpty: 'models' });
  await r('providers.test', 'POST', `/api/providers/${disposableProvider.id}/test`, 'connectionTestSchema', { payload: {} });
  await r('tasks.lane', 'GET', '/api/code/tasks', 'codeLaneSchema');
  // The Canvas (1.40): the tree, one file, the diff, and the preview's mint and
  // revoke. `entries` is required non-empty because a tree that parsed as an
  // empty array would exercise `canvasEntrySchema` zero times.
  await r('canvas.files', 'GET', '/api/code/tasks/wire-canvas/files?path=.', 'canvasTreeSchema', {
    requireNonEmpty: 'entries',
  });
  await r('canvas.file', 'GET', '/api/code/tasks/wire-canvas/file?path=README.md', 'canvasFileSchema');
  await r('canvas.diff', 'GET', '/api/code/tasks/wire-canvas/diff', 'canvasDiffSchema');
  await r('canvas.preview', 'POST', '/api/code/tasks/wire-canvas/preview', 'mintedPreviewSchema', {
    expectStatus: 201,
  });
  // The read, taken while a session is live, so it exercises the non-null arm of
  // `previewStatusSchema.preview` rather than the nullable one the panel's idle
  // state already covers. The panel is built on this route precisely because it
  // is a read; if it minted here the token minted on the line above would be gone.
  await r('canvas.preview.status', 'GET', '/api/code/tasks/wire-canvas/preview', 'previewStatusSchema', {
    requirePresent: 'preview.url',
  });
  await r('canvas.preview.revoke', 'DELETE', '/api/code/tasks/wire-canvas/preview', 'previewRevokedSchema');
  stopPreviewServer();
  // The session panel's Processes row. A session is opened in-process before the
  // read, because an empty list would parse against the schema while exercising
  // `terminalSessionSchema` zero times — and the ended-session arm matters too:
  // the store retains ended sessions, so the fixture opens one and closes it,
  // which is what makes `endedAt`/`endedReason` real values rather than nulls.
  const { terminalSessions } = await import('../../src/services/terminal/sessions.ts');
  const opened = terminalSessions.open({ taskId: 'wire-task', client: 'wire-check' });
  terminalSessions.open({ taskId: null, client: 'wire-check-second' });
  terminalSessions.close({ sessionId: opened.session.id, token: opened.token });
  await r('terminal.sessions', 'GET', '/api/terminal/sessions', 'terminalSessionsSchema', {
    requireNonEmpty: 'sessions',
  });
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
  await r('providers.enable', 'POST', `/api/providers/${providerRow.id}/enable`, 'providerEnabledResponseSchema', { payload: {} });
  await r('providers.create', 'POST', '/api/providers', 'providerResponseSchema', {
    payload: { name: 'Wire created provider', type: 'remote', baseUrl: providerBase, apiKey: 'wire-key' },
    expectStatus: 201,
  });
  await r('providers.patch', 'PATCH', `/api/providers/${disposableProvider.id}`, 'providerResponseSchema', {
    payload: { priority: 42 },
  });
  await r('providers.zdr', 'PUT', `/api/providers/${disposableProvider.id}/zdr`, 'providerResponseSchema', {
    payload: { support: 'supported_default' },
  });
  await r('providers.enableDisposable', 'POST', `/api/providers/${disposableProvider.id}/enable`, 'providerEnabledResponseSchema', { payload: {} });
  await r('providers.disableDisposable', 'POST', `/api/providers/${disposableProvider.id}/disable`, 'providerEnabledResponseSchema', { payload: {} });
  // The disable above leaves nothing active; restore the fixture provider for the checks that follow.
  await r('providers.enable', 'POST', `/api/providers/${providerRow.id}/enable`, 'providerEnabledResponseSchema', { payload: {} });
  await r('error.envelope(404)', 'GET', '/api/wire-check-does-not-exist', 'errorEnvelopeSchema', { expectStatus: 404 });
  await r('error.envelope(400)', 'GET', '/api/artifacts/versions', 'errorEnvelopeSchema', { expectStatus: 400 });
  await r('attention.decide', 'POST', '/api/cowork/tasks/wire-task/approve', 'approvalResultSchema', {
    payload: { approvalId, decision: 'deny' },
  });
  await r('artifacts.versions', 'GET', '/api/artifacts/versions?key=wire/artifact.txt', 'artifactVersionsResponseSchema', { requireNonEmpty: 'versions' });
  await r('chat.resumeInNewSession', 'POST', `/api/chat/${chat.id}/resume-in-new-session`, 'resumeInNewSessionResponseSchema', { payload: {} });
  await r('storage.discardWorktree', 'POST', '/api/storage/worktrees/wire-orphan/discard', 'discardWorktreeResponseSchema', { payload: { force: true } });
  await r('chat.delete', 'DELETE', `/api/chat/${chat.id}`, 'deletedResponseSchema');

  // --- stream payloads ------------------------------------------------------
  // The seven `chatSse*` schemas validate frames on a live stream, so they are
  // exercised by opening streams rather than by asserting their shape. Three of
  // them need paths a happy stream never takes, and the mock provider serves all
  // three: a model it streams, a model it fails so the router can fail over from
  // it, and a model it fails with nowhere left to go.
  const { createChat: createStreamChat } = await import('../../src/db/chats.ts');
  const { createProvider: createStreamProvider, enableProvider: enableStreamProvider } =
    await import('../../src/providers/repository.ts');

  const streamChat = createStreamChat({ tool: 'chat', title: 'Wire stream' });
  const streamAltChat = createStreamChat({ tool: 'chat', title: 'Wire stream failover' });
  const streamDeadChat = createStreamChat({ tool: 'chat', title: 'Wire stream dead end' });
  const okProvider = createStreamProvider({
    name: 'Wire stream provider',
    type: 'remote',
    baseUrl: providerBase,
    apiKey: 'wire-key',
    maxContextTokens: 8192,
  });
  const altProvider = createStreamProvider({
    name: 'Wire stream backup',
    type: 'remote',
    baseUrl: altBase,
    apiKey: 'wire-key',
    maxContextTokens: 8192,
  });
  enableStreamProvider(okProvider.id);
  enableStreamProvider(altProvider.id);

  // 1. A normal turn: open, token, usage, done.
  const happy = await openChatStream({
    chatId: streamChat.id,
    tool: 'chat',
    modelId: 'wire-model',
    prompt: 'Say something short.',
    providerId: okProvider.id,
  });
  if (happy.status !== 200) {
    results.push({ name: 'chat.sse stream opened', ok: false, detail: `HTTP ${happy.status}` });
  }
  checkFrames('chat.sseOpen', happy.frames, 'open', 'chatSseOpenSchema', { schemas, decode: decoders.decodeChatEvent });
  checkFrames('chat.sseToken', happy.frames, 'token', 'chatSseTokenSchema', { schemas, decode: decoders.decodeChatEvent });
  checkFrames('chat.sseUsage', happy.frames, 'usage', 'chatSseUsageSchema', { schemas, decode: decoders.decodeChatEvent });
  checkFrames('chat.sseDone', happy.frames, 'done', 'chatSseDoneSchema', { schemas, decode: decoders.decodeChatEvent });

  // 2. A failing provider with a working alternative behind it: the run pauses
  //    transiently (the switch, which the UI must show), then resumes on the
  //    backup. This is the only path that emits `resumed`.
  const failover = await openChatStream({
    chatId: streamAltChat.id,
    tool: 'chat',
    modelId: 'wire-unstable',
    prompt: 'This one fails over.',
    providerId: okProvider.id,
  });
  checkFrames('chat.ssePaused', failover.frames, 'paused', 'chatSsePausedSchema', { schemas, decode: decoders.decodeChatEvent });
  checkFrames('chat.sseResumed', failover.frames, 'resumed', 'chatSseResumedSchema', { schemas, decode: decoders.decodeChatEvent });

  // 3. A failing provider with nothing behind it: the honest dead end, which is
  //    the only path that emits `error`.
  await openChatStream({
    chatId: streamDeadChat.id,
    tool: 'chat',
    modelId: 'wire-dead',
    prompt: 'This one has nowhere to go.',
    providerId: okProvider.id,
  });
  // A dead end with no error frame is what the *pause* path does: the run pauses on a
  // 200 and the stream ends normally (src/orchestrator/chat.ts returns after emitting
  // `paused`). The `error` frame is for a failure raised while the stream is open, and
  // the redaction gate is one: it refuses before the provider is called, which is after
  // the status line has gone out. Enabled here for one request, then off again, because
  // a gate the fixture leaves on would change what the next check measures.
  const { setSetting } = await import('../../src/db/settings.ts');
  setSetting(REDACTION_CHECK_KEY, 'true');
  const refused = await openChatStream({
    chatId: streamDeadChat.id,
    tool: 'chat',
    modelId: 'wire-model',
    prompt: 'here is my key: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
    providerId: okProvider.id,
  });
  checkFrames('chat.sseError', refused.frames, 'error', 'chatSseErrorSchema', {
    schemas,
    decode: decoders.decodeChatEvent,
  });

  // The agent protocol's `error` frame comes from the same emitter, and until
  // 2026-09-22 the frontend decoded it with the HTTP envelope schema instead — so
  // every failed task run was dropped as `invalid_payload`, and since `error` is the
  // only terminal event name this protocol has, the failure arrived as a
  // reconciliation with no code and no message. Driven here for real: a cowork run
  // that cannot be routed to any provider fails inside the run, where the route
  // answers with `sendError`.
  // A blocked *send* is the one agent failure this protocol reports as a frame rather
  // than a park: the run is interactive, so `parkOnBlockedSend` rethrows instead of
  // parking (src/services/agent/loop.ts), which is what reaches the route's
  // `sendError`. Driven with the same redaction gate the chat check above uses —
  // enabled once, for these two requests.
  // 4. A normal task run, for the channel census below: the agent protocol carries
  //    everything inside one `agent` event with a `channel` discriminator, and the
  //    channel vocabulary is the other half of this boundary.
  const agentRun = await fetch(`${base}/api/cowork/run-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatId: streamDeadChat.id,
      modelId: 'wire-model',
      prompt: 'Say something short.',
      mode: 'ask',
    }),
  });
  const agentRunFrames = await readFrames(agentRun);

  // 5. And a task run that fails, which is where the protocol's `error` frame comes
  //    from. (See the note above `checkFrames` for why this one matters.) A Code run
  //    is provisioned a worktree rooted in the open project, and a path that escapes
  //    that root is refused while provisioning — after `openStream` and after the run
  //    row exists, so the refusal is reported as a frame rather than as a pre-stream
  //    JSON body.
  const agentFailure = await fetch(`${base}/api/code/run-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatId: streamDeadChat.id,
      taskId: 'wire-code-escape',
      modelId: 'wire-model',
      prompt: 'This run cannot start.',
      mode: 'ask',
      cwd: '../../outside-the-project',
    }),
  });
  const agentFrames = await readFrames(agentFailure);
  checkFrames('agent.sseError', agentFrames, 'error', 'chatSseErrorSchema', {
    schemas,
    decode: decoders.decodeAgentEvent,
  });
  // Off again: a gate left on would change what any later check measures.
  setSetting(REDACTION_CHECK_KEY, 'false');

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
  // Reported rather than required, for the same reason as the attention kinds: the
  // channels a check produces are the ones its fixtures reach — `started`, `partial`,
  // `provider`, `switched` and `result` here — while the rest need a parked approval,
  // a subagent or a compaction, which are different fixtures and not different bugs.
  const channelsSeen = new Set(
    [...agentRunFrames, ...agentFrames]
      .filter((frame) => frame.event === 'agent')
      .map((frame) => { try { return JSON.parse(frame.data).channel; } catch { return null; } })
      .filter((channel) => typeof channel === 'string'),
  );
  console.log(`Agent channels observed: ${[...channelsSeen].sort().join(', ') || 'none'}`);

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
  await new Promise((resolve) => alt.close(resolve));
  closeDb();
  rmSync(bundling, { recursive: true, force: true });

  if (failed.length > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  rmSync(home, { recursive: true, force: true });
}
