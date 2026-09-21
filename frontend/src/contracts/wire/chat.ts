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
/**
 * `POST /api/chat/:id/fork` (docs/API.md §4.2). `pausedPartials` counts the copied
 * messages that were mid-stream in the source and land `paused` in the branch —
 * the branch has no writer, so `streaming` would be a claim nothing can keep.
 */
export const forkChatResponseSchema = z.object({
  chat: chatRecordSchema,
  messages: z.array(messageRecordSchema),
  forkedFrom: z.string(),
  pausedPartials: z.number().int().nonnegative(),
}).passthrough();
export type ForkChatResponse = z.infer<typeof forkChatResponseSchema>;

/**
 * `GET /api/chat/:id/context` (docs/API.md §4.5) — how full the conversation is.
 *
 * `window.assumed` is part of the contract rather than a detail: most
 * OpenAI-compatible gateways report no context length, so the number the
 * assessment is compared against is often the conservative default, and a
 * surface that hides that would be presenting a guess as a measurement.
 */
export const chatContextSchema = z.object({
  chatId: z.string(),
  modelId: z.string().nullable(),
  window: z.object({
    tokens: z.number().int().positive(),
    source: z.enum(['override', 'model', 'default']),
    assumed: z.boolean(),
  }).passthrough(),
  estimatedTokens: z.number().nonnegative(),
  ratio: z.number().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  needsNewSession: z.boolean(),
}).passthrough();
export type ChatContext = z.infer<typeof chatContextSchema>;

/**
 * `POST /api/chat/:id/resume-in-new-session` (1.28).
 *
 * `messages` is the receipt followed by the copied tail, `droppedMessages` says
 * how many were described instead of copied, and `assessment` carries the numbers
 * the decision was made from so the surface can state them rather than re-derive
 * them. `receipt` is the exact text of the first message: a surface can render it
 * without parsing the transcript.
 */
export const resumeInNewSessionResponseSchema = z.object({
  chat: chatRecordSchema,
  messages: z.array(messageRecordSchema),
  source: z.object({ id: z.string(), title: z.string() }).passthrough(),
  droppedMessages: z.number().int().nonnegative(),
  pausedPartials: z.number().int().nonnegative(),
  receipt: z.string(),
  assessment: chatContextSchema,
}).passthrough();
export type ResumeInNewSessionResponse = z.infer<typeof resumeInNewSessionResponseSchema>;

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
