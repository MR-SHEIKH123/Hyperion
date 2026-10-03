/**
 * Read-only filesystem services for Canvas.
 *
 * Canvas deliberately owns no path policy. Every candidate is sent through
 * `files.ts`, whose resolver is bound to one registered task worktree here.
 * That keeps traversal, symlink, per-task containment and `.git` refusal at one
 * seam instead of teaching the HTTP viewer a second approximation of them.
 */
import fs from 'node:fs';
import path from 'node:path';

import { exportCodeTask } from '../export/index.ts';
import { AppError } from '../../util/errors.ts';
import {
  isGitPathSegment,
  readCodeFile,
  resolveCodePath,
} from './files.ts';
import { containAgentCwd, getWorktree } from './worktree.ts';

import type { CodeFileServices } from './files.ts';

export const MAX_ENTRIES = 2_000;
export const MAX_DEPTH = 12;
export const MAX_VIEW_BYTES = 2 * 1024 * 1024;

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
  type: 'file' | 'directory';
  bytes: number | null;
  skipped?: boolean;
}

export interface CanvasTree {
  taskId: string;
  mode: 'worktree' | 'direct';
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
}

/** A read-only service object equivalent to the Code agent's file services. */
export function canvasServices(taskId: string): CodeFileServices {
  const worktree = getWorktree(taskId);
  if (worktree === undefined || worktree.heldSince !== null) {
    throw new AppError('not_found', `No active code task with id "${taskId}".`, {
      details: { taskId },
    });
  }

  return {
    taskId,
    resolvePath: (candidate: string): string => containAgentCwd(candidate, taskId),
  };
}

/** Breadth-first, bounded view of one task workspace subtree. */
export async function listCanvasFiles(taskId: string, candidate = '.'): Promise<CanvasTree> {
  const worktree = getWorktree(taskId);
  const services = canvasServices(taskId);
  // canvasServices established this; the guard keeps the type narrow if the
  // registry changes between the two reads in a future asynchronous caller.
  if (worktree === undefined) {
    throw new AppError('not_found', `No active code task with id "${taskId}".`, {
      details: { taskId },
    });
  }

  const root = resolveCodePath(candidate, services);
  const rootStat = await safeLstat(root.absolute, root.relative);
  if (rootStat.isSymbolicLink()) {
    throw new AppError('scope_violation', 'Canvas does not follow symbolic links.', {
      details: { path: root.relative },
    });
  }

  const entries: CanvasEntry[] = [];
  const skipped = new Set<string>();
  let truncated = false;

  if (!rootStat.isDirectory()) {
    entries.push({
      path: root.relative,
      name: path.posix.basename(root.relative),
      type: 'file',
      bytes: rootStat.size,
    });
    return {
      taskId,
      mode: worktree.mode,
      root: root.relative,
      entries,
      truncated,
      skipped: [],
    };
  }

  interface PendingDirectory {
    absolute: string;
    relative: string;
    depth: number;
  }
  const queue: PendingDirectory[] = [{ absolute: root.absolute, relative: root.relative, depth: 0 }];

  listing: while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;

    let children: fs.Dirent[];
    try {
      children = await fs.promises.readdir(current.absolute, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, 'ENOENT')) continue;
      if (hasCode(error, 'ENOTDIR')) {
        throw new AppError('bad_request', 'The requested Canvas path is not a directory.', {
          details: { path: current.relative },
        });
      }
      throw error;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      // A linked worktree exposes `.git` as a pointer file and a direct task as
      // a directory. Neither belongs in a tree whose file route will refuse it.
      if (isGitPathSegment(child.name)) continue;
      // Dirent gives us the link fact without following the link. Do not offer
      // an entry the viewer can never safely resolve.
      if (child.isSymbolicLink()) continue;

      const relative = current.relative === '.'
        ? child.name
        : `${current.relative}/${child.name}`;

      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        skipped.add(current.relative);
        for (const pending of queue) skipped.add(pending.relative);
        break listing;
      }

      // No ad-hoc join is trusted as the absolute location: even names returned
      // by readdir cross the shared files.ts seam before their first stat.
      const resolved = resolveCodePath(relative, services);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(resolved.absolute);
      } catch (error) {
        if (hasCode(error, 'ENOENT')) continue;
        throw error;
      }
      if (stat.isSymbolicLink()) continue;

      if (stat.isDirectory()) {
        const omitted = SKIPPED_DIRS.has(child.name);
        const atDepthLimit = current.depth + 1 >= MAX_DEPTH;
        entries.push({
          path: resolved.relative,
          name: child.name,
          type: 'directory',
          bytes: null,
          ...((omitted || atDepthLimit) ? { skipped: true } : {}),
        });

        if (omitted || atDepthLimit) {
          skipped.add(resolved.relative);
          if (atDepthLimit) truncated = true;
        } else {
          queue.push({
            absolute: resolved.absolute,
            relative: resolved.relative,
            depth: current.depth + 1,
          });
        }
        continue;
      }

      if (stat.isFile()) {
        entries.push({
          path: resolved.relative,
          name: child.name,
          type: 'file',
          bytes: stat.size,
        });
      }
    }
  }

  return {
    taskId,
    mode: worktree.mode,
    root: root.relative,
    entries,
    truncated,
    skipped: [...skipped].sort(),
  };
}

/** Read one UTF-8 file after rejecting an oversized view with only a stat. */
export async function canvasFile(taskId: string, candidate: string): Promise<CanvasFile> {
  const services = canvasServices(taskId);
  const location = resolveCodePath(candidate, services);
  const stat = await safeLstat(location.absolute, location.relative);
  if (!stat.isFile()) {
    throw new AppError('bad_request', 'The requested Canvas path is not a file.', {
      details: { path: location.relative },
    });
  }
  if (stat.size > MAX_VIEW_BYTES) {
    throw new AppError(
      'bad_request',
      `The requested file is ${stat.size} bytes, too large to show (maximum ${MAX_VIEW_BYTES} bytes).`,
      {
        details: {
          path: location.relative,
          bytes: stat.size,
          maxBytes: MAX_VIEW_BYTES,
        },
      },
    );
  }

  return readCodeFile(candidate, services);
}

/** Canvas reuses the exporter's hardened, worktree-aware git diff. */
export async function canvasDiff(taskId: string): Promise<CanvasDiff> {
  // Establish the task once for narrowing; the exporter still owns both the
  // unknown-task and direct-mode responses. In particular, Canvas introduces
  // no second wording or empty-patch semantic for direct mode.
  canvasServices(taskId);
  const worktree = getWorktree(taskId);
  if (worktree === undefined) throw new Error('registered Code task disappeared synchronously');
  const exported = await exportCodeTask(taskId);
  return {
    taskId,
    // exportCodeTask returns only after proving this is non-null.
    baseCommit: worktree.baseCommit as string,
    patch: exported.content,
  };
}

async function safeLstat(absolute: string, relative: string): Promise<fs.Stats> {
  try {
    return await fs.promises.lstat(absolute);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      throw new AppError('not_found', `Code path "${relative}" was not found.`, {
        details: { path: relative },
      });
    }
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code;
}
