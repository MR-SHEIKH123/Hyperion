/**
 * Chat and message persistence.
 *
 * The rule that shapes this module: message history is never destroyed by a
 * failure. A truncated assistant response is stored with `status = 'paused'`
 * and its partial text intact, so a provider outage costs the user nothing
 * except the tail of one reply.
 *
 * ## Temporary chats
 *
 * Every function that reads or writes a single chat checks the in-memory
 * registry in `temporaryChats.ts` first and returns before any SQL runs. The
 * guard lives here rather than in the orchestrator because the orchestrator has
 * six separate write sites, and the one that forgot would persist a private
 * transcript with no visible symptom. `listChats` is deliberately *not*
 * diverted — a temporary chat never belongs in the sidebar.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from './adapter.ts';
import {
  appendTemporaryMessage,
  endTemporaryChat,
  findTemporaryChat,
  findTemporaryMessage,
  isTemporaryChat,
  temporaryMessages,
  touchTemporaryChat,
  updateTemporaryMessage,
} from './temporaryChats.ts';
import { AppError } from '../util/errors.ts';
import type { ChatMessage, MessageRecord, MessageRole, MessageStatus, ToolName } from '../types/core.ts';


export interface ChatRecord {
  id: string;
  title: string;
  tool: ToolName;
  modelId: string | null;
  providerId: string | null;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
}

interface ChatRow {
  id: string;
  title: string;
  tool: string;
  model_id: string | null;
  provider_id: string | null;
  pinned: number;
  archived: number;
  created_at: number;
  updated_at: number;
  last_opened_at: number;
}

interface MessageRow {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  tool: string | null;
  model_id: string | null;
  provider_id: string | null;
  provider_name: string | null;
  status: string;
  error_code: string | null;
  error_message: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  seq: number;
  created_at: number;
  updated_at: number;
}

function mapChat(row: ChatRow): ChatRecord {
  return {
    id: row.id,
    title: row.title,
    tool: row.tool as ToolName,
    modelId: row.model_id,
    providerId: row.provider_id,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
  };
}

function mapMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role as MessageRole,
    content: row.content,
    tool: (row.tool as ToolName | null) ?? null,
    modelId: row.model_id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    status: row.status as MessageStatus,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    seq: row.seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- chats -----------------------------------------------------------------

/**
 * Lists chats for the sidebar.
 *
 * Archived chats are hidden by default — that is the entire point of archiving.
 * `includeArchived` widens the list to everything, and `archivedOnly` narrows it
 * to just the archive, which is what a dedicated "Archived" view wants.
 * `archivedOnly` wins if both are passed, since it is the more specific request.
 *
 * Temporary chats are absent by construction: they have no row to select. That
 * is also why they never reach the activity feed or an export, both of which
 * start from this table.
 */
export function listChats(
  options: { tool?: ToolName; includeArchived?: boolean; archivedOnly?: boolean; limit?: number } = {},
): ChatRecord[] {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  if (options.tool) {
    clauses.push('tool = ?');
    values.push(options.tool);
  }
  if (options.archivedOnly) clauses.push('archived = 1');
  else if (!options.includeArchived) clauses.push('archived = 0');
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(options.limit ?? 200);
  return getDb()
    .prepare<ChatRow>(`SELECT * FROM chats ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(...values)
    .map(mapChat);
}

export function findChat(id: string): ChatRecord | null {
  // Checked before the table, not after: an in-memory hit is authoritative,
  // because the create route refuses to open a temporary chat under an id that
  // already exists in `chats`.
  const temporary = findTemporaryChat(id);
  if (temporary) return temporary;
  const row = getDb().prepare<ChatRow>(`SELECT * FROM chats WHERE id = ?`).get(id);
  return row ? mapChat(row) : null;
}

export function requireChat(id: string): ChatRecord {
  const chat = findChat(id);
  if (!chat) throw new AppError('not_found', `No chat with id "${id}".`);
  return chat;
}

export function createChat(input: {
  tool: ToolName;
  title?: string;
  modelId?: string | null;
  providerId?: string | null;
  id?: string;
}): ChatRecord {
  const id = input.id ?? randomUUID();
  // Reaching here with a temporary id would insert the row this whole feature
  // exists to prevent. Refuse loudly rather than quietly persist it.
  if (isTemporaryChat(id)) {
    throw new AppError('conflict', `Chat "${id}" is temporary and cannot be persisted.`, {
      details: { field: 'id', chatId: id },
    });
  }
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO chats (id, title, tool, model_id, provider_id, pinned, archived, created_at, updated_at, last_opened_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
    )
    .run(id, input.title ?? 'New chat', input.tool, input.modelId ?? null, input.providerId ?? null, now, now, now);
  return requireChat(id);
}

/**
 * Returns the chat, creating it if absent. The frontend generates chat ids
 * client-side so the first message of a brand-new conversation is a single
 * round trip; this is what makes that safe.
 *
 * An open temporary chat is found by `findChat` and returned as-is, so the
 * orchestrator's first call on a private conversation does not create a row.
 */
export function ensureChat(input: {
  id: string;
  tool: ToolName;
  title?: string;
  modelId?: string | null;
  providerId?: string | null;
}): ChatRecord {
  const existing = findChat(input.id);
  if (existing) return existing;
  return createChat(input);
}

export function touchChat(
  id: string,
  input: { modelId?: string | null; providerId?: string | null; opened?: boolean; title?: string } = {},
): void {
  if (isTemporaryChat(id)) {
    touchTemporaryChat(id, input);
    return;
  }
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE chats
         SET updated_at = ?,
             last_opened_at = CASE WHEN ? = 1 THEN ? ELSE last_opened_at END,
             model_id = COALESCE(?, model_id),
             provider_id = COALESCE(?, provider_id),
             title = COALESCE(?, title)
       WHERE id = ?`,
    )
    .run(now, input.opened ? 1 : 0, now, input.modelId ?? null, input.providerId ?? null, input.title ?? null, id);
}

/** Records that a chat was opened. Resets the idle cleanup timer. */
export function markChatOpened(id: string): void {
  // A temporary chat has its own idle timer, reset by any activity.
  if (isTemporaryChat(id)) {
    touchTemporaryChat(id);
    return;
  }
  getDb().prepare(`UPDATE chats SET last_opened_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function setChatPinned(id: string, pinned: boolean): ChatRecord {
  // Pinning means "survive the cleanup sweep", which is meaningless for a chat
  // that cannot outlive the process. Saying so beats a silent no-op that
  // reports success and then loses the conversation anyway.
  if (isTemporaryChat(id)) {
    throw new AppError('bad_request', 'A temporary chat cannot be pinned — it is never saved.', {
      details: { field: 'id', chatId: id },
    });
  }
  getDb().prepare(`UPDATE chats SET pinned = ?, updated_at = ? WHERE id = ?`).run(pinned, Date.now(), id);
  return requireChat(id);
}

/**
 * Archives or unarchives a chat.
 *
 * Archiving hides a chat from the default list *and* exempts it from the idle
 * cleanup sweep, exactly as pinning does. It means "keep this, just get it out
 * of my way" — the opposite of a step toward deletion — so a chat you archive
 * today is still there in a year.
 */
export function setChatArchived(id: string, archived: boolean): ChatRecord {
  if (isTemporaryChat(id)) {
    throw new AppError('bad_request', 'A temporary chat cannot be archived — it is never saved.', {
      details: { field: 'id', chatId: id },
    });
  }
  getDb().prepare(`UPDATE chats SET archived = ?, updated_at = ? WHERE id = ?`).run(archived, Date.now(), id);
  return requireChat(id);
}

export function deleteChat(id: string): boolean {
  // Ending a temporary session is the same user gesture as deleting a saved
  // chat, and it is already as permanent as deletion gets — the transcript only
  // ever existed in this process's memory.
  if (isTemporaryChat(id)) return endTemporaryChat(id);
  const result = getDb().prepare(`DELETE FROM chats WHERE id = ?`).run(id);
  return Number(result.changes ?? 0) > 0;
}

export interface BulkDeleteResult {
  deleted: string[];
  /** Ids that matched no row. Reported, not an error — see below. */
  missing: string[];
}

/**
 * Delete several chats, with exactly the permanence of `deleteChat` — the same
 * DELETE, so the same `ON DELETE CASCADE` removes their messages.
 *
 * Not wrapped in a transaction, deliberately. An id that no longer exists is
 * the ordinary case here (two tabs open, or a list the user has been staring at
 * for a while), and a transaction would roll back forty successful deletions
 * because of one row someone else had already removed. Each id is answered
 * independently and the caller is told which is which.
 */
export function deleteChats(ids: readonly string[]): BulkDeleteResult {
  const deleted: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    if (deleteChat(id)) deleted.push(id);
    else missing.push(id);
  }
  return { deleted, missing };
}

// --- messages --------------------------------------------------------------

export function listMessages(chatId: string, limit = 500): MessageRecord[] {
  if (isTemporaryChat(chatId)) return temporaryMessages(chatId, limit);
  return getDb()
    .prepare<MessageRow>(`SELECT * FROM messages WHERE chat_id = ? ORDER BY seq ASC LIMIT ?`)
    .all(chatId, limit)
    .map(mapMessage);
}

export interface MessagePage {
  /** Oldest-first, so a page can be rendered without reversing it. */
  messages: MessageRecord[];
  /** Feed back as `before` for the next older page; null on the last page. */
  nextBefore: string | null;
}

/**
 * One page of a chat's transcript, newest page first, walking backwards.
 *
 * The cursor is a **message id**, not an offset and not a timestamp. An offset
 * shifts the moment a message is appended mid-scroll, which silently skips or
 * repeats a row; two messages can share a millisecond, so a timestamp cursor
 * has the same defect. `seq` is monotonic within a chat and never changes once
 * written, which is the only property a cursor actually needs — the id is
 * resolved to its seq and the comparison happens there.
 *
 * Note this returns the *newest* `limit` messages when no cursor is given,
 * where the unpaginated `listMessages` returns the oldest. Opening a long chat
 * should land at the bottom of the transcript, not at the beginning of a
 * conversation from months ago. The two agree whenever a chat is shorter than
 * the limit, which is nearly always.
 */
export function listMessagePage(chatId: string, limit = 500, before?: string): MessagePage {
  if (isTemporaryChat(chatId)) return temporaryMessagePage(chatId, limit, before);

  const db = getDb();

  let cursorSeq: number | null = null;
  if (before !== undefined) {
    const row = db
      .prepare<{ seq: number }>(`SELECT seq FROM messages WHERE id = ? AND chat_id = ?`)
      .get(before, chatId);
    // Silently ignoring an unknown cursor would serve the newest page again,
    // which reads to the user as the transcript duplicating itself.
    if (!row) {
      throw new AppError('bad_request', `No message "${before}" in this chat to page before.`, {
        details: { field: 'before', chatId },
      });
    }
    cursorSeq = row.seq;
  }

  // One extra row answers "is there another page?" without a second count.
  const rows =
    cursorSeq === null
      ? db
          .prepare<MessageRow>(`SELECT * FROM messages WHERE chat_id = ? ORDER BY seq DESC LIMIT ?`)
          .all(chatId, limit + 1)
      : db
          .prepare<MessageRow>(
            `SELECT * FROM messages WHERE chat_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
          )
          .all(chatId, cursorSeq, limit + 1);

  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).map(mapMessage).reverse();
  const oldest = page[0];

  return { messages: page, nextBefore: hasMore && oldest ? oldest.id : null };
}

/**
 * The same paging contract over an in-memory transcript.
 *
 * Written out rather than short-circuited to "one page, no cursor" so the
 * frontend needs no special case: an unknown cursor is still the same
 * `bad_request`, and `nextBefore` still means the same thing.
 */
function temporaryMessagePage(chatId: string, limit: number, before?: string): MessagePage {
  const all = temporaryMessages(chatId, Number.MAX_SAFE_INTEGER);

  let end = all.length;
  if (before !== undefined) {
    const index = all.findIndex((message) => message.id === before);
    if (index === -1) {
      throw new AppError('bad_request', `No message "${before}" in this chat to page before.`, {
        details: { field: 'before', chatId },
      });
    }
    end = index;
  }

  const start = Math.max(0, end - limit);
  const page = all.slice(start, end);
  const oldest = page[0];

  return { messages: page, nextBefore: start > 0 && oldest ? oldest.id : null };
}

export function findMessage(id: string): MessageRecord | null {
  const temporary = findTemporaryMessage(id);
  if (temporary) return temporary;
  const row = getDb().prepare<MessageRow>(`SELECT * FROM messages WHERE id = ?`).get(id);
  return row ? mapMessage(row) : null;
}

function nextSeq(chatId: string): number {
  const row = getDb()
    .prepare<{ next: number }>(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE chat_id = ?`)
    .get(chatId);
  return row?.next ?? 1;
}

export interface AppendMessageInput {
  chatId: string;
  role: MessageRole;
  content?: string;
  tool?: ToolName | null;
  modelId?: string | null;
  providerId?: string | null;
  providerName?: string | null;
  status?: MessageStatus;
  id?: string;
}

export function appendMessage(input: AppendMessageInput): MessageRecord {
  if (isTemporaryChat(input.chatId)) return appendTemporaryMessage(input);

  const id = input.id ?? randomUUID();
  const now = Date.now();
  const seq = nextSeq(input.chatId);
  getDb()
    .prepare(
      `INSERT INTO messages
         (id, chat_id, role, content, tool, model_id, provider_id, provider_name, status, seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.chatId,
      input.role,
      input.content ?? '',
      input.tool ?? null,
      input.modelId ?? null,
      input.providerId ?? null,
      input.providerName ?? null,
      input.status ?? 'complete',
      seq,
      now,
      now,
    );
  const message = findMessage(id);
  if (!message) throw new AppError('storage_error', 'Message insert did not persist.');
  return message;
}

export interface UpdateMessageInput {
  content?: string;
  status?: MessageStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  providerId?: string | null;
  providerName?: string | null;
  modelId?: string | null;
}

export function updateMessage(id: string, input: UpdateMessageInput): void {
  // Keyed by message id, since callers here hold a message rather than a chat.
  // A miss means the id belongs to a persisted row, not that nothing happened.
  if (updateTemporaryMessage(id, input)) return;

  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  const put = (column: string, value: string | number | null | undefined): void => {
    if (value === undefined) return;
    sets.push(`${column} = ?`);
    values.push(value);
  };
  put('content', input.content);
  put('status', input.status);
  put('error_code', input.errorCode);
  put('error_message', input.errorMessage);
  put('tokens_in', input.tokensIn);
  put('tokens_out', input.tokensOut);
  put('provider_id', input.providerId);
  put('provider_name', input.providerName);
  put('model_id', input.modelId);
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(Date.now(), id);
  getDb().prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Streaming writes go through here. The partial text is flushed to disk
 * periodically (not per token) so that even a hard `kill -9` mid-response
 * loses at most the last fragment rather than the whole reply.
 *
 * For a temporary chat the same flush updates memory instead, which is what
 * keeps a private reply resumable within the session without ever writing it.
 */
export function saveStreamProgress(id: string, content: string): void {
  if (updateTemporaryMessage(id, { content, status: 'streaming' })) return;
  getDb()
    .prepare(`UPDATE messages SET content = ?, status = 'streaming', updated_at = ? WHERE id = ?`)
    .run(content, Date.now(), id);
}

/**
 * Persisted rows narrowed to what a provider accepts.
 *
 * Errored messages are dropped, but `paused` ones are kept: their partial text
 * is real assistant output the model produced, and discarding it on resume
 * would silently rewrite the conversation the user is looking at.
 */
export function toProviderMessages(messages: MessageRecord[]): ChatMessage[] {
  return messages
    .filter((message) => message.status !== 'error' && message.content.trim().length > 0)
    .map((message) => ({ role: message.role, content: message.content }));
}
