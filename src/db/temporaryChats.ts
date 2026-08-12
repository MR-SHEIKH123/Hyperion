/**
 * Temporary ("incognito") chats — Part 1.20.
 *
 * A temporary chat is held in memory and **never** reaches SQLite. Not written
 * and then deleted, not written with a flag: never inserted, so there is no row
 * for a cleanup sweep to miss, no `-wal` frame to recover, and nothing for the
 * backup archive to carry forward.
 *
 * ## Why the guard lives in the storage layer
 *
 * `chats.ts` checks this registry at the top of every function that writes, so
 * a temporary chat is filtered out at the single point every writer must pass
 * through. Branching inside the orchestrator instead would mean each of the six
 * write sites in `orchestrator/chat.ts` had to remember, and the one that
 * forgot would persist the transcript with no visible symptom — the exact
 * failure this feature cannot have.
 *
 * ## What is deliberately *not* skipped
 *
 * Token usage. `recordUsage` writes to `usage_log`, which holds no message
 * content, and it is what the daily spending cap reads. A private conversation
 * that spent money still spent it, and a cap that could be bypassed by toggling
 * incognito would not be a cap.
 *
 * The row is written **anonymously**: `usage_log.chat_id` really does carry
 * `REFERENCES chats (id)`, so naming a chat that was never inserted would raise
 * SQLITE_CONSTRAINT, and `recordUsage` swallows its own errors — the spend would
 * have vanished silently, which is the exact bypass this is meant to prevent.
 * `recordUsage` therefore nulls `chat_id` for a temporary chat, which also keeps
 * the id itself off disk. An earlier version of this comment claimed there was
 * no foreign key; that was wrong, and believing it is what let the bug through.
 * See docs/CONTRACTS.md.
 */

import { randomUUID } from 'node:crypto';

import { AppError } from '../util/errors.ts';
import { createLogger } from '../util/logger.ts';

import type { ChatRecord } from './chats.ts';

import type { MessageRecord, MessageRole, MessageStatus, ToolName } from '../types/core.ts';

const log = createLogger('chats.temporary');

/**
 * Idle lifetime of an abandoned temporary chat.
 *
 * These are only ever released by the client calling DELETE or by the process
 * exiting, so without a sweep a browser that was closed mid-conversation would
 * pin its transcript in memory until restart. Twelve hours is long enough that
 * no live session is ever cut short, which matters more than reclaiming a few
 * kilobytes promptly.
 */
const IDLE_TTL_MS = 12 * 60 * 60 * 1000;

interface TemporaryChat {
  record: ChatRecord;
  messages: MessageRecord[];
  touchedAt: number;
}

const chats = new Map<string, TemporaryChat>();

/** Drops abandoned sessions. Called on registration, not on a timer. */
function sweep(now: number): void {
  for (const [id, entry] of chats) {
    if (now - entry.touchedAt > IDLE_TTL_MS) {
      chats.delete(id);
      log.info('released an idle temporary chat', { chatId: id });
    }
  }
}

export function isTemporaryChat(id: string): boolean {
  return chats.has(id);
}

export function temporaryChatCount(): number {
  return chats.size;
}

/**
 * Register a temporary chat.
 *
 * Rejects an id that already exists in memory rather than adopting it, so a
 * repeated create cannot silently discard a transcript the user is mid-way
 * through. A collision with a *persisted* id is rejected by the caller, which
 * is the layer that can see the table.
 */
export function createTemporaryChat(input: {
  tool: ToolName;
  title?: string;
  modelId?: string | null;
  providerId?: string | null;
  id?: string;
}): ChatRecord {
  const now = Date.now();
  sweep(now);

  const id = input.id ?? randomUUID();
  if (chats.has(id)) {
    throw new AppError('conflict', `A temporary chat with id "${id}" is already open.`, {
      details: { field: 'id', chatId: id },
    });
  }

  const record: ChatRecord = {
    id,
    title: input.title ?? 'Temporary chat',
    tool: input.tool,
    modelId: input.modelId ?? null,
    providerId: input.providerId ?? null,
    // Neither is meaningful for a chat that cannot outlive the process, but the
    // shape must match `ChatRecord` exactly so nothing downstream has to care
    // which kind of chat it was handed.
    pinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };

  chats.set(id, { record, messages: [], touchedAt: now });
  log.info('opened a temporary chat', { chatId: id, tool: input.tool });
  return record;
}

export function findTemporaryChat(id: string): ChatRecord | null {
  return chats.get(id)?.record ?? null;
}

/** Forget the chat and its transcript. Returns false if there was none. */
export function endTemporaryChat(id: string): boolean {
  const existed = chats.delete(id);
  if (existed) log.info('ended a temporary chat', { chatId: id });
  return existed;
}

export function touchTemporaryChat(
  id: string,
  input: { modelId?: string | null; providerId?: string | null; title?: string } = {},
): void {
  const entry = chats.get(id);
  if (!entry) return;
  const now = Date.now();
  // COALESCE semantics, matching `touchChat`: null means "leave it alone".
  entry.record = {
    ...entry.record,
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.title ? { title: input.title } : {}),
    updatedAt: now,
  };
  entry.touchedAt = now;
}

export function appendTemporaryMessage(input: {
  chatId: string;
  role: MessageRole;
  content?: string;
  tool?: ToolName | null;
  modelId?: string | null;
  providerId?: string | null;
  providerName?: string | null;
  status?: MessageStatus;
  id?: string;
}): MessageRecord {
  const entry = chats.get(input.chatId);
  if (!entry) {
    throw new AppError('not_found', `No temporary chat with id "${input.chatId}".`);
  }

  const now = Date.now();
  const message: MessageRecord = {
    id: input.id ?? randomUUID(),
    chatId: input.chatId,
    role: input.role,
    content: input.content ?? '',
    tool: input.tool ?? null,
    modelId: input.modelId ?? null,
    providerId: input.providerId ?? null,
    providerName: input.providerName ?? null,
    status: input.status ?? 'complete',
    errorCode: null,
    errorMessage: null,
    tokensIn: null,
    tokensOut: null,
    seq: entry.messages.length + 1,
    createdAt: now,
    updatedAt: now,
  };

  entry.messages.push(message);
  entry.touchedAt = now;
  return message;
}

/**
 * Patch a message in place.
 *
 * Mirrors `updateMessage`'s contract, including that `undefined` means "leave
 * this field alone" while an explicit null clears it — the streaming path
 * depends on that distinction to blank an error on a successful retry.
 */
export function updateTemporaryMessage(
  id: string,
  input: {
    content?: string;
    status?: MessageStatus;
    errorCode?: string | null;
    errorMessage?: string | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    providerId?: string | null;
    providerName?: string | null;
    modelId?: string | null;
  },
): boolean {
  for (const entry of chats.values()) {
    const index = entry.messages.findIndex((message) => message.id === id);
    if (index === -1) continue;

    const current = entry.messages[index];
    if (current === undefined) continue;

    const patch: Partial<MessageRecord> = {};
    if (input.content !== undefined) patch.content = input.content;
    if (input.status !== undefined) patch.status = input.status;
    if (input.errorCode !== undefined) patch.errorCode = input.errorCode;
    if (input.errorMessage !== undefined) patch.errorMessage = input.errorMessage;
    if (input.tokensIn !== undefined) patch.tokensIn = input.tokensIn;
    if (input.tokensOut !== undefined) patch.tokensOut = input.tokensOut;
    if (input.providerId !== undefined) patch.providerId = input.providerId;
    if (input.providerName !== undefined) patch.providerName = input.providerName;
    if (input.modelId !== undefined) patch.modelId = input.modelId;

    entry.messages[index] = { ...current, ...patch, updatedAt: Date.now() };
    entry.touchedAt = Date.now();
    return true;
  }
  return false;
}

export function findTemporaryMessage(id: string): MessageRecord | null {
  for (const entry of chats.values()) {
    const found = entry.messages.find((message) => message.id === id);
    if (found) return found;
  }
  return null;
}

/** The in-memory transcript, oldest first — the shape `listMessages` returns. */
export function temporaryMessages(chatId: string, limit = 500): MessageRecord[] {
  const entry = chats.get(chatId);
  if (!entry) return [];
  return entry.messages.slice(0, limit);
}

/** Test seam. Also called on shutdown so a restart never inherits a session. */
export function clearTemporaryChats(): void {
  chats.clear();
}
