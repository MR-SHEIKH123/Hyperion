import { z } from 'zod';

/**
 * Canvas wire contracts (docs/API.md §27, milestone 1.40).
 *
 * Read-only access to a Code task's workspace, plus the sandboxed preview's
 * mint and revoke. Four shapes, and they are the whole surface: a tree, one
 * file, one diff, one minted preview.
 *
 * **The diff is a patch string, not a hunk model.** `canvasDiffSchema` says so
 * in its type rather than in a comment a caller skips past — the backend runs
 * `git diff` once and hands the text over, and a client that wanted structured
 * hunks would have to build them from this. `splitPatch` alongside the surface
 * does exactly that for the file list, and keeps the wire shape untouched.
 *
 * `passthrough()` throughout, as everywhere else in this directory: the
 * frontend asserts what it needs and ignores what a newer backend adds, rather
 * than rejecting a response for carrying a field it has not heard of.
 */

export const canvasEntrySchema = z
  .object({
    /** Workspace-relative POSIX path — never absolute, which is the seam's promise. */
    path: z.string(),
    name: z.string(),
    type: z.enum(['file', 'directory']),
    /**
     * `null` for a directory, and for a file whose size was not read.
     *
     * Deliberately not `0`-able: a caller that rendered `bytes ?? 0` would print
     * "0 B" for a directory, which is the same defect as showing a missing figure
     * as a zero.
     */
    bytes: z.number().int().nonnegative().nullable(),
    /** Present only when this directory was deliberately not walked (see `SKIPPED_DIRS`). */
    skipped: z.boolean().optional(),
  })
  .passthrough();

export const canvasTreeSchema = z
  .object({
    taskId: z.string(),
    /**
     * `worktree` is the task's own checkout; `direct` means the task works in the
     * project directory itself. A `direct` task has no base commit, which is what
     * makes its diff route answer with a refusal instead of an empty patch.
     */
    mode: z.enum(['worktree', 'direct']),
    /** The listing root, as a workspace-relative POSIX path; `.` for the whole workspace. */
    root: z.string(),
    entries: z.array(canvasEntrySchema),
    /** True when the listing stopped at `MAX_ENTRIES`/`MAX_DEPTH` rather than at the end. */
    truncated: z.boolean(),
    /** Directory names the walk declined to enter, so an omission is visible as one. */
    skipped: z.array(z.string()),
  })
  .passthrough();

export const canvasFileSchema = z
  .object({
    path: z.string(),
    content: z.string(),
    sha256: z.string(),
    bytes: z.number().int().nonnegative(),
  })
  .passthrough();

export const canvasDiffSchema = z
  .object({
    taskId: z.string(),
    /** The commit the task's worktree was cut from, as a SHA. */
    baseCommit: z.string(),
    /** One unified diff. Empty only when the tree really is unchanged. */
    patch: z.string(),
  })
  .passthrough();

export const mintedPreviewSchema = z
  .object({
    taskId: z.string(),
    /** 256-bit, hex. Short-lived: `expiresAt` is the deadline, not a hint. */
    token: z.string(),
    /** The preview URL — the origin to open, never a filesystem path. */
    url: z.string(),
    /** Epoch milliseconds, the same clock the rest of the API reports. */
    expiresAt: z.number(),
  })
  .passthrough();

export const previewRevokedSchema = z
  .object({
    revoked: z.boolean(),
  })
  .passthrough();

export type CanvasEntry = z.infer<typeof canvasEntrySchema>;
export type CanvasTree = z.infer<typeof canvasTreeSchema>;
export type CanvasFile = z.infer<typeof canvasFileSchema>;
export type CanvasDiff = z.infer<typeof canvasDiffSchema>;
export type MintedPreview = z.infer<typeof mintedPreviewSchema>;
