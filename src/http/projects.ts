/**
 * Projects API — the registry of directories Hyperion may work in, and which
 * one is currently open.
 *
 * Two kinds of project exist and the difference is visible in every route here.
 * A *managed* project is a directory this app created under its own projects
 * root. An *external* project is a checkout that existed first and that the user
 * merely pointed at. The registry treats them the same once created; the
 * difference matters at creation, where an external path has to be checked, and
 * at deletion, where neither has its files touched.
 *
 * Filesystem work lives here rather than in `db/projects.ts` because a refusal
 * is a fact the user has to see. A path that cannot be a project is a `400` with
 * the reason attached, not a silent correction.
 */

import fs from 'node:fs';
import path from 'node:path';

import { Router } from 'express';

import { env } from '../config/env.ts';
import {
  activeProject,
  createProject,
  deleteProject,
  getProject,
  getProjectByPath,
  listProjects,
  renameProject,
  type Project,
} from '../db/projects.ts';

import { activeTaskRuns, isActiveRunState, type ActiveTaskRunState } from '../db/taskRuns.ts';
import { defaultProjectRoot, pathContains, safeFilename } from '../security/fsScope.ts';
import {
  activeProjectRoot,
  clearActive,
  switchActiveProject,
} from '../services/projects/active.ts';
import { AppError } from '../util/errors.ts';
import { asOptionalString, asString, body, pathParam } from './params.ts';
import { wrap } from './errors.ts';

export const projectsRouter: Router = Router();

function requireProjectOr404(id: string): Project {
  const project = getProject(id);
  if (project === null) {
    throw new AppError('not_found', `No project with id "${id}".`, {
      details: { projectId: id },
    });
  }
  return project;
}

/**
 * Validate a user-supplied directory as an external project root.
 *
 * The path must already exist. Creating an arbitrary directory anywhere on disk
 * on the strength of a POST body is a different and much broader permission than
 * registering one the user has already made, and only the managed case — which
 * writes inside the app's own root — gets it.
 *
 * The overlap check runs in **both** directions against ~/Hyperion. A project
 * inside the app's home would put the database, the secret key and every stored
 * attachment within reach of project-scoped agents; a project *containing* the
 * home directory does the same by transitivity, which is what would happen if
 * someone pointed a project at `C:\` or at their user profile. Managed projects
 * are exempt because this route builds their paths itself, under the projects
 * root, and never from caller input.
 */
function validateExternalPath(candidate: string): string {
  if (candidate.includes('\0')) {
    throw new AppError('bad_request', 'A project path may not contain NUL bytes.', {
      details: { field: 'path' },
    });
  }
  if (!path.isAbsolute(candidate)) {
    throw new AppError(
      'bad_request',
      'A project path must be absolute. Relative paths would be resolved against the ' +
        "server's working directory, which is not a location you chose.",
      { details: { field: 'path' } },
    );
  }

  const resolved = path.resolve(candidate);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new AppError(
      'bad_request',
      `No directory exists at ${resolved}. Create it first, or omit "path" to have ` +
        'Hyperion make one for you.',
      { details: { field: 'path', path: resolved } },
    );
  }
  if (!stat.isDirectory()) {
    throw new AppError('bad_request', `${resolved} is a file, not a directory.`, {
      details: { field: 'path', path: resolved },
    });
  }

  if (pathContains(env.paths.home, resolved) || pathContains(resolved, env.paths.home)) {
    throw new AppError(
      'bad_request',
      `${resolved} overlaps Hyperion's own data directory (${env.paths.home}), which ` +
        'would place the database and stored credentials inside the project scope. ' +
        'Choose a directory outside it, or omit "path" for a managed project.',
      { details: { field: 'path', path: resolved } },
    );
  }

  return resolved;
}

/**
 * Build the directory for a managed project from its name.
 *
 * Named after the project rather than its id: the user sees this path in the
 * Code tool and in every agent transcript, and a UUID tells them nothing about
 * which project they are looking at. `safeFilename` is what makes a
 * user-controlled string safe to append.
 */
function managedPathFor(name: string): string {
  return path.join(defaultProjectRoot(), safeFilename(name, 'project'));
}

function assertPathUnclaimed(candidate: string): void {
  const existing = getProjectByPath(candidate);
  if (existing !== null) {
    throw new AppError(
      'conflict',
      `That directory is already registered as the project "${existing.name}".`,
      { details: { projectId: existing.id, path: candidate } },
    );
  }
}

/**
 * GET /api/projects — every project, most recently opened first.
 *
 * `activeId` and `activeRoot` are reported alongside so the UI can mark the open
 * project and show what path the tools are actually scoped to without a second
 * request. They come from different places on purpose: the id from the registry,
 * the root from the containment layer, so a disagreement between the two is
 * visible to the user rather than hidden by deriving one from the other.
 * `activeRoot` is the default root when nothing is open.
 */
projectsRouter.get(
  '/',
  wrap((_req, res) => {
    res.json({
      projects: listProjects(),
      activeId: activeProject()?.id ?? null,
      activeRoot: activeProjectRoot(),

      defaultRoot: defaultProjectRoot(),
    });
  }),
);

/**
 * POST /api/projects — register a project.
 *
 * With `path`, an existing directory is adopted as-is. Without one, a directory
 * is created under the app's projects root. Creating a project does not open it;
 * that is a separate, explicit act, so that adding a second project cannot
 * silently move the scope out from under a run in progress.
 */
projectsRouter.post(
  '/',
  wrap((req, res) => {
    const input = body(req);
    const name = asString(input.name, 'name').trim();
    if (name === '') {
      throw new AppError('bad_request', 'A project needs a name.', {
        details: { field: 'name' },
      });
    }

    const requested = asOptionalString(input.path, 'path');
    const managed = requested === undefined;
    const resolved = managed ? managedPathFor(name) : validateExternalPath(requested);

    assertPathUnclaimed(resolved);

    // Only managed directories are created. `recursive` makes this idempotent,
    // which matters because a directory left behind by a previously deleted
    // project is a normal thing to find here — deletion never removes files.
    if (managed) fs.mkdirSync(resolved, { recursive: true });

    res.status(201).json({ project: createProject({ name, path: resolved, managed }) });
  }),
);

/** GET /api/projects/:id — one project's details. */
projectsRouter.get(
  '/:id',
  wrap((req, res) => {
    res.json({ project: requireProjectOr404(pathParam(req, 'id')) });
  }),
);

/**
 * PATCH /api/projects/:id — rename.
 *
 * The name only. A project's path is its identity here: changing it would mean
 * every artifact, worktree and task run recorded against the old directory now
 * claims to belong to a different one. Pointing at a new directory is a new
 * project.
 */
projectsRouter.patch(
  '/:id',
  wrap((req, res) => {
    const id = pathParam(req, 'id');
    requireProjectOr404(id);

    const name = asString(body(req).name, 'name').trim();
    if (name === '') {
      throw new AppError('bad_request', 'A project needs a name.', {
        details: { field: 'name' },
      });
    }

    renameProject(id, name);
    res.json({ project: requireProjectOr404(id) });
  }),
);

/**
 * POST /api/projects/:id/open — make this project active.
 *
 * Stamps `last_opened_at`, repoints filesystem containment, and drops per-task
 * worktree assignments so work from the previous project cannot leak into the
 * next one.
 */
projectsRouter.post(
  '/:id/open',
  wrap((req, res) => {
    const id = pathParam(req, 'id');
    requireProjectOr404(id);

    res.json({ project: switchActiveProject(id), activeRoot: activeProjectRoot() });
  }),
);

/**
 * GET /api/projects/:id/tasks — what is still unfinished in this project.
 *
 * This is the read a project switch is warned by: opening another project moves
 * every scoped tool's directory and drops the per-task worktree assignments, so
 * a user who switches away from running work does not stop it — they lose sight
 * of it. The client asks this before opening the other project and can say what
 * is being left behind, by name, instead of a generic "some tasks are running".
 *
 * Three shapes are worth stating outright.
 *
 * **It lists tasks, not runs.** A task id can be run more than once, and only the
 * latest run for each `(tool, taskId)` is reported, mirroring
 * `GET /api/{tool}/tasks/:taskId/state` — so `tasks[0].runId` is the run a client
 * would watch, and the count is tasks rather than rows.
 *
 * **Active means unfinished, not busy.** `blocked` and `ready_for_review` are
 * included: a run waiting on an approval has not ended, and it is the one most
 * worth mentioning before somebody navigates away from it. Terminal runs are
 * excluded — the point is what is still going, not a history.
 *
 * **Coverage is part of the answer.** `unattributedActive` counts the runs that
 * are active but name no project — started with nothing open, or written before
 * migration `027` recorded a scope. They are never folded into whichever project
 * happens to be open, because that would be the listing inventing an answer; they
 * are counted here so a client can say "something else is running" rather than
 * presenting the per-project number as the whole truth. For rows written from
 * `027` on this count only stays non-zero while nothing is open.
 *
 * `active` says whether this project is the one the tools are scoped to right
 * now, which is what decides whether the warning is "you are leaving this" or
 * "you are switching back to this".
 */
projectsRouter.get(
  '/:id/tasks',
  wrap((req, res) => {
    const project = requireProjectOr404(pathParam(req, 'id'));
    const tasks = activeTaskRuns(project.id);

    // Every key is present even at zero: a client branch on `counts.blocked`
    // should not have to distinguish "none" from "not said". The `Record` type
    // over the active states is also what makes a new state a compile error
    // here rather than a counter that silently never increments.
    const counts: Record<ActiveTaskRunState, number> = {
      running: 0,
      paused: 0,
      blocked: 0,
      ready_for_review: 0,
    };
    for (const run of tasks) {
      // Narrowed rather than asserted: the query filters by the same set, and a
      // counter that trusted that would be one SQL edit away from counting a
      // terminal run as active.
      if (isActiveRunState(run.state)) counts[run.state] += 1;
    }

    res.json({
      project,
      active: activeProject()?.id === project.id,
      tasks: tasks.map((run) => ({
        tool: run.tool,
        taskId: run.taskId,
        runId: run.runId,
        state: run.state,
        pauseReason: run.pauseReason,
        chatId: run.chatId,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
      })),
      counts: { total: tasks.length, ...counts },
      unattributedActive: activeTaskRuns(null).length,
    });
  }),
);

/**
 * DELETE /api/projects/:id — remove from the registry.
 *
 * **The directory and its contents are left entirely alone.** A project usually
 * points at work that predates Hyperion, and even a managed one holds the user's
 * code, so "take this off my list" must never be the same gesture as "delete my
 * files". `filesRemoved: false` says so in the response rather than leaving the
 * caller to assume either way.
 *
 * Removing the active project deselects it, returning the scope to the default
 * root instead of leaving the tools pointed at a directory no longer in the
 * registry.
 */
projectsRouter.delete(
  '/:id',
  wrap((req, res) => {
    const id = pathParam(req, 'id');
    const project = requireProjectOr404(id);
    // Read before the delete: `deleteProject` clears the pointer itself, so
    // afterwards there is no way to tell whether this row was the active one.
    const wasActive = activeProject()?.id === id;

    deleteProject(id);

    if (wasActive) clearActive();

    res.json({
      deleted: true,
      path: project.path,
      filesRemoved: false,
      activeRoot: activeProjectRoot(),
    });
  }),
);
