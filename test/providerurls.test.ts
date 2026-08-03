/**
 * Base URL normalization.
 *
 * Kept separate from `providers.test.ts`, which covers registry, health and
 * routing behaviour. This file is about one thing: the shape of a stored base
 * URL, and the fact that the two provider families disagree about it.
 *
 * OpenAI-compatible endpoints take a base URL that conventionally already ends
 * in `/v1`, because the client appends `/chat/completions`. Anthropic-native
 * takes a plain host and appends `/v1/messages` itself. Ollama's local API lives
 * under `/api/...` with no `/v1` anywhere. So `/v1` cannot be appended blindly —
 * only for the types on the allowlist.
 *
 * The case that motivated this: **Ollama Cloud** (the remote, key-based,
 * OpenAI-compatible service, not the local runner) is handed out as a bare
 * `https://ollama.com`. Every request 404s until `/v1` is on the end.
 */
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupHome, freshDb } from './helpers.ts';

// Imported after helpers.ts has set the environment.
const { createProvider, normalizeBaseUrl, updateProvider } = await import(
  '../src/providers/repository.ts'
);
const { AppError } = await import('../src/util/errors.ts');

beforeEach(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

// --- the four required cases ----------------------------------------------

test('an openai-compatible base URL without /v1 gets it appended', () => {
  const provider = createProvider({
    name: 'Ollama Cloud',
    type: 'remote',
    baseUrl: 'https://ollama.com',
  });

  assert.equal(provider.baseUrl, 'https://ollama.com/v1');
});

test('a base URL that already ends in /v1 is left exactly as typed', () => {
  const provider = createProvider({
    name: 'Already versioned',
    type: 'remote',
    baseUrl: 'https://api.openai.com/v1',
  });

  assert.equal(provider.baseUrl, 'https://api.openai.com/v1');
});

test('a trailing slash does not produce a double slash before /v1', () => {
  const provider = createProvider({
    name: 'Trailing slash',
    type: 'remote',
    baseUrl: 'https://ollama.com/',
  });

  assert.equal(provider.baseUrl, 'https://ollama.com/v1');
  assert.ok(!provider.baseUrl.includes('//v1'), 'no double slash');
});

test('a base URL that is not openai-compatible is never modified', () => {
  // An Anthropic-native host appends /v1/messages itself and Ollama's local API
  // has no /v1 at all. Bolting it on would break both.
  const local = createProvider({
    name: 'Local',
    type: 'local',
    baseUrl: 'http://127.0.0.1:11434',
  });
  const codex = createProvider({
    name: 'Codex',
    type: 'opencodex',
    baseUrl: 'https://codex.test',
  });

  assert.equal(local.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(codex.baseUrl, 'https://codex.test');
});

// --- the surrounding edges ------------------------------------------------

test('a base URL that already carries a path keeps it', () => {
  // "https://openrouter.ai/api/v1" and "https://host/openai" are both real
  // shapes. Appending /v1 to either would be wrong, so only a bare host is
  // treated as missing its version segment.
  const routed = createProvider({
    name: 'Routed',
    type: 'remote',
    baseUrl: 'https://openrouter.ai/api/v1',
  });
  const prefixed = createProvider({
    name: 'Prefixed',
    type: 'remote',
    baseUrl: 'https://host.test/openai',
  });

  assert.equal(routed.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(prefixed.baseUrl, 'https://host.test/openai');
});

test('editing a base URL normalizes it the same way creating one does', () => {
  // A provider's type is immutable, so an edit is normalized through the stored
  // type rather than one supplied with the patch.
  const provider = createProvider({
    name: 'Edited',
    type: 'remote',
    baseUrl: 'https://a.test/v1',
  });

  const updated = updateProvider(provider.id, { baseUrl: 'https://ollama.com/' });

  assert.equal(updated.baseUrl, 'https://ollama.com/v1');
});

test('whitespace is trimmed and a pasted URL with a port still normalizes', () => {
  assert.equal(normalizeBaseUrl('  https://ollama.com  ', 'remote'), 'https://ollama.com/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8080', 'remote'), 'http://127.0.0.1:8080/v1');
});

test('a malformed or non-http base URL is rejected rather than stored', () => {
  // Normalization is the last place a typo can be caught cheaply — after this
  // the URL is only ever seen by fetch, mid-request.
  for (const bad of ['', '   ', 'not a url', 'ftp://files.test', 'ollama.com']) {
    assert.throws(
      () => normalizeBaseUrl(bad, 'remote'),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'bad_request');
        return true;
      },
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test('normalizing without a type leaves the URL alone but still validates it', () => {
  // No type means no opinion about /v1 — used where a URL is checked outside the
  // context of a provider row.
  assert.equal(normalizeBaseUrl('https://ollama.com/'), 'https://ollama.com');
  assert.throws(() => normalizeBaseUrl('nonsense'));
});
