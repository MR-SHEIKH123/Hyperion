import {
  codeLaneSchema,
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
