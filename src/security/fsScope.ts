/**
 * Filesystem containment.
 *
 * The Code tool, MCP filesystem servers and skill intake all touch disk. Every
 * such path goes through here first, so their blast radius is bounded to a few
 * known roots under ~/AIStudio instead of the entire filesystem.
 *
 * Two subtleties this handles that a naive `startsWith` check does not:
 *
 *   1. **Symlinks.** `projects/evil -> C:\Windows` passes a string prefix test
 *      but resolves outside the root. Paths are resolved with realpath before
 *      the containment check.
 *   2. **Paths that do not exist yet.** Writes target new files, so realpath
 *      would throw. The nearest existing ancestor is resolved instead, then the
 *      remaining segments are appended — that ancestor is where any symlink
 *      trickery would have to live.
 */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.ts';

export type ScopeName =
  | 'projects'
  | 'attachments'
  | 'skills'
  | 'backups'
  | 'tmp'
  | 'mcp'
  | 'worktrees';

const ROOTS: Record<ScopeName, string> = {
  projects: env.paths.projects,
  attachments: env.paths.attachments,
  skills: env.paths.skills,
  backups: env.paths.backups,
  tmp: env.paths.tmp,
  // Where an MCP server's own installation lives (its venv, its generated data
  // files). Distinct from `projects`: a server may legitimately be handed a path
  // to its own artefacts without that implying access to the user's code.
  mcp: env.paths.mcp,
  // Per-task git worktrees for parallel Code runs. A parallel Code task works
  // here instead of in `projects`, so two tasks editing the same repository
  // cannot see each other's half-written files. Note that scope membership is
  // not enough on its own for those tasks — see `resolveInSubtree`.
  worktrees: env.paths.worktrees,
};


export class ScopeViolationError extends Error {
  readonly code = 'scope_violation';
  readonly scope: ScopeName;
  readonly attempted: string;

  /**
   * `boundary` overrides the root named in the message. Subtree checks are
   * stricter than the scope root, so reporting the root would otherwise
   * describe a wider permission than the caller actually had.
   */
  constructor(scope: ScopeName, attempted: string, boundary?: string) {
    super(
      `Path escapes the "${scope}" scope: ${attempted}. ` +
        `Access is restricted to ${boundary ?? ROOTS[scope]}.`,
    );
    this.name = 'ScopeViolationError';
    this.scope = scope;
    this.attempted = attempted;
  }
}


export function getRoot(scope: ScopeName): string {
  return ROOTS[scope];
}

/**
 * Resolve a path as far as it exists on disk, then re-append the missing tail.
 * Lets containment be checked for files that have not been created yet.
 */
function realpathAllowingMissing(target: string): string {
  let current = path.resolve(target);
  const missing: string[] = [];

  // Walk up until something exists. Terminates at the filesystem root, where
  // path.dirname(x) === x.
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target); // nothing existed
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Validate that `candidate` lies inside `scope` and return its absolute path.
 *
 * `candidate` may be relative (interpreted against the scope root) or absolute.
 * Throws ScopeViolationError otherwise.
 */
export function resolveInScope(scope: ScopeName, candidate: string): string {
  const root = ROOTS[scope];
  if (!root) throw new Error(`Unknown filesystem scope: ${scope}`);

  // Reject NUL bytes outright: they can truncate paths in some syscalls.
  if (candidate.includes('\0')) {
    throw new ScopeViolationError(scope, candidate);
  }

  const absolute = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(root, candidate);

  const resolvedRoot = realpathAllowingMissing(root);
  const resolvedTarget = realpathAllowingMissing(absolute);

  if (!isInside(resolvedRoot, resolvedTarget)) {
    throw new ScopeViolationError(scope, candidate);
  }

  return resolvedTarget;
}

/**
 * True when `target` is the root itself or below it.
 *
 * path.relative is used rather than string prefixing so that a sibling
 * directory sharing a name prefix (`projects-backup` vs `projects`) is not
 * mistaken for a child. Comparison is case-insensitive on Windows, where
 * `C:\Users` and `c:\users` are the same directory.
 */
function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative === '') return true; // the root itself
  if (path.isAbsolute(relative)) return false; // different drive/volume
  return !relative.startsWith('..' + path.sep) && relative !== '..';
}

/** Non-throwing variant, for callers that treat a violation as a normal outcome. */
export function isInScope(scope: ScopeName, candidate: string): boolean {
  try {
    resolveInScope(scope, candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate that `candidate` lies inside one *subtree* of a scope.
 *
 * Scope membership alone is too coarse once work runs in parallel. Every Code
 * task's worktree sits under the same `worktrees` root, so a plain
 * `resolveInScope` check would happily accept `../<other-task>/src/app.ts` —
 * both paths are in scope. This narrower check is what makes two concurrent
 * tasks independent rather than merely both-contained.
 *
 * `subtree` is itself validated against the scope first, so a caller cannot
 * widen its own permission by naming an arbitrary directory as its boundary.
 */
export function resolveInSubtree(scope: ScopeName, subtree: string, candidate: string): string {
  const boundary = resolveInScope(scope, subtree);

  if (candidate.includes('\0')) {
    throw new ScopeViolationError(scope, candidate, boundary);
  }

  const absolute = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(boundary, candidate);

  const resolvedBoundary = realpathAllowingMissing(boundary);
  const resolvedTarget = realpathAllowingMissing(absolute);

  if (!isInside(resolvedBoundary, resolvedTarget)) {
    throw new ScopeViolationError(scope, candidate, boundary);
  }

  return resolvedTarget;
}

/** Non-throwing variant of `resolveInSubtree`. */
export function isInSubtree(scope: ScopeName, subtree: string, candidate: string): boolean {
  try {
    resolveInSubtree(scope, subtree, candidate);
    return true;
  } catch {
    return false;
  }
}


/**
 * Validate and create a directory inside a scope.
 * Used for per-skill and per-project directories.
 */
export function ensureDirInScope(scope: ScopeName, candidate: string): string {
  const resolved = resolveInScope(scope, candidate);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/**
 * Convert an absolute path back to a scope-relative one for storage.
 *
 * The database stores relative paths so it stays portable across machines,
 * restores and a changed AISTUDIO_HOME.
 */
export function toRelative(scope: ScopeName, absolute: string): string {
  const resolvedRoot = realpathAllowingMissing(ROOTS[scope]);
  const resolvedTarget = realpathAllowingMissing(absolute);
  if (!isInside(resolvedRoot, resolvedTarget)) {
    throw new ScopeViolationError(scope, absolute);
  }
  // Always POSIX separators on the way into the DB, so a backup taken on
  // Windows restores correctly on Linux.
  return path.relative(resolvedRoot, resolvedTarget).split(path.sep).join('/');
}

/** Turn a stored relative path back into a validated absolute one. */
export function fromRelative(scope: ScopeName, relative: string): string {
  return resolveInScope(scope, relative.split('/').join(path.sep));
}

/**
 * Make a filename safe to place on disk.
 *
 * Strips directory components and characters that are illegal on Windows or
 * meaningful to a shell, so an upload named `../../.ssh/authorized_keys`
 * becomes an inert flat filename.
 */
export function safeFilename(name: string, fallback = 'file'): string {
  const base = path
    .basename(name)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '_') // no dotfiles, no '..'
    .replace(/[. ]+$/, '') // Windows rejects trailing dots/spaces
    .slice(0, 200)
    .trim();

  // Windows reserved device names remain reserved with any extension.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(base)) {
    return `_${base}`;
  }

  return base === '' ? fallback : base;
}
