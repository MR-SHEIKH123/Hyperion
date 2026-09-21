import {
  chatDetailResponseSchema,
  chatResponseSchema,
  chatRunsResponseSchema,
  chatsResponseSchema,
  deletedResponseSchema,
  chatContextSchema,
  forkChatResponseSchema,
  resumeInNewSessionResponseSchema,
  messagesPageSchema,
  openChatResponseSchema,
  pausedRunsResponseSchema,
  type ChatResumeInput,
  type ChatStreamInput,
  type MessageRecord,
  type RunStateSnapshot,
} from '../contracts/wire/chat';
import { runStreamSession, type StreamEnd } from './sse/session';
import { decodeChatEvent, type ChatSseEvent } from './sse/events';
import { request } from './client';

/**
 * Chat feature module (docs/API.md §4). Relative `/api` URLs only; wire
 * validation happens at the boundary via the request() schemas and the SSE
 * decoders.
 */

export interface ListChatsParams {
  tool?: string;
  includeArchived?: boolean;
  archivedOnly?: boolean;
  limit?: number;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

export const listChats = (params: ListChatsParams = {}, signal?: AbortSignal) =>
  request('/api/chat' + qs({ tool: params.tool, includeArchived: params.includeArchived ? 1 : undefined, archivedOnly: params.archivedOnly ? 1 : undefined, limit: params.limit }), chatsResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export const createChat = (body: { tool: string; title?: string; modelId?: string | null; providerId?: string | null; id?: string }, signal?: AbortSignal) =>
  request('/api/chat', chatResponseSchema, { method: 'POST', body, ...(signal === undefined ? {} : { signal }) });

export const getChat = (id: string, signal?: AbortSignal) =>
  request(`/api/chat/${encodeURIComponent(id)}`, chatDetailResponseSchema, { ...(signal === undefined ? {} : { signal }) });

/** Resets the chat's idle timer and returns its latest run (paused-banner restore on open). */
export const openChat = (id: string, signal?: AbortSignal) =>
  request(`/api/chat/${encodeURIComponent(id)}/open`, openChatResponseSchema, { method: 'POST', body: {}, ...(signal === undefined ? {} : { signal }) });

export const patchChat = (id: string, body: { title?: string; modelId?: string | null; providerId?: string | null; opened?: boolean }, signal?: AbortSignal) =>
  request(`/api/chat/${encodeURIComponent(id)}`, chatResponseSchema, { method: 'PATCH', body, ...(signal === undefined ? {} : { signal }) });

export const deleteChat = (id: string, signal?: AbortSignal) =>
  request(`/api/chat/${encodeURIComponent(id)}`, deletedResponseSchema, { method: 'DELETE', ...(signal === undefined ? {} : { signal }) });

export const pinChat = (id: string, pinned?: boolean, signal?: AbortSignal) =>
  request(`/api/chat/${encodeURIComponent(id)}/pin`, chatResponseSchema, { method: 'POST', body: pinned === undefined ? {} : { pinned }, ...(signal === undefined ? {} : { signal }) });

export const archiveChat = (id: string, signal?: AbortSignal) =>
  request(`/api/chat/${encodeURIComponent(id)}/archive`, chatResponseSchema, { method: 'POST', body: {}, ...(signal === undefined ? {} : { signal }) });

export const unarchiveChat = (id: string, signal?: AbortSignal) =>
  request(`/api/chat/${encodeURIComponent(id)}/unarchive`, chatResponseSchema, { method: 'POST', body: {}, ...(signal === undefined ? {} : { signal }) });

/** Cursor-paginated transcript: `before` names a message id; feed `nextBefore` back. */
export const listMessages = (chatId: string, params: { limit?: number; before?: string } = {}, signal?: AbortSignal) =>
  request(`/api/chat/${encodeURIComponent(chatId)}/messages` + qs({ limit: params.limit, before: params.before }), messagesPageSchema, { ...(signal === undefined ? {} : { signal }) });

/**
 * Branch a conversation (1.27's session fork). `upToMessageId` is **inclusive** —
 * it names the last message the branch gets. Omit everything for a full copy;
 * the branch's title defaults to `<source title> (fork)`.
 */
export const forkChat = (
  id: string,
  body: { upToMessageId?: string; title?: string; chatId?: string } = {},
  signal?: AbortSignal,
) =>
  request(`/api/chat/${encodeURIComponent(id)}/fork`, forkChatResponseSchema, { method: 'POST', body, ...(signal === undefined ? {} : { signal }) });

/**
 * How full this conversation is (1.28). A read with no provider call: the window
 * is the model's cached context length when something knows one, and the
 * conservative default otherwise (`window.assumed` says which).
 */
export const getChatContext = (id: string, signal?: AbortSignal) =>
  request(`/api/chat/${encodeURIComponent(id)}/context`, chatContextSchema, { ...(signal === undefined ? {} : { signal }) });

/**
 * Continue this conversation in a new session (1.28). The source is untouched —
 * the messages left behind still exist there — and the response carries the
 * receipt and the numbers. A conversation that already fits is refused with a
 * `409` naming both, because a copy that drops nothing solves nothing.
 */
export const resumeInNewSession = (
  id: string,
  body: { title?: string; chatId?: string } = {},
  signal?: AbortSignal,
) =>
  request(`/api/chat/${encodeURIComponent(id)}/resume-in-new-session`, resumeInNewSessionResponseSchema, { method: 'POST', body, ...(signal === undefined ? {} : { signal }) });

export const getChatRuns = (chatId: string, signal?: AbortSignal) =>
  request(`/api/chat/${encodeURIComponent(chatId)}/runs`, chatRunsResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export const listPausedRuns = (chatId?: string, signal?: AbortSignal) =>
  request('/api/chat/runs/paused' + qs({ chatId }), pausedRunsResponseSchema, { ...(signal === undefined ? {} : { signal }) });

// --- streaming -----------------------------------------------------------------

export interface ChatReconciliation {
  latest: RunStateSnapshot | null;
  messages: MessageRecord[];
}

export interface ChatStreamCallbacks {
  /** Every validly decoded frame, in order. */
  onEvent: (event: ChatSseEvent) => void;
  onEnd: (reason: StreamEnd) => void;
  /** Called after a non-terminal close with the server-side truth, so a dropped
   *  stream is reconciled through state — never replayed. */
  onReconciled?: (reconciliation: ChatReconciliation) => void;
  /** Decoded frames that failed validation. Kept separate so a wire drift is
   *  diagnosable instead of silently shaping the conversation. */
  onInvalidFrame?: (eventName: string, reason: string) => void;
}

async function reconcileChat(chatId: string, signal: AbortSignal): Promise<ChatReconciliation> {
  const [runs, page] = await Promise.all([
    getChatRuns(chatId, signal),
    listMessages(chatId, { limit: 50 }, signal),
  ]);
  return { latest: runs.latest, messages: page.messages };
}

async function runChatStream(
  path: string,
  body: ChatStreamInput | ChatResumeInput,
  chatId: string,
  callbacks: ChatStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  await runStreamSession({
    request: path,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    terminalEvents: new Set(['done', 'error']),
    onFrame: (frame) => {
      const decoded = decodeChatEvent(frame);
      if (decoded.ok) {
        callbacks.onEvent(decoded.event);
      } else {
        callbacks.onInvalidFrame?.(decoded.eventName, decoded.reason);
      }
    },
    onEnd: callbacks.onEnd,
    reconcile: async (sessionSignal) => {
      const reconciliation = await reconcileChat(chatId, sessionSignal);
      callbacks.onReconciled?.(reconciliation);
    },
    ...(signal === undefined ? {} : { signal }),
  });
}

/** POST /api/chat/stream — validation happens before the SSE headers, so a
 *  `busy` conflict arrives as an ordinary JSON 409 (an ApiError). */
export function streamChat(input: ChatStreamInput, callbacks: ChatStreamCallbacks, signal?: AbortSignal): Promise<void> {
  return runChatStream('/api/chat/stream', input, input.chatId, callbacks, signal);
}

/**
 * POST /api/chat/resume — requires the run to be paused (409 run_not_paused
 * otherwise). The resume body carries only a runId, so the caller threads the
 * chat id for post-close reconciliation from the run snapshot it already holds.
 */
export function resumeRun(input: ChatResumeInput, chatId: string, callbacks: ChatStreamCallbacks, signal?: AbortSignal): Promise<void> {
  return runChatStream('/api/chat/resume', input, chatId, callbacks, signal);
}
