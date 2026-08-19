import { Router } from 'express';

import {
  createChat,
  deleteChat,
  deleteChats,
  findChat,
  listChats,
  listMessagePage,
  listMessages,
  markChatOpened,
  requireChat,
  setChatArchived,
  setChatPinned,
  touchChat,
} from '../db/chats.ts';
import { concurrencyMode } from '../db/settings.ts';
import { createTemporaryChat, isTemporaryChat } from '../db/temporaryChats.ts';

import { sendMessage, switchAndResume } from '../orchestrator/chat.ts';
import { currentJob, isBusy, withLock } from '../orchestrator/lock.ts';
import { latestRunForChat, listPausedRuns } from '../orchestrator/runState.ts';
import { openStream } from '../orchestrator/sse.ts';
import { exportChat } from '../services/export/index.ts';
import type { ToolName } from '../types/core.ts';
import { AppError } from '../util/errors.ts';
import { attachDownloadHeaders } from './download.ts';
import { wrap } from './errors.ts';
import {
  asBool,
  asEnum,
  asNullableString,
  asNumber,
  asOptionalString,
  asString,
  asStringArray,
  asTool,
  body,
  pathParam,
  queryBool,
  queryNumber,

  queryString,
  requireTool,
} from './params.ts';

export const chatRouter: Router = Router();

interface StreamInput {
  chatId: string;
  tool: ToolName;
  modelId: string;
  prompt: string;
  systemPrompt: string | undefined;
  providerId: string | undefined;
  temperature: number | undefined;
  maxTokens: number | undefined;
  attachments: { id: string; filename: string }[] | undefined;
  resumeRunId: string | undefined;
  /** Send anyway, after an outbound-safety refusal (Part 1.23). */
  acknowledgeSensitive: boolean | undefined;
}

function parseAttachments(value: unknown): { id: string; filename: string }[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new AppError('bad_request', 'attachments must be an array');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new AppError('bad_request', `attachments[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    return {
      id: asString(record.id, `attachments[${index}].id`),
      filename: asString(record.filename, `attachments[${index}].filename`),
    };
  });
}

/**
 * The frontend may post either a bare `prompt` or a `messages` array (the
 * shape used by the provider adapters). Only the trailing user turn matters:
 * prior turns are rebuilt from the database so history can never be forged
 * by the client.
 */
function readPrompt(payload: Record<string, unknown>): string {
  const direct = asOptionalString(payload.prompt ?? payload.message, 'prompt');
  if (direct !== undefined) return direct;

  const messages = payload.messages;
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index];
      if (typeof entry === 'string' && entry.trim()) return entry.trim();
      if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>;
        const role = typeof record.role === 'string' ? record.role : 'user';
        const content = typeof record.content === 'string' ? record.content.trim() : '';
        if (role === 'user' && content) return content;
      }
    }
  }

  throw new AppError('bad_request', 'prompt is required');
}

function parseStreamInput(payload: Record<string, unknown>): StreamInput {
  return {
    chatId: asString(payload.chatId ?? payload.id, 'chatId'),
    tool: requireTool(payload.tool),
    modelId: asString(payload.modelId, 'modelId'),
    prompt: readPrompt(payload),
    systemPrompt: asOptionalString(payload.systemPrompt, 'systemPrompt'),
    providerId: asOptionalString(payload.providerId, 'providerId'),
    temperature: asNumber(payload.temperature, 'temperature'),
    maxTokens: asNumber(payload.maxTokens, 'maxTokens'),
    attachments: parseAttachments(payload.attachments),
    resumeRunId: asOptionalString(payload.resumeRunId, 'resumeRunId'),
    acknowledgeSensitive: asBool(payload.acknowledgeSensitive, 'acknowledgeSensitive'),
  };
}

/**
 * `reject` mode should fail fast with a JSON 409 before the stream opens, so
 * the client gets a plain HTTP error instead of an SSE error frame. In
 * `queue` mode the request waits its turn inside the lock instead.
 */
function assertNotBusy(): void {
  if (concurrencyMode() !== 'reject' || !isBusy()) return;
  const job = currentJob();
  throw new AppError('busy', 'Another job is already running', {
    details: job ? { jobId: job.id } : undefined,
    retryable: true,
  });
}

chatRouter.get(
  '/',
  wrap(async (req, res) => {
    const chats = listChats({
      tool: asTool(queryString(req, 'tool')),
      includeArchived: queryBool(req, 'includeArchived'),
      archivedOnly: queryBool(req, 'archivedOnly'),
      limit: queryNumber(req, 'limit'),
    });
    res.json({ chats });
  }),
);

/**
 * Creates a chat.
 *
 * `temporary: true` opens an incognito session instead: held in memory, never
 * inserted, gone when it is ended or when the process exits. The response shape
 * is identical apart from the `temporary` flag, so the frontend renders both the
 * same way — but the flag is echoed so it can show that nothing is being saved.
 */
chatRouter.post(
  '/',
  wrap(async (req, res) => {
    const payload = body(req);
    const input = {
      tool: requireTool(payload.tool),
      title: asOptionalString(payload.title, 'title'),
      modelId: asNullableString(payload.modelId, 'modelId'),
      providerId: asNullableString(payload.providerId, 'providerId'),
      id: asOptionalString(payload.id, 'id'),
    };

    if (asBool(payload.temporary, 'temporary') === true) {
      // A client-supplied id that already names a saved chat is refused rather
      // than shadowed: `findChat` prefers the in-memory entry, so adopting it
      // would hide the real transcript for as long as the session lasted.
      if (input.id !== undefined && findChat(input.id) !== null) {
        throw new AppError('conflict', `Chat "${input.id}" already exists and is saved.`, {
          details: { field: 'id', chatId: input.id },
        });
      }
      const chat = createTemporaryChat(input);
      res.status(201).json({ chat, temporary: true });
      return;
    }

    res.status(201).json({ chat: createChat(input), temporary: false });
  }),
);

/**
 * Deletes several chats at once, as permanently as deleting one.
 *
 * Declared above `/:id` so the literal segment is not taken for an id. Missing
 * ids are reported in `missing` rather than failing the call — see `deleteChats`
 * for why one stale id must not cost the caller the other forty deletions.
 */
chatRouter.post(
  '/bulk-delete',
  wrap(async (req, res) => {
    const ids = asStringArray(body(req).ids, 'ids');
    if (ids === undefined || ids.length === 0) {
      throw new AppError('bad_request', 'ids must be a non-empty array of chat ids.', {
        details: { field: 'ids' },
      });
    }
    res.json(deleteChats(ids));
  }),
);

/**
 * Streaming lives above `/:id` so the literal path is never swallowed by the
 * id parameter.
 */
chatRouter.post('/stream', (req, res, next) => {
  let input: StreamInput;
  try {
    input = parseStreamInput(body(req));
    assertNotBusy();
  } catch (error) {
    next(error);
    return;
  }

  const sse = openStream(res);
  void withLock(
    {
      tool: input.tool,
      label: `chat:${input.chatId}`,
      mode: concurrencyMode(),
      signal: sse.signal,
    },
    () => sendMessage(input, sse),
  )
    .catch((error: unknown) => {
      // sendMessage already emitted open/token/usage/paused/done frames; only
      // the failure path is ours to report.
      sse.sendError(error);
    })
    .finally(() => {
      sse.close();
    });
});

chatRouter.post('/resume', (req, res, next) => {
  let runId: string;
  let modelId: string | undefined;
  let providerId: string | undefined;
  let tool: ToolName | undefined;
  try {
    const payload = body(req);
    runId = asString(payload.runId, 'runId');
    modelId = asOptionalString(payload.modelId, 'modelId');
    providerId = asOptionalString(payload.providerId, 'providerId');
    tool = asTool(payload.tool);
    assertNotBusy();
  } catch (error) {
    next(error);
    return;
  }

  const sse = openStream(res);
  void withLock(
    {
      tool: tool ?? 'chat',
      label: `resume:${runId}`,
      mode: concurrencyMode(),
      signal: sse.signal,
    },
    () => switchAndResume({ runId, modelId, providerId, tool }, sse),
  )
    .catch((error: unknown) => {
      sse.sendError(error, runId);
    })
    .finally(() => {
      sse.close();
    });
});

chatRouter.get(
  '/runs/paused',
  wrap(async (req, res) => {
    res.json({ runs: listPausedRuns(queryString(req, 'chatId')) });
  }),
);

chatRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    const chat = requireChat(id);
    res.json({
      chat,
      messages: listMessages(id, queryNumber(req, 'limit') ?? 500),
    });
  }),
);

chatRouter.patch(
  '/:id',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    requireChat(id);
    const payload = body(req);
    touchChat(id, {
      title: asOptionalString(payload.title, 'title'),
      modelId: asNullableString(payload.modelId, 'modelId'),
      providerId: asNullableString(payload.providerId, 'providerId'),
      opened: asBool(payload.opened, 'opened'),
    });
    res.json({ chat: requireChat(id) });
  }),
);

/**
 * Deletes a saved chat, or ends a temporary one.
 *
 * One route for both because it is one user gesture, and because a temporary
 * session is already at least as gone as a deleted row. `temporary` is read
 * before the delete — afterwards there is nothing left to ask — and reported so
 * the frontend can word the confirmation honestly.
 */
chatRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    const temporary = isTemporaryChat(id);
    if (!deleteChat(id)) {
      throw new AppError('not_found', `Chat ${id} was not found`);
    }
    res.json({ deleted: true, id, temporary });
  }),
);


/**
 * The transcript, paged backwards from the newest message.
 *
 * Cursor-based rather than offset-based: a chat grows at the end while it is
 * being scrolled, and every appended message shifts an offset by one, so
 * `?offset=` silently repeats or skips a row. `before` names a message id, and
 * a message's position in its chat never moves.
 *
 * With no `before` this returns the newest page. Callers wanting the whole
 * transcript oldest-first still use `GET /api/chat/:id`, which is unchanged.
 */
chatRouter.get(
  '/:id/messages',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    requireChat(id);

    const limit = queryNumber(req, 'limit') ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new AppError('bad_request', 'limit must be an integer between 1 and 500.', {
        details: { field: 'limit' },
      });
    }

    const page = listMessagePage(id, limit, queryString(req, 'before'));
    res.json({ messages: page.messages, nextBefore: page.nextBefore });
  }),
);


/** Resets the idle timer used by the cleanup job. */
chatRouter.post(
  '/:id/open',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    requireChat(id);
    markChatOpened(id);
    res.json({
      chat: requireChat(id),
      messages: listMessages(id, 500),
      latestRun: latestRunForChat(id),
    });
  }),
);

chatRouter.post(
  '/:id/pin',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    const chat = requireChat(id);
    const pinned = asBool(body(req).pinned, 'pinned') ?? !chat.pinned;
    res.json({ chat: setChatPinned(id, pinned) });
  }),
);

/**
 * Archive and unarchive.
 *
 * Two routes rather than one toggle: archiving is usually driven by a menu item
 * with a definite intent ("Archive this"), and an idempotent endpoint is easier
 * for the frontend to call without first knowing the current state.
 */
chatRouter.post(
  '/:id/archive',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    requireChat(id);
    res.json({ chat: setChatArchived(id, true) });
  }),
);

chatRouter.post(
  '/:id/unarchive',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    requireChat(id);
    res.json({ chat: setChatArchived(id, false) });
  }),
);

chatRouter.get(
  '/:id/runs',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    requireChat(id);
    res.json({
      latest: latestRunForChat(id),
      paused: listPausedRuns(id),
    });
  }),
);

/**
 * One chat as a file — Markdown by default, `?format=json` for the structured
 * form.
 *
 * Markdown is the default because the usual reason to export a conversation is
 * to read or share it, not to re-import it; the JSON form keeps the
 * per-message metadata the transcript drops.
 *
 * The extra path segment is what keeps this reachable at all: `/:id` is
 * declared above, but it only matches a single segment, so `/:id/export` is
 * never swallowed by it.
 */
chatRouter.get(
  '/:id/export',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    const format = asEnum(queryString(req, 'format'), 'format', ['markdown', 'json'] as const);

    const exported = exportChat(id, format ?? 'markdown');
    attachDownloadHeaders(res, exported.filename, exported.contentType);
    res.send(exported.content);
  }),
);
