import { z } from 'zod';
export const taskToolSchema = z.enum(['code','cowork','design']);
export const taskRunStateSchema = z.enum(['running','paused','blocked','ready_for_review','complete','error','stopped','interrupted']);
/**
 * The Code lane's live view (`GET /api/code/tasks`, docs/API.md §12.2).
 *
 * Deliberately not a journal: a finished task disappears, which is what scratch
 * space means. `held` is reported separately from `active` because a parked task
 * holds disk but not a lane slot — counting it as running would misreport
 * capacity, and omitting it would make a deliberately retained directory look
 * like a leaked one.
 */
export const codeLaneSchema = z.object({
  running: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  queued: z.number().int().nonnegative(),
  active: z.array(z.object({
    id: z.string(),
    taskId: z.string().nullable(),
    label: z.string().nullable(),
    startedAt: z.number(),
    worktree: z.string().nullable(),
  }).passthrough()),
  held: z.array(z.object({
    taskId: z.string(),
    worktree: z.string(),
    branch: z.string(),
    heldSince: z.number(),
    state: taskRunStateSchema.nullable(),
  }).passthrough()),
}).passthrough();

export const taskStateResponseSchema = z.object({ run:z.object({
  runId:z.string(), taskId:z.string(), tool:taskToolSchema, state:taskRunStateSchema,
  pauseReason:z.string().nullable(), errorCode:z.string().nullable(), errorMessage:z.string().nullable(),
  startedAt:z.number(), updatedAt:z.number(), completedAt:z.number().nullable(),
}).passthrough() }).passthrough();
/**
 * The task's recorded spend (docs/API.md §12.4, Master Plan v4 §6.2).
 *
 * `requests: 0` means nothing was recorded — not that the work was free — and
 * `costUsd` is null unless a price matched, with `priced` saying whether the
 * figure is the whole bill. Both are carried through to the UI unchanged: a
 * summary that rendered `$0.00` for "unpriced" would be the exact mistake the
 * backend's shape exists to prevent.
 */
export const taskUsageSchema = z.object({
  requests: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  costUsd: z.number().nullable(),
  priced: z.boolean(),
  // Required, like the backend's `TaskUsage`: a missing count must not be read as
  // "no unpriced requests", which is the one reading that overstates the figure.
  unpricedRequests: z.number().int().nonnegative(),
}).passthrough();
export const taskStateWithUsageResponseSchema = z.object({ run:taskStateResponseSchema.shape.run, usage:taskUsageSchema.optional() }).passthrough();
