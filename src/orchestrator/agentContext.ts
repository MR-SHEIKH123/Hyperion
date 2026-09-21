/**
 * Builds the AgentContext handed to agent modules (`code`, `cowork`, `design`).
 *
 * Each agent implements only `runTask(input, ctx)`, so constructing a fully
 * wired `ctx` is this file's job: LLM access through the failover router,
 * sandboxed filesystem paths, shell execution through the registered terminal
 * module, artifact versioning, and SSE progress events. Production composes
 * Cowork and Code; Design remains an optional registry entry.
 */
import { executeCommand as runCommand } from './agents.ts';
import { complete as routerComplete, stream as routerStream } from '../providers/router.ts';
import { recordUsage } from '../db/usage.ts';
import { zdrRequirement } from '../db/settings.ts';
import { zdrStatusFor } from '../services/safety/zdr.ts';
import { resolveInScope } from '../security/fsScope.ts';
import { containAgentCwd } from '../services/code/worktree.ts';
import {
  readCodeFile,
  restoreArtifactVersion as restoreCodeArtifactVersion,
  saveArtifactVersion as persistArtifactVersion,
  writeCodeFile,
} from '../services/code/files.ts';
import { skillsAvailableTo } from '../services/plugins/consumers.ts';
import { createLogger } from '../util/logger.ts';
import type { SseStream } from './sse.ts';
import type {
  AgentContext,
  CommandResult,
  CompletionRequest,
  ProviderRecord,
  StreamChunk,
  TokenUsage,
  ToolName,
} from '../types/core.ts';

export interface AgentContextInput {
  tool: ToolName;
  chatId: string;
  modelId: string;
  sse: SseStream;
  cwd?: string;
  /** Stable identity for state, cancellation, terminal handoff, and artifacts. */
  taskId: string;
  /**
   * Interactive task_runs identity.
   *
   * Scheduled runs used to omit it, which meant `parkRun` skipped both the state
   * write and the step row and a scheduled park was invisible. Since 1.27 the
   * scheduler allocates a `task_runs` row and passes it, so this is optional only
   * for a genuinely row-less caller.
   */
  runId?: string;
  /**
   * A second reason to stop, independent of the browser. `sse.signal` fires only
   * on disconnect, so cancelling through it would mean closing the very stream
   * that still has to deliver the `stopped` frame and whatever partial work was
   * done. Passing cancellation in separately keeps the channel open while the
   * work unwinds; the two are combined below rather than replacing each other,
   * because a disconnect must still abort an in-flight request as it always has.
   */
  cancelSignal?: AbortSignal;
}

export function createAgentContext(input: AgentContextInput): AgentContext {
  const { tool, chatId, modelId, sse, taskId, runId, cancelSignal } = input;
  const log = createLogger(`agent:${tool}`);

  /**
   * The ZDR policy as it stood when this run started.
   *
   * Captured once, here, rather than re-read per request — the same reasoning as
   * `orchestrator/chat.ts`. The log has to hold the rule a request was judged
   * against, and a policy changed mid-run must not retroactively restate the
   * requests already made under the old one.
   */
  const zdrRequirementAtStart = zdrRequirement();

  // Disconnect *or* cancellation, whichever comes first. `sse.signal` is backed
  // by one controller created with the stream, so reading it once here is the
  // same signal the getter used to return. Without a cancelSignal this is that
  // signal unchanged — `AbortSignal.any` is deliberately not used in that case,
  // so a run with nothing to cancel keeps the exact object it always had.
  const stopSignal =
    cancelSignal === undefined ? sse.signal : AbortSignal.any([sse.signal, cancelSignal]);

  // A task id identifies every agent run, but only Code owns a worktree. Cowork
  // and Design remain inside the projects scope rather than being sent through
  // Code's worktree lookup merely because they now carry the same identity.
  const codeTaskId = tool === 'code' ? taskId : undefined;
  const resolvePath = (candidate: string): string =>
    codeTaskId === undefined
      ? resolveInScope('projects', candidate)
      : containAgentCwd(candidate, codeTaskId);

  const emit = (event: string, data: Record<string, unknown>): void => {
    sse.emit('agent', { channel: event, tool, chatId, ...data });
  };

  /**
   * Log one provider request's spend against its task and its run (v4 §6.2).
   *
   * Called from the two places a request is actually made — `llmStream` and
   * `llmComplete` — so nothing reaching a provider goes unrecorded, and the
   * context is the right seam for it: it is the one object every task run passes
   * through, whether the run was started by a route, by a continuation, or by the
   * scheduler. Chat runs do not build one, so they keep recording through
   * `orchestrator/chat.ts` and nothing is counted twice.
   *
   * Where a delegated child's spend lands is worth stating precisely, because two
   * documents described it wrongly. The child does not build a context of its own
   * (`childContext` hands it the parent's `llm`, and these wrappers close over the
   * `taskId` and `runId` of the run that built *this* context), so a child's
   * requests are logged against the **parent's task id and the parent's run id**.
   * The task total therefore includes delegated work — that much was documented and
   * is true — and so does the parent *run*'s figure, which the feed's per-entry
   * `spend` reports and which the API docs said excluded it. A child's own spend is
   * consequently not separable from its parent's today, which is why a `subagent`
   * entry in the activity feed carries no spend rather than a share of one.
   * Migration 018 explains why task and run are two keys.
   *
   * Never throws. `recordUsage` swallows its own failures, and this must not be
   * the thing that turns a finished request into a failed run.
   */
  const recordRequestUsage = (input: {
    provider: ProviderRecord;
    usage: TokenUsage;
    status: 'ok' | 'partial';
    durationMs: number;
  }): void => {
    recordUsage({
      chatId,
      tool,
      modelId,
      providerId: input.provider.id,
      providerName: input.provider.name,
      // Read off the provider that actually served, not the one aimed at: a
      // mid-run failover can move the request to a provider of a different egress
      // class, and the log has to say where the bytes went.
      providerType: input.provider.type,
      zdrStatus: zdrStatusFor(input.provider),
      zdrRequirement: zdrRequirementAtStart,
      tokensIn: input.usage.tokensIn,
      tokensOut: input.usage.tokensOut,
      // The same optional accounting the chat path records (1.28): undefined
      // stays NULL, a reported zero stays a zero.
      cacheReadTokens: input.usage.cacheReadTokens,
      cacheWriteTokens: input.usage.cacheWriteTokens,
      reasoningTokens: input.usage.reasoningTokens,
      status: input.status,
      durationMs: input.durationMs,
      taskId,
      runId: runId ?? null,
    });
  };

  const llmStream = async function* (
    request: CompletionRequest,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const signal = request.signal ?? stopSignal;
    const startedAt = Date.now();
    // Accumulated rather than overwritten: a request is one row, and an adapter
    // that reports usage in more than one chunk reported it for one request.
    let observed: TokenUsage | null = null;
    let provider: ProviderRecord | null = null;

    try {
      for await (const event of routerStream({ ...request, signal })) {
        switch (event.type) {
          case 'token':
            yield { type: 'token', text: event.text };
            break;
          case 'usage':
            observed =
              observed === null
                ? event.usage
                : {
                    tokensIn: observed.tokensIn + event.usage.tokensIn,
                    tokensOut: observed.tokensOut + event.usage.tokensOut,
                  };
            yield { type: 'usage', usage: event.usage };
            break;
          case 'tool_call':
            yield { type: 'tool_call', call: event.call };
            break;
          case 'done':
            yield { type: 'done', finishReason: event.finishReason };
            break;
          case 'provider':
            provider = event.provider;
            emit('provider', {
              providerId: event.provider.id,
              providerName: event.provider.name,
              modelId: event.modelId,
              attempt: event.attempt,
            });
            break;
          case 'switched':
            emit('switched', {
              from: event.from.id,
              to: event.to.id,
              reason: event.reason,
              message: event.message,
            });
            break;
          default:
            break;
        }
      }
    } catch (error) {
      // A request that failed part-way is still a request the provider may have
      // billed, so whatever it reported before the failure is recorded as
      // `partial` — and only when it reported something. Zero tokens is written
      // for a request whose usage was never reported: "unknown tokens" must not
      // enter the log as "no tokens", which is the same line `usage.ts` draws
      // between unpriced and free. The failure itself is the run's row to carry.
      if (observed !== null && provider !== null) {
        recordRequestUsage({
          provider,
          usage: observed,
          status: 'partial',
          durationMs: Date.now() - startedAt,
        });
      }
      throw error;
    }

    if (observed !== null && provider !== null) {
      recordRequestUsage({
        provider,
        usage: observed,
        status: 'ok',
        durationMs: Date.now() - startedAt,
      });
    }
  };

  const llmComplete = async (
    request: CompletionRequest,
  ): Promise<{ text: string; usage: TokenUsage }> => {
    const signal = request.signal ?? stopSignal;
    const startedAt = Date.now();
    const result = await routerComplete({ ...request, signal });
    recordRequestUsage({
      provider: result.provider,
      usage: result.usage,
      status: 'ok',
      durationMs: Date.now() - startedAt,
    });
    return { text: result.text, usage: result.usage };
  };

  const executeCommand = (
    cwd: string,
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<CommandResult> =>
    runCommand(resolvePath(cwd), command, {
      timeoutMs: options?.timeoutMs,
      signal: stopSignal,
      ...(codeTaskId === undefined ? {} : { taskId: codeTaskId }),
    });

  const artifactServices = {
    taskId,
    resolvePath,
    emit: (artifactKey: string, version: number, label: string | null): void => {
      emit('artifact', { artifactKey, version, label });
    },
  };
  const saveArtifactVersion: AgentContext['saveArtifactVersion'] = (artifact) =>
    persistArtifactVersion(artifact, artifactServices);
  const readFile: AgentContext['readFile'] = (candidate) => readCodeFile(candidate, artifactServices);
  const writeFile: AgentContext['writeFile'] = (file) => writeCodeFile(file, artifactServices);
  const restoreArtifactVersion: AgentContext['restoreArtifactVersion'] = (artifact) =>
    restoreCodeArtifactVersion(artifact, artifactServices);

  // Filtered by the Plugins hub (1.34): a skill switched off for this tool is
  // not offered to it, so the model cannot recommend what it is not allowed to
  // run. The library read is untouched — the skill is still installed and still
  // listed in Settings, with the switch that hid it.
  const getSkillsSummary = (): { name: string; description: string }[] =>
    skillsAvailableTo(tool).map((skill) => ({ name: skill.name, description: skill.description }));

  return {
    taskId,
    ...(runId === undefined ? {} : { runId }),
    emit,
    llm: { stream: llmStream, complete: llmComplete },
    executeCommand,
    saveArtifactVersion,
    readFile,
    writeFile,
    restoreArtifactVersion,
    getSkillsSummary,
    resolvePath,
    get signal(): AbortSignal {
      return stopSignal;
    },
    log,
  };
}

/** Default working directory for a run: the projects scope root, or a caller-supplied subpath. */
export function resolveAgentCwd(candidate?: string): string {
  return resolveInScope('projects', candidate && candidate.trim() ? candidate : '.');
}

export { createLogger as createAgentLogger };
