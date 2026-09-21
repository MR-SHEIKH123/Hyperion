import { z } from 'zod';

import { taskToolSchema } from './tasks';

/**
 * `GET /api/attention` — the queue of things waiting on the user.
 *
 * `kind` and `tool` are **enums, not strings**, and deliberately so: they decide
 * the badge a user reads and the action a row offers, so a value this frontend
 * cannot label must fail closed as `invalid_response` rather than render a generic
 * row that looks like every other kind. That is the same rule the provider
 * contracts use for `egress`/`zdr`, and it applies here for the same reason — the
 * consequence of mislabelling is a user acting on the wrong thing.
 *
 * `counts` keys are checked against the same set for display, but a kind the
 * frontend does not know is *skipped* rather than fatal: a count is a number with
 * a label beside it, not a decision, and a stale frontend should still show the
 * items it does understand. Adding a kind to the backend therefore needs both
 * this file and `labels.ts`; the exhaustiveness in `links.ts` is what makes that
 * a compile error rather than a silent gap.
 */
export const attentionKindSchema = z.enum([
  'approval_required',
  'plan_ready',
  'interrupted',
  'paused',
  'blocked',
  'ready_for_review',
  'scheduled_run_failed',
  'backup_failure',
  'spending_cap',
  'mcp_disconnected',
  // 1.31's orphaned-worktree check: a Code checkout a restart left behind that
  // holds work no task owns. Last in the list because it is disk that may be a
  // decision, not something broken.
  'orphaned_worktree',
]);

export const attentionToolSchema = z.enum(['chat', 'code', 'cowork', 'design', 'system']);

export const attentionKindList = attentionKindSchema.options;

export const attentionResolveSchema = z.object({
  method: z.literal('POST'),
  path: z.string().startsWith('/api/'),
  body: z.record(z.string(), z.unknown()).optional(),
});

export const attentionItemSchema = z
  .object({
    id: z.string().min(1),
    kind: attentionKindSchema,
    tool: attentionToolSchema,
    title: z.string().min(1),
    detail: z.string(),
    createdAt: z.number(),
    taskId: z.string().optional(),
    runId: z.string().optional(),
    chatId: z.string().optional(),
    resolve: attentionResolveSchema.optional(),
  })
  .passthrough();

export const attentionSourceSchema = z
  .object({
    source: z.string().min(1),
    status: z.enum(['ok', 'empty', 'unavailable']),
    count: z.number().int().nonnegative(),
    reason: z.string().optional(),
  })
  .passthrough();

export const attentionQueueSchema = z
  .object({
    generatedAt: z.number(),
    total: z.number().int().nonnegative(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    items: z.array(attentionItemSchema),
    sources: z.array(attentionSourceSchema),
  })
  .passthrough();

/** What `POST /api/{tool}/tasks/:taskId/approve` answers with. */
export const approvalDecisionSchema = z.enum(['allow_once', 'allow_session', 'deny']);

export const approvalResultSchema = z
  .object({
    // The approve route exists for the three task tools only — a chat is resumed,
    // not approved — so this is the same enum the task-state contract uses.
    tool: taskToolSchema,
    taskId: z.string(),
    approvalId: z.string(),
    state: z.string(),
    applied: z.boolean(),
    continuable: z.boolean(),
  })
  .passthrough();

export type AttentionItem = z.infer<typeof attentionItemSchema>;
export type AttentionQueue = z.infer<typeof attentionQueueSchema>;
export type AttentionSource = z.infer<typeof attentionSourceSchema>;
export type AttentionKind = z.infer<typeof attentionKindSchema>;
