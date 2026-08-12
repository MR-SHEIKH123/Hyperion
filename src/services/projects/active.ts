/**
 * Switching the active project.
 *
 * The active project is recorded in two places that must agree: the
 * `active_project_id` setting, which survives a restart, and the cached
 * `projects` root inside `fsScope`, which every path check reads. This module is
 * the only writer of both. Anything that called `openProject` directly would
 * update the database and leave containment pointing at the previous project —
 * an agent would then be refused access to the project the UI says is open, or
 * worse, allowed into the one that was closed.
 *
 * Switching is a boundary, not a blend: per-task worktree assignments belong to
 * the project they were provisioned from, so they are dropped rather than
 * carried across.
 */

import {
  activeProject,
  clearActiveProject,
  openProject,
  type Project,
} from '../../db/projects.ts';
import { getRoot, setProjectRoot } from '../../security/fsScope.ts';
import { resetWorktrees } from '../code/worktree.ts';
import { rescopeFilesystemServer } from '../mcp/defaults.ts';


/**
 * Open a project and point every scoped tool at it.
 *
 * Order matters. The setting is written first so that a crash between the two
 * writes leaves the durable record ahead of the in-memory cache: the next boot
 * calls `restoreActiveProject` and the two agree again. The reverse order would
 * leave a process scoped to a project that no restart would reproduce.
 */
export function switchActiveProject(id: string): Project {
  const project = openProject(id);
  setProjectRoot(project.path);
  resetWorktrees();
  rescopeFilesystemServer();
  return project;
}


/**
 * Deselect whatever is active, restoring the default root.
 *
 * Used when the active project is removed from the registry. `deleteProject`
 * already clears the setting, but it cannot reach the cached root, which is why
 * a delete has to come back through here.
 */
export function clearActive(): void {
  clearActiveProject();
  setProjectRoot(null);
  resetWorktrees();
}

/**
 * Re-apply the stored choice at boot.
 *
 * A missing directory does not clear the selection. A project may live on a
 * drive that is not mounted yet, and quietly deselecting it would turn a
 * temporary condition into a lost setting — the user would find no project open
 * and no explanation. Path checks against an absent root fail loudly on their
 * own, which is the better failure.
 */
export function restoreActiveProject(): Project | null {
  const project = activeProject();
  setProjectRoot(project === null ? null : project.path);
  return project;
}

/**
 * The directory the `projects` scope currently resolves against.
 *
 * Read from `fsScope` rather than the database so callers cannot be handed a
 * path that containment would then refuse. When no project is active this is the
 * default root.
 */
export function activeProjectRoot(): string {
  return getRoot('projects');
}
