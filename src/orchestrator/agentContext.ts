/**
 * Builds the AgentContext handed to agent modules (`code`, `cowork`, `design`).
 *
 * Agent modules are implemented outside this backend spine (Kimi = code/cowork,
 * Sol = design/terminal). They only ever implement `runTask(input, ctx)`, so
 * constructing a fully wired `ctx` is this file's job: LLM access through the
 * failover router, sandboxed filesystem paths, shell execution through the
 * registered terminal module, artifact versioning, and SSE progress events.
 */
import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';

import { getDb } from '../db/adapter.ts';
import { executeCommand as runCommand } from './agents.ts';
import { complete as routerComplete, stream as routerStream } from '../providers/router.ts';
import { resolveInScope } from '../security/fsScope.ts';
import { containAgentCwd } from '../services/code/worktree.ts';
import { skillsSummary } from '../services/skills/registry.ts';
import { AppError } from '../util/errors.ts';
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
  /**
   * Present for a parallel Code task, and the reason its paths resolve against
   * its own worktree instead of the whole projects tree. Every path the agent
   * offers — `resolvePath`, `executeCommand`, an artifact's `relPath` — is
   * checked against that one directory, so a task cannot read or write inside
   * another task's checkout even though both live under the same scope root.
   */
  taskId?: string;
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

interface ArtifactInput {
  artifactKey: string;
  tool: ToolName;
  content?: string;
  relPath?: string;
  label?: string;
}

/** Next monotonic version for an artifact key. Version 1 = state before the first edit. */
function nextVersion(artifactKey: string): number {
  const row = getDb()
    .prepare<{ maxVersion: number | null }>(
      'SELECT MAX(version) AS maxVersion FROM artifact_versions WHERE artifact_key = ?',
    )
    .get(artifactKey);
  const current = row && typeof row.maxVersion === 'number' ? row.maxVersion : 0;
  return current + 1;
}

function fileBytes(absolute: string): number | null {
  try {
    return statSync(absolute).size;
  } catch {
    return null;
  }
}

export function createAgentContext(input: AgentContextInput): AgentContext {
  const { tool, chatId, modelId, sse, taskId, cancelSignal } = input;
  const log = createLogger(`agent:${tool}`);

  // Disconnect *or* cancellation, whichever comes first. `sse.signal` is backed
  // by one controller created with the stream, so reading it once here is the
  // same signal the getter used to return. Without a cancelSignal this is that
  // signal unchanged — `AbortSignal.any` is deliberately not used in that case,
  // so a run with nothing to cancel keeps the exact object it always had.
  const stopSignal =
    cancelSignal === undefined ? sse.signal : AbortSignal.any([sse.signal, cancelSignal]);

  // Without a task this is exactly the old rule, the projects scope; with one it
  // narrows to that task's worktree. Going through a single resolver keeps the
  // two from drifting apart.
  const resolvePath = (candidate: string): string =>
    taskId === undefined ? resolveInScope('projects', candidate) : containAgentCwd(candidate, taskId);

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
      ...(taskId === undefined ? {} : { taskId }),
    });

  const saveArtifactVersion = (artifact: ArtifactInput): { version: number } => {
    const key = artifact.artifactKey.trim();
    if (!key) {
      throw new AppError('bad_request', 'artifactKey is required');
    }
    if (artifact.content === undefined && !artifact.relPath) {
      throw new AppError('bad_request', 'Either content or relPath is required');
    }

    let relPath: string | null = null;
    let bytes: number | null = null;
    let sha256: string | null = null;

    if (typeof artifact.content === 'string') {
      bytes = Buffer.byteLength(artifact.content, 'utf8');
      sha256 = createHash('sha256').update(artifact.content, 'utf8').digest('hex');
    }
    if (artifact.relPath) {
      const absolute = resolvePath(artifact.relPath);
      relPath = artifact.relPath;
      if (bytes === null) bytes = fileBytes(absolute);
    }

    const version = nextVersion(key);
    getDb()
      .prepare(
        `INSERT INTO artifact_versions
           (id, artifact_key, tool, version, content, rel_path, label, bytes, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        key,
        artifact.tool ?? tool,
        version,
        artifact.content ?? null,
        relPath,
        artifact.label ?? null,
        bytes,
        sha256,
        Date.now(),
      );

    emit('artifact', { artifactKey: key, version, label: artifact.label ?? null });
    return { version };
  };

  const getSkillsSummary = (): { name: string; description: string }[] =>
    skillsSummary().map((skill) => ({ name: skill.name, description: skill.description }));

  return {
    emit,
    llm: { stream: llmStream, complete: llmComplete },
    executeCommand,
    saveArtifactVersion,
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
