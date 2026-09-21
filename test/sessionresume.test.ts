/**
 * Resume in a new session (1.28's second half).
 *
 * Named `sessionresume` because `test/continuation.test.ts` is already the task
 * `…/continue` surface; an earlier draft of this file was written over the top of
 * it and had to be recovered from git — a reminder that a familiar word is not a
 * free filename.
 *
 * A long conversation eventually stops fitting in the model's window, and the
 * provider answers that with a rejected request. The agent loops compact their
 * own context; a *chat* is the user's transcript, where silently dropping the
 * middle would rewrite history someone is reading. The shape that a person can
 * act on is a new session: keep the recent part, describe the rest, leave the
 * original exactly where it was.
 *
 * Every decision here is a way to get that wrong:
 *
 *   1. **Detection is a read, and honest.** `GET /:id/context` never calls a
 *      provider and never writes. The window is the model's reported context
 *      length when a cached model knows one and the conservative default
 *      otherwise — reported as `assumed: true` rather than presented as fact,
 *      because most OpenAI-compatible gateways report nothing.
 *   2. **Refusing is an outcome.** A conversation that already fits gets a `409`
 *      naming both numbers: "resume in a new session" exists to escape a limit,
 *      and a copy that leaves nothing behind solves nothing. The error says so.
 *   3. **The receipt is persisted, and describes rather than quotes.** A chat's
 *      transcript *is* its context — the next turn is built from these rows — so
 *      a receipt that lived only in the response would vanish at the next
 *      message and the model would meet a conversation starting mid-sentence
 *      with no idea it had. It is a `system` row: context supplied by the
 *      harness, not words put in the model's mouth. It counts roles, never
 *      content, because quoting the dropped span would cost the tokens the
 *      resume was for — and the text it would quote is whatever the user pasted.
 *   4. **The tail fits the target, and the last message is kept regardless.**
 *      Walking backwards stops when the next message would exceed the target,
 *      except for the most recent one: a new session that dropped the thing the
 *      user is working on would have nothing to continue.
 *   5. **The source is untouched.** Nothing is deleted, truncated or re-stamped
 *      in the original — including the span the new session left behind, which
 *      is now the only copy of it. Asserted by comparing the whole list.
 *   6. **A temporary chat is refused**, like the fork: its messages exist only
 *      in the process, and a resumed session would write down what the user
 *      asked to leave no trace of.
 *
 * One fixture note, because it took a failed first draft: the window a chat is
 * judged against comes from the *provider registry cache* (`findCachedModel`),
 * which is deliberately cache-only and never fetches. A chat pointed at a model
 * id nobody has cached therefore falls back to the assumed default, however the
 * id is spelled — so a test that wants a different window has to seed the cache
 * the way the real path does: `createProvider` + `saveModelCache`, no network.
 * The routes are exercised over HTTP, because the envelope is the contract.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

const { createApp } = await import('../src/http/app.ts');
const { appendMessage, createChat, findChat, listMessages } = await import('../src/db/chats.ts');
const { createTemporaryChat } = await import('../src/db/temporaryChats.ts');
const { DEFAULT_CONTEXT_TOKENS } = await import('../src/services/agent/compaction.ts');
const { createProvider, saveModelCache } = await import('../src/providers/repository.ts');

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

interface ContextBody {
  chatId?: string;
  modelId?: string | null;
  window?: { tokens: number; source: string; assumed: boolean };
  estimatedTokens?: number;
  ratio?: number;
  messageCount?: number;
  needsNewSession?: boolean;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

interface ResumeBody {
  chat?: { id: string; title: string; tool: string; modelId: string | null; forkedFrom: string | null };
  messages?: {
    id: string;
    role: string;
    content: string;
    status: string;
    seq: number;
    createdAt: number;
  }[];
  source?: { id: string; title: string };
  droppedMessages?: number;
  pausedPartials?: number;
  receipt?: string;
  assessment?: { estimatedTokens: number; window: { tokens: number; assumed: boolean } };
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

async function getContext(chatId: string): Promise<{ status: number; body: ContextBody }> {
  const res = await fetch(`${base}/api/chat/${chatId}/context`);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as ContextBody) : {} };
}

async function resume(
  chatId: string,
  payload: Record<string, unknown> = {},
): Promise<{ status: number; body: ResumeBody }> {
  const res = await fetch(`${base}/api/chat/${chatId}/resume-in-new-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as ResumeBody) : {} };
}

/**
 * Cache a model with a known context length, the way `refreshModels` would.
 *
 * `findCachedModel` reads only the registry cache, so a test that needs a
 * specific window has to put one there. No provider call is involved: this is
 * the same write the model-list refresh performs.
 */
function seedModel(tokens: number): string {
  const modelId = `model-${tokens}`;
  const provider = createProvider({
    name: `Provider ${tokens}`,
    type: 'remote',
    baseUrl: 'https://gateway.test/v1',
    apiKey: 'test-key',
  });
  saveModelCache(provider.id, [{ id: modelId, label: modelId, contextLength: tokens }]);
  return modelId;
}

/**
 * A conversation whose estimate is unambiguously over any trigger.
 *
 * `count` pairs of long messages, so the arithmetic is not subtle: at ~4
 * characters per token and 6 000 characters each, 14 messages are roughly
 * 21 000 tokens against an 8 192 default.
 */
function longChat(tokens: number, pairs = 7) {
  const chat = createChat({
    tool: 'chat',
    title: 'Long one',
    modelId: seedModel(tokens),
    providerId: null,
  });
  for (let index = 0; index < pairs; index += 1) {
    appendMessage({ chatId: chat.id, role: 'user', content: `Q${index} ${'u'.repeat(6000)}` });
    appendMessage({ chatId: chat.id, role: 'assistant', content: `A${index} ${'a'.repeat(6000)}` });
  }
  return chat;
}

test('the context read reports the window, its provenance, and the estimate', async () => {
  const chat = longChat(4096, 1);
  const { status, body } = await getContext(chat.id);

  assert.equal(status, 200);
  assert.equal(body.chatId, chat.id);
  assert.equal(body.modelId, 'model-4096');
  assert.equal(body.window?.tokens, 4096);
  assert.equal(body.window?.source, 'model');
  assert.equal(body.window?.assumed, false, 'a reported context length is not a guess');
  assert.equal(body.messageCount, 2);
  assert.ok((body.estimatedTokens ?? 0) > 0, 'an estimate is reported, not withheld');
  assert.equal(body.ratio, (body.estimatedTokens ?? 0) / 4096);
  assert.equal(body.needsNewSession, (body.ratio ?? 0) >= 0.8);
});

test('a chat whose model reports nothing falls back to the default, marked assumed', async () => {
  const chat = createChat({ tool: 'chat', title: 'No model', modelId: null, providerId: null });
  appendMessage({ chatId: chat.id, role: 'user', content: 'hello' });

  const { status, body } = await getContext(chat.id);
  assert.equal(status, 200);
  assert.equal(body.modelId, null);
  assert.equal(body.window?.tokens, DEFAULT_CONTEXT_TOKENS);
  assert.equal(body.window?.source, 'default');
  assert.equal(body.window?.assumed, true, 'a default is a guess and says so');
  assert.equal(body.needsNewSession, false, 'one short message is nowhere near the trigger');
});

test('the read never writes: the transcript is untouched and no chat appears', async () => {
  const chat = longChat(4096, 2);
  const before = listMessages(chat.id);
  await getContext(chat.id);
  const after = listMessages(chat.id);
  assert.deepEqual(
    after.map((m) => [m.id, m.seq, m.content]),
    before.map((m) => [m.id, m.seq, m.content]),
  );
});

test('resuming keeps the tail, drops the head, and leaves a system receipt', async () => {
  const source = longChat(4096, 7);
  const beforeSource = listMessages(source.id);

  const { status, body } = await resume(source.id);
  assert.equal(status, 201);
  assert.ok(body.chat);
  assert.equal(body.chat.forkedFrom, source.id);
  assert.equal(body.chat.tool, 'chat');
  assert.equal(body.chat.modelId, 'model-4096', 'the new session continues with the same model');
  assert.equal(body.chat.title, 'Long one (continued)');
  assert.equal(body.source?.id, source.id);
  assert.ok((body.droppedMessages ?? 0) > 0, 'a long conversation drops something');

  // The receipt is the first row, persisted, and it is a system message.
  const receipt = body.messages?.[0];
  assert.equal(receipt?.role, 'system');
  assert.equal(receipt?.seq, 1);
  assert.equal(receipt?.content, body.receipt);
  assert.match(body.receipt ?? '', /Earlier conversation left behind/);
  // The receipt counts what was dropped, per role; the counts adding up to the
  // reported total is the whole claim it makes.
  const counted = [
    ...(body.receipt ?? '').matchAll(/(\d+) (user|assistant|system|tool result)/g),
  ].reduce((sum, match) => sum + Number(match[1]), 0);
  assert.equal(counted, body.droppedMessages, 'the receipt accounts for every dropped message');

  // The copy is contiguous with the end of the source: the same messages, in the
  // same order, from some index to the last one.
  const keptSource = beforeSource.slice(beforeSource.length - (body.messages?.length ?? 0) + 1);
  assert.deepEqual(
    body.messages?.slice(1).map((m) => m.content),
    keptSource.map((m) => m.content),
  );
  assert.deepEqual(
    body.messages?.slice(1).map((m) => m.seq),
    keptSource.map((_, index) => index + 2),
    'numbering restarts after the receipt',
  );
  // History keeps its shape: the copy carries the timestamps it was written with.
  assert.deepEqual(
    body.messages?.slice(1).map((m) => m.createdAt),
    keptSource.map((m) => m.createdAt),
    'a week-old exchange is not re-stamped with "now"',
  );

  // The receipt describes the span; it never quotes it.
  assert.ok(
    !(body.receipt ?? '').includes('u'.repeat(20)),
    'the receipt counts messages rather than quoting them',
  );
});

test('the kept tail fits the target, and the last message is kept regardless', async () => {
  const source = longChat(4096, 7);
  const source_messages = listMessages(source.id);
  const { body } = await resume(source.id);

  const kept = body.messages?.slice(1) ?? [];
  const cost = kept.reduce((sum, message) => sum + Math.ceil(message.content.length / 4) + 6, 0);
  assert.ok(cost <= 4096 * 0.5, `the tail fits the target budget (${cost} tokens)`);
  assert.equal(
    kept[kept.length - 1]?.content,
    source_messages[source_messages.length - 1]?.content,
    'the most recent message is what the session is for',
  );
});

test('a conversation that already fits is refused, with the numbers', async () => {
  const modelId = seedModel(8192);
  const chat = createChat({ tool: 'chat', title: 'Short', modelId, providerId: null });
  appendMessage({ chatId: chat.id, role: 'user', content: 'a short question' });
  appendMessage({ chatId: chat.id, role: 'assistant', content: 'a short answer' });

  const chatsBefore = (await (await fetch(`${base}/api/chat?includeArchived=true`)).json()) as {
    chats: unknown[];
  };

  const { status, body } = await resume(chat.id);
  assert.equal(status, 409);
  assert.equal(body.error?.code, 'conflict');
  assert.match(body.error?.message ?? '', /already fits/);
  assert.equal(body.error?.details?.windowTokens, 8192);
  assert.equal(typeof body.error?.details?.estimatedTokens, 'number');
  assert.equal(body.error?.details?.assumed, false);

  const chatsAfter = (await (await fetch(`${base}/api/chat?includeArchived=true`)).json()) as {
    chats: unknown[];
  };
  assert.equal(chatsAfter.chats.length, chatsBefore.chats.length, 'a refusal creates no chat');
});

test('the source is untouched, including the span the new session left behind', async () => {
  const source = longChat(4096, 7);
  const before = listMessages(source.id);
  const beforeChat = findChat(source.id);

  const { status } = await resume(source.id);
  assert.equal(status, 201);

  const after = listMessages(source.id);
  assert.deepEqual(
    after.map((m) => [m.id, m.seq, m.content, m.status, m.createdAt]),
    before.map((m) => [m.id, m.seq, m.content, m.status, m.createdAt]),
    'the original is byte-for-byte where it was',
  );
  assert.equal(findChat(source.id)?.title, beforeChat?.title, 'the original was not renamed');
  assert.equal(after.length, before.length, 'nothing was deleted from the original');
});

test('the new session is independent: writing to it does not touch the source', async () => {
  const source = longChat(4096, 7);
  const { body } = await resume(source.id);
  assert.ok(body.chat);
  const sourceLength = listMessages(source.id).length;

  appendMessage({ chatId: body.chat.id, role: 'user', content: 'keep going' });

  assert.equal(listMessages(source.id).length, sourceLength);
  const continued = listMessages(body.chat.id);
  assert.equal(continued[continued.length - 1]?.content, 'keep going');
  assert.equal(continued[continued.length - 1]?.role, 'user');
});

test('the trigger is the agent loops\' threshold, not something near it', async () => {
  // Sized between the compaction target (0.5) and the trigger (0.8): a session
  // that offered a new session here would be acting on a different definition of
  // "nearly full" than every agent run in this build.
  const modelId = seedModel(8192);
  const chat = createChat({ tool: 'chat', title: 'Three quarters', modelId, providerId: null });
  // (19636 - 6) * 4 = 4915 tokens ≈ 0.6 of 8192.
  appendMessage({ chatId: chat.id, role: 'user', content: 'u'.repeat(19630) });

  const { status, body } = await getContext(chat.id);
  assert.equal(status, 200);
  assert.ok((body.ratio ?? 0) > 0.5 && (body.ratio ?? 0) < 0.8, `ratio was ${body.ratio}`);
  assert.equal(body.needsNewSession, false, 'below the trigger is below the trigger');

  // And the same conversation is refused when asked to resume, because there is
  // nothing older than its only message to leave behind.
  const refused = await resume(chat.id);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error?.details?.reason, 'fits');
});

test('a newest message that alone exceeds the window is kept, and the refusal says why', async () => {
  const long = createChat({ tool: 'chat', title: 'One huge message', modelId: seedModel(4096), providerId: null });
  appendMessage({ chatId: long.id, role: 'user', content: 'u'.repeat(12000) });
  appendMessage({ chatId: long.id, role: 'user', content: 'v'.repeat(40000) });

  const { status, body } = await resume(long.id);
  assert.equal(status, 201);
  // The budget is 2 048 tokens and the last message alone is ~10 006, but a
  // session resumed without the thing the user is working on has nothing to
  // continue — so it overshoots rather than dropping it.
  const kept = body.messages?.slice(1) ?? [];
  assert.equal(kept.length, 1, 'the older message was dropped, the newest was not');
  assert.equal(kept[0]?.content, 'v'.repeat(40000));
  assert.equal(body.droppedMessages, 1);

  // A conversation whose *only* message overflows the window has nothing older
  // to leave behind, and the refusal says that instead of claiming it fits —
  // dropping older messages cannot help, so the advice is about the message.
  const single = createChat({
    tool: 'chat',
    title: 'One message',
    modelId: seedModel(2048),
    providerId: null,
  });
  appendMessage({ chatId: single.id, role: 'user', content: 'w'.repeat(40000) });

  const refused = await resume(single.id);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error?.details?.reason, 'nothing_droppable');
  assert.match(refused.body.error?.message ?? '', /nothing older to leave behind/);
  assert.match(refused.body.error?.message ?? '', /Shorten or split that message/);
});

test('a temporary chat is refused rather than persisted', async () => {
  const temporary = createTemporaryChat({ tool: 'chat', title: 'Ephemeral' });
  const { status, body } = await resume(temporary.id);
  assert.equal(status, 409);
  assert.match(body.error?.message ?? '', /temporary chat/i);
});

test('an unknown chat is a 404 on both routes', async () => {
  const read = await getContext('00000000-0000-4000-8000-000000000000');
  assert.equal(read.status, 404);
  const write = await resume('00000000-0000-4000-8000-000000000000');
  assert.equal(write.status, 404);
});

test('a mid-stream message copied into the new session lands paused', async () => {
  const source = longChat(4096, 7);
  appendMessage({
    chatId: source.id,
    role: 'assistant',
    content: 'half an ans',
    status: 'streaming',
  });

  const { status, body } = await resume(source.id);
  assert.equal(status, 201);
  assert.equal(body.pausedPartials, 1);
  const copied = body.messages?.[body.messages.length - 1];
  assert.equal(copied?.content, 'half an ans');
  assert.equal(copied?.status, 'paused');

  const stillStreaming = listMessages(source.id).find((m) => m.content === 'half an ans');
  assert.equal(stillStreaming?.status, 'streaming', 'the writer still owns the source row');
});

test('a caller-supplied id is honoured, and a duplicate is a conflict', async () => {
  const source = longChat(4096, 7);
  const chatId = '11111111-1111-4111-8111-111111111111';
  const first = await resume(source.id, { chatId, title: 'Resumed' });
  assert.equal(first.status, 201);
  assert.equal(first.body.chat?.id, chatId);
  assert.equal(first.body.chat?.title, 'Resumed');

  const second = await resume(source.id, { chatId });
  assert.equal(second.status, 409, 'an id already in use is refused, not silently replaced');
});
