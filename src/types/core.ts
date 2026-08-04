/**
 * Shared types — the contract surface Sol's frontend and Kimi's agent modules
 * code against. Changing anything here is a breaking change for their layers.
 */

// --- tools -----------------------------------------------------------------

/** Sidebar tools. Each selects its model independently of the others. */
export type ToolName = 'chat' | 'code' | 'cowork' | 'design' | 'playground';

export const TOOLS: readonly ToolName[] = [
  'chat',
  'code',
  'cowork',
  'design',
  'playground',
] as const;

export function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && (TOOLS as readonly string[]).includes(value);
}

// --- providers -------------------------------------------------------------

/**
 * How a provider is reached and which wire protocol it speaks.
 *   remote    — OpenAI-compatible gateway: base URL + API key, /chat/completions
 *   local     — auto-detected local runner (Ollama): /api/tags + /api/chat
 *   opencodex — local opencodex proxy: /v1/models + /v1/responses (the OpenAI
 *               *Responses* API, which is NOT chat-completions shaped)
 *   colibri   — local Colibrì server: /v1/models + /v1/chat/completions. Genuinely
 *               chat-completions shaped, so it reuses the `openai` adapter; it is
 *               a distinct type because its operational profile (registered by
 *               hand, one generation at a time, minutes-to-hours per reply) is
 *               nothing like a hosted gateway's.
 */
export type ProviderType = 'remote' | 'local' | 'opencodex' | 'colibri';

export const PROVIDER_TYPES: readonly ProviderType[] = [
  'remote',
  'local',
  'opencodex',
  'colibri',
];

export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === 'string' && (PROVIDER_TYPES as readonly string[]).includes(value);
}

export type HealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unhealthy';

/** A provider as stored. `apiKeyEnc` never leaves the backend. */
export interface ProviderRecord {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKeyEnc: string | null;
  apiKeyHint: string | null;
  enabled: boolean;
  priority: number;
  healthStatus: HealthStatus;
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  models: ModelInfo[] | null;
  modelsFetchedAt: number | null;
  modelsError: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Provider as sent to the frontend.
 *
 * Deliberately has no key field of any kind — `hasKey` and `apiKeyHint` (last 4
 * chars) are the only credential-adjacent facts that cross the wire.
 */
export interface ProviderPublic {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  hasKey: boolean;
  apiKeyHint: string | null;
  enabled: boolean;
  priority: number;
  healthStatus: HealthStatus;
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  modelCount: number | null;
  modelsFetchedAt: number | null;
  modelsError: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A model, identified by its raw provider-side ID. There is no curated list;
 * whatever the active provider reports is what the user can pick.
 */
export interface ModelInfo {
  id: string;
  /** Optional display name, when the provider supplies one. */
  label?: string;
  ownedBy?: string;
  contextLength?: number;
}

// --- chat ------------------------------------------------------------------

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * The minimal shape sent to a provider. Deliberately just role + content —
 * persistence metadata must never leak into an upstream request body.
 */
export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export type MessageStatus = 'streaming' | 'paused' | 'complete' | 'error';

/**
 * A persisted message row, as returned to the frontend.
 *
 * `status` is the part that matters: a `paused` assistant message carries the
 * partial text produced before the provider failed. It is displayed, not
 * discarded, and the run that produced it can be resumed.
 */
export interface MessageRecord {
  id: string;
  chatId: string;
  role: MessageRole;
  content: string;
  tool: ToolName | null;
  modelId: string | null;
  providerId: string | null;
  providerName: string | null;
  status: MessageStatus;
  errorCode: string | null;
  errorMessage: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  seq: number;
  createdAt: number;
  updatedAt: number;
}

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
}

/** What a provider adapter yields while streaming. */
export type StreamChunk =
  | { type: 'token'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; finishReason?: string };

export interface CompletionRequest {
  modelId: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Implemented once per provider protocol (OpenAI-compatible, Ollama). */
export interface ProviderAdapter {
  readonly kind: string;
  /** Live model list. Feeds the capability check and the model picker. */
  listModels(provider: ProviderRecord, signal?: AbortSignal): Promise<ModelInfo[]>;
  /** Streamed completion. Must throw AppError-shaped failures. */
  stream(
    provider: ProviderRecord,
    request: CompletionRequest,
  ): AsyncGenerator<StreamChunk, void, unknown>;
}

// --- run state machine -----------------------------------------------------

export type RunState = 'idle' | 'running' | 'paused' | 'complete' | 'error';

export type PauseReason =
  /** The provider failed mid-stream. Stays paused; no auto-retry into the same broken state. */
  | 'provider_failure'
  /** The user switched provider; auto-resumes when the switch succeeds. */
  | 'provider_switch'
  /** The user switched model; auto-resumes when the switch succeeds. */
  | 'model_switch'
  /** Failover found no healthy alternative. */
  | 'no_healthy_provider'
  /** No configured provider lists the requested model. */
  | 'capability_mismatch'
  | 'user_request';

export interface RunStateSnapshot {
  runId: string;
  chatId: string;
  tool: ToolName;
  state: RunState;
  pauseReason: PauseReason | null;
  errorCode: string | null;
  errorMessage: string | null;
  modelId: string | null;
  providerId: string | null;
  providerName: string | null;
  messageId: string | null;
  attempt: number;
  updatedAt: number;
}

// --- SSE -------------------------------------------------------------------

/**
 * Events emitted on /api/chat/stream.
 *
 * The frontend renders purely from these. `paused` in particular is a normal
 * event on a 200 response, not an HTTP error — the stream stays open so the
 * conversation can resume on the same connection.
 */
export type SseEvent =
  | { event: 'open'; data: { runId: string; chatId: string; messageId: string; providerId: string; providerName: string; modelId: string } }
  | { event: 'token'; data: { text: string } }
  | { event: 'usage'; data: TokenUsage & { costUsd: number | null } }
  | { event: 'paused'; data: { runId: string; reason: PauseReason; code: string; message: string; retryable: boolean; partialContent: string } }
  | { event: 'resumed'; data: { runId: string; providerId: string; providerName: string; modelId: string; attempt: number } }
  | { event: 'error'; data: { runId: string | null; code: string; message: string; retryable: boolean } }
  | { event: 'done'; data: { runId: string; messageId: string; finishReason?: string } }
  /** Free-form channel for agent progress (Kimi/Sol tool loops). */
  | { event: 'agent'; data: Record<string, unknown> };

// --- agent modules (implemented by Kimi and Sol) ---------------------------

/**
 * Result of a long-running agent task.
 * Kimi returns this from the code/cowork agents; Sol from the design agent.
 */
export interface TaskResult {
  ok: boolean;
  summary: string;
  /** Files created/modified, for the frontend to render a change list. */
  changedFiles?: string[];
  artifacts?: { key: string; version: number }[];
  error?: { code: string; message: string };
}

export interface TaskInput {
  tool: ToolName;
  chatId: string;
  modelId: string;
  prompt: string;
  /** Absolute path, always pre-validated inside the projects scope. */
  cwd?: string;
  attachments?: { id: string; path: string; filename: string }[];
  options?: Record<string, unknown>;
}

/**
 * Services handed to an agent module. Agents should use these rather than
 * reaching for the database or the network directly — `llm.stream` in
 * particular inherits provider failover and the pause/resume machine for free.
 */
export interface AgentContext {
  /** Push an SSE event to the client watching this task. */
  emit(event: string, data: Record<string, unknown>): void;
  /** Streamed completion through the active provider, with failover applied. */
  llm: {
    stream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown>;
    complete(request: CompletionRequest): Promise<{ text: string; usage: TokenUsage }>;
  };
  /** Run a shell command. Backed by Sol's terminal module. */
  executeCommand(
    cwd: string,
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<CommandResult>;
  /** Snapshot an artifact before editing it, so the change is undoable. */
  saveArtifactVersion(input: {
    artifactKey: string;
    tool: ToolName;
    content?: string;
    relPath?: string;
    label?: string;
  }): { version: number };
  /** Name + description of every registered skill, for prompt injection. */
  getSkillsSummary(): { name: string; description: string }[];
  /** Validate a path against the projects scope. Throws on escape. */
  resolvePath(candidate: string): string;
  /** Cancelled when the user aborts or the server shuts down. */
  signal: AbortSignal;
  log: {
    info(message: string, extra?: unknown): void;
    warn(message: string, extra?: unknown): void;
    error(message: string, extra?: unknown): void;
    debug(message: string, extra?: unknown): void;
  };
}

/** Implemented by Kimi (code, cowork) and Sol (design). */
export interface AgentModule {
  runTask(input: TaskInput, ctx: AgentContext): Promise<TaskResult>;
}

/**
 * Terminal execution, implemented by Sol and called in-process by Kimi's code
 * agent. A function call rather than an HTTP hop, for latency.
 */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface TerminalModule {
  executeCommand(
    cwd: string,
    command: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<CommandResult>;
}

/**
 * MCP process manager, implemented by Kimi. This backend owns the config file
 * and the API surface; spawning and supervising the servers is Kimi's.
 */
export interface McpProcessManager {
  /** Live status of every running server, surfaced by GET /api/mcp/status. */
  getStatus(): McpServerStatus[];
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  /** Optional live probe used by the test-connection endpoint for stdio servers. */
  testConnection?(name: string): Promise<{ ok: boolean; message: string }>;
}

export interface McpServerStatus {
  name: string;
  state: 'running' | 'stopped' | 'starting' | 'error';
  pid?: number;
  uptimeMs?: number;
  toolCount?: number;
  lastError?: string;
}
