/**
 * The declared context ceiling (Part 1.28).
 *
 * `1.28` documented the window ladder as "an explicit override, then the context
 * length the provider reported, then the conservative default" — and when this
 * file was written, the first rung was reachable only from a unit test:
 * `providers.max_context_tokens` existed since migration `017` (and was carried
 * through `023`'s table rebuild), `resolveContextWindow` accepted an `override`,
 * and **nothing in `src/` read the column or wrote it**. A user could not declare
 * a ceiling, and a row that had one was ignored.
 *
 * These tests pin the wiring in both directions, because either half alone is
 * invisible: the field must survive the repository (create, read back, update,
 * clear), the route must accept and refuse it with a field name, and the read
 * that a person actually looks at — `GET /api/chat/:id/context` — must report
 * `source: 'override'` rather than the model's own number.
 *
 * The refusal cases matter more than they look: a ceiling of `0` would be read as
 * "compact everything", and a fraction is a client bug. Both are `400`s naming
 * `maxContextTokens` instead of being rounded into something plausible.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

const { cleanupHome, freshDb, startMockProvider } = await import('./helpers.ts');
const { createApp } = await import('../src/http/app.ts');
const { createProvider, findProvider, saveModelCache, updateProvider } = await import('../src/providers/repository.ts');
const { createChat, appendMessage } = await import('../src/db/chats.ts');
const { DEFAULT_CONTEXT_TOKENS, OLLAMA_DEFAULT_CONTEXT_TOKENS } = await import('../src/services/agent/compaction.ts');

let base = '';
let server: { close: (cb: () => void) => void };

before(async () => {
  await freshDb();
  const app = createApp();
  await new Promise<void>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => {
      const address = listening.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      base = `http://127.0.0.1:${address.port}`;
      server = listening;
      resolve();
    });
  });
});

beforeEach(async () => {
  await freshDb();
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('a declared ceiling is stored, read back, and cleared', () => {
  it('round-trips through the repository and the public shape', async () => {
    const provider = createProvider({
      name: 'Declared',
      type: 'remote',
      baseUrl: 'https://example.test/v1',
      maxContextTokens: 200_000,
    });
    assert.equal(provider.maxContextTokens, 200_000);
    // Read back rather than trusting the object the insert returned.
    assert.equal(findProvider(provider.id)?.maxContextTokens, 200_000);

    // The frontend's shape carries it: a settings screen that cannot show the
    // number cannot edit it.
    const listed = await json('/api/providers');
    const rows = (listed.body.providers ?? []) as { id: string; maxContextTokens: number | null }[];
    assert.equal(rows.find((row) => row.id === provider.id)?.maxContextTokens, 200_000);
  });

  it('updates, and `null` removes the declaration without touching the endpoint', async () => {
    const provider = createProvider({ name: 'Declared', type: 'remote', baseUrl: 'https://example.test/v1' });
    assert.equal(provider.maxContextTokens, null, 'absent means no declaration');

    const set = updateProvider(provider.id, { maxContextTokens: 32_768 });
    assert.equal(set.maxContextTokens, 32_768);

    const cleared = updateProvider(provider.id, { maxContextTokens: null });
    assert.equal(cleared.maxContextTokens, null);
    // A ceiling is not part of the endpoint: declaring one must not throw away the
    // model cache the way editing `baseUrl` legitimately does.
    assert.equal(updateProvider(provider.id, { maxContextTokens: 1_000 }).baseUrl, set.baseUrl);
  });

  it('refuses zero, negatives and fractions, naming the field', async () => {
    for (const value of [0, -1, 2.5, 'lots']) {
      const created = await json('/api/providers', {
        method: 'POST',
        body: JSON.stringify({ name: `Bad ${String(value)}`, type: 'remote', baseUrl: 'https://example.test/v1', maxContextTokens: value }),
      });
      assert.equal(created.status, 400, `rejected: ${String(value)}`);
      const error = created.body.error as { details?: { field?: string } };
      assert.equal(error.details?.field, 'maxContextTokens');
    }
  });

  it('refuses the same values at the repository, where other callers enter', async () => {
    // The route is not the only door: local-provider detection and the scheduler
    // create and update providers directly. A rule enforced at one entry point is
    // a rule the next entry point can bypass, so the refusal is asserted here too.
    const { AppError } = await import('../src/util/errors.ts');
    for (const value of [0, -1, 2.5]) {
      assert.throws(
        () => createProvider({ name: `Bad ${String(value)}`, type: 'remote', baseUrl: 'https://example.test/v1', maxContextTokens: value }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'bad_request');
          assert.equal(error.details?.['field'], 'maxContextTokens');
          return true;
        },
      );
    }
    const provider = createProvider({ name: 'Fine', type: 'remote', baseUrl: 'https://example.test/v1' });
    assert.throws(() => updateProvider(provider.id, { maxContextTokens: 0 }), /positive integer/);
    // A refused write leaves the row exactly as it was.
    assert.equal(findProvider(provider.id)?.maxContextTokens, null);
  });

  it('accepts a ceiling on create and on patch, over the wire', async () => {
    const created = await json('/api/providers', {
      method: 'POST',
      body: JSON.stringify({ name: 'Over the wire', type: 'remote', baseUrl: 'https://example.test/v1', maxContextTokens: 65_536 }),
    });
    assert.equal(created.status, 201);
    const id = (created.body.provider as { id: string }).id;

    const patched = await json(`/api/providers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ maxContextTokens: 131_072 }),
    });
    assert.equal(patched.status, 200);
    assert.equal((patched.body.provider as { maxContextTokens: number }).maxContextTokens, 131_072);

    const badPatch = await json(`/api/providers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ maxContextTokens: 0 }),
    });
    assert.equal(badPatch.status, 400);
    // And the stored value is untouched by the refused write.
    assert.equal(findProvider(id)?.maxContextTokens, 131_072);
  });
});

describe('the ceiling reaches the read a person looks at', () => {
  /** A chat long enough that the ratio is worth reporting. */
  async function chatWith(providerId: string | null, modelId: string): Promise<string> {
    const chat = createChat({ tool: 'chat', title: 'Long enough', modelId, providerId });
    for (let index = 0; index < 6; index++) {
      appendMessage({ chatId: chat.id, role: 'user', content: 'x'.repeat(1_200), status: 'complete' });
    }
    return chat.id;
  }

  it('reports source `override` when the chat declares one through its provider', async () => {
    const provider = createProvider({
      name: 'Declared',
      type: 'remote',
      baseUrl: 'https://example.test/v1',
      enabled: true,
      maxContextTokens: 4_000,
    });
    const chatId = await chatWith(provider.id, 'model-unknown-to-the-cache');

    const read = await json(`/api/chat/${chatId}/context`);
    assert.equal(read.status, 200);
    const window = read.body.window as { tokens: number; source: string; assumed: boolean };
    // The declared number, not the 8 192 default the missing model would give —
    // that difference is the whole point of the field.
    assert.equal(window.tokens, 4_000);
    assert.equal(window.source, 'override');
    assert.equal(window.assumed, false);
  });

  it('falls back to the honest default when nobody declared anything', async () => {
    const provider = createProvider({ name: 'Silent', type: 'remote', baseUrl: 'https://example.test/v1', enabled: true });
    const chatId = await chatWith(provider.id, 'model-unknown-to-the-cache');

    const read = await json(`/api/chat/${chatId}/context`);
    const window = read.body.window as { tokens: number; source: string; assumed: boolean };
    assert.equal(window.tokens, DEFAULT_CONTEXT_TOKENS);
    assert.equal(window.source, 'default');
    assert.equal(window.assumed, true);
  });

  it('falls back to the provider list for a chat with no provider of its own', async () => {
    // No chat provider: the read resolves the active one, the same choice the send
    // path makes, so the two cannot disagree about how full a conversation is.
    createProvider({
      name: 'Active',
      type: 'remote',
      baseUrl: 'https://example.test/v1',
      enabled: true,
      maxContextTokens: 16_000,
    });
    const chatId = await chatWith(null, 'model-unknown-to-the-cache');

    const read = await json(`/api/chat/${chatId}/context`);
    assert.equal((read.body.window as { source: string }).source, 'override');
    assert.equal((read.body.window as { tokens: number }).tokens, 16_000);
  });

  it('a local runner with no declaration falls back to Ollama\'s own default, not the gateway one', async () => {
    // Ollama loads 4 096 tokens by default and truncates silently past it, where
    // an OpenAI-shaped gateway refuses the request outright. Guessing the
    // gateway default here would let a conversation look like it fits while the
    // model answered a shortened prompt — the failure with no recovery.
    const provider = createProvider({ name: 'Local', type: 'local', baseUrl: 'http://127.0.0.1:11434', enabled: true });
    const chatId = await chatWith(provider.id, 'model-unknown-to-the-cache');

    const read = await json(`/api/chat/${chatId}/context`);
    const window = read.body.window as { tokens: number; source: string; assumed: boolean };
    assert.equal(window.tokens, OLLAMA_DEFAULT_CONTEXT_TOKENS);
    assert.equal(window.source, 'default');
    assert.equal(window.assumed, true, 'it is still a guess, and the UI must be able to say so');
  });

  it('a local runner that declares a ceiling gets it, because the user knows their own Modelfile', async () => {
    const provider = createProvider({
      name: 'Local, declared',
      type: 'local',
      baseUrl: 'http://127.0.0.1:11434',
      enabled: true,
      maxContextTokens: 32_768,
    });
    const chatId = await chatWith(provider.id, 'model-unknown-to-the-cache');

    const read = await json(`/api/chat/${chatId}/context`);
    const window = read.body.window as { tokens: number; source: string };
    assert.equal(window.tokens, 32_768);
    assert.equal(window.source, 'override');
  });

  it('a declared ceiling that is not reachable does not leak into another provider', async () => {
    // Two providers, one declaring. The chat names the silent one, so the
    // declaration must not apply to it — an override is a fact about a provider,
    // not a global setting.
    const silent = createProvider({ name: 'Silent', type: 'remote', baseUrl: 'https://example.test/v1', enabled: true });
    createProvider({
      name: 'Declared',
      type: 'remote',
      baseUrl: 'https://example.test/v1',
      maxContextTokens: 4_000,
    });
    const chatId = await chatWith(silent.id, 'model-unknown-to-the-cache');

    const read = await json(`/api/chat/${chatId}/context`);
    const window = read.body.window as { tokens: number; source: string };
    assert.equal(window.tokens, DEFAULT_CONTEXT_TOKENS);
    assert.equal(window.source, 'default');
  });

  it('a provider whose model list reports a window is still overridden by the declaration', async () => {
    // Both rungs are present and they disagree: the declaration wins, because a
    // person who typed a number meant it and a gateway's `context_length` is
    // frequently the model's marketing maximum rather than what it will accept.
    const mock = await startMockProvider({ models: ['reported-model'] });
    try {
      const provider = createProvider({
        name: 'Declared',
        type: 'remote',
        baseUrl: mock.baseUrl,
        enabled: true,
        maxContextTokens: 9_000,
      });
      saveModelCache(provider.id, [{ id: 'reported-model', contextLength: 100_000 }]);
      const chatId = await chatWith(provider.id, 'reported-model');

      const read = await json(`/api/chat/${chatId}/context`);
      const window = read.body.window as { tokens: number; source: string };
      assert.equal(window.tokens, 9_000);
      assert.equal(window.source, 'override');
    } finally {
      await mock.close();
    }
  });
});
