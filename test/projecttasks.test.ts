/**
 * `GET /api/projects/:id/tasks` — what is still unfinished in a project.
 *
 * The read exists so a client can warn before switching away: opening another
 * project moves the directory every scoped tool resolves against and drops the
 * per-task worktree assignments, so a run that is in flight keeps going and
 * stops being visible. The warning is only worth showing if the list is right,
 * and three ways of getting it wrong are what this file is about:
 *
 *   1. **Attribution.** A run's project comes from the column written when the
 *      run started (`027`), never from whichever project is open when the list
 *      is read. The setting moves; a run does not. A test that starts a run,
 *      switches projects, and re-reads is the only one that can tell the two
 *      apart, so it is here rather than a comment.
 *   2. **Counting runs instead of tasks.** A task id is reused across attempts
 *      and continuations, and the states are one-way, so the same task can have
 *      more than one row with an active state. Reporting both would inflate the
 *      number the warning is made of; the listing reports the latest run per
 *      `(tool, taskId)`, mirroring the per-task state route.
 *   3. **Presenting a partial answer as the whole one.** Runs that name no
 *      project are real and are not folded into whichever project is open —
 *      they are counted, so a client can say "something else is running" instead
 *      of "nothing is running".
 *
 * The route is also exercised over HTTP, because registration order in Express
 * decides which handler a path reaches and `/:id/tasks` sits in a file that also
 * owns `/:id`.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

import type { Server } from 'node:http';

const { createProject, openProject, deleteProject, clearActiveProject } = await import(
  '../src/db/projects.ts'
);
const {
  startTaskRun,
  finishTaskRun,
  updateTaskRunState,
  getTaskRun,
  activeTaskRuns,
} = await import('../src/db/taskRuns.ts');
const { setProjectRoot } = await import('../src/security/fsScope.ts');
const { createApp } = await import('../src/http/app.ts');

let server: Server;
let base: string;

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

async function api(method: string, route: string, payload?: unknown): Promise<ApiResponse> {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function makeProject(name: string): string {
  return createProject({ name, path: `/tmp/hyperion-projecttasks/${name}`, managed: true }).id;
}

before(async () => {
  await freshDb();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo from listen(0)');
  }
  base = `http://127.0.0.1:${address.port}`;
});

// Each test gets its own database, not just its own project id. The listing
// answers about *all* unattributed runs and a run with no project stays active
// until it is finished, so a shared database would leak one test's runs into the
// next test's "nothing else is running" assertion — which is the assertion the
// whole route exists to support.
beforeEach(async () => {
  await freshDb();
});

afterEach(() => {
  // The scope root is process-wide, and the active project is a setting in the
  // shared database. Left behind, either would decide the next test's answer.
  setProjectRoot(null);
  clearActiveProject();
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

describe('the project a run is stamped with', () => {
  test('a run started with a project open names it', () => {
    const projectId = makeProject('stamp-open');
    openProject(projectId);

    startTaskRun({ runId: 'r-stamped', taskId: 't-stamped', tool: 'code' });

    assert.equal(getTaskRun('r-stamped')?.projectId, projectId);
  });

  test('a run started with nothing open names no project', () => {
    startTaskRun({ runId: 'r-unattributed', taskId: 't-unattributed', tool: 'cowork' });

    assert.equal(getTaskRun('r-unattributed')?.projectId, null);
  });

  test('opening another project does not re-attribute a run that already started', () => {
    const first = makeProject('stamp-first');
    const second = makeProject('stamp-second');

    openProject(first);
    startTaskRun({ runId: 'r-first', taskId: 't-first', tool: 'design' });

    // The switch the warning is about: same process, same setting, different
    // directory. The run has not moved and must not read as if it had.
    openProject(second);

    assert.equal(getTaskRun('r-first')?.projectId, first);
    assert.equal(activeTaskRuns(first).length, 1, 'it is still work in the first project');
    assert.deepEqual(activeTaskRuns(second), [], 'and it did not follow the setting');
  });
});

describe('which runs are active', () => {
  test('every live state counts, including the ones waiting on the user', () => {
    const projectId = makeProject('states');
    openProject(projectId);

    startTaskRun({ runId: 'r-running', taskId: 't-1', tool: 'code' });
    startTaskRun({ runId: 'r-paused', taskId: 't-2', tool: 'code' });
    finishTaskRun('r-paused', 'paused', { pauseReason: 'user_paused' });
    startTaskRun({ runId: 'r-blocked', taskId: 't-3', tool: 'code' });
    updateTaskRunState('r-blocked', 'blocked');
    startTaskRun({ runId: 'r-review', taskId: 't-4', tool: 'design' });
    updateTaskRunState('r-review', 'ready_for_review');

    const states = activeTaskRuns(projectId)
      .map((run) => run.state)
      .sort();
    assert.deepEqual(states, ['blocked', 'paused', 'ready_for_review', 'running']);
  });

  test('a finished run drops out of the listing', () => {
    const projectId = makeProject('finished');
    openProject(projectId);

    startTaskRun({ runId: 'r-done', taskId: 't-done', tool: 'code' });
    finishTaskRun('r-done', 'complete');

    // Also the four terminal states that are not `complete`, since the split is
    // typed rather than a single comparison.
    startTaskRun({ runId: 'r-err', taskId: 't-err', tool: 'code' });
    finishTaskRun('r-err', 'error', { code: 'internal_error' });
    startTaskRun({ runId: 'r-stopped', taskId: 't-stopped', tool: 'cowork' });
    finishTaskRun('r-stopped', 'stopped', { pauseReason: 'ceiling_reached' });
    startTaskRun({ runId: 'r-int', taskId: 't-int', tool: 'cowork' });
    finishTaskRun('r-int', 'interrupted', { code: 'internal_error' });

    assert.deepEqual(activeTaskRuns(projectId), []);
  });

  test('a task re-run reports only its latest run', () => {
    const projectId = makeProject('retry');
    openProject(projectId);

    startTaskRun({ runId: 'r-attempt-1', taskId: 't-retry', tool: 'code' });
    startTaskRun({ runId: 'r-attempt-2', taskId: 't-retry', tool: 'code' });
    // A different tool under the same task id is a different task: the tool is
    // part of the key everywhere else in this schema, and the listing must not
    // collapse two tools' work into one row.
    startTaskRun({ runId: 'r-other-tool', taskId: 't-retry', tool: 'design' });

    const listed = activeTaskRuns(projectId);
    assert.equal(listed.length, 2, 'one row for the task in each tool');
    const code = listed.find((run) => run.tool === 'code');
    assert.equal(code?.runId, 'r-attempt-2', 'the newest attempt of the task');
  });

  test('the unattributed half is separate and does not leak into a project', () => {
    const projectId = makeProject('mixed');
    openProject(projectId);
    startTaskRun({ runId: 'r-in-project', taskId: 't-in', tool: 'code' });

    clearActiveProject();
    startTaskRun({ runId: 'r-no-project', taskId: 't-out', tool: 'code' });

    assert.deepEqual(
      activeTaskRuns(projectId).map((run) => run.runId),
      ['r-in-project'],
    );
    assert.deepEqual(
      activeTaskRuns(null).map((run) => run.runId),
      ['r-no-project'],
    );
  });

  test('deleting a project un-attributes its runs rather than dropping them', () => {
    const projectId = makeProject('deleted');
    openProject(projectId);
    startTaskRun({ runId: 'r-orphan', taskId: 't-orphan', tool: 'code' });

    deleteProject(projectId);

    // `ON DELETE SET NULL` at the schema level; what matters here is that the
    // record of a live run survives its project coming off the list.
    assert.equal(getTaskRun('r-orphan')?.projectId, null);
    assert.deepEqual(activeTaskRuns(projectId), []);
    assert.deepEqual(
      activeTaskRuns(null).map((run) => run.runId),
      ['r-orphan'],
    );
  });
});

describe('GET /api/projects/:id/tasks', () => {
  test('an unknown project is a 404 naming it', async () => {
    const { status, body } = await api('GET', '/api/projects/does-not-exist/tasks');

    assert.equal(status, 404);
    assert.equal((body.error as { code?: string } | undefined)?.code, 'not_found');
  });

  test('it answers with the listing, the per-state counts, and the unattributed count', async () => {
    const projectId = makeProject('route');
    openProject(projectId);
    startTaskRun({ runId: 'r-route-1', taskId: 't-route-1', tool: 'code' });
    startTaskRun({ runId: 'r-route-2', taskId: 't-route-2', tool: 'cowork' });
    updateTaskRunState('r-route-2', 'blocked');
    clearActiveProject();
    startTaskRun({ runId: 'r-route-3', taskId: 't-route-3', tool: 'design' });

    const { status, body } = await api('GET', `/api/projects/${projectId}/tasks`);

    assert.equal(status, 200);
    // The `tasks` key is what proves this reached the listing handler and not
    // `GET /api/projects/:id`, which sits above it in the same router.
    const tasks = body.tasks as Record<string, unknown>[];
    assert.equal(tasks.length, 2);
    assert.deepEqual(
      tasks.map((task) => task.taskId).sort(),
      ['t-route-1', 't-route-2'],
    );
    const blocked = tasks.find((task) => task.taskId === 't-route-2');
    assert.equal(blocked?.state, 'blocked');
    assert.equal(blocked?.runId, 'r-route-2');
    assert.equal(blocked?.tool, 'cowork');
    assert.equal(typeof blocked?.startedAt, 'number');
    assert.equal(typeof blocked?.updatedAt, 'number');
    assert.equal(blocked?.chatId, null);
    assert.equal(blocked?.pauseReason, null);

    // Every key is present at zero, so a client branching on a count never has
    // to tell "none" from "not said".
    assert.deepEqual(body.counts, {
      total: 2,
      running: 1,
      paused: 0,
      blocked: 1,
      ready_for_review: 0,
    });
    assert.equal(body.unattributedActive, 1);
    assert.equal(body.active, false, 'another project was opened after these runs started');
    assert.equal((body.project as { id?: string }).id, projectId);
  });

  test('`active` marks the project the tools are scoped to right now', async () => {
    const projectId = makeProject('active-flag');
    openProject(projectId);

    const { body } = await api('GET', `/api/projects/${projectId}/tasks`);

    assert.equal(body.active, true);
  });

  test('another project\'s work is not in this project\'s answer', async () => {
    const mine = makeProject('mine');
    const theirs = makeProject('theirs');
    openProject(mine);
    startTaskRun({ runId: 'r-mine', taskId: 't-mine', tool: 'code' });
    openProject(theirs);
    startTaskRun({ runId: 'r-theirs', taskId: 't-theirs', tool: 'code' });

    const { body } = await api('GET', `/api/projects/${mine}/tasks`);

    assert.deepEqual(
      (body.tasks as Record<string, unknown>[]).map((task) => task.taskId),
      ['t-mine'],
    );
    assert.equal((body.counts as { total: number }).total, 1);
    assert.equal(body.unattributedActive, 0);
  });

  test('a run whose project was deregistered shows up as unattributed', async () => {
    const projectId = makeProject('deregistered');
    openProject(projectId);
    startTaskRun({ runId: 'r-live', taskId: 't-live', tool: 'cowork' });

    const removed = await api('DELETE', `/api/projects/${projectId}`);
    assert.equal(removed.status, 200);

    const gone = await api('GET', `/api/projects/${projectId}/tasks`);
    assert.equal(gone.status, 404);

    // The project's listing is gone, but the work is still running and the next
    // project's listing has to be able to say so.
    const other = makeProject('after-deregister');
    openProject(other);
    const { body } = await api('GET', `/api/projects/${other}/tasks`);
    assert.equal(body.unattributedActive, 1);
    assert.deepEqual(body.tasks, []);
  });
});
