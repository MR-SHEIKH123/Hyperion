/**
 * An incognito turn is not remembered.
 *
 * `temporaryChats.ts` states the rule and, more usefully, the reason it lives
 * where it does: *"chats.ts checks this registry at the top of every function
 * that writes, so a temporary chat is filtered out at the single point every
 * writer must pass through. Branching inside the orchestrator instead would mean
 * each of the six write sites had to remember, and the one that forgot would
 * persist the transcript with no visible symptom."*
 *
 * Memory is a seventh writer and it does not pass through that point. After a
 * completed turn, `orchestrator/chat.ts` hands the exchange to `rememberTurn`,
 * which asks mem0 to extract facts and writes them to `~/Hyperion/memory/` —
 * durable, retrievable, and injected into later turns. Nothing in that path asked
 * whether the chat was temporary, so an incognito conversation was recorded in
 * substance: not the transcript as such, but facts distilled from it, plus the
 * private chat's id as metadata on every one of them. The user was told the
 * conversation was not being recorded.
 *
 * The guard therefore goes in the writer (`rememberTurn`), not the caller — the
 * same reasoning the storage layer already uses, applied to a writer that reaches
 * a different store. `RememberOutcome` is returned so the decision is observable
 * and a future caller cannot silently re-open the hole by ignoring it.
 *
 * What is deliberately *not* skipped: recall. Reading memories into an incognito
 * turn records nothing new, and the promise is about what is written. Spending is
 * not skipped either — `usage_log` already records an anonymous row, which is the
 * one write whose absence would be a bypass (see the temporary-chats contract).
 */

// Set before `src/config/env.ts` is first imported, which resolves it once: port 9
// is the discard port, so a memory write that *does* get dispatched fails fast
// instead of hanging the suite on a connection attempt.
process.env.OLLAMA_URL = 'http://127.0.0.1:9';

import './helpers.ts';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { after, before, describe } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

const { createChat } = await import('../src/db/chats.ts');
const { createTemporaryChat } = await import('../src/db/temporaryChats.ts');
const { setSetting } = await import('../src/db/settings.ts');
const { env } = await import('../src/config/env.ts');
const { rememberTurn, MEMORY_ENABLED_KEY } = await import('../src/services/memory/index.ts');

before(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

describe('handing a completed turn to the memory plugin', () => {
  test('a temporary chat is refused before anything is loaded or written', async () => {
    setSetting(MEMORY_ENABLED_KEY, true);

    const temporary = createTemporaryChat({ tool: 'chat', title: 'Private' });
    const outcome = rememberTurn('My salary is 4,200 a month.', 'Noted — anything else?', {
      tool: 'chat',
      chatId: temporary.id,
    });

    assert.equal(outcome, 'temporary');

    // The dispatch is fire-and-forget, so give a write that *was* started time to
    // reach the disk — mem0 creates its stores on first use, and the directory
    // being untouched afterwards is the evidence that nothing was even attempted.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(fs.readdirSync(env.paths.memory), [], 'the memory store was written to');
    assert.equal(fs.existsSync(`${env.paths.memory}/history.db`), false);
  });

  test('a saved chat is still queued, so the guard is about the chat and not everything', () => {
    setSetting(MEMORY_ENABLED_KEY, true);

    const saved = createChat({ id: 'saved-chat', tool: 'chat', title: 'Saved' });
    const outcome = rememberTurn('What is on my calendar?', 'Two meetings.', {
      tool: 'chat',
      chatId: saved.id,
    });

    assert.equal(outcome, 'queued');
  });

  test('the toggle still comes first, and is reported as itself', () => {
    setSetting(MEMORY_ENABLED_KEY, false);

    const saved = createChat({ id: 'saved-chat-2', tool: 'chat', title: 'Saved too' });
    const outcome = rememberTurn('hello', 'hi', { tool: 'chat', chatId: saved.id });

    assert.equal(outcome, 'disabled');
  });

  test('an empty turn is not worth extracting from', () => {
    setSetting(MEMORY_ENABLED_KEY, true);

    const saved = createChat({ id: 'saved-chat-3', tool: 'chat', title: 'Saved third' });
    const outcome = rememberTurn('   ', '   ', { tool: 'chat', chatId: saved.id });

    assert.equal(outcome, 'empty');
  });
});
