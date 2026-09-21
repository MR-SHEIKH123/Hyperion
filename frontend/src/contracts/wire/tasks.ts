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

/**
 * One row of `task_steps` — what a run actually did, as it did it (§12.4a).
 *
 * `kind` is a plain string rather than an enum on purpose. Migration `017` dropped
 * the CHECK that used to constrain that column specifically so a new kind could be
 * added without a table rebuild, and the TypeScript union is now the only
 * definition; a panel that refused to render an unfamiliar kind would reintroduce,
 * in the client, the rigidity the backend deliberately removed.
 *
 * Every count is nullable and null means "the provider reported none" — never 0,
 * which renders as a step that was free.
 */
export const taskStepSchema = z.object({
  runId: z.string(),
  step: z.number().int(),
  mode: z.enum(['ask', 'plan', 'act']).nullable(),
  kind: z.string(),
  profile: z.string().nullable(),
  provenance: z.string().nullable(),
  toolName: z.string().nullable(),
  ok: z.boolean().nullable(),
  detail: z.string().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  cacheReadTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  createdAt: z.number(),
}).passthrough();

/**
 * Totals over *every* step of a run, computed in SQL.
 *
 * `complete: false` means at least one step had no count to add, so the token
 * totals are a floor. Carried through rather than smoothed over, for the same
 * reason `TaskUsage.unpricedRequests` is: a number that quietly understates a run
 * reads as authoritative.
 */
export const taskStepSummarySchema = z.object({
  steps: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  compressions: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  complete: z.boolean(),
}).passthrough();

/**
 * A checkout a restart left behind that still holds a task's edits (§12.4a).
 *
 * `risk` is why removing it would lose something and `checked` says whether that
 * question could be answered at all — `risk: null, checked: false` must not render
 * as "provably empty".
 */
export const orphanedWorktreeSchema = z.object({
  name: z.string(),
  dir: z.string(),
  taskId: z.string(),
  lastModified: z.number(),
  risk: z.string().nullable(),
  checked: z.boolean(),
}).passthrough();

/**
 * What an interrupted run left, and which of the three recoveries apply
 * (`GET /api/{tool}/tasks/:taskId/recovery`, docs/API.md §12.4a).
 *
 * `interrupted: false` is a normal answer, not an error: the state the caller
 * asked about can have moved on between the list and the click, and "it finished,
 * there is nothing to recover" is more useful than a 404.
 */
export const recoveryReportSchema = z.object({
  run: taskStateResponseSchema.shape.run,
  interrupted: z.boolean(),
  stop: z.object({
    code: z.string().nullable(),
    message: z.string().nullable(),
    at: z.number().nullable(),
  }).nullable(),
  partial: z.object({
    steps: z.array(taskStepSchema),
    summary: taskStepSummarySchema,
    /** Steps left out of `steps` by the tail bound. Zero for most runs. */
    omitted: z.number().int().nonnegative(),
    lastStepAt: z.number().nullable(),
    conversation: z.object({ durable: z.boolean(), messages: z.number().int().nonnegative() }),
  }).passthrough(),
  worktree: orphanedWorktreeSchema.nullable(),
  actions: z.object({
    resume: z.object({ possible: z.boolean(), reason: z.string().nullable() }),
    discard: z.object({
      possible: z.boolean(),
      name: z.string().nullable(),
      requiresForce: z.boolean(),
      reason: z.string().nullable(),
    }),
  }).passthrough(),
}).passthrough();

/** What a discard removed, and the fresh scan it answered with (§8.1). */
export const discardWorktreeResponseSchema = z.object({
  name: z.string(),
  method: z.string(),
  lostReason: z.string().nullable(),
}).passthrough();
