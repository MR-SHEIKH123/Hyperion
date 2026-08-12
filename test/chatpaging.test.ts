/**
 * Cursor pagination over a chat transcript (Prompt 1.8c).
 *
 * The guarantee under test is that paging backwards through a long chat visits
 * every message exactly once, even while the chat is still growing. That is the
 * whole reason the cursor is a message id resolved to `seq` rather than an
 * offset: an offset is a position in a result set that shifts every time a
 * message is appended, so a client scrolling upward through a live conversation
 * silently skips or repeats rows. None of that is observable without walking a
 * transcript that is longer than one page, which is what these tests do.
 */

import './helpers.ts';

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

const { appendMessage, createChat, listMessagePage } = await import('../src/db/chats.ts');
const { createApp } = await import('../src/http/app.ts');

let server: http.Server;
let base: string;

before(async () => {
  await freshDb();

  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  base = `http://127.0.0.1:${address.port}`;

  // 12 messages, so a limit of 5 needs three pages and the last one is partial.
  createChat({ id: 'chat-long', tool: 'chat', title: 'A long conversation' });
  for (let index = 1; index <= 12; index += 1) {
    appendMessage({
      chatId: 'chat-long',
      role: index % 2 === 1 ? 'user' : 'assistant',
      content: `message ${index}`,
    });
  }

  createChat({ id: 'chat-short', tool: 'chat', title: 'A short conversation' });
  appendMessage({ chatId: 'chat-short', role: 'user', content: 'only message' });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

describe('paging backwards through a transcript', () => {
  test('the first page is the newest messages, returned oldest-first', () => {
    const page = listMessagePage('chat-long', 5);

    assert.equal(page.messages.length, 5);
    assert.deepEqual(
      page.messages.map((message) => message.content),
      ['message 8', 'message 9', 'message 10', 'message 11', 'message 12'],
      'opening a long chat lands at the end of the conversation, not its beginning',
    );
    // Ordered within the page so the caller can render it without reversing.
    assert.equal(page.nextBefore, page.messages[0]?.id);
  });

  test('walking every page visits each message exactly once and then stops', () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page: { messages: { id: string; content: string }[]; nextBefore: string | null } =
        cursor === null ? listMessagePage('chat-long', 5) : listMessagePage('chat-long', 5, cursor);
      seen.unshift(...page.messages.map((message) => message.content));
      cursor = page.nextBefore;
      pages += 1;
      assert.ok(pages <= 10, 'pagination did not terminate');
    } while (cursor !== null);

    assert.equal(pages, 3, '12 messages at 5 per page is three pages');
    assert.equal(seen.length, 12, 'no message was skipped and none was repeated');
    assert.deepEqual(
      seen,
      Array.from({ length: 12 }, (_, index) => `message ${index + 1}`),
      'the reassembled transcript is in its original order',
    );
    assert.equal(new Set(seen).size, 12);
  });

  test('a cursor still resolves correctly after newer messages arrive', () => {
    const first = listMessagePage('chat-long', 5);
    const cursor = first.nextBefore;
    assert.ok(cursor);

    // The exact race the cursor exists for: the chat grows while it is held.
    appendMessage({ chatId: 'chat-long', role: 'user', content: 'message 13' });

    const older = listMessagePage('chat-long', 5, cursor);
    assert.deepEqual(
      older.messages.map((message) => message.content),
      ['message 3', 'message 4', 'message 5', 'message 6', 'message 7'],
      'an append shifts an offset but never moves a message relative to the cursor',
    );
  });

  test('a chat shorter than the limit is one page with no cursor', () => {
    const page = listMessagePage('chat-short', 50);

    assert.equal(page.messages.length, 1);
    assert.equal(page.nextBefore, null, 'null is how a client knows to stop without a count query');
  });

  test('an unknown cursor is refused rather than silently serving the newest page', () => {
    assert.throws(
      () => listMessagePage('chat-long', 5, 'no-such-message'),
      (error: unknown) => {
        const app = error as { code?: string; details?: { field?: string } };
        assert.equal(app.code, 'bad_request');
        assert.equal(app.details?.field, 'before');
        return true;
      },
      'ignoring a bad cursor would repeat the newest page, which reads as the transcript duplicating itself',
    );
  });

  test('a cursor belonging to a different chat is not accepted', () => {
    const other = listMessagePage('chat-short', 5);
    const foreign = other.messages[0]?.id;
    assert.ok(foreign);

    assert.throws(() => listMessagePage('chat-long', 5, foreign), { code: 'bad_request' });
  });
});

describe('GET /api/chat/:id/messages', () => {
  test('the response carries the page and the cursor for the next one', async () => {
    const response = await fetch(`${base}/api/chat/chat-long/messages?limit=5`);
    assert.equal(response.status, 200);

    const payload = (await response.json()) as {
      messages: { content: string }[];
      nextBefore: string | null;
    };
    assert.equal(payload.messages.length, 5);
    assert.ok(payload.nextBefore, 'a longer transcript must advertise its next page');

    const next = await fetch(
      `${base}/api/chat/chat-long/messages?limit=5&before=${payload.nextBefore}`,
    );
    assert.equal(next.status, 200);
    const older = (await next.json()) as { messages: { content: string }[] };
    assert.notDeepEqual(
      older.messages.map((message) => message.content),
      payload.messages.map((message) => message.content),
      'the second page is genuinely older, not the first page served again',
    );
  });

  test('a limit outside the accepted range names the offending field', async () => {
    for (const limit of ['0', '501', '1.5', 'lots']) {
      const response = await fetch(`${base}/api/chat/chat-long/messages?limit=${limit}`);
      assert.equal(response.status, 400, `limit=${limit} should be refused`);

      const payload = (await response.json()) as {
        error: { code: string; details?: { field?: string } };
      };
      assert.equal(payload.error.code, 'bad_request');
      assert.equal(payload.error.details?.field, 'limit');
    }
  });

  test('an unknown cursor is a 400 naming before, not a 500', async () => {
    const response = await fetch(`${base}/api/chat/chat-long/messages?before=nope`);
    assert.equal(response.status, 400);

    const payload = (await response.json()) as {
      error: { code: string; details?: { field?: string } };
    };
    assert.equal(payload.error.code, 'bad_request');
    assert.equal(payload.error.details?.field, 'before');
  });

  test('paging a chat that does not exist is a 404', async () => {
    const response = await fetch(`${base}/api/chat/no-such-chat/messages`);
    assert.equal(response.status, 404);

    const payload = (await response.json()) as { error: { code: string } };
    assert.equal(payload.error.code, 'not_found');
  });
});
