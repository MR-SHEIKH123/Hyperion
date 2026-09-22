import {
  codeLaneSchema,
  recoveryReportSchema,
  taskApprovalsResponseSchema,
  taskStateWithUsageResponseSchema,
  type taskToolSchema,
} from '../contracts/wire/tasks';
import { request } from './client';
import type { z } from 'zod';

type TaskTool = z.infer<typeof taskToolSchema>;

/**
 * Task routes (docs/API.md §12.2–12.4).
 *
 * `getTaskState` is the reconnection path: a client whose SSE stream died asks
 * this instead, so `running` means keep waiting and the terminal states carry
 * what the stream would have delivered.
 */
export const getTaskState = (tool: TaskTool, taskId: string, signal?: AbortSignal) =>
  request(`/api/${tool}/tasks/${encodeURIComponent(taskId)}/state`, taskStateWithUsageResponseSchema, {
    ...(signal === undefined ? {} : { signal }),
  });

/**
 * What the Code lane is doing right now.
 *
 * Deliberately the lane's *live* view rather than a task history: a finished task
 * disappears, which is what scratch space means. The rail therefore shows what is
 * running, what is queued, and what is parked holding a worktree — and says so.
 */
export const getCodeLane = (signal?: AbortSignal) =>
  request('/api/code/tasks', codeLaneSchema, { ...(signal === undefined ? {} : { signal }) });

/**
 * What an interrupted task run left behind, and which recoveries apply (§12.4a).
 *
 * A read, not a probe: it answers `interrupted: false` for a run that turned out
 * to be finished, keeps its step list bounded with totals over all of it, and
 * never guesses whether a leftover checkout is safe to remove. The screen renders
 * those answers; nothing here interprets them.
 */
export const getTaskRecovery = (tool: TaskTool, taskId: string, signal?: AbortSignal) =>
  request(`/api/${tool}/tasks/${encodeURIComponent(taskId)}/recovery`, recoveryReportSchema, {
    ...(signal === undefined ? {} : { signal }),
  });

/**
 * What this task is waiting on: the parked calls, with their arguments verbatim
 * (§12.5).
 *
 * The task surface is where the full three-way decision belongs — the Attention
 * Center offers `allow_once` and `deny` inline and says so, because a standing
 * `allow_session` is a decision about a rule and needs the task's context in front
 * of the person making it. This read is that context: the call, the layer that
 * refused it, and the deadline.
 */
export const getTaskApprovals = (tool: TaskTool, taskId: string, signal?: AbortSignal) =>
  request(`/api/${tool}/tasks/${encodeURIComponent(taskId)}/approvals`, taskApprovalsResponseSchema, {
    ...(signal === undefined ? {} : { signal }),
  });

/** The decision endpoint for this task, as the queue item's own `resolve.path` spells it. */
export const taskApprovalPath = (tool: TaskTool, taskId: string): string =>
  `/api/${tool}/tasks/${encodeURIComponent(taskId)}/approve`;
