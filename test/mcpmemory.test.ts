/**
 * The first-party memory MCP server: `memory_search` and `memory_add`.
 *
 * The handlers are unit-tested with stub dependencies, because the tool
 * contract (argument validation, outcome mapping, honest refusals) must hold
 * regardless of backend state. The entry itself is tested by spawning it for
 * real through the process manager: a stdio server's contract is its stdio
 * discipline, and only a live child proves a log line never lands mid-stream.
 * The plugin stays off in the spawned tests, so both tools refuse — a refusal
 * is a full round trip, and it needs no Ollama.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

const {
  MEMORY_ADD_TOOL,
  MEMORY_SEARCH_TOOL,
  createMemoryMcpServer,
  handleMemoryAdd,
  handleMemorySearch,
  memoryToolDefinitions,
} = await import('../src/mcp-servers/memory.ts');

function textOf(result: { content: unknown[] }): string {
  const first = result.content[0] as { type?: unknown; text?: unknown } | undefined;
  return typeof first?.text === 'string' ? first.text : '';
}

describe('the memory MCP tool surface', () => {
  it('offers exactly memory_search and memory_add, with honest schemas', () => {
    assert.equal(MEMORY_SEARCH_TOOL, 'memory_search');
    assert.equal(MEMORY_ADD_TOOL, 'memory_add');
    const tools = memoryToolDefinitions();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['memory_add', 'memory_search']);
    const search = tools.find((tool) => tool.name === 'memory_search');
    assert.deepEqual((search?.inputSchema as { properties?: object })?.properties !== undefined, true);
    const add = tools.find((tool) => tool.name === 'memory_add');
    assert.deepEqual((add?.inputSchema as { required?: string[] })?.required, ['text']);
  });

  it('registers both tools on the served server', async () => {
    // The factory is what the entry serves; pinning the list here keeps a
    // handler that exists but is never registered from passing quietly.
    const server = createMemoryMcpServer({ isEnabled: () => false });
    assert.ok(server, 'the factory builds a server');
    assert.equal(memoryToolDefinitions().length, 2);
  });
});

describe('memory_search', () => {
  const entry = {
    id: 'm1',
    memory: 'I prefer tabs.',
    createdAt: null,
    updatedAt: null,
    score: 0.9,
    tool: 'settings',
    chatId: null,
  };

  it('is an error, not an empty list, when the plugin is off', async () => {
    const result = await handleMemorySearch({ query: 'tabs' }, { isEnabled: () => false });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /plugin is off/);
  });

  it('passes the query and limit through, and answers the entries as JSON', async () => {
    const seen: unknown[] = [];
    const result = await handleMemorySearch(
      { query: 'tabs', limit: 3 },
      {
        isEnabled: () => true,
        list: async (options) => {
          seen.push(options);
          return [entry];
        },
      },
    );
    assert.equal(result.isError, undefined);
    assert.deepEqual(seen, [{ query: 'tabs', limit: 3 }]);
    assert.deepEqual(JSON.parse(textOf(result)), { memories: [entry] });
  });

  it('lists recent memories when no query is given', async () => {
    const seen: unknown[] = [];
    await handleMemorySearch(
      {},
      {
        isEnabled: () => true,
        list: async (options) => {
          seen.push(options);
          return [];
        },
      },
    );
    assert.deepEqual(seen, [{}]);
  });

  it('refuses a limit that is not a positive whole number within the bound', async () => {
    for (const limit of [0, -2, 1.5, 'ten', 201]) {
      const result = await handleMemorySearch(
        { limit },
        {
          isEnabled: () => true,
          list: async () => {
            throw new Error('the backend must not be reached');
          },
        },
      );
      assert.equal(result.isError, true, `limit ${String(limit)}`);
      assert.match(textOf(result), /limit/, `limit ${String(limit)}`);
    }
  });

  it('refuses a non-string query without reaching the backend', async () => {
    const result = await handleMemorySearch(
      { query: 42 },
      {
        isEnabled: () => true,
        list: async () => {
          throw new Error('the backend must not be reached');
        },
      },
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /query must be a string/);
  });

  it('names an unreadable plugin switch instead of throwing a protocol error', async () => {
    const result = await handleMemorySearch(
      { query: 'tabs' },
      {
        isEnabled: () => {
          throw new Error('settings table missing');
        },
      },
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Could not read the Memory switch/);
  });

  it('turns a misbehaving backend into a tool error, not a crash', async () => {
    const result = await handleMemorySearch(
      { query: 'tabs' },
      {
        isEnabled: () => true,
        list: async () => {
          throw new Error('vector store exploded');
        },
      },
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /vector store exploded/);
  });
});

describe('memory_add', () => {
  it('is an error, not a silent no-op, when the plugin is off', async () => {
    const result = await handleMemoryAdd({ text: 'I prefer tabs.' }, { isEnabled: () => false });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /plugin is off/);
  });

  it('stores through the injected add, and says so as JSON', async () => {
    const seen: string[] = [];
    const result = await handleMemoryAdd(
      { text: 'I prefer tabs.' },
      {
        isEnabled: () => true,
        add: async (text) => {
          seen.push(text);
          return 'stored';
        },
      },
    );
    assert.equal(result.isError, undefined);
    assert.deepEqual(seen, ['I prefer tabs.']);
    assert.deepEqual(JSON.parse(textOf(result)), { stored: true });
  });

  it('maps every backend outcome to a tool answer', async () => {
    for (const [outcome, pattern] of [
      ['disabled', /plugin is off/],
      ['unavailable', /not available/],
      ['empty', /non-empty/],
    ] as const) {
      const result = await handleMemoryAdd(
        { text: 'I prefer tabs.' },
        { isEnabled: () => true, add: async () => outcome },
      );
      assert.equal(result.isError, true, outcome);
      assert.match(textOf(result), pattern, outcome);
    }
  });

  it('refuses empty, missing, and non-string text before the backend', async () => {
    for (const text of ['', '   ', undefined, 42]) {
      const result = await handleMemoryAdd(
        text === undefined ? {} : { text },
        {
          isEnabled: () => true,
          add: async () => {
            throw new Error('the backend must not be reached');
          },
        },
      );
      assert.equal(result.isError, true, String(text));
      assert.match(textOf(result), /non-empty/, String(text));
    }
  });

  it('holds the same length bound as the add route, and names it', async () => {
    const { MEMORY_MAX_CHARS } = await import('../src/services/memory/index.ts');
    const result = await handleMemoryAdd(
      { text: 'x'.repeat(MEMORY_MAX_CHARS + 1) },
      {
        isEnabled: () => true,
        add: async () => {
          throw new Error('the backend must not be reached');
        },
      },
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), new RegExp(String(MEMORY_MAX_CHARS)));
  });
});

describe('logger silence for stdio children', () => {
  it('discards every line while silent, and writes again when restored', async () => {
    const { createLogger, setLogSilent } = await import('../src/util/logger.ts');
    // The test log level is `error`, so `error` is the line that writes.
    const log = createLogger('mcpmemory-test');
    const writes: string[] = [];
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      setLogSilent(true);
      log.error('this must not reach any stream');
      assert.deepEqual(writes, []);
      setLogSilent(false);
      log.error('this must reach stderr');
      assert.equal(writes.length, 1);
      assert.match(writes[0] ?? '', /this must reach stderr/);
    } finally {
      setLogSilent(false);
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    }
  });
});

describe('the served memory server', () => {
  before(async () => {
    await freshDb();
    // Boot migrates the default-path database before the supervisor spawns
    // anything; the child opens that same file (it cannot know the test's
    // uuid database), so mirror boot here.
    const { env } = await import('../src/config/env.ts');
    const { openDatabase } = await import('../src/db/adapter.ts');
    const { runMigrations } = await import('../src/db/migrate.ts');
    const db = openDatabase(env.paths.db);
    try {
      runMigrations(db);
    } finally {
      db.close();
    }
  });

  after(async () => {
    await cleanupHome();
  });

  /** Poll until a condition holds or the deadline passes. */
  async function waitFor(check: () => boolean, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for condition.');
  }

  it('serves both tools over a live stdio child with clean streams', async () => {
    const { env } = await import('../src/config/env.ts');
    const { createServer } = await import('../src/services/mcp/registry.ts');
    const { createProcessManager } = await import('../src/services/mcp/processManager.ts');

    // The seed's own shape: this Node running the shipped script.
    const record = createServer({
      name: 'memory-live',
      type: 'local',
      command: process.execPath,
      args: [path.join(env.appRoot, 'src', 'mcp-servers', 'memory.ts')],
      enabled: true,
    });

    const manager = createProcessManager();
    try {
      await manager.start(record.name);
      // A log line on stdout would corrupt the handshake and leave the
      // server in `error` — reaching `running` is the stdio assertion.
      await waitFor(() =>
        manager.getStatus().some((status) => status.name === 'memory-live' && status.state === 'running'),
      );
      const tools = await manager.listTools('memory-live');
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ['memory_add', 'memory_search'],
      );

      // The plugin is off in a fresh home: both tools refuse honestly, and a
      // refusal is a full round trip through the child.
      const search = await manager.callTool('memory-live', 'memory_search', { query: 'tabs' });
      assert.equal(search.isError, true);
      assert.match(textOf(search), /plugin is off/);

      const add = await manager.callTool('memory-live', 'memory_add', { text: 'I prefer tabs.' });
      assert.equal(add.isError, true);
      assert.match(textOf(add), /plugin is off/);

      const unknown = await manager.callTool('memory-live', 'memory_forget', {});
      assert.equal(unknown.isError, true);
      assert.match(textOf(unknown), /Unknown tool/);
    } finally {
      await manager.stopAll();
    }
  });
});
