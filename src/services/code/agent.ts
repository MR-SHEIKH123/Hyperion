/**
 * Production Code agent.
 *
 * The adapter owns Code's prompt and tools, while `runAgentLoop` remains the
 * only control loop and mode gate. File and terminal operations stay behind the
 * AgentContext closures established for the parent task worktree. Delegated
 * children inherit those closures and cancellation signal but omit `runId`, so
 * their tool turns do not become parent task-step transcripts; the bounded
 * `subagent_runs` lifecycle is their durable record.
 */
import { randomUUID } from 'node:crypto';

import { finishSubagentRun, startSubagentRun } from '../../db/subagents.ts';
import { sessionPermissionRules } from '../../db/approvals.ts';
import { loadConversation } from '../../db/taskMessages.ts';
import { runAgentLoop } from '../agent/loop.ts';
import { createPermissionResolver } from '../agent/permissions.ts';
import { assertKnownTools, permissionLayers, profileSelector, resolveProfile } from '../agent/profiles.ts';
import { resolveContextWindow } from '../agent/compaction.ts';
import { assertWithinSpendCap, TaskBudget } from '../limits/budget.ts';
import {
  loadAgentProfile,
  loadProjectPermissions,
  loadProjectProfiles,
  loadProjectRules,
  resolveDeclaredCommand,
} from './projectContext.ts';
import { AppError, toAppError } from '../../util/errors.ts';

import type {
  AgentContext,
  AgentModule,
  AgentProfile,
  ChatMessage,
  CommandResult,
  ModelInfo,
  PermissionRule,
  TaskInput,
  TaskResult,
  ToolCall,
  ToolSchema,
} from '../../types/core.ts';
import type {
  CodeToolName,
  DeclaredCommand,
  ProjectContextResolver,
  RuntimeRules,
} from './projectContext.ts';

const MAX_TOOL_OUTPUT = 32_000;
const MAX_SUMMARY = 4_000;
const ALL_TOOLS: readonly CodeToolName[] = [
  'read',
  'write',
  'restore',
  'bash',
  'command',
  'delegate',
];

export interface CodeDependencies {
  loadProjectRules?: (
    projectDir: string,
    relevantPaths: string[],
    resolver: ProjectContextResolver,
  ) => Promise<RuntimeRules>;
  loadAgentProfile?: (
    projectDir: string,
    selector: string,
    resolver: ProjectContextResolver,
  ) => Promise<AgentProfile>;
  loadProjectProfiles?: (
    projectDir: string,
    resolver: ProjectContextResolver,
  ) => Promise<AgentProfile[]>;
  loadProjectPermissions?: (
    projectDir: string,
    resolver: ProjectContextResolver,
  ) => Promise<Record<string, PermissionRule>>;
  resolveProfile?: typeof resolveProfile;
  sessionPermissionRules?: (taskId: string) => Record<string, PermissionRule>;
  resolveDeclaredCommand?: (
    projectDir: string,
    selector: string,
    resolver: ProjectContextResolver,
  ) => Promise<DeclaredCommand>;
  createBudget?: (taskId: string) => TaskBudget;
  assertWithinSpendCap?: typeof assertWithinSpendCap;
  startSubagentRun?: typeof startSubagentRun;
  finishSubagentRun?: typeof finishSubagentRun;
  resolveContextWindow?: (input: { model?: ModelInfo; override?: number }) => ReturnType<typeof resolveContextWindow>;
  unattended?: boolean;
  iterationCeiling?: number;
}

export interface CodeRunOptions {
  dependencies?: CodeDependencies;
}

interface SharedRunState {
  parentTaskId: string;
  budget: TaskBudget;
  nextSequence: number;
  changedFiles: Set<string>;
  artifacts: { key: string; version: number }[];
}

interface InternalRun {
  depth: 0 | 1;
  shared: SharedRunState;
  dependencies: RequiredCodeDependencies;
}

type RequiredCodeDependencies = Required<Pick<CodeDependencies,
  | 'loadProjectRules'
  | 'loadAgentProfile'
  | 'loadProjectProfiles'
  | 'loadProjectPermissions'
  | 'resolveProfile'
  | 'sessionPermissionRules'
  | 'resolveDeclaredCommand'
  | 'createBudget'
  | 'assertWithinSpendCap'
  | 'startSubagentRun'
  | 'finishSubagentRun'
>> & CodeDependencies;

function defaultDependencies(): RequiredCodeDependencies {
  return {
    loadProjectRules,
    loadAgentProfile,
    loadProjectProfiles,
    loadProjectPermissions,
    resolveProfile,
    sessionPermissionRules,
    resolveDeclaredCommand,
    createBudget: (taskId) => new TaskBudget(taskId),
    assertWithinSpendCap,
    startSubagentRun,
    finishSubagentRun,
  };
}

export function createCodeAgent(options: CodeRunOptions = {}): AgentModule {
  return { runTask: (input, ctx) => runCodeTask(input, ctx, options) };
}

export async function runCodeTask(
  input: TaskInput,
  ctx: AgentContext,
  options: CodeRunOptions = {},
): Promise<TaskResult> {
  const dependencies = { ...defaultDependencies(), ...(options.dependencies ?? {}) };
  const shared: SharedRunState = {
    parentTaskId: ctx.taskId,
    budget: dependencies.createBudget(ctx.taskId),
    nextSequence: 1,
    changedFiles: new Set<string>(),
    artifacts: [],
  };
  return runCodeInternal(input, ctx, { depth: 0, shared, dependencies });
}

async function runCodeInternal(
  input: TaskInput,
  ctx: AgentContext,
  runtime: InternalRun,
): Promise<TaskResult> {
  const partial: string[] = [];
  let messages: ChatMessage[] = [];
  const continued = optionFlag(input.options, 'continueTaskId');

  try {
    const projectRoot = ctx.resolvePath('.');
    const relevantPaths = optionStringArray(input.options, 'relevantPaths');
    const rules = await runtime.dependencies.loadProjectRules(projectRoot, relevantPaths, ctx.resolvePath);

    // The profile is resolved before anything is offered to the model, because it
    // decides what the tool list even contains. Resolving it later would mean
    // describing tools the profile withholds.
    const profile = await runtime.dependencies.resolveProfile({
      mode: input.mode,
      ...(profileSelector(input) === undefined ? {} : { selector: profileSelector(input) }),
      source: {
        load: (selector) => runtime.dependencies.loadAgentProfile(projectRoot, selector, ctx.resolvePath),
        list: () => runtime.dependencies.loadProjectProfiles(projectRoot, ctx.resolvePath),
      },
      forSubagent: runtime.depth === 1,
    });
    const knownTools = new Set<string>(ALL_TOOLS);
    assertKnownTools(profile, knownTools);

    const allowed = allowedTools(profile, runtime.depth);
    const schemas = toolSchemas(allowed);
    const system = systemPrompt(ctx, rules, profile, runtime.depth, allowed);

    // A continuation replays the stored conversation rather than starting a new
    // one. The **system prompt is rebuilt**, not restored, and deliberately so:
    // the profile, project rules and session permissions may all have changed
    // while the task was parked, and that change is usually the reason the user
    // continued it. Replaying a stale system message would resume under exactly
    // the rules that stopped the run.
    const restored = continued ? loadConversation(ctx.taskId) : [];
    messages = restored.length === 0
      ? [{ role: 'system', content: system }, { role: 'user', content: input.prompt }]
      : [{ role: 'system', content: system }, ...restored.filter((message) => message.role !== 'system')];

    const project = await runtime.dependencies.loadProjectPermissions(projectRoot, ctx.resolvePath);
    const session = runtime.dependencies.sessionPermissionRules(runtime.shared.parentTaskId);
    const permissions = createPermissionResolver({
      layers: permissionLayers({
        profile,
        ...(Object.keys(project).length === 0 ? {} : { project }),
        ...(Object.keys(session).length === 0 ? {} : { session }),
      }),
      knownTools: new Set(allowed),
    });

    const policy = {
      effect: (name: string) => name === 'read'
        ? 'read' as const
        : ALL_TOOLS.includes(name as CodeToolName)
          ? 'mutate' as const
          : undefined,
    };

    const runTool = async (call: ToolCall): Promise<string> => {
      if (!allowed.has(call.name as CodeToolName)) {
        throw new AppError('capability_disabled', `The selected Code profile does not allow the ${call.name} tool.`, {
          details: { tool: call.name },
        });
      }
      const args = parseArguments(call.arguments);
      switch (call.name) {
        case 'read': {
          const file = await ctx.readFile(requiredString(args, 'path'));
          return bounded(`${JSON.stringify({ path: file.path, sha256: file.sha256, bytes: file.bytes })}\n${file.content}`);
        }
        case 'write': {
          const expectedSha256 = nullableSha(args.expectedSha256, 'expectedSha256');
          const saved = await ctx.writeFile({
            path: requiredString(args, 'path'),
            content: requiredString(args, 'content', true),
            expectedSha256,
          });
          runtime.shared.changedFiles.add(saved.path);
          const key = artifactKey(runtime.shared.parentTaskId, saved.path);
          runtime.shared.artifacts.push({ key, version: saved.version });
          return JSON.stringify({ ...saved, artifactKey: key });
        }
        case 'restore': {
          const restored = await ctx.restoreArtifactVersion({
            artifactKey: requiredString(args, 'artifactKey'),
            version: positiveInteger(args.version, 'version'),
            path: requiredString(args, 'path'),
            expectedSha256: nullableSha(args.expectedSha256, 'expectedSha256'),
          });
          runtime.shared.changedFiles.add(restored.path);
          runtime.shared.artifacts.push({ key: requiredString(args, 'artifactKey'), version: restored.version });
          return JSON.stringify(restored);
        }
        case 'bash': {
          const result = await ctx.executeCommand(
            optionalString(args.cwd, 'cwd') ?? '.',
            requiredString(args, 'command'),
            commandOptions(args.timeoutMs),
          );
          return commandResult(result);
        }
        case 'command': {
          const declared = await runtime.dependencies.resolveDeclaredCommand(
            projectRoot,
            requiredString(args, 'selector'),
            ctx.resolvePath,
          );
          const result = await ctx.executeCommand(
            optionalString(args.cwd, 'cwd') ?? '.',
            declared.run,
            declared.timeoutMs === null ? undefined : { timeoutMs: declared.timeoutMs },
          );
          return commandResult(result);
        }
        case 'delegate':
          return delegate(requiredString(args, 'prompt'), input, ctx, runtime);
        default:
          throw new AppError('bad_request', `Unknown Code tool: ${call.name}.`, {
            details: { tool: call.name },
          });
      }
    };

    const loop = await runAgentLoop({
      ...(runtime.depth === 0 && ctx.runId !== undefined ? { runId: ctx.runId } : {}),
      taskId: ctx.taskId,
      tool: 'code',
      mode: profile.mode,
      profile,
      permissions,
      policy,
      run: runTool,
      // See cowork/agent.ts: the per-run flag wins, and the dependency survives
      // only as a test override.
      unattended: input.unattended ?? runtime.dependencies.unattended ?? false,
      iterationCeiling: runtime.dependencies.iterationCeiling,
      context: {
        messages: () => messages,
        replace: (next) => { messages = [...next]; },
        window: (runtime.dependencies.resolveContextWindow ?? resolveContextWindow)({}),
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
          // Carried per profile, so switching profiles mid-task switches the
          // reasoning level with it rather than leaving the previous one in force.
          ...(profile.variant === null ? {} : { reasoningEffort: profile.variant }),
          ...(schemas.length === 0 ? {} : { tools: schemas, toolChoice: 'auto' as const }),
        })) {
          if (chunk.type === 'token') {
            text += chunk.text;
            partial.push(chunk.text);
            ctx.emit('partial', { text: chunk.text, ...(runtime.depth === 0 ? {} : { childTaskId: ctx.taskId }) });
          } else if (chunk.type === 'tool_call') {
            calls.push(chunk.call);
          }
        }
        messages.push({ role: 'assistant', content: text, ...(calls.length === 0 ? {} : { toolCalls: calls }) });
        return calls;
      },
    }, ctx);

    const reply = messages.filter((message) => message.role === 'assistant').at(-1)?.content ?? partial.join('');
    return {
      ok: loop.completed,
      summary: summaryFor(reply, loop.parked ? `Code paused: ${loop.parked}.` : 'Code completed without a text response.'),
      changedFiles: runtime.shared.changedFiles.size === 0 ? undefined : [...runtime.shared.changedFiles],
      artifacts: runtime.shared.artifacts.length === 0 ? undefined : [...runtime.shared.artifacts],
      plan: loop.plan.length === 0 ? undefined : loop.plan,
    };
  } catch (error) {
    const appError = toAppError(error);
    return {
      ok: false,
      summary: summaryFor(partial.join(''), 'Code stopped before it could complete.'),
      changedFiles: runtime.shared.changedFiles.size === 0 ? undefined : [...runtime.shared.changedFiles],
      artifacts: runtime.shared.artifacts.length === 0 ? undefined : [...runtime.shared.artifacts],
      error: { code: appError.code, message: appError.message },
    };
  }
}

async function delegate(
  prompt: string,
  parentInput: TaskInput,
  parentCtx: AgentContext,
  runtime: InternalRun,
): Promise<string> {
  if (runtime.depth !== 0) {
    throw new AppError('capability_disabled', 'Delegated Code agents cannot delegate again.');
  }

  const sequence = runtime.shared.nextSequence;
  runtime.dependencies.assertWithinSpendCap('autonomous', `Code subagent ${sequence}`);
  runtime.shared.budget.claimSubagent();
  runtime.shared.nextSequence += 1;

  const childTaskId = randomUUID();
  const persisted = runtime.dependencies.startSubagentRun({
    ...(parentCtx.runId === undefined ? {} : { parentRunId: parentCtx.runId }),
    parentTaskId: runtime.shared.parentTaskId,
    childTaskId,
    sequence,
    prompt,
  });
  parentCtx.emit('subagent_started', { childTaskId, sequence });

  const childCtx = childContext(parentCtx, childTaskId);
  const childInput: TaskInput = {
    ...parentInput,
    tool: 'code',
    prompt,
    mode: 'act',
  };

  let result: TaskResult;
  try {
    result = await runCodeInternal(childInput, childCtx, { ...runtime, depth: 1 });
  } catch (error) {
    const appError = toAppError(error);
    runtime.dependencies.finishSubagentRun(persisted.id, appError.code === 'aborted' ? 'stopped' : 'error', appError.code === 'aborted'
      ? { summary: bounded(appError.message, MAX_SUMMARY) }
      : { errorCode: appError.code, errorMessage: bounded(appError.message, 1_000) });
    throw error;
  }

  const summary = bounded(result.summary, MAX_SUMMARY);
  if (result.ok) {
    runtime.dependencies.finishSubagentRun(persisted.id, 'complete', { summary });
  } else if (result.error?.code === 'aborted') {
    runtime.dependencies.finishSubagentRun(persisted.id, 'stopped', { summary });
  } else {
    runtime.dependencies.finishSubagentRun(persisted.id, 'error', {
      summary,
      errorCode: result.error?.code ?? 'internal_error',
      errorMessage: bounded(result.error?.message ?? 'The subagent stopped without completing.', 1_000),
    });
  }
  parentCtx.emit('subagent_finished', { childTaskId, sequence, ok: result.ok });
  return bounded(JSON.stringify({ childTaskId, sequence, ok: result.ok, summary, error: result.error }));
}

function childContext(parent: AgentContext, childTaskId: string): AgentContext {
  return {
    taskId: childTaskId,
    emit: (event, data) => parent.emit(event, { ...data, childTaskId }),
    llm: parent.llm,
    executeCommand: parent.executeCommand,
    saveArtifactVersion: parent.saveArtifactVersion,
    readFile: parent.readFile,
    writeFile: parent.writeFile,
    restoreArtifactVersion: parent.restoreArtifactVersion,
    getSkillsSummary: parent.getSkillsSummary,
    resolvePath: parent.resolvePath,
    signal: parent.signal,
    log: parent.log,
  };
}

/**
 * Restrict Code's tool set to what the profile declares and the depth allows.
 *
 * Two separate mechanisms, deliberately: the profile's list decides *which* tools
 * are offered at all, and the permission engine decides whether an offered call
 * may run. A tool absent from the schema list is never described to the model; a
 * tool present but denied produces a refusal the model can read and react to.
 * Collapsing the two would either hide the reason for a refusal or advertise a
 * tool that can never work.
 *
 * The `delegate` strip at depth 1 stays structural. `delegate()` also throws
 * (see there), and Phase 3 additionally expresses it as an `inherited` deny so it
 * appears in provenance — three layers for one rule, because a subagent that can
 * delegate is unbounded recursion and the failure mode is a fork bomb.
 */
function allowedTools(profile: AgentProfile, depth: 0 | 1): Set<CodeToolName> {
  const declared = profile.tools;
  const tools = declared === null
    ? ALL_TOOLS
    : ALL_TOOLS.filter((tool) => declared.includes(tool));
  return new Set(tools.filter((tool) => depth === 0 || tool !== 'delegate'));
}

function systemPrompt(
  ctx: AgentContext,
  rules: RuntimeRules,
  profile: AgentProfile,
  depth: 0 | 1,
  allowed: ReadonlySet<CodeToolName>,
): string {
  const ruleText = rules.rules.length === 0
    ? 'No project rules apply to this task.'
    : rules.rules.map((rule) => `--- ${rule.name} (${rule.path}) ---\n${rule.body}`).join('\n\n');
  const profileText = [
    `Active agent profile: ${profile.name}${profile.builtin ? ' (built-in)' : ` (${profile.path})`}` +
      `${profile.model ? `; preferred model: ${profile.model}` : ''}.`,
    profile.body,
  ]
    .filter((part) => part.trim() !== '')
    .join('\n');
  const skills = ctx.getSkillsSummary();
  const skillText = skills.length === 0
    ? 'No registered skills are available.'
    : `Registered skills:\n${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')}`;
  return [
    depth === 0
      ? 'You are Code, Hyperion’s production software-engineering agent.'
      : 'You are a one-level Code subagent working inside the parent task workspace.',
    'Work only through the offered tools. Read before writing and preserve observed SHA-256 values for clobber-safe edits.',
    'A declared command executes only its frontmatter run: value; Markdown command bodies are instructions, never shell text.',
    depth === 0
      ? 'Delegate only a focused bounded subtask. A child shares this workspace and cannot delegate again.'
      : 'You cannot delegate. Return a concise terminal summary to the parent.',
    `Allowed tools: ${[...allowed].join(', ') || 'none'}.`,
    `Project rules source: ${rules.source}.\n${ruleText}`,
    profileText,
    skillText,
  ].join('\n\n');
}

function toolSchemas(allowed: ReadonlySet<CodeToolName>): ToolSchema[] {
  const schemas: Record<CodeToolName, ToolSchema> = {
    read: {
      name: 'read',
      description: 'Read one UTF-8 file in the task workspace and return its SHA-256.',
      parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } } },
    },
    write: {
      name: 'write',
      description: 'Clobber-safe UTF-8 file replacement. expectedSha256 is the hash previously read, or null for an observed absence.',
      parameters: {
        type: 'object',
        required: ['path', 'content', 'expectedSha256'],
        properties: {
          path: { type: 'string', minLength: 1 },
          content: { type: 'string' },
          expectedSha256: { anyOf: [{ type: 'string', pattern: '^[a-fA-F0-9]{64}$' }, { type: 'null' }] },
        },
      },
    },
    restore: {
      name: 'restore',
      description: 'Restore an inline Code file snapshot without clobbering newer work.',
      parameters: {
        type: 'object',
        required: ['artifactKey', 'version', 'path', 'expectedSha256'],
        properties: {
          artifactKey: { type: 'string', minLength: 1 },
          version: { type: 'integer', minimum: 1 },
          path: { type: 'string', minLength: 1 },
          expectedSha256: { anyOf: [{ type: 'string', pattern: '^[a-fA-F0-9]{64}$' }, { type: 'null' }] },
        },
      },
    },
    bash: {
      name: 'bash',
      description: 'Run a shell command through Hyperion’s capability, scope, timeout, cancellation, and output guards.',
      parameters: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', minLength: 1 },
          cwd: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 1 },
        },
      },
    },
    command: {
      name: 'command',
      description: 'Run a project-declared command by selector. Only frontmatter run: is executable.',
      parameters: {
        type: 'object',
        required: ['selector'],
        properties: { selector: { type: 'string', minLength: 1 }, cwd: { type: 'string' } },
      },
    },
    delegate: {
      name: 'delegate',
      description: 'Run one focused subtask in a bounded one-level child sharing this task workspace.',
      parameters: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string', minLength: 1, maxLength: 16000 } } },
    },
  };
  return ALL_TOOLS.filter((tool) => allowed.has(tool)).map((tool) => schemas[tool]);
}

function parseArguments(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AppError('bad_request', 'The model produced invalid JSON tool arguments.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('bad_request', 'Tool arguments must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function requiredString(args: Record<string, unknown>, field: string, allowEmpty = false): string {
  const value = args[field];
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new AppError('bad_request', `${field} must be a${allowEmpty ? '' : ' non-empty'} string.`, { details: { field } });
  }
  return allowEmpty ? value : value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('bad_request', `${field} must be a non-empty string.`, { details: { field } });
  }
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new AppError('bad_request', `${field} must be a positive integer.`, { details: { field } });
  }
  return value;
}

function nullableSha(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new AppError('bad_request', `${field} must be a SHA-256 hash or null.`, { details: { field } });
  }
  return value.toLowerCase();
}

function commandOptions(value: unknown): { timeoutMs?: number } | undefined {
  if (value === undefined || value === null) return undefined;
  return { timeoutMs: positiveInteger(value, 'timeoutMs') };
}

/** True when the option is present as a non-empty string. */
function optionFlag(options: Record<string, unknown> | undefined, field: string): boolean {
  const value = options?.[field];
  return typeof value === 'string' && value.trim() !== '';
}

function optionStringArray(options: Record<string, unknown> | undefined, field: string): string[] {
  const value = options?.[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AppError('bad_request', `options.${field} must be an array of strings.`, { details: { field: `options.${field}` } });
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new AppError('bad_request', `options.${field}[${index}] must be a non-empty string.`, {
        details: { field: `options.${field}[${index}]` },
      });
    }
    return item.trim();
  });
}

function commandResult(result: CommandResult): string {
  return bounded(JSON.stringify(result));
}

function artifactKey(taskId: string, path: string): string {
  return `code:file:${taskId}:${path}`;
}

function bounded(text: string, maximum = MAX_TOOL_OUTPUT): string {
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function summaryFor(text: string, fallback: string): string {
  const summary = text.trim() || fallback;
  return bounded(summary, MAX_SUMMARY);
}