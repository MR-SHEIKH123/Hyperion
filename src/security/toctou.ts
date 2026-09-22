/**
 * Point-of-use revalidation: the path an agent named is checked again at the
 * moment it is used, not only where it was resolved.
 *
 * `fsScope` answers "is this inside the scope?" by canonicalising the path — it
 * follows symlinks and returns the real location. That is the right answer to its
 * own question, and it is a *snapshot*: it describes the filesystem at the instant
 * it ran. A model that can create symlinks inside the directory it is allowed to
 * write to can change that answer afterwards, and a write or a spawn that trusted
 * the snapshot then lands outside the boundary it was checked against.
 *
 * Two checks, both run at the point of use, in this order, and both are needed:
 *
 *  1. **No traversal through a symlinked directory**
 *     (`assertNoSymlinkedTraversal`). Every component of the path *as spelled*
 *     between the boundary and the target is `lstat`ed, and a symlink is refused
 *     even when it currently resolves back inside the boundary. This is the
 *     check that has to run before canonicalisation, because canonicalisation is
 *     precisely what erases the evidence: by the time a resolver has answered,
 *     an inward link and a real directory are the same path. A link that points
 *     inward today is the hook a later swap needs, and "the path was fine when it
 *     was resolved" is the whole class of failure being defended against.
 *
 *     The cost is stated rather than hidden: a *pre-existing* intentional link
 *     (a project that symlinks `docs -> shared/docs`) is refused when an agent
 *     names the link. The refusal names the component, and the canonical spelling
 *     works, so the agent has a mechanical retry and the user has a message that
 *     says what to do. Refusing a class outright is the point — a check that
 *     allowed inward links would have to decide, at use time, whether a link is
 *     about to be re-pointed, which is not a decidable question.
 *
 *  2. **Canonical boundary revalidation** (`assertStillInside`). The resolved path
 *     is re-resolved through symlinks *now* — missing tails tolerated, exactly as
 *     `fsScope` does, because a write target usually does not exist yet — and it
 *     must still be inside the boundary. This is what catches a target that is
 *     itself a symlink out of the workspace, and any escape the first check could
 *     not see because it happened before the spelling existed.
 *
 * **What this cannot do.** No pre-check can remove the window between the check
 * and the syscall; they are two operations. What these narrow is the window from
 * "resolved early, once, when the task context was built" to "the instant before
 * the operation". Both checks are synchronous and adjacent to the syscall, so the
 * remaining window is the call itself rather than the task's whole lifetime. The
 * honest claim is narrower than "closed": an escape now needs a race won in
 * microseconds rather than a link planted minutes earlier.
 *
 * **Policy that belongs to this file, not to the callers.** A symlink at the
 * *target itself* is not refused by check 1 — the item this implements names
 * intermediate directory symlinks, and a symlinked file is a normal thing to
 * write. It is still refused by check 2 whenever it points outside. If a future
 * reading of the requirement wants "no symlinks anywhere along the path", this is
 * the clause to change, and it is the only one.
 */
import fs from 'node:fs';
import path from 'node:path';

import { AppError } from '../util/errors.ts';
import { pathContains } from './fsScope.ts';

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * Refuse a path whose *spelling* crosses a symlinked directory below `boundary`.
 *
 * `candidate` is what the caller was handed — a model's argument, a route's query
 * — so this must be called **before** the caller's resolver canonicalises it.
 * Relative candidates resolve against `boundary`, which is also the only sensible
 * reading of a relative path in this position.
 *
 * A missing component ends the walk rather than failing it: nothing exists there
 * yet for anyone to have swapped, and the write path is allowed to create it.
 * (A component created between this check and the syscall is outside what any
 * pre-check can promise; that caveat is the module note above.)
 */
export function assertNoSymlinkedTraversal(boundary: string, candidate: string): void {
  const root = path.resolve(boundary);
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  const relative = path.relative(root, absolute);

  // `..`, an absolute path (different volume on Windows) or the boundary itself:
  // there is no traversal to inspect. Containment is check 2's job, and it runs
  // on the resolved path where `..` cannot be spelled away.
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return;

  let current = root;
  // Every component except the last: the last is the target itself, which may be
  // a file (or a symlink to one) — see the module note.
  for (const component of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new AppError(
        'scope_violation',
        `Refusing ${absolute}: "${current}" is a symbolic link, and a path may not be used through one. ` +
          `Name the directory it points at instead.`,
        {
          details: {
            boundary: root,
            candidate,
            component: current,
            reason: 'intermediate_symlink',
          },
        },
      );
    }
  }
}

/**
 * Revalidate a resolved path against the boundary that was supposed to contain it.
 *
 * Takes the resolver's output (canonical at the time it ran) and re-resolves it
 * now: `pathContains` follows symlinks on both sides and tolerates a missing tail,
 * so this asks the same question the resolver asked, at a later instant. Returns
 * the path unchanged, so a caller can write `const p = assertStillInside(root, resolve(x))`
 * and be holding the checked value rather than a second resolution of its own.
 *
 * Throws `scope_violation` (403), not a generic error: the request was
 * well-formed and the boundary is the reason. `details.reason` distinguishes this
 * from the traversal refusal, because the two need different user responses —
 * "name the real directory" versus "that file is outside what this task owns".
 */
export function assertStillInside(boundary: string, resolved: string): string {
  if (!pathContains(boundary, resolved)) {
    throw new AppError('scope_violation', `Refusing ${resolved}: it resolves outside ${path.resolve(boundary)}.`, {
      details: { boundary: path.resolve(boundary), resolved, reason: 'resolves_outside' },
    });
  }
  return resolved;
}
