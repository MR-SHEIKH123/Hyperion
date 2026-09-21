/**
 * Cowork's knowledge-first agent.
 *
 * This module deliberately does not register itself. The production composition
 * boundary owns registration so tests and alternate hosts can construct the
 * runner without changing the live module set as a side effect.
 *
 * The model receives source status before source content. A missing, unreadable,
 * binary or hash-mismatched file is evidence that the reference library needs
 * attention, not evidence about the user's question.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

import { createLogger } from '../../util/logger.ts';

import { getMcpProcessManager } from '../../orchestrator/agents.ts';
import { findServerByName } from '../mcp/registry.ts';
import { recallForTurn, rememberTurn } from '../memory/index.ts';
import { ScopeViolationError } from '../../security/fsScope.ts';
import {
  knowledgePath,
  listKnowledgeSources,
} from './knowledge.ts';
import { runAgentLoop } from '../agent/loop.ts';
import { createPermissionResolver } from '../agent/permissions.ts';
import { assertKnownTools, permissionLayers, profileSelector, resolveProfile } from '../agent/profiles.ts';
import { sessionPermissionRules } from '../../db/approvals.ts';
import { recordRunKnowledge } from '../../db/runKnowledge.ts';
import { loadConversation } from '../../db/taskMessages.ts';
import { resolveContextWindow } from '../agent/compaction.ts';
import { findCachedModel } from '../../providers/registry.ts';
import { toAppError, AppError } from '../../util/errors.ts';
import { TaskBudget } from '../limits/budget.ts';

import type {
  AgentContext,
  AgentModule,
  ChatMessage,
  McpProcessManager,
  McpServerStatus,
  McpToolDefinition,
  ModelInfo,
  PermissionRule,
  TaskInput,
  TaskResult,
  ToolCall,
  ToolSchema,
} from '../../types/core.ts';
import type { KnowledgeSource } from './knowledge.ts';

const log = createLogger('cowork');

const WIGOLO_NAME = 'wigolo';
const WIGOLO_GUIDANCE = 'Wigolo is unavailable. To set it up, run `npx -y wigolo init`.';
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_TOOL_OUTPUT = 32_000;

export interface CoworkDependencies {
  listKnowledgeSources?: () => readonly KnowledgeSource[];
  readKnowledge?: (source: KnowledgeSource) => Promise<KnowledgeReadResult>;
  recallForTurn?: (prompt: string, tool: 'cowork') => Promise<string | null>;
  rememberTurn?: (prompt: string, reply: string, meta: { tool: 'cowork'; chatId: string }) => void;
  findWigolo?: () => { enabled: boolean } | null;
  getMcpProcessManager?: () => McpProcessManager | null;
  resolveProfile?: typeof resolveProfile;
  sessionPermissionRules?: (taskId: string) => Record<string, PermissionRule>;
  resolveContextWindow?: (input: { model?: ModelInfo; override?: number }) => ReturnType<typeof resolveContextWindow>;
  /** Test seam for the cache-only model lookup; production uses the registry. */
  findModel?: (modelId: string) => ModelInfo | null;
  createBudget?: () => TaskBudget;
  unattended?: boolean;
  iterationCeiling?: number;
}

export interface KnowledgeReadResult {
  status: 'usable' | 'missing' | 'unreadable' | 'binary' | 'unsupported' | 'hash_mismatch';
  text?: string;
  /**
   * The digest of the bytes actually read, and how many there were.
   *
   * Computed for every successful read, not only when the source pins one, because
   * this is the identity a provenance row stores: "this run used *these* bytes" is
   * the only claim worth keeping, and a digest that only exists when someone
   * happened to register one could not make it. `unsupported`/`binary`/`missing`
   * carry neither — nothing was read.
   */
  sha256?: string;
  bytes?: number;
}

export interface CoworkRunOptions {
  dependencies?: CoworkDependencies;
}

interface WigoloState {
  available: boolean;
  enabled: boolean;
  running: boolean;
  manager?: McpProcessManager;
  tools: McpToolDefinition[];
  message: string;
}

interface PreparedKnowledge {
  source: KnowledgeSource;
  result: KnowledgeReadResult;
}

type KnowledgeFileReader = (filename: string) => Promise<Buffer>;

function defaultDependencies(): Required<Pick<CoworkDependencies, 'listKnowledgeSources' | 'recallForTurn' | 'rememberTurn' | 'findWigolo' | 'getMcpProcessManager'>> & CoworkDependencies {
  return {
    listKnowledgeSources,
    recallForTurn,
    rememberTurn,
    findWigolo: () => findServerByName(WIGOLO_NAME),
    getMcpProcessManager,
  };
}

/** Read only verified UTF-8 text through the knowledge scope. */
export async function readKnowledgeSource(
  source: KnowledgeSource,
  readFile?: KnowledgeFileReader,
): Promise<KnowledgeReadResult> {
  let bytes: Buffer;
  try {
    const reader = readFile ?? ((filename: string) => fs.readFile(filename));
    bytes = await reader(knowledgePath(source));
  } catch (error) {
    // A tampered relative path is a security failure, not a missing document.
    if (error instanceof ScopeViolationError) throw error;
    if (isNodeFsError(error) && error.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable' };
  }

  if (bytes.byteLength > MAX_SOURCE_BYTES) return { status: 'unsupported' };
  if (bytes.includes(0)) return { status: 'binary' };

  const digest = createHash('sha256').update(bytes).digest('hex');

  const text = new TextDecoder('utf-8', { fatal: true });
  let decoded: string;
  try {
    decoded = text.decode(bytes);
  } catch {
    return { status: 'binary' };
  }

  if (source.sha256 !== null && digest !== source.sha256) return { status: 'hash_mismatch' };

  const extension = source.filename.toLowerCase().split('.').pop();
  const mime = source.mimeType?.toLowerCase() ?? '';
  const supported =
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/csv' ||
    extension === 'txt' || extension === 'md' || extension === 'markdown' ||
    extension === 'csv' || extension === 'json' || extension === 'xml';
  return supported
    ? { status: 'usable', text: decoded, sha256: digest, bytes: bytes.byteLength }
    : { status: 'unsupported' };
}

function isNodeFsError(error: unknown): error is { code?: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function safeText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value.length > MAX_TOOL_OUTPUT ? `${value.slice(0, MAX_TOOL_OUTPUT)}…` : value;
}

function serialiseToolResult(result: { content: unknown[]; structuredContent?: Record<string, unknown>; isError: boolean }): string {
  const payload = result.structuredContent === undefined
    ? result.content
    : { content: result.content, structuredContent: result.structuredContent };
  const text = safeText(JSON.stringify(payload), 'The MCP tool returned no readable output.');
  return result.isError ? `MCP tool reported an error: ${text}` : text;
}

function runningStatus(manager: McpProcessManager): McpServerStatus | undefined {
  return manager.getStatus().find((status) => status.name.toLowerCase() === WIGOLO_NAME);
}

async function wigoloState(deps: CoworkDependencies): Promise<WigoloState> {
  const configured = (deps.findWigolo ?? defaultDependencies().findWigolo)();
  if (!configured) {
    return { available: false, enabled: false, running: false, tools: [], message: WIGOLO_GUIDANCE };
  }
  if (!configured.enabled) {
    return { available: true, enabled: false, running: false, tools: [], message: 'Wigolo is configured but disabled. Enable it in MCP settings; Cowork will not start it automatically.' };
  }

  const manager = (deps.getMcpProcessManager ?? defaultDependencies().getMcpProcessManager)();
  if (!manager) {
    return { available: true, enabled: true, running: false, tools: [], message: 'Wigolo is enabled but its MCP supervisor is unavailable. Cowork will not start it.' };
  }
  const status = runningStatus(manager);
  if (!status || status.state !== 'running') {
    return { available: true, enabled: true, running: false, tools: [], message: 'Wigolo is enabled but not running. Start it from MCP supervision; Cowork will not spawn it.' };
  }
  const tools = await manager.listTools(WIGOLO_NAME);
  return { available: true, enabled: true, running: true, manager, tools, message: `Wigolo is live with ${tools.length} supervised tool(s).` };
}

function sourceLabel(source: KnowledgeSource): string {
  return source.label?.trim() || source.filename;
}

function knowledgeBlock(prepared: readonly PreparedKnowledge[]): string {
  const lines = ['Knowledge sources (only entries marked usable are evidence):'];
  for (const item of prepared) {
    const label = sourceLabel(item.source);
    if (item.result.status === 'usable') {
      lines.push(`\n--- ${label} (${item.source.filename}) ---\n${item.result.text ?? ''}`);
    } else {
      lines.push(`- ${label}: ${item.result.status}; not used as evidence.`);
    }
  }
  return lines.join('\n');
}

function toolSchemas(tools: readonly McpToolDefinition[]): ToolSchema[] {
  return [
    {
      name: 'cowork.save_artifact',
      description: 'Save confirmed Markdown or CSV content as a versioned artifact.',
      parameters: {
        type: 'object',
        required: ['format', 'artifactKey', 'content'],
        properties: {
          format: { type: 'string', enum: ['markdown', 'csv'] },
          artifactKey: { type: 'string', minLength: 1 },
          content: { type: 'string' },
          label: { type: 'string' },
          relPath: { type: 'string' },
        },
      },
    },
    ...tools.map((tool) => ({
      name: `wigolo.${tool.name}`,
      description: tool.description ?? tool.title ?? `Wigolo tool ${tool.name}`,
      parameters: tool.inputSchema,
    })),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArguments(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AppError('bad_request', 'The model produced invalid JSON tool arguments.');
  }
  if (!isRecord(value)) throw new AppError('bad_request', 'Tool arguments must be a JSON object.');
  return value;
}

function summaryFor(text: string, fallback: string): string {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function createCoworkAgent(options: CoworkRunOptions = {}): AgentModule {
  return {
    runTask: (input, ctx) => runCoworkTask(input, ctx, options),
  };
}

export async function runCoworkTask(
  input: TaskInput,
  ctx: AgentContext,
  options: CoworkRunOptions = {},
): Promise<TaskResult> {
  const supplied = options.dependencies ?? {};
  const deps = { ...defaultDependencies(), ...supplied };
  const partial: string[] = [];
  const artifacts: { key: string; version: number }[] = [];
  let messages: ChatMessage[] = [];

  try {
    const sources = [...(deps.listKnowledgeSources?.() ?? [])];
    const prepared = await Promise.all(sources.map(async (source) => ({
      source,
      result: await (deps.readKnowledge ?? readKnowledgeSource)(source),
    })));
    // Provenance (1.39 A6): record the sources this run is about to be given as
    // evidence — the usable ones, which is what the prompt's own header promises
    // ("only entries marked usable are evidence"). Best-effort on purpose: a run
    // whose answer is already computed must not fail because a history row could
    // not be written.
    try {
      // A run with no id has nowhere to hang the record; the route always starts
      // one, and a test calling the agent directly may not, which is not a reason
      // to fail the run.
      if (ctx.runId !== undefined) recordRunKnowledge(
        ctx.runId,
        prepared
          .filter((item) => item.result.status === 'usable')
          .map((item) => ({
            sourceId: item.source.id,
            label: item.source.label,
            filename: item.source.filename,
            bytes: item.result.bytes ?? null,
            sha256: item.result.sha256 ?? null,
          })),
      );
    } catch (error) {
      log.warn('could not record the knowledge sources this run used', error);
    }

    const memory = await (deps.recallForTurn ?? recallForTurn)(input.prompt, 'cowork');
    const wigolo = await wigoloState(deps);
    const system = [
      'You are Cowork, a knowledge-first research and productivity agent.',
      'Use only confirmed usable knowledge text as source evidence. Never infer facts from unavailable source status.',
      knowledgeBlock(prepared),
      memory ?? 'No relevant memory was available for this turn.',
      `Wigolo status: ${wigolo.message}`,
      'Do not claim Wigolo ran unless a live supervised tool returned a result.',
      'Save an artifact only when the user requested or clearly confirmed it, and only as Markdown or CSV.',
    ].join('\n\n');
    // See code/agent.ts: a continuation replays the stored conversation but the
    // system prompt is rebuilt, because the knowledge library, Wigolo's status and
    // the session permissions may all have moved while the task was parked.
    const continued = typeof input.options?.continueTaskId === 'string';
    const restored = continued ? loadConversation(ctx.taskId) : [];
    messages = restored.length === 0
      ? [{ role: 'system', content: system }, { role: 'user', content: input.prompt }]
      : [{ role: 'system', content: system }, ...restored.filter((message) => message.role !== 'system')];

    const manager = wigolo.manager ?? null;
    const schemas = toolSchemas(wigolo.tools);
    const policy = {
      effect: (name: string) => name === 'cowork.save_artifact' ? 'mutate' as const : name.startsWith('wigolo.') ? 'read' as const : undefined,
    };

    // Cowork has no project directory, so only the built-ins and the session
    // layer are in play. `hasProjectFiles` is deliberately not faked: a resolver
    // pointed at the active checkout would apply a *Code* project's permission
    // file to a Cowork run, which is a rule the user never wrote for it.
    const profile = await (deps.resolveProfile ?? resolveProfile)({
      mode: input.mode,
      ...(profileSelector(input) === undefined ? {} : { selector: profileSelector(input) }),
    });
    const knownTools = new Set(schemas.map((schema) => schema.name));
    assertKnownTools(profile, knownTools);
    const session = (deps.sessionPermissionRules ?? sessionPermissionRules)(ctx.taskId);
    const permissions = createPermissionResolver({
      layers: permissionLayers({
        profile,
        ...(Object.keys(session).length === 0 ? {} : { session }),
      }),
      knownTools,
    });
    // One budget per task run: the loop consults it after each turn, and the
    // turn charges it as usage chunks arrive.
    const budget = (deps.createBudget ?? (() => new TaskBudget(ctx.taskId)))();

    const runTool = async (call: ToolCall): Promise<string> => {
      const args = parseArguments(call.arguments);
      if (call.name === 'cowork.save_artifact') {
        const format = args.format;
        const artifactKey = args.artifactKey;
        const content = args.content;
        if ((format !== 'markdown' && format !== 'csv') || typeof artifactKey !== 'string' || artifactKey.trim() === '' || typeof content !== 'string') {
          throw new AppError('bad_request', 'Artifact requires format markdown or csv, an artifact key, and text content.');
        }
        const saved = ctx.saveArtifactVersion({
          artifactKey: artifactKey.trim(),
          tool: 'cowork',
          content,
          ...(typeof args.relPath === 'string' ? { relPath: args.relPath } : {}),
          ...(typeof args.label === 'string' ? { label: args.label } : {}),
        });
        artifacts.push({ key: artifactKey.trim(), version: saved.version });
        ctx.emit('artifact', { artifactKey: artifactKey.trim(), version: saved.version, format });
        return `Saved ${format} artifact ${artifactKey.trim()} version ${saved.version}.`;
      }
      if (!call.name.startsWith('wigolo.') || !manager) {
        throw new AppError('capability_disabled', 'Wigolo is unavailable, disabled, or not running; no tool was called.');
      }
      const actualName = call.name.slice('wigolo.'.length);
      const result = await manager.callTool(WIGOLO_NAME, actualName, args);
      return serialiseToolResult(result);
    };

    // The window is the model's real one when a provider cache knows it.
    // Cache-only: a run start must not wait on a network call, and an
    // unknown model keeps the honest `assumed` default.
    const modelInfo = (deps.findModel ?? findCachedModel)(input.modelId);

    const loop = await runAgentLoop({
      runId: ctx.runId,
      taskId: ctx.taskId,
      tool: 'cowork',
      mode: profile.mode,
      profile,
      permissions,
      policy,
      run: runTool,
      // `input.unattended` first: it is a per-run fact. `deps.unattended` is
      // retained only as a test override, which is why it loses — before 1.27 it
      // was the only source, and production never set it.
      unattended: input.unattended ?? deps.unattended ?? false,
      iterationCeiling: deps.iterationCeiling,
      budget,
      context: {
        messages: () => messages,
        replace: (next) => { messages = [...next]; },
        window: (deps.resolveContextWindow ?? ((value) => resolveContextWindow(value)))(
          modelInfo === null ? {} : { model: modelInfo },
        ),
      },
      turn: async (feedback) => {
        for (const item of feedback) {
          messages.push({ role: 'tool', content: item.output, toolCallId: item.call.id, name: item.call.name });
        }
        let text = '';
        const calls: ToolCall[] = [];
        for await (const chunk of ctx.llm.stream({
          modelId: input.modelId,
          messages,
          signal: ctx.signal,
          ...(profile.variant === null ? {} : { reasoningEffort: profile.variant }),
          ...(schemas.length > 0 ? { tools: schemas, toolChoice: 'auto' as const } : {}),
        })) {
          if (chunk.type === 'token') {
            text += chunk.text;
            partial.push(chunk.text);
            ctx.emit('partial', { text: chunk.text });
          } else if (chunk.type === 'tool_call') {
            calls.push(chunk.call);
          } else if (chunk.type === 'usage') {
            // The charge is the accounting; the loop decides on a trip.
            budget.charge(chunk.usage.tokensIn, chunk.usage.tokensOut);
          }
        }
        messages.push({ role: 'assistant', content: text, ...(calls.length > 0 ? { toolCalls: calls } : {}) });
        return calls;
      },
    }, ctx);

    const reply = messages.filter((message) => message.role === 'assistant').at(-1)?.content ?? partial.join('');
    if (loop.completed) (deps.rememberTurn ?? rememberTurn)(input.prompt, reply, { tool: 'cowork', chatId: input.chatId });
    return {
      ok: loop.completed,
      summary: summaryFor(reply, loop.parked ? `Cowork paused: ${loop.parked}.` : 'Cowork completed without a text response.'),
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      plan: loop.plan.length > 0 ? loop.plan : undefined,
    };
  } catch (error) {
    const appError = toAppError(error);
    const partialText = partial.join('').trim();
    return {
      ok: false,
      summary: summaryFor(partialText, 'Cowork stopped before it could complete.'),
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      error: { code: appError.code, message: appError.message },
    };
  }
}
