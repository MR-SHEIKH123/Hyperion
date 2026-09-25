/**
 * Agent routes: `code`, `cowork`, `design` task runs plus terminal execution.
 *
 * Each route resolves its in-process module first. Cowork and terminal are
 * registered during production composition; Code is production-ready while
 * Design remains optional and fails fast with the coded 501 response below.
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
import multer from 'multer';


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
  CANCEL_REASON,
  cancelRun,
  registerCancellable,
} from '../orchestrator/cancel.ts';
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
  loadAgentProfile,
  loadProjectPermissions,
  loadProjectProfiles,
  matchProjectRules,
} from '../services/code/projectContext.ts';
import { permissionLayers, resolveProfile } from '../services/agent/profiles.ts';
import { describeVerdict } from '../services/agent/permissions.ts';
import { sessionPermissionRules } from '../db/approvals.ts';
import { terminalSessions } from '../services/terminal/sessions.ts';
import { terminalCommandVerdict } from '../services/terminal/authority.ts';
import { SESSION_HEADER, SESSION_TOKEN_HEADER } from './terminal.ts';
import {
  getWorktree,
  heldWorktrees,
  holdWorktree,
  provisionWorktree,
  releaseWorktree,
} from '../services/code/worktree.ts';
import { exportCodeTask } from '../services/export/index.ts';
import { findChat } from '../db/chats.ts';
import { listRunKnowledge } from '../db/runKnowledge.ts';
import { concurrencyMode } from '../db/settings.ts';
import { taskUsage } from '../db/usage.ts';
import {
  finishTaskRun,
  getTaskRun,
  latestRunForTask,
  startTaskRun,
  type TaskRunTool,
} from '../db/taskRuns.ts';
import { recoveryReport } from '../services/agent/recovery.ts';
import { AppError, toAppError } from '../util/errors.ts';

import { createLogger } from '../util/logger.ts';
import { redactSecrets } from '../util/redact.ts';
import { env } from '../config/env.ts';
import { importProfiles, parseOnConflict } from '../services/code/profileImport.ts';
import { attachDownloadHeaders } from './download.ts';
import { wrap } from './errors.ts';
import {
  asBool,
  asEnum,
  asPositiveInteger,
  asString,
  asOptionalString,
  body,
  headerString,
  pathParam,
  queryString,
  queryStrings,
} from './params.ts';


import type { Request, Response } from 'express';
import type { AgentMode, AgentModule, TaskInput, TaskResult } from '../types/core.ts';
import type { Worktree } from '../services/code/worktree.ts';

export const agentsRouter: Router = Router();

const log = createLogger('agents:http');

/** How much of a bypassed command the audit line carries. */
const AUDIT_COMMAND_MAX = 400;

/** Truncate for a log field. Never for anything the command runs with. */
function clip(text: string, maximum: number): string {
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
}
const AGENT_MODES: readonly AgentMode[] = ['ask', 'plan', 'act'];

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
    // Older clients sent no mode. Act preserves their established behaviour;
    // once parsed, agents always receive a definite permission level.
    mode: asEnum(payload.mode, 'mode', AGENT_MODES) ?? 'act',
  };
  // `unattended` is deliberately not read from the request body. It is a fact
  // about who is watching, not a client preference, and this route exists because
  // somebody is: they opened an SSE stream and are waiting on it. A body flag
  // would let a client silently opt out of the refusals that exist to be answered
  // — a `redaction_flagged` send would park instead of asking, which defeats the
  // check. Only `scheduler.ts` sets it, because only it knows nobody is there.
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
  state: 'complete' | 'error' | 'stopped',
  reason?: {
    pauseReason?: string | undefined;
    code?: string | undefined;
    message?: string | undefined;
  },
): void {
  try {
    // A row whose state is no longer `running` belongs to the run that wrote
    // it. A parked agent — approval pending, send blocked, context exhausted —
    // has already recorded its non-terminal state by the time this tail runs,
    // and stamping `complete` over it falsifies the record: `settleWorktree`'s
    // hold reads this same state, and a continuation needs the row to still be
    // parked. The unattended scheduler settles its runs with this same guard.
    if (getTaskRun(runId)?.state !== 'running') return;
    finishTaskRun(runId, state, reason);
  } catch (error) {
    log.warn(`task run ${runId}: recording ${state} failed: ${String(error)}`);
  }
}

/**
 * Release a Code task's worktree, or hold it because the run parked.
 *
 * The gate is the run's **final state**, not the shape of the promise chain. Both
 * the success and failure tails reach here, and a parked run arrives through the
 * success tail: `runAgentLoop` returns a result for a park rather than throwing,
 * so "the promise resolved" says nothing about whether the task is finished.
 *
 * Releasing a parked task's worktree is what made every pre-existing park a dead
 * end — see `Worktree.heldSince`. Terminal states still release, because a finished
 * task has no continuation to protect.
 *
 * A run with no row at all (cancelled while queued, or provisioning failed) is
 * released: there is nothing to continue.
 */
function settleWorktree(runId: string, taskId: string): void {
  const state = latestRunForTask('code', taskId)?.runId === runId
    ? latestRunForTask('code', taskId)?.state
    : getTaskRun(runId)?.state;

  if (state === 'blocked' || state === 'ready_for_review') {
    const held = holdWorktree(taskId);
    if (held !== null) {
      log.info(`code task ${taskId}: worktree held while the run is ${state}`);
      return;
    }
  }

  void releaseWorktree(taskId).catch((error: unknown) => {
    log.warn(`code task ${taskId}: worktree release failed: ${String(error)}`);
  });
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
    // Registered before the lock rather than inside it, so a task parked in
    // the queue is cancellable too. Until it holds the lock the only thing
    // there is to stop is the wait itself, and a queued run that could not be
    // stopped would look to the cancel endpoint like a task never heard of.
    const cancellable = registerCancellable(runId, tool, taskId);
    const sse = openStream(res);

    /**
     * Record a run the user stopped.
     *
     * `stopped` rather than `error` because nothing broke, and an `agent`
     * frame rather than `sendError` because a red failure in the UI is the
     * wrong answer to something the user asked for.
     */
    const finishCancelled = (): void => {
      markTaskRun(runId, 'stopped', { pauseReason: CANCEL_REASON });
      sse.emit('agent', {
        channel: 'stopped',
        tool,
        chatId: input.chatId,
        taskId,
        reason: CANCEL_REASON,
      });
    };

    void withLock(
      {
        tool,
        label: `${tool}:${input.chatId}`,
        mode: concurrencyMode(),
        // Either reason to stop leaves the queue. Waiting on `sse.signal`
        // alone would keep a cancelled task parked until it timed out.
        signal: AbortSignal.any([sse.signal, cancellable.signal]),
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
          taskId,
          runId,
          cancelSignal: cancellable.signal,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        });
        const result: TaskResult = await agent.runTask(input, ctx);
        sse.emit('agent', { channel: 'result', tool, chatId: input.chatId, ...result });
        return result;
      },
    )
      .then(() => {
        // An agent that honours `ctx.signal` returns whatever it had rather
        // than throwing, so a cancelled run can arrive here looking like a
        // successful one. Recording `complete` would claim work finished
        // that the user stopped halfway through.
        if (cancellable.cancelled) finishCancelled();
        else markTaskRun(runId, 'complete');
      })
      .catch((error: unknown) => {
        // A cancelled run and a broken one both surface as an aborted
        // request; only the registry knows which this was.
        if (cancellable.cancelled) {
          finishCancelled();
          return;
        }
        markTaskRun(runId, 'error', failureReason(error));
        sse.sendError(error);
      })
      .finally(() => {
        cancellable.dispose();
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

    // Before the lane for the same reason the other tools register before the
    // lock: a task queued behind a full lane has to be stoppable as well.
    const cancellable = registerCancellable(runId, 'code', taskId);
    const sse = openStream(res);

    /**
     * Record a code run the user stopped.
     *
     * The `provisioned` guard is the same one the rest of this chain uses: a
     * run whose worktree could not be created has already recorded its own
     * failure, and must not have it overwritten with `stopped`. A run
     * cancelled while still queued has no row at all, so the update matches
     * nothing — which is the truth, because it never started.
     */
    const finishCancelled = (): void => {
      if (provisioned) markTaskRun(runId, 'stopped', { pauseReason: CANCEL_REASON });
      sse.emit('agent', {
        channel: 'stopped',
        tool: 'code',
        chatId: input.chatId,
        taskId,
        reason: CANCEL_REASON,
      });
    };

    void withCodeLane(
      {
        tool: 'code',
        label: `${input.chatId}:${taskId}`,
        mode: concurrencyMode(),
        signal: AbortSignal.any([sse.signal, cancellable.signal]),
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
          runId,
          cancelSignal: cancellable.signal,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        });
        const result: TaskResult = await agent.runTask(input, ctx);
        sse.emit('agent', { channel: 'result', tool: 'code', chatId: input.chatId, taskId, ...result });
        return result;
      },
    )
      .then(() => {
        if (cancellable.cancelled) finishCancelled();
        else if (provisioned) markTaskRun(runId, 'complete');
        settleWorktree(runId, taskId);
      })
      .catch((error: unknown) => {
        if (cancellable.cancelled) {
          finishCancelled();
        } else {
          if (provisioned) markTaskRun(runId, 'error', failureReason(error));
          sse.sendError(error);
        }
        settleWorktree(runId, taskId);
      })
      .finally(() => {
        cancellable.dispose();
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
    // Reported separately from `active`, and that distinction is the point. A
    // parked task holds disk but not a lane slot, so counting it as running would
    // misreport capacity — and omitting it entirely would make a deliberately
    // retained directory indistinguishable from a leaked one.
    held: heldWorktrees().map((worktree) => ({
      taskId: worktree.taskId,
      worktree: worktree.dir,
      branch: worktree.branch,
      heldSince: worktree.heldSince,
      state: latestRunForTask('code', worktree.taskId)?.state ?? null,
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
 *
 * `usage` is the task's recorded spend (v4 §6.2), summed over every request
 * logged against the task id — which **includes work it delegated**, because a
 * subagent child inherits the parent's task id and contributes its tokens and
 * cost here. `usage.runs` counts the runs that logged under their own id, so
 * "three runs, five requests" is readable. `requests: 0` means nothing was
 * recorded (a run from before this accounting, a run that never reached a
 * provider) and is not a claim that the task was free; `costUsd` is null unless
 * at least one logged request had a price, and `priced` says whether the total
 * is the whole bill.
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
    res.json({ run, usage: taskUsage(taskId) });
  });
}

/**
 * What a Cowork run was built on, for `GET /api/cowork/tasks/:taskId/provenance`.
 *
 * Prompt 1.39 A6 asks for exactly two additions to provenance, and this is the
 * second of them: the knowledge sources *used* — the ones that went into the
 * prompt as evidence, not the ones that were merely listed as unavailable. The
 * `run` object comes along so the caller can tell which run it is looking at: a
 * task can have been restarted, and provenance belongs to the attempt, not to the
 * task.
 *
 * An empty list is a real answer and means one of two things — the library is
 * empty, or every source was unusable. They are not distinguished here because
 * `GET /api/cowork/knowledge` already answers what the library holds, and
 * `startedAt` says whether this run predates the recording.
 */
agentsRouter.get(
  '/cowork/tasks/:taskId/provenance',
  wrap(async (req, res) => {
    const taskId = pathParam(req, 'taskId');
    const run = latestRunForTask('cowork', taskId);
    if (run === null) {
      throw new AppError('not_found', `No cowork task run recorded for "${taskId}".`, { details: { taskId } });
    }
    res.json({ run, knowledgeSources: listRunKnowledge(run.runId) });
  }),
);

agentsRouter.get('/code/tasks/:taskId/state', taskStateRoute('code'));
agentsRouter.get('/cowork/tasks/:taskId/state', taskStateRoute('cowork'));
agentsRouter.get('/design/tasks/:taskId/state', taskStateRoute('design'));

/**
 * What an interrupted run left, for `GET /api/{tool}/tasks/:taskId/recovery`.
 *
 * The heavy half of this read is the worktree check — one `git status` and maybe
 * a `rev-parse` in the single directory named for the task, not the per-directory
 * scan the queue's source is built around — which is why it can be answered on
 * demand rather than from the last scan. `services/agent/recovery.ts` carries the
 * reasoning for the shape.
 */
function taskRecoveryRoute(tool: TaskRunTool) {
  return wrap(async (req: Request, res: Response) => {
    const taskId = pathParam(req, 'taskId');
    res.json(await recoveryReport(tool, taskId));
  });
}

agentsRouter.get('/code/tasks/:taskId/recovery', taskRecoveryRoute('code'));
agentsRouter.get('/cowork/tasks/:taskId/recovery', taskRecoveryRoute('cowork'));
agentsRouter.get('/design/tasks/:taskId/recovery', taskRecoveryRoute('design'));

/**
 * Stop a task, for `POST /api/{tool}/tasks/:taskId/cancel`.
 *
 * Three cases, all of them a 200, because each is a real answer to "stop
 * this" rather than a failure of the request:
 *
 *   - **A live run.** Its cancel signal is raised and the answer is
 *     `stopping`, not `stopped`: the run is still unwinding, and it owns the
 *     transition to a terminal state. Saying `stopped` here would have the
 *     client believe the work had already put its tools down.
 *   - **A row with no live run.** Nothing is left in this process to signal —
 *     the state was left behind by a run whose process is gone — so the
 *     transition is made directly. "No controller found" is success, not a
 *     404: the user asked for this task to be stopped, and afterwards it is.
 *   - **A run that already ended.** Idempotent success carrying the state it
 *     actually reached. Cancelling something that finished a moment ago is a
 *     race the user cannot avoid, so it must not read as an error.
 *
 * A task id with no row at all is still a 404, on the same reasoning as the
 * state endpoint: "I have never heard of this task" and "this task is not
 * running" are different answers, and only one of them means the client is
 * asking about something that exists.
 */
function cancelTaskRoute(tool: AgentTool) {
  return wrap(async (req: Request, res: Response) => {
    const taskId = pathParam(req, 'taskId');

    const signalled = cancelRun(tool, taskId);
    if (signalled !== null) {
      res.json({ tool, taskId, runId: signalled, state: 'stopping', wasRunning: true });
      return;
    }

    const run = latestRunForTask(tool, taskId);
    if (run === null) {
      throw new AppError('not_found', `No ${tool} task run recorded for "${taskId}".`, {
        details: { taskId },
      });
    }

    const ended =
      run.state === 'complete' || run.state === 'error' || run.state === 'stopped';
    if (ended) {
      res.json({ tool, taskId, runId: run.runId, state: run.state, wasRunning: false });
      return;
    }

    finishTaskRun(run.runId, 'stopped', { pauseReason: CANCEL_REASON });
    res.json({ tool, taskId, runId: run.runId, state: 'stopped', wasRunning: false });
  });
}

agentsRouter.post('/code/tasks/:taskId/cancel', cancelTaskRoute('code'));
agentsRouter.post('/cowork/tasks/:taskId/cancel', cancelTaskRoute('cowork'));
agentsRouter.post('/design/tasks/:taskId/cancel', cancelTaskRoute('design'));

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
  const listing = await matchProjectRules(projectQuery(req), queryStrings(req, 'path'));
  res.json({
    source: listing.source,
    scopeEnforced: listing.scopeEnforced,
    count: listing.rules.length,
    matchedCount: listing.rules.filter((rule) => rule.matched).length,
    rules: listing.rules,
  });
}));

/** Sub-agents declared for a project, for `GET /api/code/agents`. */
agentsRouter.get('/code/agents', wrap(async (req, res) => {
  const agents = await listProjectAgents(projectQuery(req));
  res.json({ count: agents.length, agents });
}));

/**
 * Profile uploads, in memory: the service files buffers, and a file over the
 * 64 KiB profile limit is a per-file `invalid`, not a rejected request — so the
 * transport cap stays the shared upload maximum rather than the policy limit.
 */
const profileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadBytes },
});

/**
 * Files `.md` agent profiles into the active project's `.hyperion/agents/`
 * (1.28) — the profile set's first writer.
 *
 * Multipart `files` (at most 50; each at most 64 KiB to be filed, larger ones
 * reported per file rather than failing the batch). `onConflict` is `skip`
 * (default), `rename` (`<stem>-2.md`), or `overwrite`, which additionally
 * requires `confirm: true` — the policy is validated before the first byte
 * lands, so a missing confirmation refuses the whole request. The file count is
 * enforced in the service as a 400: a multer-level file-count limit would
 * surface as a 500 with an error-log row asserting a server fault for a client
 * error (the S17 lesson), which is why this route deliberately differs from the
 * skills intake's `files: 200`.
 *
 * 200 with a per-file result each; `imported` counts the files that landed.
 * 409 `conflict` (`no_active_project`) when no project is open — with no
 * project there is no destination to file into.
 */
agentsRouter.post(
  '/code/agents/import',
  profileUpload.array('files'),
  wrap(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      throw new AppError('bad_request', 'No files were uploaded.', {
        details: { field: 'files' },
      });
    }
    const payload = body(req);
    const confirm = asBool(payload.confirm, 'confirm');
    const outcome = importProfiles(
      files.map((file) => ({ filename: file.originalname || 'profile.md', buffer: file.buffer })),
      {
        onConflict: parseOnConflict(asOptionalString(payload.onConflict, 'onConflict')),
        ...(confirm === undefined ? {} : { confirm }),
      },
    );
    res.json({ ...outcome, count: outcome.results.length });
  }),
);

/** Custom commands declared for a project, for `GET /api/code/commands`. */
agentsRouter.get('/code/commands', wrap(async (req, res) => {
  const commands = await listProjectCommands(projectQuery(req));
  res.json({ count: commands.length, commands });
}));

/**
 * The permission rules that would apply to a run, for `GET /api/code/permissions`.
 *
 * Returns the layers separately rather than a merged map, and that is the point:
 * a merged answer tells the user *what* is allowed but not *who said so*, and the
 * one question this endpoint exists to answer is "why is this refused?". The
 * layers come back in evaluation order, so reading them top to bottom is exactly
 * how the engine reaches its verdict.
 *
 * `?profile=` picks a profile the same way a run does, and `?mode=` supplies the
 * base mode when no profile is named — because Ask, Plan and Act resolve to
 * different baselines and showing one of them as "the" answer would be wrong for
 * the other two.
 */
agentsRouter.get('/code/permissions', wrap(async (req, res) => {
  const project = projectQuery(req);
  const mode = asEnum(queryString(req, 'mode'), 'mode', AGENT_MODES) ?? 'act';
  const selector = queryString(req, 'profile');
  const taskId = queryString(req, 'taskId');

  const profile = await resolveProfile({
    mode,
    ...(selector === undefined ? {} : { selector }),
    source: {
      load: (name) => loadAgentProfile(project, name),
      list: () => loadProjectProfiles(project),
    },
  });
  const projectRules = await loadProjectPermissions(project);
  const session = taskId === undefined ? {} : sessionPermissionRules(taskId);

  const layers = permissionLayers({
    profile,
    ...(Object.keys(projectRules).length === 0 ? {} : { project: projectRules }),
    ...(Object.keys(session).length === 0 ? {} : { session }),
  });

  res.json({
    project,
    mode,
    profile: { name: profile.name, builtin: profile.builtin, mode: profile.mode },
    // Evaluation order, and named so a client does not have to know it.
    layers: layers.map((layer) => ({ layer: layer.layer, rules: layer.rules })),
  });
}));

/**
 * Terminal execution, owned by the terminal module. Plain JSON, not SSE.
 *
 * Two kinds of caller arrive here (S17), and the difference is what the server can
 * prove about them.
 *
 * A caller presenting the id and token of a **live interactive session** is a
 * person: the token was minted by this process when they opened the session, it is
 * compared in constant time, and it dies when the session is closed or goes idle.
 * Their command is exempt from the permission engine's `ask`/`deny` evaluation —
 * asking somebody to confirm the command they just typed is a prompt with one
 * answer — and nothing else is exempted: the capability gate, the containment
 * boundary, the output bound and the audit line below all still apply.
 *
 * Any other caller is an automated execution like any other, and is evaluated by
 * the permission engine over the project's own rules. The claim is never the
 * authority: a header that says "human" is not a bypass, and there is no field on
 * this route that switches one on.
 */
agentsRouter.post(
  '/code/execute-command',
  wrap(async (req, res) => {
    const payload = body(req);
    const command = asString(payload.command, 'command');
    const cwd = asOptionalString(payload.cwd, 'cwd') ?? '.';
    const timeoutMs = asPositiveInteger(payload.timeoutMs, 'timeoutMs');

    requireTerminal();

    const human = terminalSessions.authenticate({
      sessionId: headerString(req, SESSION_HEADER),
      token: headerString(req, SESSION_TOKEN_HEADER),
    });
    if (!human.ok) {
      const verdict = await terminalCommandVerdict({ command, project: projectQuery(req) });
      if (verdict.action === 'ask') {
        throw new AppError('approval_required', `The terminal command needs approval (${describeVerdict(verdict)}).`, {
          details: { permissionKey: verdict.key, matchedLayer: verdict.layer, matchedPattern: verdict.pattern },
        });
      }
      if (verdict.action === 'deny') {
        throw new AppError('permission_denied', `The terminal command is refused by ${describeVerdict(verdict)}.`, {
          details: { permissionKey: verdict.key, matchedLayer: verdict.layer, matchedPattern: verdict.pattern },
        });
      }
    }

    const session = human.ok ? human.session : undefined;
    if (session !== undefined) {
      // Audit before the command runs, because the interesting fact is the
      // authorisation, not the outcome: a command that fails still ran with an
      // exemption. Redacted for the same reason every other log is: this line
      // outlives the session, and a credential typed as an argument must not be
      // what a reader finds here.
      log.info('terminal command accepted under a live interactive session', {
        sessionId: session.id,
        taskId: session.taskId,
        cwd,
        command: clip(redactSecrets(command), AUDIT_COMMAND_MAX),
      });
    }

    const result = await runCommand(cwd, command, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(session === undefined ? {} : { sessionId: session.id }),
      // Task ownership: a session opened against a task contains its commands to
      // that task's worktree, the same boundary an agent's shell call gets (S17).
      ...(session?.taskId == null ? {} : { taskId: session.taskId }),
    });

    res.json({
      result,
      // Stated, not implied: a client must be able to tell an exempted command from
      // an evaluated one, and so must a test.
      ...(human.ok ? { bypass: 'human_session' as const, sessionId: human.session?.id } : {}),
    });
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
