/**
 * The project registry.
 *
 * A project is a name and a directory. Which one is *active* decides where the
 * Code, Design and Cowork tools resolve paths, so that choice has to survive a
 * restart — it lives in `settings` under `active_project_id` rather than in a
 * module variable, and `activeProject()` is the single reader.
 *
 * Nothing here touches the filesystem. Creating the directory, and refusing a
 * path outside what the app may write to, belong to the HTTP layer where a
 * refusal can be reported to the user as the 4xx it is; this module only
 * records decisions already made.
 */

import { randomUUID } from 'node:crypto';

import { getDb } from './adapter.ts';
import { getSetting, setSetting } from './settings.ts';

/** Where the active project id is kept, so a restart reopens the same work. */
const ACTIVE_KEY = 'active_project_id';

export interface Project {
  id: string;
  name: string;
  /** Absolute. See the note in migration 008 on why this is not relative. */
  path: string;
  /** True when Hyperion created the directory under its own projects root. */
  managed: boolean;
  createdAt: number;
  lastOpenedAt: number | null;
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  managed: number;
  created_at: number;
  last_opened_at: number | null;
}

function mapRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    managed: row.managed !== 0,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
  };
}

export interface CreateProjectInput {
  name: string;
  /** Absolute, already resolved and containment-checked by the caller. */
  path: string;
  managed: boolean;
}

export function createProject(input: CreateProjectInput): Project {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, path, managed, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, input.name, input.path, input.managed ? 1 : 0, Date.now());
  return requireProject(id);
}

export function getProject(id: string): Project | null {
  const row = getDb().prepare<ProjectRow>('SELECT * FROM projects WHERE id = ?').get(id);
  return row ? mapRow(row) : null;
}

/**
 * Lookup by directory, for the uniqueness check before an insert.
 *
 * The `UNIQUE` constraint on `path` is the real guarantee; this exists so the
 * conflict surfaces as a `bad_request` naming the existing project instead of a
 * constraint violation the user cannot act on.
 */
export function getProjectByPath(path: string): Project | null {
  const row = getDb().prepare<ProjectRow>('SELECT * FROM projects WHERE path = ?').get(path);
  return row ? mapRow(row) : null;
}

function requireProject(id: string): Project {
  const project = getProject(id);
  if (project === null) {
    throw new Error(`project "${id}" vanished immediately after being written`);
  }
  return project;
}

/**
 * Every project, most recently opened first.
 *
 * Never-opened rows sort last rather than first: `last_opened_at` is NULL for
 * them, and a project the user has not opened yet is not what they are looking
 * for when they open the list. `created_at DESC` breaks the tie so a freshly
 * created project is the first of those.
 */
export function listProjects(): Project[] {
  return getDb()
    .prepare<ProjectRow>(
      `SELECT * FROM projects
        ORDER BY last_opened_at IS NULL, last_opened_at DESC, created_at DESC`,
    )
    .all()
    .map(mapRow);
}

export function renameProject(id: string, name: string): void {
  getDb().prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id);
}

/**
 * Remove a project from the registry.
 *
 * Registry only — the directory and every file in it stay on disk. A project
 * often points at a checkout that existed long before Hyperion saw it, and even
 * a managed one holds the user's work, so deleting files here would make
 * "remove from the list" and "destroy my code" the same gesture. Whoever wants
 * the directory gone deletes it themselves.
 *
 * Clears the active pointer when it named this project, so the setting cannot
 * outlive the row it refers to.
 */
export function deleteProject(id: string): void {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
  if (getSetting(ACTIVE_KEY) === id) setSetting(ACTIVE_KEY, null);
}

/** Mark a project active and stamp `last_opened_at`. */
export function openProject(id: string): Project {
  getDb().prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(Date.now(), id);
  setSetting(ACTIVE_KEY, id);
  return requireProject(id);
}

/**
 * The active project, or null when none is.
 *
 * A stored id whose row is gone reads as null rather than throwing. That state
 * should be unreachable — `deleteProject` clears the pointer — but a restored
 * backup or a hand-edited database can produce it, and a dangling pointer must
 * degrade to "no project selected" rather than breaking every path resolution
 * in the app.
 */
export function activeProject(): Project | null {
  const id = getSetting(ACTIVE_KEY);
  return id === null ? null : getProject(id);
}

/** Clears the active pointer without touching any project row. */
export function clearActiveProject(): void {
  setSetting(ACTIVE_KEY, null);
}
