/**
 * Temporary ("incognito") chats and bulk chat deletion — Prompt 1.20.
 *
 * The guarantee that matters is negative: a temporary chat must not appear in
 * the chat list, the activity feed, or a bulk export, and no row may exist for
 * one. Negative guarantees are the easy ones to think you have, so these assert
 * against the real table and the real listing rather than the in-memory
 * registry that would agree with itself.
 *
 * The counterpart is deliberately positive: token usage IS still recorded, so
 * toggling incognito cannot be used to slip past the daily spending cap.
 */

import assert from 'node:assert/strict';
import test, { after, before, beforeEach, describe } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

import type { Server } from 'node:http';

const { getDb } = await import('../src/db/adapter.ts');
const {
  appendMessage,
  createChat,
  deleteChats,
  findChat,
  listChats,
  listMessagePage,
  listMessages,
  setChatArchived,
  setChatPinned,
} = await import('../src/db/chats.ts');
const { clearTemporaryChats, createTemporaryChat, isTemporaryChat, temporaryChatCount } =
  await import('../src/db/temporaryChats.ts');
const { recordUsage } = await import('../src/db/usage.ts');
const { spendStatus } = await import('../src/services/limits/budget.ts');
const { activityFeed } = await import('../src/services/activity/feed.ts');
const { exportBulk } = await import('../src/services/export/bulk.ts');

let server: Server;
let base: string;

before(async () => {
  await freshDb();
  const { createApp } = await import('../src/http/app.ts');
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

beforeEach(() => {
  // The registry is process-wide, so a leaked session would make the next
  // file's assertions depend on this one's ordering.
  clearTemporaryChats();
});

after(async () => {
  clearTemporaryChats();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

/** Rows in `chats` for this id — the only authority on "was it persisted". */
function chatRowCount(id: string): number {
  const row = getDb()
    .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM chats WHERE id = ?')
    .get(id);
  return row?.n ?? 0;
}

describe('a temporary chat never reaches the database', () => {
  test('creating one writes no row but is still findable', () => {
    const chat = createTemporaryChat({ tool: 'chat', title: 'private' });

    assert.equal(chatRowCount(chat.id), 0);
    assert.equal(isTemporaryChat(chat.id), true);
    // Findable through the same accessor the routes use, so callers need no
    // special case to read one back.
    assert.equal(findChat(chat.id)?.title, 'private');
  });

  test('its messages are readable but unwritten', () => {
    const chat = createTemporaryChat({ tool: 'chat' });
    appendMessage({ chatId: chat.id, role: 'user', content: 'a secret question' });
    appendMessage({ chatId: chat.id, role: 'assistant', content: 'a secret answer' });

    const messages = listMessages(chat.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.content, 'a secret question');

    const rows = getDb()
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?')
      .get(chat.id);
    assert.equal(rows?.n, 0, 'not one message row may exist for a temporary chat');
  });

  test('paging a temporary transcript honours the same contract as a saved one', () => {
    const chat = createTemporaryChat({ tool: 'chat' });
    for (const text of ['one', 'two', 'three']) {
      appendMessage({ chatId: chat.id, role: 'user', content: text });
    }

    const page = listMessagePage(chat.id, 2);
    assert.equal(page.messages.length, 2);
    // Oldest-first within the page, newest page first — same as the SQL path.
    assert.equal(page.messages[0]?.content, 'two');
    assert.equal(page.messages[1]?.content, 'three');

    const older = listMessagePage(chat.id, 2, page.nextBefore ?? undefined);
    assert.equal(older.messages[0]?.content, 'one');
  });

  test('an unknown paging cursor is rejected the same way the SQL path rejects it', () => {
    const chat = createTemporaryChat({ tool: 'chat' });
    appendMessage({ chatId: chat.id, role: 'user', content: 'only one' });

    assert.throws(
      () => listMessagePage(chat.id, 10, 'msg_not_here'),
      (error: unknown) => (error as { code?: string }).code === 'bad_request',
    );
  });

  test('it is absent from the chat list, which is where the leak would show', () => {
    const saved = createChat({ tool: 'chat', title: 'saved' });
    const temporary = createTemporaryChat({ tool: 'chat', title: 'private' });

    const ids = listChats().map((chat) => chat.id);
    assert.ok(ids.includes(saved.id));
    assert.ok(!ids.includes(temporary.id));
  });

  test('it is absent from the activity feed', () => {
    const temporary = createTemporaryChat({ tool: 'chat', title: 'private' });
    appendMessage({ chatId: temporary.id, role: 'user', content: 'invisible' });

    const feed = activityFeed({ limit: 100 });
    assert.ok(!feed.entries.some((entry) => JSON.stringify(entry).includes(temporary.id)));
  });

  test('a bulk export cannot carry it, because there is nothing to select', () => {
    const temporary = createTemporaryChat({ tool: 'chat', title: 'private' });
    appendMessage({ chatId: temporary.id, role: 'user', content: 'not in the zip' });

    const result = exportBulk({ contentType: 'chats' });
    // The archive is built from a table scan, so absence from the table is what
    // makes this true — asserted here so a future export that reads elsewhere
    // has to face this test.
    assert.ok(!result.skipped.some((entry) => entry.id === temporary.id));
    assert.equal(chatRowCount(temporary.id), 0);
  });

  test('ending one forgets it entirely', () => {
    const chat = createTemporaryChat({ tool: 'chat' });
    appendMessage({ chatId: chat.id, role: 'user', content: 'gone soon' });

    assert.equal(temporaryChatCount(), 1);
    const res = deleteChats([chat.id]);

    assert.deepEqual(res.deleted, [chat.id]);
    assert.equal(temporaryChatCount(), 0);
    assert.equal(findChat(chat.id), null);
  });
});

describe('the refusals that keep a temporary chat honest', () => {
  test('pinning is refused rather than silently ignored', () => {
    const chat = createTemporaryChat({ tool: 'chat' });
    // A no-op returning success would tell the user their chat is protected
    // moments before it vanishes.
    assert.throws(
      () => setChatPinned(chat.id, true),
      (error: unknown) => (error as { code?: string }).code === 'bad_request',
    );
  });

  test('archiving is refused for the same reason', () => {
    const chat = createTemporaryChat({ tool: 'chat' });
    assert.throws(
      () => setChatArchived(chat.id, true),
      (error: unknown) => (error as { code?: string }).code === 'bad_request',
    );
  });

  test('persisting an id that is currently temporary is a conflict', () => {
    const chat = createTemporaryChat({ tool: 'chat' });
    assert.throws(
      () => createChat({ tool: 'chat', id: chat.id }),
      (error: unknown) => (error as { code?: string }).code === 'conflict',
    );
    assert.equal(chatRowCount(chat.id), 0);
  });
});

describe('incognito is not a way around the spending cap', () => {
  test('tokens spent in a temporary chat still count toward the day', () => {
    const chat = createTemporaryChat({ tool: 'chat' });
    // A model id used nowhere else, so the row found below is unambiguously the
    // one this test produced rather than another case's leftovers.
    const modelId = 'incognito-probe-model';

    recordUsage({
      chatId: chat.id,
      messageId: 'msg-that-was-never-persisted',
      tool: 'chat',
      modelId,
      tokensIn: 1000,
      tokensOut: 500,
    });

    const row = getDb()
      .prepare<{ n: number; tokens_in: number; chat_id: string | null; message_id: string | null }>(
        `SELECT COUNT(*) AS n, tokens_in, chat_id, message_id
           FROM usage_log WHERE model_id = ?`,
      )
      .get(modelId);

    // The spend survives, which is the point: `assertWithinSpendCap` reads these
    // rows, so a missing one would make incognito a way to spend for free.
    assert.equal(row?.n, 1);
    assert.equal(row?.tokens_in, 1000);
    assert.ok(spendStatus().unpricedRequestsToday >= 1);
  });

  test('the recorded row does not name the private chat', () => {
    const chat = createTemporaryChat({ tool: 'chat' });
    recordUsage({
      chatId: chat.id,
      messageId: 'another-unpersisted-message',
      tool: 'chat',
      modelId: 'incognito-anonymity-model',
      tokensIn: 10,
      tokensOut: 20,
    });

    // Two guarantees in one query. Privacy: the id of a chat the user asked not
    // to keep must not reach disk, not even as a bare foreign key. Correctness:
    // `usage_log.chat_id` REFERENCES `chats (id)` with enforcement on, so naming
    // an uninserted chat would raise SQLITE_CONSTRAINT — and `recordUsage`
    // swallows its own errors, so the row would have vanished with no symptom.
    const named = getDb()
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM usage_log WHERE chat_id = ?')
      .get(chat.id);
    assert.equal(named?.n, 0);

    const row = getDb()
      .prepare<{ chat_id: string | null; message_id: string | null; tokens_out: number }>(
        'SELECT chat_id, message_id, tokens_out FROM usage_log WHERE model_id = ?',
      )
      .get('incognito-anonymity-model');
    assert.equal(row?.chat_id, null);
    assert.equal(row?.message_id, null);
    assert.equal(row?.tokens_out, 20);
  });

  test('a persisted chat still gets its usage attributed', () => {
    // The anonymising branch must be reached only by temporary chats; if it ran
    // for everything, the usage dashboard's per-chat breakdown would go empty
    // and nothing else here would notice.
    const chat = createChat({ tool: 'chat', title: 'on the record' });
    recordUsage({
      chatId: chat.id,
      tool: 'chat',
      modelId: 'attributed-model',
      tokensIn: 5,
      tokensOut: 5,
    });

    const row = getDb()
      .prepare<{ chat_id: string | null }>('SELECT chat_id FROM usage_log WHERE model_id = ?')
      .get('attributed-model');
    assert.equal(row?.chat_id, chat.id);
  });
});


describe('the HTTP surface for temporary chats', () => {
  test('POST /api/chat with temporary:true reports it and writes no row', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'chat', title: 'incognito', temporary: true }),
    });
    const payload = (await res.json()) as { chat: { id: string }; temporary: boolean };

    assert.equal(res.status, 201);
    assert.equal(payload.temporary, true);
    assert.equal(chatRowCount(payload.chat.id), 0);
    assert.equal(isTemporaryChat(payload.chat.id), true);
  });

  test('a normal create still reports temporary:false, so the flag is never ambiguous', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'chat', title: 'saved' }),
    });
    const payload = (await res.json()) as { chat: { id: string }; temporary: boolean };

    assert.equal(res.status, 201);
    assert.equal(payload.temporary, false);
    assert.equal(chatRowCount(payload.chat.id), 1);
  });

  test('asking for a temporary chat on a saved id is a conflict, not a shadow copy', async () => {
    const saved = createChat({ tool: 'chat', title: 'already here' });

    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'chat', id: saved.id, temporary: true }),
    });
    const body = (await res.json()) as { error: { code: string; details?: { field?: string } } };

    assert.equal(res.status, 409);
    assert.equal(body.error.code, 'conflict');
    assert.equal(body.error.details?.field, 'id');
    // The saved chat must be untouched.
    assert.equal(chatRowCount(saved.id), 1);
  });

  test('DELETE reports whether the chat it removed was temporary', async () => {
    const temporary = createTemporaryChat({ tool: 'chat' });
    const saved = createChat({ tool: 'chat' });

    const first = await fetch(`${base}/api/chat/${temporary.id}`, { method: 'DELETE' });
    const firstBody = (await first.json()) as { deleted: boolean; temporary: boolean };
    assert.equal(first.status, 200);
    assert.equal(firstBody.deleted, true);
    assert.equal(firstBody.temporary, true);

    const second = await fetch(`${base}/api/chat/${saved.id}`, { method: 'DELETE' });
    const secondBody = (await second.json()) as { deleted: boolean; temporary: boolean };
    assert.equal(secondBody.temporary, false);
    assert.equal(chatRowCount(saved.id), 0);
  });
});

describe('bulk chat deletion', () => {
  test('a missing id is reported without rolling back the deletes that worked', async () => {
    const first = createChat({ tool: 'chat', title: 'one' });
    const second = createChat({ tool: 'chat', title: 'two' });

    const res = await fetch(`${base}/api/chat/bulk-delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [first.id, 'chat_not_here', second.id] }),
    });
    const payload = (await res.json()) as { deleted: string[]; missing: string[] };

    assert.equal(res.status, 200);
    // Deliberately not transactional: deleting two of three chats and saying so
    // is more useful than refusing all three over one stale id from the UI.
    assert.deepEqual(payload.deleted.sort(), [first.id, second.id].sort());
    assert.deepEqual(payload.missing, ['chat_not_here']);
    assert.equal(chatRowCount(first.id), 0);
    assert.equal(chatRowCount(second.id), 0);
  });

  test('an empty or absent id list is rejected by name', async () => {
    for (const payload of [{ ids: [] }, {}]) {
      const res = await fetch(`${base}/api/chat/bulk-delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as { error: { code: string; details?: { field?: string } } };

      assert.equal(res.status, 400, JSON.stringify(payload));
      assert.equal(body.error.code, 'bad_request');
      assert.equal(body.error.details?.field, 'ids');
    }
  });

  test('bulk-delete is not shadowed by DELETE /:id', async () => {
    // Declared above `/:id` in the router; if that order regressed, this would
    // be read as a chat whose id is "bulk-delete".
    const res = await fetch(`${base}/api/chat/bulk-delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['chat_absent'] }),
    });
    const payload = (await res.json()) as { missing: string[] };

    assert.equal(res.status, 200);
    assert.deepEqual(payload.missing, ['chat_absent']);
  });
});
