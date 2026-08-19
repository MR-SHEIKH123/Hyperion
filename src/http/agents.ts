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
 *
 * The `/code/rules`, `/code/agents` and `/code/commands` listings are the
 * exception to all of the above: read-only, lock-free, and served for the
 * frontend's benefit rather than an agent's. They never need a registered agent.
 *
 * Every run also writes a coarse state row to `task_runs` — running, then
 * complete or error. The SSE stream is the only channel these tools have, and a
 * phone that locks its screen drops it, so `GET /api/{tool}/tasks/:taskId/state`
 * is how a client that reconnects finds out whether the work it can no longer
 * see is still going, already finished, or dead.
 */
import { randomUUID } from 'node:crypto';

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
import {
  listProjectAgents,
  listProjectCommands,
  listProjectRules,
} from '../services/code/projectContext.ts';
import { getWorktree, provisionWorktree, releaseWorktree } from '../services/code/worktree.ts';
import { exportCodeTask } from '../services/export/index.ts';
import { findChat } from '../db/chats.ts';
import { concurrencyMode } from '../db/settings.ts';
import {
  finishTaskRun,
  latestRunForTask,
  startTaskRun,
  type TaskRunTool,
} from '../db/taskRuns.ts';
import { AppError, toAppError } from '../util/errors.ts';

import { createLogger } from '../util/logger.ts';
import { attachDownloadHeaders } from './download.ts';
import { wrap } from './errors.ts';
import {
  asNumber,
  asString,
  asOptionalString,
  body,
  pathParam,
  queryString,
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
 * `chat_id` on a task run is a real foreign key, and `PRAGMA foreign_keys` is
 * on, so a chat id the frontend has not created yet would make the whole
 * insert fail — losing the state row for a task that is about to run, over a
 * column that is only a convenience link. An id with no chat behind it is not
 * a link to anything, so it is stored as NULL and the task is still recorded.
 */
function linkedChatId(chatId: string): string | undefined {
  return findChat(chatId) === null ? undefined : chatId;
}

/** The bits of a failure worth keeping on the run row. */
function failureReason(error: unknown): { code: string; message: string } {
  const app = toAppError(error);
  return { code: app.code, message: app.message };
}

/**
 * Journal a run's ending, never at the cost of the run itself.
 *
 * This is called from the tail of an SSE lifecycle where the response is
 * already closing and there is no one left to tell. A bookkeeping write that
 * threw here would surface as an unhandled rejection about a task that
 * otherwise finished perfectly well, so it is logged and swallowed — the
 * stream, not this row, is what the client was actually reading.
 */
function markTaskRun(
  runId: string,
  state: 'complete' | 'error',
  reason?: { code: string; message: string },
): void {
  try {
    finishTaskRun(runId, state, reason);
  } catch (error) {
    log.warn(`task run ${runId}: recording ${state} failed: ${String(error)}`);
  }
}

/**
 * Shared handler for the non-Code run-task routes. Validation and module lookup
 * happen synchronously so failures surface as JSON; only once the run is
 * actually starting do we switch the response into an SSE stream.
 *
 * Cowork and Design take no task id of their own, so the chat is the task: it
 * is the handle the user already has for this piece of work, and the one they
 * will come back to when the stream drops.
 */
function runTaskRoute(tool: AgentTool) {
  return (req: Request, res: Response, next: (error?: unknown) => void): void => {
    let input: TaskInput;
    let agent: AgentModule;
    let taskId: string;
    try {
      input = parseTaskInput(tool, body(req));
      agent = requireAgent(tool);
      taskId = asOptionalString(body(req).taskId, 'taskId') ?? input.chatId;
      assertNotBusy();
    } catch (error) {
      next(error);
      return;
    }

    const runId = randomUUID();
    const sse = openStream(res);
    void withLock(
      {
        tool,
        label: `${tool}:${input.chatId}`,
        mode: concurrencyMode(),
        signal: sse.signal,
      },
      async () => {
        // Inside the lock, not before it: a request that waits its turn in
        // queue mode is not running yet, and a row claiming otherwise would
        // have a client watching for progress that cannot start.
        startTaskRun({
          runId,
          taskId,
          tool: tool as TaskRunTool,
          chatId: linkedChatId(input.chatId),
        });

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
      .then(() => {
        markTaskRun(runId, 'complete');
      })
      .catch((error: unknown) => {
        markTaskRun(runId, 'error', failureReason(error));
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

    const runId = randomUUID();
    // Provisioning reports its own failure on the stream and returns rather
    // than throwing, so the tail of the chain cannot tell that run apart from a
    // successful one. This says which it was.
    let provisioned = true;

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
        // Inside the lane for the same reason the other tools record inside the
        // lock: a task queued behind a full lane has not started yet.
        startTaskRun({ runId, taskId, tool: 'code', chatId: linkedChatId(input.chatId) });

        let worktree: Worktree;
        try {
          worktree = await provisionWorktree(taskId, input.cwd ?? '.');
        } catch (error) {
          provisioned = false;
          markTaskRun(runId, 'error', failureReason(error));
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
        if (provisioned) markTaskRun(runId, 'complete');
        void releaseWorktree(taskId).catch((error: unknown) => {
          log.warn(`code task ${taskId}: worktree release failed: ${String(error)}`);
        });
      })
      .catch((error: unknown) => {
        if (provisioned) markTaskRun(runId, 'error', failureReason(error));
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

/**
 * Where a task got to, for `GET /api/{tool}/tasks/:taskId/state`.
 *
 * This is the reconnection path. A client whose SSE stream died — screen lock,
 * sleep, tunnel drop — has no way to ask the stream what happened, because the
 * stream is gone. It polls this instead: `running` means keep waiting, `error`
 * carries the code and message the stream would have delivered, and `complete`
 * means the work landed while nobody was watching.
 *
 * A task with no row is a 404 rather than an invented `idle`: "I have never
 * heard of this task" and "this task is not doing anything" are different
 * answers, and only one of them means the client should stop asking.
 */
function taskStateRoute(tool: TaskRunTool) {
  return wrap(async (req: Request, res: Response) => {
    const taskId = pathParam(req, 'taskId');
    const run = latestRunForTask(tool, taskId);
    if (run === null) {
      throw new AppError('not_found', `No ${tool} task run recorded for "${taskId}".`, {
        details: { taskId },
      });
    }
    res.json({ run });
  });
}

agentsRouter.get('/code/tasks/:taskId/state', taskStateRoute('code'));
agentsRouter.get('/cowork/tasks/:taskId/state', taskStateRoute('cowork'));
agentsRouter.get('/design/tasks/:taskId/state', taskStateRoute('design'));

/**
 * A code task's changes as a unified patch.
 *
 * Only Code gets this: it is the one lane that works inside a git worktree, so
 * it is the only one where "the changes this task made" has an exact answer.
 *
 * The task must still have a worktree — the diff is computed live from git
 * rather than stored, so a released worktree is a 404. Exporting is therefore
 * something done while the task is still around, which is also when anyone
 * wants it.
 */
agentsRouter.get(
  '/code/tasks/:taskId/export',
  wrap(async (req, res) => {
    const exported = await exportCodeTask(pathParam(req, 'taskId'));
    attachDownloadHeaders(res, exported.filename, exported.contentType);
    res.send(exported.content);
  }),
);

/**
 * The project directory these listings apply to.

 *
 * Defaults to `.` — the projects-scope root — so the frontend can ask what a
 * fresh session has available before the user has picked anything. The value is
 * only ever resolved inside the projects scope, so `?project=../../etc` is a
 * `scope_violation` (403) rather than a path traversal.
 */
function projectQuery(req: Request): string {
  return queryString(req, 'project') ?? '.';
}

/**
 * Rules active for a project, for `GET /api/code/rules`.
 *
 * `source` names which location supplied them — `.hyperion/rules` or a root
 * `HYPERION.md` — because a project whose rules arrive through the fallback path
 * is not the same as one with no rules, and the UI has to be able to say which it
 * is looking at.
 */
agentsRouter.get('/code/rules', wrap(async (req, res) => {
  const listing = await listProjectRules(projectQuery(req));
  res.json({ source: listing.source, count: listing.rules.length, rules: listing.rules });
}));

/** Sub-agents declared for a project, for `GET /api/code/agents`. */
agentsRouter.get('/code/agents', wrap(async (req, res) => {
  const agents = await listProjectAgents(projectQuery(req));
  res.json({ count: agents.length, agents });
}));

/** Custom commands declared for a project, for `GET /api/code/commands`. */
agentsRouter.get('/code/commands', wrap(async (req, res) => {
  const commands = await listProjectCommands(projectQuery(req));
  res.json({ count: commands.length, commands });
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
