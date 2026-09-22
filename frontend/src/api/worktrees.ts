import { discardWorktreeResponseSchema } from '../contracts/wire/tasks';
import { request } from './client';

/**
 * Orphaned checkouts a restart left behind — `GET /api/storage/worktrees` and the
 * one destructive call in the storage surface (docs/API.md §8.1).
 *
 * `discardWorktree` is only reachable from a screen that has already shown the
 * user what a discard would lose, because the backend refuses a directory holding
 * work unless `force` is passed and that refusal is a `409` naming the reason. The
 * two-step is deliberate on both sides: the service will not delete a checkout
 * with uncommitted edits on a bare request, and this client will not send `force`
 * unless the user asked for it a second time.
 */
export const discardWorktree = (name: string, options: { force?: boolean }, signal?: AbortSignal) =>
  request(`/api/storage/worktrees/${encodeURIComponent(name)}/discard`, discardWorktreeResponseSchema, {
    method: 'POST',
    body: { force: options.force === true },
    ...(signal === undefined ? {} : { signal }),
  });
