import { approvalDecisionSchema, approvalResultSchema, attentionQueueSchema } from '../contracts/wire/attention';
import { request } from './client';

import type { z } from 'zod';

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const getAttention = (signal?: AbortSignal) =>
  request('/api/attention', attentionQueueSchema, { ...(signal === undefined ? {} : { signal }) });

/**
 * Answer a parked call from the queue.
 *
 * `path` is whatever the item's `resolve.path` said — the backend owns its URLs and
 * this frontend does not re-derive them — and the decision is the same vocabulary
 * the task view uses (`allow_once` / `allow_session` / `deny`).
 *
 * Allowing does **not** resume the run: the response's `continuable` says whether
 * there is a conversation to continue, and continuing is a separate call the task
 * surface makes. A queue that silently started a continuation would be starting a
 * stream with nowhere to render it.
 */
export const decideApproval = (
  path: string,
  body: { approvalId: string; decision: ApprovalDecision },
) => request(path, approvalResultSchema, { method: 'POST', body });
