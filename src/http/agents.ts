/**
 * Agent routes: `code`, `cowork`, `design` task runs plus terminal execution.
 *
 * The agent loops themselves live outside this backend spine, so every route
 * here resolves a registered module first. When nothing is registered the
 * request fails fast with `agent_not_registered` / `terminal_not_registered`
 * (both HTTP 501) as plain JSON, before any SSE headers are written.
 *
 * Code is the one tool that does not take the app-wide job lock. It runs in a
 * counting lane instead (`HYPERION_CODE_LANE_LIMIT`, default 2), with each task
 * in its own git worktree, so a long refactor does not stand between the user
 * and an unrelated one. Cowork, Design and Chat still serialise exactly as
 * before. `GET /api/code/tasks` reports what that lane is doing.
 */
import { Router } from 'express';

import {
  getTerminal,
  registeredAgents,
  requireAgent,
  requireTerminal,
  executeCommand as runCommand,
  type AgentTool,
} from '../orchestrator/agents.ts';
import { createAgentContext } from '../orchestrator/agentContext.ts';
import {
  codeLaneBusyError,
  codeLaneHasCapacity,
  codeLaneStatus,
  currentJob,
  isBusy,
  withCodeLane,
  withLock,
} from '../orchestrator/lock.ts';
import { openStream } from '../orchestrator/sse.ts';
import { getWorktree, provisionWorktree, releaseWorktree } from '../services/code/worktree.ts';
import { concurrencyMode } from '../db/settings.ts';
import { AppError } from '../util/errors.ts';
import { createLogger } from '../util/logger.ts';
import { wrap } from './errors.ts';
import {
  asNumber,
  asString,
  asOptionalString,
  body,
} from './params.ts';

import type { Request, Response } from 'express';
import type { AgentModule, TaskInput, TaskResult } from '../types/core.ts';
import type { Worktree } from '../services/code/worktree.ts';

export const agentsRouter: Router = Router();

const log = createLogger('agents:http');

function assertNotBusy(): void {
  if (concurrencyMode() !== 'reject' || !isBusy()) return;
  const job = currentJob();
  throw new AppError('busy', 'Another job is already running', {
    details: job ? { jobId: job.id } : undefined,
    retryable: true,
  });
}

/**
 * The Code equivalent of `assertNotBusy`, checking the lane rather than the
 * global lock.
 *
 * Same reason it runs before `openStream`: `acquireCodeLane` would raise the
 * identical error a moment later, but by then the response is an event stream
 * and a client that asked for JSON has to dig the failure out of the body.
 */
function assertCodeLaneAvailable(): void {
  if (concurrencyMode() !== 'reject' || codeLaneHasCapacity()) return;
  throw codeLaneBusyError();
}

function parseAttachments(value: unknown): TaskInput['attachments'] {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new AppError('bad_request', 'attachments must be an array');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new AppError('bad_request', `attachments[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    return {
      id: asString(record.id, `attachments[${index}].id`),
      path: asString(record.path, `attachments[${index}].path`),
      filename: asString(record.filename, `attachments[${index}].filename`),
    };
  });
}

function parseOptions(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('bad_request', 'options must be an object');
  }
  return value as Record<string, unknown>;
}

function parseTaskInput(tool: AgentTool, payload: Record<string, unknown>): TaskInput {
  const input: TaskInput = {
    tool,
    chatId: asString(payload.chatId, 'chatId'),
    modelId: asString(payload.modelId, 'modelId'),
    prompt: asString(payload.prompt, 'prompt'),
  };
  const cwd = asOptionalString(payload.cwd, 'cwd');
  if (cwd !== undefined) input.cwd = cwd;
  const attachments = parseAttachments(payload.attachments);
  if (attachments !== undefined) input.attachments = attachments;
  const options = parseOptions(payload.options);
  if (options !== undefined) input.options = options;
  return input;
}

/**
 * Shared handler for the non-Code run-task routes. Validation and module lookup
 * happen synchronously so failures surface as JSON; only once the run is
 * actually starting do we switch the response into an SSE stream.
 */
function runTaskRoute(tool: AgentTool) {
  return (req: Request, res: Response, next: (error?: unknown) => void): void => {
    let input: TaskInput;
    let agent: AgentModule;
    try {
      input = parseTaskInput(tool, body(req));
      agent = requireAgent(tool);
      assertNotBusy();
    } catch (error) {
      next(error);
      return;
    }

    const sse = openStream(res);
    void withLock(
      {
        tool,
        label: `${tool}:${input.chatId}`,
        mode: concurrencyMode(),
        signal: sse.signal,
      },
      async () => {
        const ctx = createAgentContext({
          tool,
          chatId: input.chatId,
          modelId: input.modelId,
          sse,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        });
        const result: TaskResult = await agent.runTask(input, ctx);
        sse.emit('agent', { channel: 'result', tool, chatId: input.chatId, ...result });
        return result;
      },
    )
      .catch((error: unknown) => {
        sse.sendError(error);
      })
      .finally(() => {
        sse.close();
      });
  };
}

/**
 * Code task handler. Same JSON-before-SSE discipline, then the lane instead of
 * the global lock.
 *
 * The task id travels with the whole run: it is the join key between the lane's
 * slot and the worktree module, and it is how the agent context narrows every
 * path it touches to that task's own checkout. Provisioning happens once the
 * slot is actually held, so the lane is not spent on a task that could not be
 * isolated.
 */
function runCodeTaskRoute() {
  return (req: Request, res: Response, next: (error?: unknown) => void): void => {
    let input: TaskInput;
    let agent: AgentModule;
    let taskId: string;
    try {
      input = parseTaskInput('code', body(req));
      agent = requireAgent('code');
      taskId = asString(body(req).taskId, 'taskId');
      assertCodeLaneAvailable();
    } catch (error) {
      next(error);
      return;
    }

    const sse = openStream(res);
    void withCodeLane(
      {
        tool: 'code',
        label: `${input.chatId}:${taskId}`,
        mode: concurrencyMode(),
        signal: sse.signal,
        taskId,
      },
      async () => {
        let worktree: Worktree;
        try {
          worktree = await provisionWorktree(taskId, input.cwd ?? '.');
        } catch (error) {
          sse.sendError(error);
          return;
        }

        // Queued-vs-started is worth saying explicitly: the client already knows
        // it asked, but not whether the task is running yet or waiting for a slot.
        sse.emit('agent', { channel: 'started', tool: 'code', chatId: input.chatId, taskId, mode: worktree.mode, dir: worktree.dir, reason: worktree.reason });

        const ctx = createAgentContext({
          tool: 'code',
          chatId: input.chatId,
          modelId: input.modelId,
          sse,
          taskId,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        });
        const result: TaskResult = await agent.runTask(input, ctx);
        sse.emit('agent', { channel: 'result', tool: 'code', chatId: input.chatId, taskId, ...result });
        return result;
      },
    )
      .then(() => {
        void releaseWorktree(taskId).catch((error: unknown) => {
          log.warn(`code task ${taskId}: worktree release failed: ${String(error)}`);
        });
      })
      .catch((error: unknown) => {
        sse.sendError(error);
        void releaseWorktree(taskId).catch((error: unknown) => {
          log.warn(`code task ${taskId}: worktree release failed: ${String(error)}`);
        });
      })
      .finally(() => {
        sse.close();
      });
  };
}

agentsRouter.post('/code/run-task', runCodeTaskRoute());
agentsRouter.post('/cowork/run-task', runTaskRoute('cowork'));
agentsRouter.post('/design/run-task', runTaskRoute('design'));

/**
 * What the Code lane is doing right now, for `GET /api/code/tasks`.
 *
 * `active` entries carry the task id (when one was named), and each task's
 * worktree directory comes from the worktree module — a path the frontend can
 * open directly. This is deliberately the lane's live view, not a journal:
 * finished tasks disappear, which is the point of scratch space.
 */
agentsRouter.get('/code/tasks', wrap(async (_req, res) => {
  const status = codeLaneStatus();
  res.json({
    running: status.running,
    limit: status.limit,
    queued: status.queued,
    active: status.active.map((slot) => ({
      id: slot.id,
      taskId: slot.taskId ?? null,
      label: slot.label ?? null,
      startedAt: slot.startedAt,
      worktree: slot.taskId === undefined ? null : getWorktree(slot.taskId)?.dir ?? null,
    })),
  });
}));

/** Terminal execution, owned by the terminal module. Plain JSON, not SSE. */
agentsRouter.post(
  '/code/execute-command',
  wrap(async (req, res) => {
    const payload = body(req);
    const command = asString(payload.command, 'command');
    const cwd = asOptionalString(payload.cwd, 'cwd') ?? '.';
    const timeoutMs = asNumber(payload.timeoutMs, 'timeoutMs');

    requireTerminal();
    const result = await runCommand(cwd, command, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    res.json({ result });
  }),
);

agentsRouter.get('/agents/status', (_req, res) => {
  const agents = registeredAgents();
  res.json({
    agents,
    terminal: getTerminal() !== null,
    registered: {
      code: agents.includes('code'),
      cowork: agents.includes('cowork'),
      design: agents.includes('design'),
    },
  });
});
