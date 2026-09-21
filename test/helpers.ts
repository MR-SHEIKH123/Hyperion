/**
 * Test harness.
 *
 * Two things must happen before any `src/` module is imported:
 *   1. HYPERION_HOME must point at a throwaway directory, because config/env.ts
 *      resolves every path once at import time. A test that imports first and
 *      configures second would read and write the user's real ~/Hyperion.
 *   2. The bind guard must be satisfied.
 *
 * So this module sets the environment as a side effect of being imported, and
 * every src import in the tests is dynamic (`await import`) and therefore
 * ordered after it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-test-'));

process.env.NODE_ENV = 'test';
process.env.HYPERION_HOME = root;
process.env.HYPERION_LOG_LEVEL = 'error';
process.env.HYPERION_BIND = '127.0.0.1';
process.env.HYPERION_PORT = '0';
// Keep the health window long enough that timing jitter on a loaded CI box
// cannot silently invalidate a "2 failures in one window" assertion.
process.env.HYPERION_HEALTH_WINDOW_MS = '20000';
process.env.HYPERION_HEALTH_FAILURE_THRESHOLD = '2';
process.env.HYPERION_LOCAL_DETECT_TIMEOUT_MS = '400';
process.env.HYPERION_REQUEST_TIMEOUT_MS = '5000';
process.env.HYPERION_CLEANUP_DISABLED = '1';
// Same reasoning as the cleanup switch, and it covers both background jobs:
// without it a test file that boots the app would start writing real backup
// archives and firing Cowork runs against a registered agent, on a timer no
// assertion is waiting for.
process.env.HYPERION_SCHEDULER_DISABLED = '1';
// The supervisor spawns the default filesystem server with `npx -y`, which
// downloads a package. A unit suite must not reach the network, and an
// abandoned child process would outlive the test run that started it. Tests
// that want a live manager construct one directly, as mcpprocesses.test.ts
// does, rather than relying on boot.
process.env.HYPERION_MCP_DISABLED = '1';

export const testHome = root;

/** Fresh migrated database, isolated per test file. */
export async function freshDb(): Promise<void> {
  const { openDatabase, setDb, closeDb } = await import('../src/db/adapter.ts');
  const { runMigrations } = await import('../src/db/migrate.ts');
  const { ensureDirectories } = await import('../src/config/env.ts');

  ensureDirectories();
  closeDb();
  const db = openDatabase(path.join(root, `test-${randomUUID()}.db`));
  setDb(db);
  runMigrations(db);
}

export async function cleanupHome(): Promise<void> {
  // Windows will not unlink a file that still has an open handle, and SQLite
  // holds the .db plus its -wal and -shm siblings open until closed.
  const { closeDb } = await import('../src/db/adapter.ts');
  closeDb();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// --- mock provider ---------------------------------------------------------

export interface MockBehaviour {
  /** Model IDs reported by GET /models. */
  models?: string[];
  /** Tokens emitted by a successful stream. */
  tokens?: string[];
  /** Status to return instead of streaming (e.g. 500, 401). */
  failStatus?: number;
  /** Status to return from GET /models instead of a model list. */
  modelsFailStatus?: number;
  /**
   * Puter's catalogue, as its two endpoints would answer.
   *
   * A second listing shape is needed because Puter's model catalogue is *not*
   * `{base}/models`: it is a sibling path carrying `context` (the context window)
   * and the vendor behind each model. `catalogueFailStatus` fails the rich
   * endpoint so the documented fallback can be exercised.
   */
  catalogue?: { id: string; name?: string; provider?: string; context?: number }[];
  catalogueFailStatus?: number;
  /**
   * Raw body sent with `failStatus`/`modelsFailStatus`. Real gateways echo the
   * rejected credential here, which is exactly what must not reach the client.
   */
  failBody?: string;
  /** Fail only the first N stream requests, then behave normally. */
  failFirst?: number;
  /**
   * `Retry-After` header sent with a failing stream response.
   *
   * Real gateways send it with a 429, and it is the one thing a rate limit
   * cannot be respected without, so the mock has to be able to say it.
   */
  retryAfter?: string;
  /** Emit these tokens, then abort the connection mid-stream. */
  truncateAfter?: number;
  /** Hang without responding, to exercise the timeout path. */
  hang?: boolean;
  /**
   * Tool calls to stream instead of finishing with prose.
   *
   * Arguments are split across frames on purpose: reassembling fragments keyed
   * by index is the part of the protocol most likely to be implemented wrong,
   * and a single-frame mock would never catch it.
   */
  toolCalls?: { id: string; name: string; arguments: string }[];
  /** Script a different behaviour for each successive request. */
  thenBehave?: MockBehaviour;
}

export interface MockProvider {
  baseUrl: string;
  /**
   * Requests received, for asserting that zero calls were made.
   *
   * `body` is the parsed request, so a test can assert what was actually sent
   * upstream — that `tools` was present, or that a `tool` message carried its
   * `tool_call_id`.
   */
  streamCalls: { model: string; body: Record<string, unknown> }[];
  /**
   * `Authorization` as received on the last stream request, or null.
   *
   * The credential path is otherwise unobservable from a test: a provider whose
   * token never leaves the process looks identical, from the response alone, to
   * one that sends it (Part 1.38).
   */
  lastAuthorization: string | null;
  modelCalls: number;
  behave(next: MockBehaviour): void;
  close(): Promise<void>;
}

/**
 * A real HTTP server speaking the OpenAI-compatible protocol.
 *
 * Deliberately a socket-level server rather than a stubbed adapter: the SSE
 * framing, chunk-boundary buffering and mid-stream truncation handling are
 * exactly the parts most likely to be wrong, and a stub would assert none of it.
 */
export async function startMockProvider(initial: MockBehaviour = {}): Promise<MockProvider> {
  let behaviour: MockBehaviour = { models: ['mock-model'], tokens: ['Hello', ' world'], ...initial };
  const streamCalls: { model: string; body: Record<string, unknown> }[] = [];
  let lastAuthorization: string | null = null;
  let modelCalls = 0;
  let streamRequests = 0;

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';

    // Checked before `/models`: `/puterai/chat/models` also ends with `/models`.
    if (url.endsWith('/puterai/chat/models/details') || url.endsWith('/puterai/chat/models')) {
      const rich = url.endsWith('/details');
      if (rich && behaviour.catalogueFailStatus !== undefined) {
        res.writeHead(behaviour.catalogueFailStatus, { 'Content-Type': 'application/json' });
        res.end(behaviour.failBody ?? JSON.stringify({ error: { code: 'subscription_required' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const catalogue = behaviour.catalogue ?? [];
      res.end(
        JSON.stringify(
          rich
            ? catalogue.map((entry) => ({ provider: 'mock', ...entry }))
            : { models: catalogue.map((entry) => entry.id) },
        ),
      );
      return;
    }

    if (url.endsWith('/models')) {
      modelCalls++;
      if (behaviour.modelsFailStatus !== undefined) {
        res.writeHead(behaviour.modelsFailStatus, { 'Content-Type': 'application/json' });
        res.end(behaviour.failBody ?? JSON.stringify({ error: { message: 'mock failure' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: (behaviour.models ?? []).map((id) => ({ id, object: 'model', owned_by: 'mock' })),
        }),
      );
      return;
    }

    if (url.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        streamRequests++;
        lastAuthorization = req.headers.authorization ?? null;
        const parsed = JSON.parse(body || '{}') as { model?: string };
        streamCalls.push({ model: parsed.model ?? '', body: parsed as Record<string, unknown> });

        if (behaviour.hang) return; // never respond

        const shouldFail =
          behaviour.failStatus !== undefined &&
          (behaviour.failFirst === undefined || streamRequests <= behaviour.failFirst);

        if (shouldFail) {
          res.writeHead(behaviour.failStatus ?? 500, {
            'Content-Type': 'application/json',
            ...(behaviour.retryAfter === undefined ? {} : { 'Retry-After': behaviour.retryAfter }),
          });
          res.end(behaviour.failBody ?? JSON.stringify({ error: { message: 'mock failure' } }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const scripted = behaviour.toolCalls ?? [];
        if (scripted.length > 0) {
          // First frame per call carries id and name; the arguments are then
          // dribbled out in two-character slices so the client has to
          // reassemble them by index.
          for (const [index, call] of scripted.entries()) {
            res.write(
              `data: ${JSON.stringify({
                choices: [
                  {
                    index: 0,
                    delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] },
                  },
                ],
              })}\n\n`,
            );
            for (let at = 0; at < call.arguments.length; at += 2) {
              res.write(
                `data: ${JSON.stringify({
                  choices: [
                    {
                      index: 0,
                      delta: { tool_calls: [{ index, function: { arguments: call.arguments.slice(at, at + 2) } }] },
                    },
                  ],
                })}\n\n`,
              );
            }
          }
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }],
              usage: { prompt_tokens: 11, completion_tokens: 22 },
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
          // A scripted follow-up is how a loop test gets a *different* second
          // turn: without it the model would request the same tool forever.
          if (behaviour.thenBehave) behaviour = behaviour.thenBehave;
          return;
        }

        const tokens = behaviour.tokens ?? [];
        const limit = behaviour.truncateAfter ?? tokens.length;

        for (const [index, token] of tokens.entries()) {
          if (index >= limit) {
            // Kill the socket mid-stream: the client sees a truncated body, which
            // is what a real provider dropping out looks like.
            //
            // The destroy is deferred deliberately. Destroying synchronously
            // after write() tears the socket down before the bytes are flushed,
            // so the client receives *nothing* — which tests a different case
            // (failure before first output) than the one intended here.
            setTimeout(() => res.destroy(), 50);
            return;
          }
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: token }, index: 0 }] })}\n\n`,
          );
        }

        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
            usage: { prompt_tokens: 11, completion_tokens: 22 },
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        if (behaviour.thenBehave) behaviour = behaviour.thenBehave;
      });
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('mock provider failed to bind');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    streamCalls,
    get modelCalls() {
      return modelCalls;
    },
    get lastAuthorization() {
      return lastAuthorization;
    },
    behave(next) {
      behaviour = { ...behaviour, ...next };
      streamRequests = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A port with nothing listening, for connection-refused paths. */
export async function unusedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const { port } = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
