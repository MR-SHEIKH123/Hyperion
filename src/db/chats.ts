/**
 * Chat and message persistence.
 *
 * The rule that shapes this module: message history is never destroyed by a
 * failure. A truncated assistant response is stored with `status = 'paused'`
 * and its partial text intact, so a provider outage costs the user nothing
 * except the tail of one reply.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from './adapter.ts';
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
  getDb().prepare(`UPDATE chats SET last_opened_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function setChatPinned(id: string, pinned: boolean): ChatRecord {
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
  getDb().prepare(`UPDATE chats SET archived = ?, updated_at = ? WHERE id = ?`).run(archived, Date.now(), id);
  return requireChat(id);
}

export function deleteChat(id: string): boolean {
  const result = getDb().prepare(`DELETE FROM chats WHERE id = ?`).run(id);
  return Number(result.changes ?? 0) > 0;
}

// --- messages --------------------------------------------------------------

export function listMessages(chatId: string, limit = 500): MessageRecord[] {
  return getDb()
    .prepare<MessageRow>(`SELECT * FROM messages WHERE chat_id = ? ORDER BY seq ASC LIMIT ?`)
    .all(chatId, limit)
    .map(mapMessage);
}

export function findMessage(id: string): MessageRecord | null {
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
 */
export function saveStreamProgress(id: string, content: string): void {
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
