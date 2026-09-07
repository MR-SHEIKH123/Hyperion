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
import { resolveInScope } from '../security/fsScope.ts';
import { containAgentCwd } from '../services/code/worktree.ts';
import {
  readCodeFile,
  restoreArtifactVersion as restoreCodeArtifactVersion,
  saveArtifactVersion as persistArtifactVersion,
  writeCodeFile,
} from '../services/code/files.ts';
import { skillsSummary } from '../services/skills/registry.ts';
import { createLogger } from '../util/logger.ts';
import type { SseStream } from './sse.ts';
import type {
  AgentContext,
  CommandResult,
  CompletionRequest,
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

  const llmStream = async function* (
    request: CompletionRequest,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const signal = request.signal ?? stopSignal;
    for await (const event of routerStream({ ...request, signal })) {
      switch (event.type) {
        case 'token':
          yield { type: 'token', text: event.text };
          break;
        case 'usage':
          yield { type: 'usage', usage: event.usage };
          break;
        case 'tool_call':
          yield { type: 'tool_call', call: event.call };
          break;
        case 'done':
          yield { type: 'done', finishReason: event.finishReason };
          break;
        case 'provider':
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
  };

  const llmComplete = async (
    request: CompletionRequest,
  ): Promise<{ text: string; usage: TokenUsage }> => {
    const signal = request.signal ?? stopSignal;
    const result = await routerComplete({ ...request, signal });
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

  const getSkillsSummary = (): { name: string; description: string }[] =>
    skillsSummary().map((skill) => ({ name: skill.name, description: skill.description }));

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
