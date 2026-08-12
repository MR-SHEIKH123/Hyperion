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
   * Raw body sent with `failStatus`/`modelsFailStatus`. Real gateways echo the
   * rejected credential here, which is exactly what must not reach the client.
   */
  failBody?: string;
  /** Fail only the first N stream requests, then behave normally. */
  failFirst?: number;
  /** Emit these tokens, then abort the connection mid-stream. */
  truncateAfter?: number;
  /** Hang without responding, to exercise the timeout path. */
  hang?: boolean;
}

export interface MockProvider {
  baseUrl: string;
  /** Requests received, for asserting that zero calls were made. */
  streamCalls: { model: string }[];
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
  const streamCalls: { model: string }[] = [];
  let modelCalls = 0;
  let streamRequests = 0;

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';

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
        const parsed = JSON.parse(body || '{}') as { model?: string };
        streamCalls.push({ model: parsed.model ?? '' });

        if (behaviour.hang) return; // never respond

        const shouldFail =
          behaviour.failStatus !== undefined &&
          (behaviour.failFirst === undefined || streamRequests <= behaviour.failFirst);

        if (shouldFail) {
          res.writeHead(behaviour.failStatus ?? 500, { 'Content-Type': 'application/json' });
          res.end(behaviour.failBody ?? JSON.stringify({ error: { message: 'mock failure' } }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

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
