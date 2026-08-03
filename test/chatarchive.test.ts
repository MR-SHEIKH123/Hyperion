/**
 * Chat archiving and the idle cleanup sweep.
 *
 * Archiving is a third state, distinct from both pinning and deleting: "keep
 * this, just get it out of my way". Two things follow, and both are asserted
 * here because both are easy to break:
 *
 *   1. An archived chat is hidden from the default list.
 *   2. An archived chat is **exempt from the sweep**, exactly as a pinned one
 *      is. Archiving is an intentional filing decision, so treating it as
 *      neglect would delete the chats a user most deliberately kept.
 *
 * The exemption is enforced in the sweep's SQL (`WHERE pinned = 0 AND
 * archived = 0`) rather than by filtering rows afterwards, so no code path can
 * forget it. These tests exercise it through `runCleanup` to prove the real
 * query behaves, not a reimplementation of it.
 */
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupHome, freshDb } from './helpers.ts';

// Imported after helpers.ts has set the environment.
const { createChat, findChat, listChats, setChatArchived, setChatPinned } = await import(
  '../src/db/chats.ts'
);
const { runCleanup } = await import('../src/services/storage/cleanup.ts');
const { getDb } = await import('../src/db/adapter.ts');

const DAY = 24 * 60 * 60 * 1000;

/**
 * Ages a chat by rewriting `last_opened_at` directly.
 *
 * `createChat` stamps "now", and the sweep reads only that column, so this is
 * the honest way to produce a chat that has genuinely been idle for months
 * without waiting or stubbing the clock inside the service.
 */
function setIdleDays(id: string, days: number): void {
  getDb()
    .prepare(`UPDATE chats SET last_opened_at = ? WHERE id = ?`)
    .run(Date.now() - days * DAY, id);
}

beforeEach(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

// --- list filtering --------------------------------------------------------

test('an archived chat drops out of the default list', () => {
  const kept = createChat({ tool: 'chat', title: 'Visible' });
  const filed = createChat({ tool: 'chat', title: 'Filed away' });

  setChatArchived(filed.id, true);

  const ids = listChats().map((chat) => chat.id);
  assert.deepEqual(ids, [kept.id]);
});

test('includeArchived widens the list to everything', () => {
  const kept = createChat({ tool: 'chat', title: 'Visible' });
  const filed = createChat({ tool: 'chat', title: 'Filed away' });
  setChatArchived(filed.id, true);

  const ids = listChats({ includeArchived: true })
    .map((chat) => chat.id)
    .sort();

  assert.deepEqual(ids, [kept.id, filed.id].sort());
});

test('archivedOnly narrows the list to the archive', () => {
  createChat({ tool: 'chat', title: 'Visible' });
  const filed = createChat({ tool: 'chat', title: 'Filed away' });
  setChatArchived(filed.id, true);

  const ids = listChats({ archivedOnly: true }).map((chat) => chat.id);
  assert.deepEqual(ids, [filed.id]);
});

test('archivedOnly wins over includeArchived, being the more specific request', () => {
  createChat({ tool: 'chat', title: 'Visible' });
  const filed = createChat({ tool: 'chat', title: 'Filed away' });
  setChatArchived(filed.id, true);

  const ids = listChats({ archivedOnly: true, includeArchived: true }).map((chat) => chat.id);
  assert.deepEqual(ids, [filed.id]);
});

test('unarchiving puts a chat back in the default list', () => {
  const chat = createChat({ tool: 'chat', title: 'Round trip' });

  setChatArchived(chat.id, true);
  assert.equal(listChats().length, 0);

  const restored = setChatArchived(chat.id, false);
  assert.equal(restored.archived, false);
  assert.deepEqual(
    listChats().map((c) => c.id),
    [chat.id],
  );
});

test('archiving is independent of pinning', () => {
  // They are separate signals: a pinned chat can be archived without losing its
  // pin, which matters because the frontend renders them differently.
  const chat = createChat({ tool: 'chat', title: 'Both' });

  setChatPinned(chat.id, true);
  const archived = setChatArchived(chat.id, true);

  assert.equal(archived.pinned, true);
  assert.equal(archived.archived, true);
});

// --- cleanup exemption -----------------------------------------------------

test('an archived chat survives a sweep that deletes an equally old unarchived one', async () => {
  const doomed = createChat({ tool: 'chat', title: 'Forgotten' });
  const filed = createChat({ tool: 'chat', title: 'Filed away' });

  // Same age, well past the four-month threshold. The only difference is the
  // archive flag, which is exactly what this asserts.
  setIdleDays(doomed.id, 200);
  setIdleDays(filed.id, 200);
  setChatArchived(filed.id, true);

  const result = await runCleanup({ chatTtlDays: 120 });

  assert.equal(result.chatsDeleted, 1);
  assert.equal(findChat(doomed.id), null);
  assert.ok(findChat(filed.id), 'the archived chat must still exist');
});

test('a pinned chat and an archived chat are both exempt in the same sweep', async () => {
  const doomed = createChat({ tool: 'chat', title: 'Forgotten' });
  const pinned = createChat({ tool: 'chat', title: 'Pinned' });
  const filed = createChat({ tool: 'chat', title: 'Archived' });

  for (const chat of [doomed, pinned, filed]) setIdleDays(chat.id, 400);
  setChatPinned(pinned.id, true);
  setChatArchived(filed.id, true);

  const result = await runCleanup({ chatTtlDays: 120 });

  assert.equal(result.chatsDeleted, 1);
  assert.deepEqual(
    result.detail.chats.map((entry) => entry.id),
    [doomed.id],
  );
  assert.ok(findChat(pinned.id));
  assert.ok(findChat(filed.id));
});

test('a chat idle for three months survives the four-month threshold', async () => {
  // Guards the D1 change itself: under the old one-month threshold this chat
  // would have been swept.
  const chat = createChat({ tool: 'chat', title: 'Last quarter' });
  setIdleDays(chat.id, 95);

  const result = await runCleanup({ chatTtlDays: 120 });

  assert.equal(result.chatsDeleted, 0);
  assert.ok(findChat(chat.id));
});

test('a dry run reports what it would delete without touching the archive', async () => {
  const doomed = createChat({ tool: 'chat', title: 'Forgotten' });
  const filed = createChat({ tool: 'chat', title: 'Filed away' });
  setIdleDays(doomed.id, 200);
  setIdleDays(filed.id, 200);
  setChatArchived(filed.id, true);

  const result = await runCleanup({ chatTtlDays: 120, dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(result.chatsDeleted, 1);
  // Nothing actually went away, including the chat it named.
  assert.ok(findChat(doomed.id));
  assert.ok(findChat(filed.id));
});
