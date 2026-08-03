import { Router } from 'express';

import {
  createChat,
  deleteChat,
  listChats,
  listMessages,
  markChatOpened,
  requireChat,
  setChatArchived,
  setChatPinned,
  touchChat,
} from '../db/chats.ts';
import { concurrencyMode } from '../db/settings.ts';
import { sendMessage, switchAndResume } from '../orchestrator/chat.ts';
import { currentJob, isBusy, withLock } from '../orchestrator/lock.ts';
import { latestRunForChat, listPausedRuns } from '../orchestrator/runState.ts';
import { openStream } from '../orchestrator/sse.ts';
import type { ToolName } from '../types/core.ts';
import { AppError } from '../util/errors.ts';
import { wrap } from './errors.ts';
import {
  asBool,
  asNullableString,
  asNumber,
  asOptionalString,
  asString,
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

chatRouter.post(
  '/',
  wrap(async (req, res) => {
    const payload = body(req);
    const chat = createChat({
      tool: requireTool(payload.tool),
      title: asOptionalString(payload.title, 'title'),
      modelId: asNullableString(payload.modelId, 'modelId'),
      providerId: asNullableString(payload.providerId, 'providerId'),
      id: asOptionalString(payload.id, 'id'),
    });
    res.status(201).json({ chat });
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

chatRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    if (!deleteChat(id)) {
      throw new AppError('not_found', `Chat ${id} was not found`);
    }
    res.json({ deleted: true, id });
  }),
);

chatRouter.get(
  '/:id/messages',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    requireChat(id);
    res.json({ messages: listMessages(id, queryNumber(req, 'limit') ?? 500) });
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
