/**
 * Session fork (1.27's last missing clause).
 *
 * `chats.forked_from` has existed since migration `017` with nothing writing to
 * it. The route behind it is small, and every one of its decisions is a way to
 * get a copy wrong:
 *
 *   1. **The original must not change.** A fork is offered on the conversation a
 *      user is *having*, so anything that renumbers, truncates or re-stamps the
 *      source turns a safe gesture into a destructive one. Asserted by comparing
 *      the source's whole message list either side of the call.
 *   2. **The copy is a conversation, not a view.** It has its own ids and
 *      sequence numbers, so it can be continued and deleted independently, and
 *      appending to it must not touch the source.
 *   3. **A message that was mid-stream in the source lands `paused`.** The
 *      original row may still be written to by the run that owns it; the copy has
 *      no writer, and `streaming` would claim one is coming.
 *   4. **A temporary chat is refused.** Its messages exist only in the process,
 *      and a fork would persist exactly what the user asked to leave no trace of.
 *   5. **Deleting the original keeps the fork.** `ON DELETE SET NULL`, because the
 *      branch is a conversation in its own right; only the provenance line is lost.
 *
 * The route is driven over HTTP, because the response envelope — status, the
 * copied messages, the count of partials — is part of the contract.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

const { createApp } = await import('../src/http/app.ts');
const { appendMessage, createChat, deleteChat, findChat, listMessages } = await import(
  '../src/db/chats.ts'
);

let server: http.Server;
let base: string;

before(async () => {
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  await freshDb();
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

interface ForkBody {
  chat?: { id: string; title: string; forkedFrom: string | null; modelId: string | null; tool: string };
  messages?: { id: string; role: string; content: string; status: string; seq: number; createdAt: number }[];
  forkedFrom?: string;
  pausedPartials?: number;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

async function fork(
  chatId: string,
  payload: Record<string, unknown> = {},
): Promise<{ status: number; body: ForkBody }> {
  const res = await fetch(`${base}/api/chat/${chatId}/fork`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as ForkBody) : {} };
}

/** A settled conversation: two exchanges plus a tool result. */
function seededChat(title = 'Original') {
  const chat = createChat({ tool: 'chat', title, modelId: 'gpt-test', providerId: null });
  appendMessage({ chatId: chat.id, role: 'user', content: 'first question' });
  appendMessage({ chatId: chat.id, role: 'assistant', content: 'first answer' });
  appendMessage({ chatId: chat.id, role: 'user', content: 'second question' });
  appendMessage({ chatId: chat.id, role: 'assistant', content: 'second answer' });
  return chat;
}

test('a fork copies the conversation and leaves the original untouched', async () => {
  const source = seededChat();
  const beforeSource = listMessages(source.id);

  const { status, body } = await fork(source.id);
  assert.equal(status, 201);
  assert.ok(body.chat);
  assert.equal(body.chat.forkedFrom, source.id);
  assert.equal(body.chat.tool, 'chat');
  assert.equal(body.chat.modelId, 'gpt-test', 'the branch continues with the same model');
  assert.equal(body.chat.title, 'Original (fork)');
  assert.equal(body.forkedFrom, source.id);
  assert.equal(body.pausedPartials, 0);

  // Same conversation, new identities.
  assert.deepEqual(
    body.messages?.map((m) => [m.role, m.content]),
    [
      ['user', 'first question'],
      ['assistant', 'first answer'],
      ['user', 'second question'],
      ['assistant', 'second answer'],
    ],
  );
  assert.deepEqual(
    body.messages?.map((m) => m.seq),
    [1, 2, 3, 4],
    'the branch is numbered from one',
  );
  const sourceIds = new Set(beforeSource.map((m) => m.id));
  assert.ok(
    body.messages?.every((m) => !sourceIds.has(m.id)),
    'copied messages are new rows, not references to the originals',
  );
  // History keeps its shape: the copy carries the timestamps it was written with.
  assert.deepEqual(
    body.messages?.map((m) => m.createdAt),
    beforeSource.map((m) => m.createdAt),
  );

  const afterSource = listMessages(source.id);
  assert.deepEqual(
    afterSource.map((m) => [m.id, m.seq, m.content, m.status]),
    beforeSource.map((m) => [m.id, m.seq, m.content, m.status]),
    'the source is byte-for-byte where it was',
  );
});

test('naming a message branches from there, inclusive, and still keeps the original whole', async () => {
  const source = seededChat();
  const messages = listMessages(source.id);
  const pivot = messages[1];
  assert.ok(pivot);

  const { status, body } = await fork(source.id, { upToMessageId: pivot.id, title: 'Branch' });
  assert.equal(status, 201);
  assert.equal(body.chat?.title, 'Branch');
  assert.equal(body.messages?.length, 2);
  assert.deepEqual(
    body.messages?.map((m) => m.content),
    ['first question', 'first answer'],
  );
  assert.equal(listMessages(source.id).length, 4, 'nothing was truncated in the source');
});

test('a message id from another chat is refused, and creates nothing', async () => {
  const alpha = seededChat('Alpha');
  const beta = seededChat('Beta');
  const stranger = listMessages(beta.id)[0];
  assert.ok(stranger);
  const before = (await (await fetch(`${base}/api/chat?includeArchived=true`)).json()) as {
    chats: unknown[];
  };

  const { status, body } = await fork(alpha.id, { upToMessageId: stranger.id });
  assert.equal(status, 400);
  assert.equal(body.error?.code, 'bad_request');
  assert.equal(body.error?.details?.field, 'upToMessageId');

  const after = (await (await fetch(`${base}/api/chat?includeArchived=true`)).json()) as {
    chats: unknown[];
  };
  assert.equal(after.chats.length, before.chats.length, 'no chat was created by the refusal');
});

test('a message that was still streaming lands paused, with no writer in the branch', async () => {
  const source = createChat({ tool: 'chat', title: 'Mid stream' });
  appendMessage({ chatId: source.id, role: 'user', content: 'ask' });
  const partial = appendMessage({
    chatId: source.id,
    role: 'assistant',
    content: 'half an ans',
    status: 'streaming',
  });

  const { status, body } = await fork(source.id);
  assert.equal(status, 201);
  assert.equal(body.pausedPartials, 1);
  const copied = body.messages?.[1];
  assert.equal(copied?.content, 'half an ans', 'the partial text is carried, not dropped');
  assert.equal(copied?.status, 'paused');

  // The source row is untouched, including its status: the run that owns it is
  // still writing.
  const stillStreaming = listMessages(source.id).find((m) => m.id === partial.id);
  assert.equal(stillStreaming?.status, 'streaming');
});

test('the branch is independent: writing to it does not touch the source', async () => {
  const source = seededChat();
  const { body } = await fork(source.id);
  const forkId = body.chat!.id;

  appendMessage({ chatId: forkId, role: 'user', content: 'a question the original never saw' });

  assert.equal(listMessages(forkId).length, 5);
  assert.equal(listMessages(source.id).length, 4);
  assert.ok(
    !listMessages(source.id).some((m) => m.content === 'a question the original never saw'),
  );
});

test('deleting the original keeps the branch and drops only the provenance line', async () => {
  const source = seededChat();
  const { body } = await fork(source.id);
  const forkId = body.chat!.id;

  assert.equal(deleteChat(source.id), true);

  const branch = findChat(forkId);
  assert.ok(branch, 'the branch survives its parent');
  assert.equal(branch.forkedFrom, null, 'ON DELETE SET NULL, not a cascade');
  assert.equal(listMessages(forkId).length, 4);
});

test('a temporary chat cannot be forked: the copy would persist what it exists not to', async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'chat', temporary: true }),
  });
  assert.equal(res.status, 201);
  const created = (await res.json()) as { chat: { id: string } };

  const { status, body } = await fork(created.chat.id);
  assert.equal(status, 409);
  assert.equal(body.error?.code, 'conflict');
  assert.match(body.error?.message ?? '', /temporary chat cannot be forked/);

  // Nothing was written down for it.
  const listed = (await (await fetch(`${base}/api/chat?includeArchived=true`)).json()) as {
    chats: { title: string }[];
  };
  assert.ok(!listed.chats.some((c) => c.title.includes('fork')));
});

test('an unknown chat is a 404, not an empty branch', async () => {
  const { status, body } = await fork('no-such-chat');
  assert.equal(status, 404);
  assert.equal(body.error?.code, 'not_found');
});

test('forking a fork records the immediate parent, and the title stacks honestly', async () => {
  const source = seededChat('Root');
  const first = await fork(source.id);
  const second = await fork(first.body.chat!.id);
  assert.equal(second.status, 201);
  assert.equal(second.body.chat?.forkedFrom, first.body.chat!.id);
  assert.equal(second.body.chat?.title, 'Root (fork) (fork)');
  assert.equal(second.body.messages?.length, 4);
});
