import {
  canvasDiffSchema,
  canvasFileSchema,
  canvasTreeSchema,
  mintedPreviewSchema,
  previewRevokedSchema,
} from '../contracts/wire/canvas';
import { request } from './client';

/**
 * The Canvas reads and the preview's two commands (docs/API.md §27, 1.40).
 *
 * Four reads and a mint/revoke pair, in the order a surface needs them: list a
 * directory, read one file, diff the task against its base commit, then put a
 * preview of it on screen. The reads are queries — a listing and a diff are
 * facts about work already done — and the preview pair is the only thing here
 * that changes server state, which is why it is the only thing with a method
 * other than GET.
 *
 * **Every path goes through `encodeURIComponent` and one parameter.** The
 * backend refuses a query key that arrives more than once (`querySingleString`),
 * so a caller cannot smuggle an array through by accident — and `?path=` is
 * required by `GET .../file` rather than defaulted, because "which file" is not
 * a question with a sensible default the way "which directory" is.
 *
 * A `direct`-mode task has no base commit, and `getTaskDiff` surfaces the
 * exporter's own 400 through `responseError` — the refusal is rendered as the
 * reasoned sentence the backend wrote, never as an empty change list.
 */

/** One directory of the task's workspace, breadth-first and bounded. */
export const getTaskFiles = (taskId: string, path = '.', signal?: AbortSignal) =>
  request(
    `/api/code/tasks/${encodeURIComponent(taskId)}/files?path=${encodeURIComponent(path)}`,
    canvasTreeSchema,
    { ...(signal === undefined ? {} : { signal }) },
  );

/** One file's contents, with the digest and size the backend computed. */
export const getTaskFile = (taskId: string, path: string, signal?: AbortSignal) =>
  request(
    `/api/code/tasks/${encodeURIComponent(taskId)}/file?path=${encodeURIComponent(path)}`,
    canvasFileSchema,
    { ...(signal === undefined ? {} : { signal }) },
  );

/** The task's work, diffed against the commit its worktree was cut from. */
export const getTaskDiff = (taskId: string, signal?: AbortSignal) =>
  request(`/api/code/tasks/${encodeURIComponent(taskId)}/diff`, canvasDiffSchema, {
    ...(signal === undefined ? {} : { signal }),
  });

/**
 * Put a preview on the second listener and hand back its URL.
 *
 * Re-minting replaces the previous session for this task, so a caller that
 * already holds a URL should treat this as "the new one" rather than "another
 * one" — there is at most one preview per task, by design.
 */
export const mintPreview = (taskId: string, signal?: AbortSignal) =>
  request(`/api/code/tasks/${encodeURIComponent(taskId)}/preview`, mintedPreviewSchema, {
    method: 'POST',
    ...(signal === undefined ? {} : { signal }),
  });

/** Take the preview down. `revoked: false` means there was nothing to revoke. */
export const revokePreview = (taskId: string, signal?: AbortSignal) =>
  request(`/api/code/tasks/${encodeURIComponent(taskId)}/preview`, previewRevokedSchema, {
    method: 'DELETE',
    ...(signal === undefined ? {} : { signal }),
  });
