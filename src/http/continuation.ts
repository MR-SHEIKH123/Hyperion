/**
 * Task-run continuation: turning a park into a pause.
 *
 * Before 1.27 a parked task run was a dead end. `db/taskRuns.ts` said so
 * outright — *"unlike a chat run there is no resume path"* — and yet three park
 * reasons already existed and were presented to the user as pauses. `plan_ready`
 * invited an approval that could only be acted on by re-running the task from
 * scratch; `redaction_blocked` and `zdr_blocked` were unreachable in production
 * for an unrelated reason and would have been dead ends if they had fired.
 *
 * Continuation needs three things to be true at once, which is why they landed
 * together rather than as separate features:
 *
 *   1. **The conversation is durable.** `db/taskMessages.ts` snapshots it at each
 *      stopping point. Without this there is nothing to resume *from*.
 *   2. **The worktree survives.** `holdWorktree` keeps the directory and its
 *      uncommitted edits across a park. Without this a Code continuation resumes
 *      into an empty checkout and silently redoes work.
 *   3. **The user's decision becomes a rule.** An approval resolves into the
 *      session permission layer, so replaying the call reaches a different verdict
 *      than the one that stopped it. Without this the continuation parks again on
 *      the same call, forever.
 *
 * ## The claim is the mutex
 *
 * `claimParkedRun` flips `blocked`/`ready_for_review` to `running` in one
 * conditional UPDATE. Two clients answering the same prompt — a phone and a laptop
 * showing the same task — must not both start an agent against one worktree, and a
 * read-then-write would let both through. The loser gets a coded 409.
 *
 * The claim happens **before** the lane is awaited, so a queued continuation is
 * already marked `running`. That matches what `http/agents.ts` does for a fresh run
 * and is what keeps the mutex effective while queued: a park that stayed parked
 * until a slot opened could be claimed twice.
 *
 * ## Why an explicit route rather than overloading run-task
 *
 * `POST /run-task` with the same `taskId` is how a user re-runs work. Continuation
 * replays a stored conversation and applies stored decisions, which is a different
 * operation with different failure modes — and one that must never happen by
 * accident, because it resumes an agent mid-thought with tools already authorised.
 */

import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { requireAgent, type AgentTool } from '../orchestrator/agents.ts';
import { createAgentContext } from '../orchestrator/agentContext.ts';
import { CANCEL_REASON, registerCancellable } from '../orchestrator/cancel.ts';
import { concurrencyMode } from '../db/settings.ts';
import { withCodeLane, withLock } from '../orchestrator/lock.ts';
import { openStream } from '../orchestrator/sse.ts';
import { findChat } from '../db/chats.ts';
import {
  getApproval,
  listPendingApprovals,
  resolveApproval,
  APPROVAL_DECISIONS,
} from '../db/approvals.ts';
import { hasConversation, loadConversation } from '../db/taskMessages.ts';
import {
  claimParkedRun,
  finishTaskRun,
  getTaskRun,
  latestRunForTask,
  startTaskRun,
  updateTaskRunState,
  type TaskRunTool,
} from '../db/taskRuns.ts';
import { nextStepNumber, recordStep } from '../db/taskSteps.ts';
import { provisionWorktree } from '../services/code/worktree.ts';
import { AppError, toAppError } from '../util/errors.ts';
import { createLogger } from '../util/logger.ts';
import { wrap } from './errors.ts';
import { asEnum, asString, body, pathParam } from './params.ts';

import type { Request, Response } from 'express';
import type { TaskInput, TaskResult } from '../types/core.ts';
import type { ApprovalDecision } from '../db/approvals.ts';
import type { TaskRun } from '../db/taskRuns.ts';

export const continuationRouter: Router = Router();

const log = createLogger('continue:http');

/**
 * A run that can be continued, or the reason it cannot.
 *
 * Every refusal is a 409 rather than a 404 or a 400, because in each case the task
 * genuinely exists and the request is well-formed — what is wrong is the state it
 * is in, which is exactly what a conflict means. Each carries a distinct
 * `details.reason` so a client can say *why* rather than showing one generic
 * message for five different situations.
 */
function requireContinuable(tool: TaskRunTool, taskId: string): TaskRun {
  const run = latestRunForTask(tool, taskId);
  if (run === null) {
    throw new AppError('not_found', `No ${tool} task run recorded for "${taskId}".`, {
      details: { taskId },
    });
  }

  if (run.state !== 'blocked' && run.state !== 'ready_for_review') {
    throw new AppError('conflict', `This ${tool} task is not parked, so there is nothing to continue.`, {
      details: { taskId, runId: run.runId, state: run.state, reason: 'not_parked' },
    });
  }

  // A park with no snapshot cannot be continued, and the honest answer is to say
  // so. An agent that supplies no `LoopContextAccess` parks without one by design
  // — it rebuilds its prompt each turn — and continuing from an empty conversation
  // would re-run the task's first turn while claiming to resume it.
  if (!hasConversation(taskId)) {
    throw new AppError(
      'conflict',
      'This task parked without a stored conversation, so it cannot be continued. Start it again instead.',
      { details: { taskId, runId: run.runId, reason: 'no_snapshot' } },
    );
  }

  return run;
}

/**
 * Resolve the approval a continuation is answering, if any.
 *
 * Returns the decision so the caller can record it, and throws when the approval
 * belongs to a different task — an id from another task would otherwise let a
 * decision made in one place authorise a call in another.
 */
function applyDecision(
  taskId: string,
  approvalId: string | undefined,
  decision: ApprovalDecision | undefined,
): { approvalId: string; decision: ApprovalDecision } | null {
  if (approvalId === undefined) return null;
  if (decision === undefined) {
    throw new AppError('bad_request', 'A decision is required when an approvalId is supplied.', {
      details: { field: 'decision', allowed: APPROVAL_DECISIONS },
    });
  }

  const approval = getApproval(approvalId);
  if (approval === null || approval.taskId !== taskId) {
    throw new AppError('not_found', `No approval "${approvalId}" was found for this task.`, {
      details: { field: 'approvalId', taskId },
    });
  }

  const { applied } = resolveApproval(approvalId, decision);
  if (!applied) {
    throw new AppError('conflict', 'That approval has already been resolved.', {
      details: { approvalId, state: getApproval(approvalId)?.state, reason: 'already_resolved' },
    });
  }
  return { approvalId, decision };
}

/**
 * Finalise a run the user denied, without starting an agent.
 *
 * `stopped` rather than `error`: nothing broke. A denied doom-loop additionally
 * records `loop_detected`, which is what that reason now means — the terminal
 * outcome of a repetition the user declined to continue, rather than the automatic
 * kill it used to be.
 */
function finishDenied(run: TaskRun, taskId: string, doomLoop: boolean): void {
  finishTaskRun(run.runId, 'stopped', {
    pauseReason: doomLoop ? 'loop_detected' : 'approval_denied',
  });
  recordStep({
    runId: run.runId,
    step: nextStepNumber(run.runId),
    kind: 'approval',
    ok: true,
    detail: doomLoop
      ? 'loop_detected: the user declined to continue a repeated call'
      : 'the user denied the pending approval',
  });
  log.info(`task ${taskId}: continuation denied, run finished as stopped`);
}

interface ContinueBody {
  approvalId?: string | undefined;
  decision?: ApprovalDecision | undefined;
}

function parseContinueBody(req: Request): ContinueBody {
  const payload = body(req);
  const approvalId =
    payload.approvalId === undefined || payload.approvalId === null
      ? undefined
      : asString(payload.approvalId, 'approvalId');
  const decision = asEnum(payload.decision, 'decision', APPROVAL_DECISIONS);
  return { approvalId, decision };
}

/**
 * `POST /api/{tool}/tasks/:taskId/continue`.
 *
 * Validation, the claim and module lookup all happen **before** the response
 * becomes an event stream, so every refusal above is JSON a client can read rather
 * than an error buried in an SSE frame. That is the same discipline `runTaskRoute`
 * follows and the reason the claim is not deferred into the lane callback.
 */
function continueTaskRoute(tool: AgentTool) {
  return (req: Request, res: Response, next: (error?: unknown) => void): void => {
    let run: TaskRun;
    let decided: { approvalId: string; decision: ApprovalDecision } | null;
    let input: TaskInput;
    let agent: ReturnType<typeof requireAgent>;
    const taskId = pathParam(req, 'taskId');

    try {
      const parsed = parseContinueBody(req);
      run = requireContinuable(tool as TaskRunTool, taskId);
      agent = requireAgent(tool);
      decided = applyDecision(taskId, parsed.approvalId, parsed.decision);

      // A denial ends the run here. There is no agent to start: the user's answer
      // was "do not do this", and running the loop again would immediately re-park
      // on the same call.
      if (decided?.decision === 'deny') {
        finishDenied(run, taskId, run.pauseReason === 'doom_loop');
        res.json({
          tool,
          taskId,
          runId: run.runId,
          continued: false,
          state: 'stopped',
          decision: 'deny',
        });
        return;
      }

      // The mutex. Claimed before the lane is awaited, so a queued continuation
      // cannot be claimed a second time while it waits — see the module header.
      if (!claimParkedRun(run.runId)) {
        throw new AppError('conflict', 'This task is already being continued.', {
          details: { taskId, runId: run.runId, state: getTaskRun(run.runId)?.state, reason: 'already_claimed' },
        });
      }

      input = continuationInput(tool, taskId, run);
    } catch (error) {
      next(error);
      return;
    }

    // A fresh run id: the parked run's cancellable was disposed in its own
    // `finally`, so a continuation has to be separately stoppable rather than
    // inheriting a registration that no longer exists.
    const continuationRunId = randomUUID();
    const cancellable = registerCancellable(continuationRunId, tool, taskId);
    const sse = openStream(res);

    const finishCancelled = (): void => {
      try {
        finishTaskRun(continuationRunId, 'stopped', { pauseReason: CANCEL_REASON });
      } catch (error) {
        log.warn(`continuation ${continuationRunId}: recording stopped failed: ${String(error)}`);
      }
      sse.emit('agent', { channel: 'stopped', tool, chatId: input.chatId, taskId, reason: CANCEL_REASON });
    };

    const drive = async (): Promise<TaskResult | undefined> => {
      // A second `task_runs` row, not a reuse of the parked one. The park is a
      // finished attempt with its own step history, and `startTaskRun` is
      // `INSERT OR REPLACE` — writing the continuation under the old id would
      // cascade that history away, which is precisely the record explaining why
      // the run stopped in the first place.
      startTaskRun({
        runId: continuationRunId,
        taskId,
        tool: tool as TaskRunTool,
        chatId: linkedChatId(input.chatId),
      });
      // The parked row is left `running` by the claim and would stay that way
      // forever otherwise, so it is closed out as superseded.
      supersede(run.runId, continuationRunId);

      if (tool === 'code') {
        // Returns the *same* directory, because the park held it. This is the
        // point of D12 and the reason a continuation is a continuation.
        const worktree = await provisionWorktree(taskId, input.cwd ?? '.');
        sse.emit('agent', {
          channel: 'started',
          tool,
          chatId: input.chatId,
          taskId,
          continued: true,
          mode: worktree.mode,
          dir: worktree.dir,
        });
      }

      const ctx = createAgentContext({
        tool,
        chatId: input.chatId,
        modelId: input.modelId,
        sse,
        taskId,
        runId: continuationRunId,
        cancelSignal: cancellable.signal,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      });
      const result = await agent.runTask(input, ctx);
      sse.emit('agent', { channel: 'result', tool, chatId: input.chatId, taskId, ...result });
      return result;
    };

    // The same concurrency primitive the original run used. A continuation is a
    // real agent run — it edits files and spends tokens — so exempting it from the
    // lane would let it run alongside the very work the lane exists to serialise.
    const lane = tool === 'code'
      ? withCodeLane(
          {
            tool: 'code',
            label: `continue:${input.chatId}:${taskId}`,
            mode: concurrencyMode(),
            signal: AbortSignal.any([sse.signal, cancellable.signal]),
            taskId,
          },
          drive,
        )
      : withLock(
          {
            tool,
            label: `continue:${tool}:${taskId}`,
            mode: concurrencyMode(),
            signal: AbortSignal.any([sse.signal, cancellable.signal]),
          },
          drive,
        );

    void lane
      .then(() => {
        if (cancellable.cancelled) finishCancelled();
        else settleContinuation(continuationRunId);
      })
      .catch((error: unknown) => {
        if (cancellable.cancelled) {
          finishCancelled();
          return;
        }
        const failure = toAppError(error);
        try {
          if (getTaskRun(continuationRunId)?.state === 'running') {
            finishTaskRun(continuationRunId, 'error', {
              code: failure.code,
              message: failure.message,
            });
          }
        } catch (writeError) {
          log.warn(`continuation ${continuationRunId}: recording error failed: ${String(writeError)}`);
        }
        sse.sendError(error);
      })
      .finally(() => {
        cancellable.dispose();
        sse.close();
      });
  };
}

/**
 * Mark the continuation's outcome, without overwriting a fresh park.
 *
 * A continuation can park again — a second approval, a ceiling — and that state is
 * already written by the loop. `finishTaskRun` rewrites the pause and error
 * columns, so stamping `complete` over it would erase the thing the user now has to
 * answer. Only a run still `running` is finished here.
 */
function settleContinuation(runId: string): void {
  try {
    if (getTaskRun(runId)?.state !== 'running') return;
    finishTaskRun(runId, 'complete');
  } catch (error) {
    log.warn(`continuation ${runId}: recording complete failed: ${String(error)}`);
  }
}

/**
 * Close out the run a continuation replaces.
 *
 * The claim moved it to `running` to win the race, and nothing else will ever touch
 * it — leaving it there would make a superseded attempt look live to
 * `reconcileOrphanedTaskRuns`, which would then demote it to `error` on the next
 * boot and report a failure that never happened.
 */
function supersede(parkedRunId: string, continuationRunId: string): void {
  try {
    finishTaskRun(parkedRunId, 'complete', { pauseReason: `continued_as:${continuationRunId}` });
  } catch (error) {
    log.warn(`run ${parkedRunId}: could not mark it superseded: ${String(error)}`);
  }
}

/**
 * Rebuild the task input for a continuation.
 *
 * The prompt is deliberately **not** the original one. The conversation snapshot
 * already holds it, along with everything that happened since, and re-sending the
 * original as a fresh user turn would have the model read its own task description
 * twice — once as history and once as a new instruction.
 *
 * Agents rebuild their own system prompt on a continuation, which is correct rather
 * than wasteful: the profile, project rules and session permissions may all have
 * changed while the task was parked, and that change is usually the reason the user
 * continued it.
 */
function continuationInput(tool: AgentTool, taskId: string, run: TaskRun): TaskInput {
  const messages = loadConversation(taskId);
  const lastUser = messages.filter((message) => message.role === 'user').at(-1);

  return {
    tool,
    chatId: run.chatId ?? taskId,
    // The model is resolved per turn from the active provider, and a continuation
    // may legitimately run on a different one — a ZDR park lifts precisely because
    // the provider changed. The stored id is a starting point, not a requirement.
    modelId: '',
    prompt: lastUser?.content ?? '',
    mode: 'act',
    options: { continueTaskId: taskId },
  };
}

/**
 * `chat_id` is a real foreign key, so an id naming no chat is stored NULL — same
 * reasoning as `http/agents.ts`'s own `linkedChatId`.
 */
function linkedChatId(chatId: string): string | undefined {
  return findChat(chatId) === null ? undefined : chatId;
}

continuationRouter.post('/code/tasks/:taskId/continue', continueTaskRoute('code'));
continuationRouter.post('/cowork/tasks/:taskId/continue', continueTaskRoute('cowork'));
continuationRouter.post('/design/tasks/:taskId/continue', continueTaskRoute('design'));

// --- approvals ---------------------------------------------------------------

/**
 * `GET /api/{tool}/tasks/:taskId/approvals` — what this task is waiting on.
 *
 * `arguments` are returned verbatim, because the point of showing an approval is
 * that the user can see exactly what would run. A summarised or reformatted call is
 * a different call from the one they would be authorising.
 */
function listApprovalsRoute(tool: TaskRunTool) {
  return wrap(async (req: Request, res: Response) => {
    const taskId = pathParam(req, 'taskId');
    const run = latestRunForTask(tool, taskId);
    const pending = listPendingApprovals(taskId);
    res.json({
      tool,
      taskId,
      state: run?.state ?? null,
      pauseReason: run?.pauseReason ?? null,
      count: pending.length,
      approvals: pending.map((approval) => ({
        id: approval.id,
        toolName: approval.toolName,
        arguments: approval.arguments,
        permissionKey: approval.permissionKey,
        matchedLayer: approval.matchedLayer,
        matchedPattern: approval.matchedPattern,
        reason: approval.reason,
        createdAt: approval.createdAt,
      })),
    });
  });
}

continuationRouter.get('/code/tasks/:taskId/approvals', listApprovalsRoute('code'));
continuationRouter.get('/cowork/tasks/:taskId/approvals', listApprovalsRoute('cowork'));
continuationRouter.get('/design/tasks/:taskId/approvals', listApprovalsRoute('design'));

/**
 * `POST /api/{tool}/tasks/:taskId/approve` — record a decision.
 *
 * Deliberately does **not** start the agent. `POST .../continue` does that, and
 * keeping them apart means a client can record a decision from a notification
 * without committing to drive the run from that connection — which matters because
 * continuing is an SSE stream and answering a prompt is a single JSON call.
 *
 * Idempotent: approving an already-resolved approval returns the state it actually
 * reached rather than failing. Answering a moment after somebody else did is a race
 * the user cannot avoid, and `cancelTaskRoute` takes the same position on a run
 * that has already ended.
 */
function approveRoute(tool: TaskRunTool) {
  return wrap(async (req: Request, res: Response) => {
    const taskId = pathParam(req, 'taskId');
    const payload = body(req);
    const approvalId = asString(payload.approvalId, 'approvalId');
    const decision = asEnum(payload.decision, 'decision', APPROVAL_DECISIONS);
    if (decision === undefined) {
      throw new AppError('bad_request', 'decision is required.', {
        details: { field: 'decision', allowed: APPROVAL_DECISIONS },
      });
    }

    const existing = getApproval(approvalId);
    if (existing === null || existing.taskId !== taskId) {
      throw new AppError('not_found', `No approval "${approvalId}" was found for this task.`, {
        details: { field: 'approvalId', taskId },
      });
    }

    const { approval, applied } = resolveApproval(approvalId, decision);
    const run = latestRunForTask(tool, taskId);

    if (applied && decision === 'deny' && run !== null && isParked(run)) {
      finishDenied(run, taskId, run.pauseReason === 'doom_loop');
    }

    res.json({
      tool,
      taskId,
      approvalId,
      state: approval.state,
      applied,
      // Says whether the caller still has work to do. A denial has already
      // finalised the run; an allowance is waiting for someone to continue it.
      continuable:
        approval.state === 'allow_once' || approval.state === 'allow_session'
          ? hasConversation(taskId)
          : false,
    });
  });
}

function isParked(run: TaskRun): boolean {
  return run.state === 'blocked' || run.state === 'ready_for_review';
}

continuationRouter.post('/code/tasks/:taskId/approve', approveRoute('code'));
continuationRouter.post('/cowork/tasks/:taskId/approve', approveRoute('cowork'));
continuationRouter.post('/design/tasks/:taskId/approve', approveRoute('design'));
