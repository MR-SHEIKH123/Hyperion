/**
 * The Design agent.
 *
 * Iterative HTML/CSS and SVG generation against the shared agent loop — this
 * module owns Design's prompt and tools, while `runAgentLoop` remains the only
 * control loop and mode gate, exactly as with Code and Cowork. Design does not
 * get its own loop, its own permission path, or its own undo table: revisions
 * are rows in `artifact_versions` (the `design:` key namespace), and the run's
 * undo stack sits on top of them, session-scoped per run.
 *
 * The toolset is closed by construction (see tools.ts): no shell, no project
 * filesystem, no delegation. The only mutation surface is the agent's own
 * artifact lineage and brand proposals that stay unapproved until the user
 * decides.
 *
 * This module deliberately does not register itself. The production
 * composition boundary owns registration so tests and alternate hosts can
 * construct the runner without changing the live module set as a side effect.
 */
import { runAgentLoop } from '../agent/loop.ts';
import { createPermissionResolver } from '../agent/permissions.ts';
import {
  assertKnownTools,
  permissionLayers,
  profileSelector,
  resolveProfile,
} from '../agent/profiles.ts';
import { resolveContextWindow } from '../agent/compaction.ts';
import { contextWindowFallback, contextWindowOverride, findCachedModel } from '../../providers/registry.ts';
import { sessionPermissionRules } from '../../db/approvals.ts';
import { loadConversation } from '../../db/taskMessages.ts';
import { TaskBudget } from '../limits/budget.ts';
import { listApprovedAssets, saveAsset } from '../storage/gallery.ts';
import { toAppError } from '../../util/errors.ts';

import {
  DESIGN_TOOL_NAMES,
  createDesignRunState,
  designToolEffect,
  designToolSchemas,
  dispatchDesignTool,
} from './tools.ts';

import type {
  AgentContext,
  AgentModule,
  ChatMessage,
  ModelInfo,
  PermissionRule,
  TaskInput,
  TaskResult,
  ToolCall,
} from '../../types/core.ts';
import type { DesignToolServices } from './tools.ts';

export interface DesignDependencies extends DesignToolServices {
  resolveProfile?: typeof resolveProfile;
  sessionPermissionRules?: (taskId: string) => Record<string, PermissionRule>;
  resolveContextWindow?: (input: { model?: ModelInfo; override?: number; fallback?: number }) => ReturnType<typeof resolveContextWindow>;
  /** Test seam for the cache-only model lookup; production uses the registry. */
  findModel?: (modelId: string) => ModelInfo | null;
  createBudget?: () => TaskBudget;
  unattended?: boolean;
  iterationCeiling?: number;
}

export interface DesignRunOptions {
  dependencies?: DesignDependencies;
}

function defaultDependencies(): Required<Pick<DesignDependencies, 'listApprovedAssets' | 'saveAsset'>> & DesignDependencies {
  return { listApprovedAssets, saveAsset };
}

/** The canonical brand set, injected at run start — approved rows only. */
function brandBlock(approved: ReturnType<typeof listApprovedAssets>): string {
  if (approved.length === 0) {
    return 'Approved brand assets: none. Nothing is canonical until the user approves an asset.';
  }
  const lines = approved.map((asset) =>
    `- ${asset.filename} (${asset.mimeType ?? 'unknown'}, ${asset.bytes} bytes, id ${asset.id}) — approved ${new Date(asset.brandApprovedAt ?? 0).toISOString()}`,
  );
  return [
    'Approved brand assets (canonical — reference these, never imitate them; call design.brand_read for SVG content):',
    ...lines,
  ].join('\n');
}

function systemPrompt(approved: ReturnType<typeof listApprovedAssets>): string {
  return [
    'You are Design, Hyperion\'s iterative visual-design agent.',
    'You produce complete HTML documents (CSS inline or in <style>) and SVG assets. Work iteratively: generate once, then revise in small described steps. Never regenerate what a revision could change — the version history is the user\'s safety net.',
    `Your toolset is closed: ${DESIGN_TOOL_NAMES.join(', ')}. You cannot run shell commands, read or write project files, or delegate. Do not attempt to.`,
    'Previews are served sandboxed — no scripts, no network, no same-origin — over the localhost API. design.preview_snapshot returns the URL of the current version.',
    'design.vision_verify is a stub and always reports unverified. Never claim you visually checked a draft.',
    'End with a short summary naming the deliverable version (declare it with design.save_asset once the work is finished).',
    brandBlock(approved),
  ].join('\n\n');
}

function summaryFor(text: string, fallback: string): string {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function createDesignAgent(options: DesignRunOptions = {}): AgentModule {
  return {
    runTask: (input, ctx) => runDesignTask(input, ctx, options),
  };
}

export async function runDesignTask(
  input: TaskInput,
  ctx: AgentContext,
  options: DesignRunOptions = {},
): Promise<TaskResult> {
  const deps = { ...defaultDependencies(), ...(options.dependencies ?? {}) };
  const partial: string[] = [];
  let messages: ChatMessage[] = [];
  const runState = createDesignRunState(ctx.runId ?? ctx.taskId);

  try {
    const selector = profileSelector(input);
    const profile = await (deps.resolveProfile ?? resolveProfile)({
      mode: input.mode,
      // An explicit selector always wins. Ask and Plan keep their own
      // built-ins; the design profile is only the default for an Act run —
      // otherwise its Act base mode would quietly widen a restricted run.
      ...(selector !== undefined
        ? { selector }
        : input.mode === 'act'
          ? { selector: 'design' }
          : {}),
    });
    const knownTools = new Set<string>(DESIGN_TOOL_NAMES);
    assertKnownTools(profile, knownTools);
    const declared = profile.tools;
    const schemas = designToolSchemas().filter((schema) => declared === null || declared.includes(schema.name));

    // Like Cowork, Design has no project directory: only the profile and the
    // session layer apply. Pointing at the active checkout would apply a Code
    // project's permission file to a run it was never written for.
    const session = (deps.sessionPermissionRules ?? sessionPermissionRules)(ctx.taskId);
    const permissions = createPermissionResolver({
      layers: permissionLayers({
        profile,
        ...(Object.keys(session).length === 0 ? {} : { session }),
      }),
      knownTools,
    });
    const policy = { effect: designToolEffect };
    // One budget per task run: the loop consults it after each turn, and the
    // turn charges it as usage chunks arrive.
    const budget = (deps.createBudget ?? (() => new TaskBudget(ctx.taskId)))();

    const system = systemPrompt(deps.listApprovedAssets?.() ?? []);
    // See code/agent.ts: a continuation replays the stored conversation but
    // the system prompt is rebuilt — the brand set and the session
    // permissions may both have moved while the task was parked.
    const continued = typeof input.options?.continueTaskId === 'string';
    const restored = continued ? loadConversation(ctx.taskId) : [];
    messages = restored.length === 0
      ? [{ role: 'system', content: system }, { role: 'user', content: input.prompt }]
      : [{ role: 'system', content: system }, ...restored.filter((message) => message.role !== 'system')];

    const runTool = (call: ToolCall): Promise<string> => dispatchDesignTool(call, runState, ctx, deps);

    // The window is the model's real one when a provider cache knows it.
    // Cache-only: a run start must not wait on a network call, and an
    // unknown model keeps the honest `assumed` default.
    const modelInfo = (deps.findModel ?? findCachedModel)(input.modelId);
    const ceiling = contextWindowOverride();
    const fallback = contextWindowFallback();

    const loop = await runAgentLoop({
      runId: ctx.runId,
      taskId: ctx.taskId,
      tool: 'design',
      mode: profile.mode,
      profile,
      permissions,
      policy,
      run: runTool,
      unattended: input.unattended ?? deps.unattended ?? false,
      iterationCeiling: deps.iterationCeiling,
      budget,
      context: {
        messages: () => messages,
        replace: (next) => { messages = [...next]; },
        window: (deps.resolveContextWindow ?? ((value) => resolveContextWindow(value)))({
          ...(modelInfo === null ? {} : { model: modelInfo }),
          // The provider's declared ceiling wins over the model list (1.28), and
          // it is read here, at run start, for the same reason the cache is:
          // neither may wait on the network.
          ...(ceiling === undefined ? {} : { override: ceiling }),
        fallback,
        }),
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
    return {
      ok: loop.completed,
      summary: summaryFor(reply, loop.parked ? `Design paused: ${loop.parked}.` : 'Design completed without a text response.'),
      artifacts: runState.deliverables.length > 0 ? runState.deliverables : undefined,
      plan: loop.plan.length > 0 ? loop.plan : undefined,
    };
  } catch (error) {
    const appError = toAppError(error);
    const partialText = partial.join('').trim();
    return {
      ok: false,
      summary: summaryFor(partialText, 'Design stopped before it could complete.'),
      artifacts: runState.deliverables.length > 0 ? runState.deliverables : undefined,
      error: { code: appError.code, message: appError.message },
    };
  }
}
