import { z } from 'zod';

/**
 * Chat wire contracts (docs/API.md §4). These are the network boundary only —
 * everything past `request()` stays ordinary TypeScript.
 */

export const toolNameSchema = z.enum(['chat', 'code', 'cowork', 'design', 'playground']);
export type ToolName = z.infer<typeof toolNameSchema>;

export const chatRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  tool: toolNameSchema,
  modelId: z.string().nullable(),
  providerId: z.string().nullable(),
  pinned: z.boolean(),
  archived: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastOpenedAt: z.number(),
}).passthrough();
export type ChatRecord = z.infer<typeof chatRecordSchema>;

export const messageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export const messageStatusSchema = z.enum(['streaming', 'paused', 'complete', 'error']);

export const messageRecordSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: messageRoleSchema,
  content: z.string(),
  tool: toolNameSchema.nullable(),
  modelId: z.string().nullable(),
  providerId: z.string().nullable(),
  providerName: z.string().nullable(),
  status: messageStatusSchema,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  seq: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).passthrough();
export type MessageRecord = z.infer<typeof messageRecordSchema>;

export const pauseReasonSchema = z.enum([
  'provider_failure',
  'provider_switch',
  'model_switch',
  'no_healthy_provider',
  'capability_mismatch',
  'user_request',
]);

export const runStateSchema = z.enum(['idle', 'running', 'paused', 'complete', 'error']);

export const runStateSnapshotSchema = z.object({
  runId: z.string(),
  chatId: z.string(),
  tool: toolNameSchema,
  state: runStateSchema,
  pauseReason: pauseReasonSchema.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  modelId: z.string().nullable(),
  providerId: z.string().nullable(),
  providerName: z.string().nullable(),
  messageId: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  updatedAt: z.number(),
}).passthrough();
export type RunStateSnapshot = z.infer<typeof runStateSnapshotSchema>;

// --- list/detail responses (API.md §4.2) ------------------------------------

export const chatsResponseSchema = z.object({ chats: z.array(chatRecordSchema) }).passthrough();

export const chatDetailResponseSchema = z.object({
  chat: chatRecordSchema,
  messages: z.array(messageRecordSchema),
}).passthrough();

export const chatResponseSchema = z.object({ chat: chatRecordSchema }).passthrough();

export const deletedResponseSchema = z.object({ deleted: z.literal(true), id: z.string() }).passthrough();

/** `POST /api/chat/:id/open` — resets the idle timer, returns the latest run so a
 *  paused banner can be restored on reload. */
export const openChatResponseSchema = z.object({
  chat: chatRecordSchema,
  messages: z.array(messageRecordSchema),
  latestRun: runStateSnapshotSchema.nullable(),
}).passthrough();

/** `GET /api/chat/:id/runs` — `{ latest, paused }`; `paused` is the paused runs for this chat. */
export const chatRunsResponseSchema = z.object({
  latest: runStateSnapshotSchema.nullable(),
  paused: z.array(runStateSnapshotSchema),
}).passthrough();

export const pausedRunsResponseSchema = z.object({ runs: z.array(runStateSnapshotSchema) }).passthrough();

/** Cursor-paginated transcript page: `before` names a message id, page is oldest-first. */
export const messagesPageSchema = z.object({
  messages: z.array(messageRecordSchema),
  nextBefore: z.string().nullable(),
}).passthrough();

// --- stream payloads (API.md §4.3; mirrors the SseEvent union in src/types/core.ts) ---

export const chatSseOpenSchema = z.object({
  runId: z.string(),
  chatId: z.string(),
  messageId: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  modelId: z.string(),
}).passthrough();

export const chatSseTokenSchema = z.object({ text: z.string() }).passthrough();

export const chatSseUsageSchema = z.object({
  tokensIn: z.number(),
  tokensOut: z.number(),
  costUsd: z.number().nullable(),
}).passthrough();

export const chatSsePausedSchema = z.object({
  runId: z.string(),
  reason: pauseReasonSchema,
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  partialContent: z.string(),
}).passthrough();

export const chatSseResumedSchema = z.object({
  runId: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  modelId: z.string(),
  attempt: z.number().int().nonnegative(),
}).passthrough();

export const chatSseErrorSchema = z.object({
  runId: z.string().nullable(),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
}).passthrough();

export const chatSseDoneSchema = z.object({
  runId: z.string(),
  messageId: z.string(),
  finishReason: z.string().optional(),
}).passthrough();

/**
 * Request bodies (validated server-side; these types keep call sites honest).
 */
export interface ChatStreamInput {
  chatId: string;
  tool: ToolName;
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  providerId?: string;
  temperature?: number;
  maxTokens?: number;
  attachments?: { id: string; filename: string }[];
  resumeRunId?: string;
  acknowledgeSensitive?: boolean;
}

export interface ChatResumeInput {
  runId: string;
  modelId?: string;
  providerId?: string;
  tool?: ToolName;
}
