/**
 * Shared contracts used across HTTP, orchestration, services and future clients.
 * Changing a public interface here can break every layer that consumes it.
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
 *   puter     — Puter's hosted OpenAI-compatible endpoint. Also chat-completions
 *               shaped, and also reuses the `openai` adapter; a distinct type
 *               because its credential is a *session auth token* rather than a
 *               vendor API key, which expires and has to be pasted again (1.38).
 */
export type ProviderType = 'remote' | 'local' | 'opencodex' | 'colibri' | 'puter';

export const PROVIDER_TYPES: readonly ProviderType[] = [
  'remote',
  'local',
  'opencodex',
  'colibri',
  'puter',
];

export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === 'string' && (PROVIDER_TYPES as readonly string[]).includes(value);
}

export type HealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unhealthy';

// --- zero data retention (Part 1.26) ---------------------------------------

/**
 * What is known about one provider's zero-data-retention behaviour.
 *
 * A *fact the user recorded*, never something this backend discovered. Nothing
 * observable about a request proves what happens to it after it arrives, so
 * every value here traces back to the user reading a vendor's terms and saying
 * so.
 *
 *   unknown           — nothing has been recorded. The default, and the reason
 *                       `require` refuses a fresh install's providers.
 *   supported_default — the provider retains nothing without being asked.
 *   supported_opt_in  — retention is off only when the request says so, which
 *                       is what `requestFlag` carries.
 *   not_supported     — the provider retains request data.
 *   not_applicable    — the question does not arise for this endpoint. Distinct
 *                       from `supported_default`: it makes no promise, so it is
 *                       not ZDR-satisfied and does not pass `require`.
 */
export type ZdrSupport =
  | 'unknown'
  | 'supported_default'
  | 'supported_opt_in'
  | 'not_supported'
  | 'not_applicable';

export const ZDR_SUPPORTS: readonly ZdrSupport[] = [
  'unknown',
  'supported_default',
  'supported_opt_in',
  'not_supported',
  'not_applicable',
] as const;

export function isZdrSupport(value: unknown): value is ZdrSupport {
  return typeof value === 'string' && (ZDR_SUPPORTS as readonly string[]).includes(value);
}

/**
 * The user's standing policy, account-wide.
 *
 *   off     — ZDR is recorded but changes no routing decision.
 *   prefer  — an eligible provider is chosen first; an ineligible one is still
 *             used when it is the only option, and the usage row says so.
 *   require — an ineligible provider is never dispatched to, including during
 *             failover. The request is refused instead.
 */
export type ZdrRequirement = 'off' | 'prefer' | 'require';

export const ZDR_REQUIREMENTS: readonly ZdrRequirement[] = ['off', 'prefer', 'require'] as const;

export function isZdrRequirement(value: unknown): value is ZdrRequirement {
  return typeof value === 'string' && (ZDR_REQUIREMENTS as readonly string[]).includes(value);
}

/** Where a `supported_opt_in` flag rides on the outbound request. */
export type ZdrFlagLocation = 'header' | 'body';

export const ZDR_FLAG_LOCATIONS: readonly ZdrFlagLocation[] = ['header', 'body'] as const;

export function isZdrFlagLocation(value: unknown): value is ZdrFlagLocation {
  return typeof value === 'string' && (ZDR_FLAG_LOCATIONS as readonly string[]).includes(value);
}

/**
 * The opt-in mechanism for a `supported_opt_in` provider, as the user described
 * it. Entirely user-supplied, which is what makes one generic applier enough —
 * no vendor-specific code exists or is wanted here.
 *
 * `value` is stored and returned in **plaintext** and must never hold a
 * credential. It is a policy declaration (`"true"`, `"zdr"`, `"strict"`), and
 * the user has to be able to read it back to check a field they maintain by
 * hand. `setProviderZdr` refuses a value that `findSensitive()` flags.
 */
export interface ZdrRequestFlag {
  location: ZdrFlagLocation;
  key: string;
  value: string;
}

/** Per-provider ZDR facts. Shared by `ProviderRecord` and `ProviderPublic`. */
export interface ProviderZdr {
  support: ZdrSupport;
  /** Null when the provider needs no flag, or none has been recorded. */
  requestFlag: ZdrRequestFlag | null;
  /**
   * Epoch ms of the user's own attestation, or null.
   *
   * **Never machine-set.** A request that succeeded proves the flag was
   * accepted, not that anything was discarded, so "requested" is the ceiling
   * for anything Hyperion can conclude on its own.
   */
  confirmedAt: number | null;
  /** What the user attested, in their words. Cleared together with the date. */
  confirmedNote: string | null;
}

/**
 * What ZDR status actually applied to one request.
 *
 * An enum, never a display string: the wording belongs to the frontend, and a
 * stored sentence cannot be grouped, filtered or re-worded later.
 *
 *   local_no_egress    — nothing left the machine, so retention is moot.
 *   zdr_confirmed      — remote, ZDR satisfied, and the user attested it.
 *   zdr_requested      — remote, ZDR satisfied, not user-attested.
 *   zdr_not_applied    — remote, opt-in available but no usable flag.
 *   standard_retention — remote, and the provider retains the data.
 *   zdr_unknown        — remote, and nothing has been recorded.
 *   egress_unknown     — the provider type does not classify at all, so we
 *                        cannot even say whether the bytes left. Fails closed.
 */
export type ZdrStatus =
  | 'local_no_egress'
  | 'zdr_confirmed'
  | 'zdr_requested'
  | 'zdr_not_applied'
  | 'standard_retention'
  | 'zdr_unknown'
  | 'egress_unknown';

export const ZDR_STATUSES: readonly ZdrStatus[] = [
  'local_no_egress',
  'zdr_confirmed',
  'zdr_requested',
  'zdr_not_applied',
  'standard_retention',
  'zdr_unknown',
  'egress_unknown',
] as const;

export function isZdrStatus(value: unknown): value is ZdrStatus {
  return typeof value === 'string' && (ZDR_STATUSES as readonly string[]).includes(value);
}

/**
 * The starting point for every provider: nothing recorded, nothing attested.
 *
 * Exported so the handful of synthetic `ProviderRecord`s in the codebase — the
 * local-detection probe, the Colibrì probe — do not each restate the default and
 * cannot drift from it. Frozen because it is shared: a caller that mutated it
 * would change what every other probe reports.
 */
export const DEFAULT_PROVIDER_ZDR: ProviderZdr = Object.freeze({
  support: 'unknown',
  requestFlag: null,
  confirmedAt: null,
  confirmedNote: null,
});

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
  /**
   * The proxy every request to this provider is tunnelled through (Part 1.37).
   *
   * Stored verbatim, credentials included, because it is what the transport
   * dials. Nothing returns this field: read paths use `egressProxyFor`, which
   * yields the redacted form, and the audit column stores `host:port` alone.
   */
  egressProxy: string | null;
  /** Zero-data-retention facts (Part 1.26). Always present; defaults to `unknown`. */
  zdr: ProviderZdr;
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
  /**
   * The egress proxy as the user may read it back: `user:***@host:port` at most.
   *
   * A redacted string rather than a structured object, because the only consumer
   * is a disclosure — "this is where the traffic goes" — and a structure invites
   * a consumer to reconstruct the URL, which is how a password comes back.
   */
  egressProxy: string | null;
  /**
   * ZDR facts, returned in full including `requestFlag.value`.
   *
   * The exception to this interface's no-secrets rule is deliberate and safe:
   * the flag value is a policy declaration, never a credential — the write path
   * rejects one that looks like a credential — and a field the user maintains
   * by hand is unverifiable if it cannot be read back.
   */
  zdr: ProviderZdr;
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
/**
 * One tool invocation requested by the model.
 *
 * `arguments` stays a raw JSON *string* rather than a parsed object because
 * that is how providers stream it — in fragments that are only valid JSON once
 * concatenated. Parsing is the caller's job, and it has to cope with a model
 * that emitted malformed JSON.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * A tool the model is allowed to call, in JSON Schema form.
 *
 * `parameters` is deliberately opaque here: schemas are authored by whichever
 * layer owns the tool (MCP server, built-in, subagent) and this spine only
 * forwards them.
 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * The minimal shape sent to a provider.
 *
 * Still deliberately narrow — persistence metadata must never leak into an
 * upstream request body. The two tool fields are the exception, because the
 * protocol requires them: an assistant turn that requested tools has to carry
 * `toolCalls`, and each answering `tool` message has to carry the
 * `toolCallId` it responds to. Without that pairing the provider cannot match
 * a result to its request and rejects the whole conversation.
 */
export interface ChatMessage {
  role: MessageRole;
  content: string;
  /** Set only on an assistant message that requested tools. */
  toolCalls?: ToolCall[];
  /** Required on a `tool` message; identifies the call being answered. */
  toolCallId?: string;
  /** Set on a `tool` message so a provider that wants the name has it. */
  name?: string;
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

/**
 * What one provider request consumed (1.28's `reasoningTokens`/`cacheHitRate`).
 *
 * `tokensIn`/`tokensOut` are exactly what the provider reported and are the only
 * two the cost table prices. The three optional fields are **additional
 * accounting some providers report separately**, and they are optional rather
 * than defaulted to zero for the reason the whole dashboard turns on: a provider
 * that does not report cache reads has *not* reported zero, and a total built
 * from silent zeroes would say "nothing was cached" about traffic nobody
 * measured.
 *
 * `cacheReadTokens` is deliberately **not** folded into `tokensIn`, even for
 * gateways where `prompt_tokens` already includes it. Folding would change what
 * `tokensIn` means overnight — and with it every historical row — while
 * `computeCost` prices `tokensIn` at the input rate and the price table has no
 * cache tier to price it with. The rate is computed from the parts instead, and
 * the direction of its error is documented where it is computed.
 */
export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
  /** Prompt tokens served from the provider's own cache, when it says so. */
  cacheReadTokens?: number;
  /** Prompt tokens written into that cache, when it says so. */
  cacheWriteTokens?: number;
  /** Thinking tokens, counted separately from the answer by some models. */
  reasoningTokens?: number;
}

/** What a provider adapter yields while streaming. */
export type StreamChunk =
  | { type: 'token'; text: string }
  /**
   * Emitted once per completed tool call, after its argument fragments have
   * been reassembled. Adapters do not surface partial calls: a half-built
   * `arguments` string is not parseable, so there is nothing a consumer could
   * usefully do with it.
   */
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; finishReason?: string };

export interface CompletionRequest {
  modelId: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Offered tools. Omitted entirely for a plain chat turn, because some
   * gateways reject an empty `tools: []` rather than ignoring it.
   */
  tools?: ToolSchema[];
  /**
   * `auto` lets the model choose; `none` forces prose. Left undefined when no
   * tools are offered — sending `tool_choice` without `tools` is an error on
   * several gateways.
   */
  toolChoice?: 'auto' | 'none';
  /**
   * How hard a reasoning model should think, when the profile asked for a level.
   *
   * Advisory by construction: an adapter that has no equivalent omits it rather
   * than erroring or approximating. A profile is authored once and used against
   * whichever provider is active, so "this provider ignores it" has to be a
   * silent no-op — the alternative is a profile that fails on three providers out
   * of four.
   */
  reasoningEffort?: ReasoningVariant;
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
  /** Free-form channel for agent progress. */
  | { event: 'agent'; data: Record<string, unknown> };

// --- agent modules ----------------------------------------------------------

/**
 * Permission level selected for an agent run.
 *
 * Retained after 1.27 turned Ask/Plan/Act into profiles, because it is still the
 * *base mode* every profile declares and still what `task_steps.mode` records
 * under a CHECK. A profile name is a different fact and rides in its own column.
 */
export type AgentMode = 'ask' | 'plan' | 'act';

// --- the permission engine (Part 1.27) --------------------------------------

/**
 * What may happen when a tool is called.
 *
 * `ask` is the load-bearing one. It is not "deny with a nicer message": the call
 * is recorded, the run parks, and continuing it replays that exact call with the
 * user's decision applied. A permission model with only allow and deny forces
 * every uncertain case to be decided in advance, which in practice means every
 * uncertain case is allowed.
 */
export const PERMISSION_ACTIONS = ['allow', 'ask', 'deny'] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/**
 * One rule for one permission key.
 *
 * A scalar covers every invocation of the tool. A map is glob → action against
 * the tool's primary argument, so `{"src/**": "allow", "*": "deny"}` says what it
 * looks like it says. The map form is why a rule cannot simply be an action.
 */
export type PermissionRule = PermissionAction | Record<string, PermissionAction>;

/**
 * Where a rule came from. Later layers override earlier ones, with one exception.
 *
 * `inherited` is a subagent's ceiling: a parent's `deny` follows its children and
 * **cannot** be overridden downward. It is listed last because it is evaluated
 * last, not because it is the weakest — it is the only layer that wins outright.
 */
export const PERMISSION_LAYERS = ['builtin', 'profile', 'project', 'session', 'inherited'] as const;

export type PermissionLayer = (typeof PERMISSION_LAYERS)[number];

/**
 * The answer, with its reasoning attached.
 *
 * `layer` and `pattern` are not diagnostics that could be dropped later. A user
 * told only "denied" has no way to find which of four layers said so, and a
 * refusal the user cannot locate is a refusal they will work around by widening
 * the broadest rule they can find.
 */
export interface PermissionVerdict {
  action: PermissionAction;
  layer: PermissionLayer;
  /** The glob that matched, or null when the rule was a bare scalar. */
  pattern: string | null;
  /** The permission key the verdict was reached under. */
  key: string;
}

/**
 * Who may select a profile.
 *
 * Independent of `hidden`, which only affects listings. A profile can be
 * selectable and unlisted (a personal shortcut), or listed and subagent-only (a
 * documented worker a parent delegates to but nobody drives directly).
 */
export const PROFILE_VISIBILITIES = ['primary', 'subagent', 'all'] as const;

export type ProfileVisibility = (typeof PROFILE_VISIBILITIES)[number];

/** Reasoning effort a profile asks for, where the provider supports one. */
export const REASONING_VARIANTS = ['low', 'medium', 'high'] as const;

export type ReasoningVariant = (typeof REASONING_VARIANTS)[number];

/**
 * A named bundle of permissions, model preference and prompt.
 *
 * Moved here from `services/code/projectContext.ts` because it stopped being a
 * Code concept: the permission engine lives in the shared loop, so Cowork (and
 * Design when it lands) resolve the same profiles through the same code.
 *
 * `tools` widened from `CodeToolName[]` to `string[]` in that move, and the cost
 * is real — a typo'd tool name is no longer a compile error. It is validated at
 * load time against the agent's registered tool set instead, which is the only
 * check that could ever have covered MCP tools whose names are not known until a
 * server is configured.
 */
export interface AgentProfile {
  /** Front-matter `name`, else the first Markdown heading, else the filename. */
  name: string;
  description: string | null;
  /** Path relative to the project directory. Empty for a built-in. */
  path: string;
  /** Declared tool allowlist, or null for "every tool the agent registers". */
  tools: string[] | null;
  /** Declared model preference, verbatim. */
  model: string | null;
  /** The Ask/Plan/Act gate this profile is a specialization of. */
  mode: AgentMode;
  visibility: ProfileVisibility;
  /** Listing-only. A hidden profile is still resolvable by name. */
  hidden: boolean;
  variant: ReasoningVariant | null;
  permissions: Record<string, PermissionRule> | null;
  /** True for the three in-code profiles, which cannot be deleted or edited. */
  builtin: boolean;
  /** Markdown after front matter, injected into the system prompt. */
  body: string;
}

/** A mutating tool call Plan mode recorded instead of executing. */
export interface PlannedAction {
  toolName: string;
  arguments: string;
  reason: string;
}

/** Result of a long-running agent task. */
export interface TaskResult {
  ok: boolean;
  summary: string;
  /** Files created/modified, for the frontend to render a change list. */
  changedFiles?: string[];
  artifacts?: { key: string; version: number }[];
  /** Mutating actions Plan mode collected for the user to approve. */
  plan?: PlannedAction[];
  error?: { code: string; message: string };
}

export interface TaskInput {
  tool: ToolName;
  chatId: string;
  modelId: string;
  prompt: string;
  mode: AgentMode;
  /** Absolute path, always pre-validated inside the projects scope. */
  cwd?: string;
  /**
   * Nobody is watching this run, so nothing can be acknowledged interactively.
   *
   * A per-*run* property, not a per-module one, and that is the whole reason it
   * lives here. One registered agent instance serves both live HTTP runs and
   * scheduled runs — `scheduler.ts` and `http/agents.ts` call the same
   * `requireAgent` — so "is anyone watching?" cannot be answered at construction
   * time. It was a construction-time dependency before 1.27, which meant it was
   * `undefined` in production and the park paths it guards were unreachable
   * outside tests.
   */
  unattended?: boolean;
  attachments?: { id: string; path: string; filename: string }[];
  options?: Record<string, unknown>;
}

/**
 * Services handed to an agent module. Agents should use these rather than
 * reaching for the database or the network directly — `llm.stream` in
 * particular inherits provider failover and the pause/resume machine for free.
 */
export interface AgentContext {
  /** Stable identity shared by the run, its state, and any handoff surfaces. */
  taskId: string;
  /** Interactive task_runs identity; absent for scheduled/headless runs. */
  runId?: string;
  /** Push an SSE event to the client watching this task. */
  emit(event: string, data: Record<string, unknown>): void;
  /** Streamed completion through the active provider, with failover applied. */
  llm: {
    stream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown>;
    complete(request: CompletionRequest): Promise<{ text: string; usage: TokenUsage }>;
  };
  /** Run a shell command through the registered terminal module. */
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
  /** Read UTF-8 text through this task's project/worktree containment boundary. */
  readFile(path: string): Promise<{ path: string; content: string; sha256: string; bytes: number }>;
  /** Replace UTF-8 text only when the on-disk state still matches the caller's observation. */
  writeFile(input: {
    path: string;
    content: string;
    /** null explicitly means the caller observed that the file did not exist. */
    expectedSha256: string | null;
  }): Promise<{ path: string; sha256: string; version: number }>;
  /** Restore an inline Code snapshot with the same clobber protection as a write. */
  restoreArtifactVersion(input: {
    artifactKey: string;
    version: number;
    path: string;
    expectedSha256: string | null;
  }): Promise<{ path: string; sha256: string | null; version: number }>;
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

/** In-process implementation of one long-running agent tool. */
export interface AgentModule {
  runTask(input: TaskInput, ctx: AgentContext): Promise<TaskResult>;
}

/** Result returned by the in-process terminal executor. */
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

/** Live MCP transport supervision registered for the supervisor's lifetime. */
export interface McpProcessManager {
  /** Live status of every running server, surfaced by GET /api/mcp/status. */
  getStatus(): McpServerStatus[];
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  /** Project-owned tool descriptions; SDK-specific types do not cross this boundary. */
  listTools(name: string): Promise<McpToolDefinition[]>;
  /** Invoke one tool and preserve the MCP server's result/error distinction. */
  callTool(
    name: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallResult>;
  /** Optional live probe used by the test-connection endpoint for stdio servers. */
  testConnection?(name: string): Promise<{ ok: boolean; message: string }>;
}

export interface McpToolDefinition {
  name: string;
  inputSchema: Record<string, unknown>;
  title?: string;
  description?: string;
  outputSchema?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: unknown[];
  structuredContent?: Record<string, unknown>;
  /** A server-declared tool failure is a result, not a manager exception. */
  isError: boolean;
}

export interface McpServerStatus {
  name: string;
  state: 'running' | 'stopped' | 'starting' | 'error';
  pid?: number;
  uptimeMs?: number;
  toolCount?: number;
  lastError?: string;
}
