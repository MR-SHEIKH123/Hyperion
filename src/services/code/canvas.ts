/**
 * The Code Canvas — a read-only view of what a task's workspace contains.
 *
 * A Code task works in a directory nobody can see. The lane listing
 * (`GET /api/code/tasks`) says a task is running; the export route hands back a
 * patch; neither answers "what files are there" or "what does this one say",
 * which is the question somebody asks before trusting a diff. This module is
 * the data half of that answer, and the preview listener is the browser half.
 *
 * Three properties are deliberate:
 *
 *   - **No path validation lives here.** `canvasServices` builds the same
 *     services object `orchestrator/agentContext.ts` builds for the agent —
 *     `resolvePath` bound to `containAgentCwd(taskId)` — and every path goes
 *     through `files.ts`. The symlink refusal, the per-task subtree boundary
 *     and the `.git` refusal are therefore one implementation, not two that
 *     drift until one of them is the way in.
 *   - **Nothing writes.** No `emit` is wired, and this module has no writer at
 *     all: reads cannot arm a git config, and a viewer has no business
 *     producing artifact versions.
 *   - **Bounded by construction.** A workspace can be a `node_modules` tree a
 *     million files deep, so the walk is breadth-first under `MAX_ENTRIES`,
 *     `MAX_DEPTH` and `SKIPPED_DIRS`, and it *reports* what it left out rather
 *     than returning a short list that reads like the whole truth.
 */
import fs from 'node:fs';
import path from 'node:path';

import { containAgentCwd, getWorktree } from './worktree.ts';
import { isGitPathSegment, readCodeFile, resolveCodePath } from './files.ts';
import { exportCodeTask } from '../export/index.ts';
import { AppError } from '../../util/errors.ts';

import type { CodeFileServices } from './files.ts';
import type { Worktree } from './worktree.ts';

/** Most entries one listing may return, before it reports itself truncated. */
export const MAX_ENTRIES = 2000;

/** Deepest directory (in path segments below the listing root) the walk descends. */
export const MAX_DEPTH = 12;

/**
 * Largest file the viewer will read into a JSON response.
 *
 * Checked with a `stat` before the read, so an oversized file costs a stat
 * rather than a 200 MB string, and the refusal carries the size so the UI can
 * say "4.1 MB, too large to show" instead of "error".
 */
export const MAX_VIEW_BYTES = 2 * 1024 * 1024;

/** Upper bound on the patch text returned to a browser, in UTF-8 bytes. */
export const MAX_CANVAS_DIFF_BYTES = 4 * 1024 * 1024;

/**
 * Directories the walk does not descend into.
 *
 * Not a security boundary — they are ordinary directories inside the task's own
 * subtree — but every one of them is a build artifact or a dependency tree:
 * enormous, generated, and never what somebody opened a Canvas to read. The
 * name is reported in `CanvasTree.skipped` so the omission is visible rather
 * than looking like an empty directory.
 */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  '.venv',
  '__pycache__',
]);

export interface CanvasEntry {
  path: string;
  name: string;
  type: 'file' | 'directory' | 'symlink';
  bytes: number | null;
  skipped?: boolean;
}

export interface CanvasTree {
  taskId: string;
  mode: 'worktree' | 'direct';
  /** The listing root, as a workspace-relative POSIX path; `.` for the whole workspace. */
  root: string;
  entries: CanvasEntry[];
  truncated: boolean;
  skipped: string[];
}

export interface CanvasFile {
  path: string;
  content: string;
  sha256: string;
  bytes: number;
}

export interface CanvasDiff {
  taskId: string;
  baseCommit: string;
  patch: string;
  truncated: boolean;
}

/**
 * The services object a read-only Canvas consumer resolves paths with.
 *
 * Deliberately the same shape `orchestrator/agentContext.ts` hands the agent:
 * `resolvePath` is `containAgentCwd` bound to this task, so a Canvas path is
 * resolved inside *this task's* subtree (worktree or project directory) rather
 * than anywhere in the projects scope. There is no `emit`, because nothing in
 * this module writes.
 *
 * The task must already exist; callers get that from `requireWorktree`, which
 * is also where an unknown task id becomes a 404 rather than a path resolved
 * against whatever scope happens to be active.
 */
export function canvasServices(taskId: string): CodeFileServices {
  return {
    taskId,
    resolvePath: (candidate: string): string => containAgentCwd(candidate, taskId),
  };
}

/**
 * A task's workspace record, or a 404.
 *
 * The wording matches `exportCodeTask`'s, because it is the same question about
 * the same object: a task with no registered workspace is not one this process
 * can show anything for.
 */
export function requireWorktree(taskId: string): Worktree {
  const worktree = getWorktree(taskId);
  if (worktree === undefined) {
    throw new AppError('not_found', `No active code task with id "${taskId}".`, {
      details: { taskId },
    });
  }
  return worktree;
}

/** A path as the listing spells it: POSIX separators, no empty segments. */
function joinRelative(base: string, name: string): string {
  return base === '' ? name : `${base}/${name}`;
}

/** Stable, locale-independent ordering, so a listing is diffable between calls. */
function byName(a: fs.Dirent, b: fs.Dirent): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function sizeOrNull(absolute: string): number | null {
  try {
    const stats = fs.statSync(absolute);
    return stats.isFile() ? stats.size : null;
  } catch {
    // A file can vanish between the readdir and the stat — a task is editing
    // this directory while the listing is taken. "Size unknown" is the honest
    // answer, and a listing is not worth failing a request over.
    return null;
  }
}

/**
 * The listing root, resolved through the one seam.
 *
 * `.` is handled here rather than in `files.ts` because `locate` refuses it by
 * design: a *file* path must name a file, and a listing root is the one
 * legitimate way to name the workspace itself. The path is still resolved by
 * `containAgentCwd` through `canvasServices`, so the boundary is unchanged;
 * every other candidate goes through `resolveCodePath` and inherits all of its
 * checks.
 */
function listingRoot(
  candidate: string,
  services: CodeFileServices,
): { absolute: string; relative: string } {
  const trimmed = candidate.trim().replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '.') {
    return { absolute: services.resolvePath('.'), relative: '' };
  }
  return resolveCodePath(trimmed, services);
}

/**
 * List a task's workspace (or a subtree of it), breadth-first and bounded.
 *
 * Breadth-first because the useful answer is "what is at the top of this
 * directory" and a depth-first walk spends the entire entry budget on the first
 * directory it meets. Bounded because a workspace is not a curated set: the
 * caps are reported in `truncated` and `skipped`, so the caller can render
 * "1 of 12 levels" rather than silently showing a partial tree as complete.
 */
export async function listCanvasTree(taskId: string, candidate = '.'): Promise<CanvasTree> {
  const worktree = requireWorktree(taskId);
  const services = canvasServices(taskId);
  const rootPath = listingRoot(candidate, services);

  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(rootPath.absolute);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new AppError('not_found', `No directory "${rootPath.relative || '.'}" in this task's workspace.`, {
        details: { taskId, path: rootPath.relative || '.' },
      });
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new AppError('bad_request', `"${rootPath.relative}" is a file, not a directory.`, {
      details: { taskId, path: rootPath.relative },
    });
  }

  const entries: CanvasEntry[] = [];
  const skipped: string[] = [];
  let truncated = false;

  // The queue holds only directories, and only ones the seam resolved. Its
  // `relative` is what an entry path is built from, so every entry the client
  // sees is named the way `files.ts` would name it back.
  const queue: { absolute: string; relative: string; depth: number }[] = [
    { ...rootPath, depth: 0 },
  ];

  while (queue.length > 0 && !truncated) {
    const directory = queue.shift();
    if (directory === undefined) break;

    let children: fs.Dirent[];
    try {
      children = await fs.promises.readdir(directory.absolute, { withFileTypes: true });
    } catch {
      // A directory that vanished, or that the process cannot read. Skipping it
      // silently would shorten the tree without saying so, so it is reported
      // through the same channel as the caps.
      skipped.push(directory.relative === '' ? '.' : directory.relative);
      continue;
    }

    for (const child of children.sort(byName)) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }

      // `.git` is omitted rather than listed: the viewer refuses it (see
      // `files.ts`), and a tree that lists an entry the next request will 403
      // on is a tree offering a refusal. The check comes before the symlink
      // branch too, so a `.git` symlink cannot be listed either.
      if (isGitPathSegment(child.name)) continue;

      // Symlinks are named so the reader can see their existence, but they are
      // never resolved, descended into or offered as readable files.
      if (child.isSymbolicLink()) {
        entries.push({ path: joinRelative(directory.relative, child.name), name: child.name, type: 'symlink', bytes: null });
        continue;
      }

      const relative = joinRelative(directory.relative, child.name);

      if (child.isDirectory()) {
        if (SKIPPED_DIRS.has(child.name)) {
          skipped.push(relative);
          continue;
        }
        if (directory.depth + 1 > MAX_DEPTH) {
          truncated = true;
          continue;
        }

        // Re-resolved through the seam before it is descended into. The
        // readdir above proved it is a directory *now*; this is the check that
        // says it is still inside the boundary, and it is the same check the
        // reader will apply to the same path.
        let absolute: string;
        try {
          absolute = resolveCodePath(relative, services).absolute;
        } catch {
          skipped.push(relative);
          continue;
        }

        entries.push({ path: relative, name: child.name, type: 'directory', bytes: null });
        queue.push({ absolute, relative, depth: directory.depth + 1 });
        continue;
      }

      // FIFOs, sockets and devices are not files anybody previews.
      if (!child.isFile()) continue;
      entries.push({
        path: relative,
        name: child.name,
        type: 'file',
        bytes: sizeOrNull(path.join(directory.absolute, child.name)),
      });
    }
  }

  return {
    taskId: worktree.taskId,
    mode: worktree.mode,
    root: rootPath.relative === '' ? '.' : rootPath.relative,
    entries,
    truncated,
    skipped,
  };
}

/** Human-readable size, for the refusals that have to say "4.1 MB, too large". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One file's text, for the viewer.
 *
 * The size is checked with a `stat` **before** the read: `readCodeFile` reads
 * the whole file to hash and decode it, so on a 200 MB file the honest refusal
 * has to come first or it arrives after the cost it was meant to avoid. The
 * size is in the message and in `details` so the UI can say "4.1 MB, too large
 * to show" without re-statting anything.
 */
export async function readCanvasFile(taskId: string, candidate: string): Promise<CanvasFile> {
  requireWorktree(taskId);
  const services = canvasServices(taskId);
  const location = resolveCodePath(candidate, services);

  let stats: fs.Stats | null = null;
  try {
    stats = await fs.promises.stat(location.absolute);
  } catch {
    // `readCodeFile` owns the not-found answer; this stat is only a size probe.
    stats = null;
  }
  if (stats !== null && stats.isFile() && stats.size > MAX_VIEW_BYTES) {
    throw new AppError(
      'bad_request',
      `"${location.relative}" is ${formatBytes(stats.size)}, which is larger than the ${formatBytes(MAX_VIEW_BYTES)} the viewer will show.`,
      { details: { path: location.relative, bytes: stats.size, limitBytes: MAX_VIEW_BYTES } },
    );
  }

  return readCodeFile(candidate, services);
}

/**
 * A task's changes, as the patch the exporter already produces.
 *
 * Deliberately a delegation and not a `git` call site. `exportCodeTask` already
 * carries `GIT_SAFE_CONFIG`, `GIT_SAFE_DIFF_FLAGS` and the per-driver filter
 * overrides (see `gitHardening.ts`), and already answers a `direct`-mode task
 * with the reasoned 400 rather than an empty patch that reads as "this task
 * changed nothing". A second implementation here would be a second place to get
 * all four of those wrong — and `test/gitexec.test.ts` is the canary that
 * covers the one call site that exists.
 *
 * `baseCommit` is read from the registry rather than parsed out of the patch:
 * it is the commit the export diffs against, and `exportCodeTask` has already
 * refused every task that has none.
 */
export async function canvasDiff(taskId: string): Promise<CanvasDiff> {
  const exported = await exportCodeTask(taskId);
  const worktree = getWorktree(taskId);
  if (worktree === undefined || worktree.baseCommit === null) {
    // Unreachable: `exportCodeTask` throws not_found for an unknown task and
    // bad_request for a task with no base commit, which is exactly this case.
    // Stated rather than asserted away with `!`, because `baseCommit` is
    // nullable in the registry and a later change to the exporter must not
    // silently start emitting an empty string here.
    throw new AppError('internal_error', 'The task\u2019s diff has no base commit to name.');
  }
  const bytes = Buffer.from(exported.content, 'utf8');
  const truncated = bytes.byteLength > MAX_CANVAS_DIFF_BYTES;
  const patch = truncated ? bytes.subarray(0, MAX_CANVAS_DIFF_BYTES).toString('utf8') : exported.content;
  return { taskId: worktree.taskId, baseCommit: worktree.baseCommit, patch, truncated };
}
