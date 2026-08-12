/**
 * Projects: the registry, and what switching one actually moves.
 *
 * Two guarantees carry the weight here.
 *
 * The first is that deleting a project never touches the user's files. It is the
 * one operation in this feature that could destroy work, the API cannot undo it,
 * and "remove from list" and "delete my code" are one click apart in any UI, so
 * the assertion is made against real directories with real files in them rather
 * than against a mock.
 *
 * The second is that opening a project actually moves the filesystem boundary.
 * The registry agreeing with itself proves nothing — what matters is that
 * `resolveInScope('projects', ...)` accepts paths in the newly opened project and
 * refuses the one that was just closed. That is the whole point of the feature,
 * and it is only observable through the containment layer.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, afterEach, before, describe } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

import type { Server } from 'node:http';

const { createProject, activeProject, listProjects } = await import('../src/db/projects.ts');
const { defaultProjectRoot, getRoot, isInScope, resolveInScope, setProjectRoot } = await import(
  '../src/security/fsScope.ts'
);
const { clearActive, restoreActiveProject, switchActiveProject } = await import(
  '../src/services/projects/active.ts'
);
const { createApp } = await import('../src/http/app.ts');

let server: Server;
let base: string;

/**
 * Scratch directories outside HYPERION_HOME.
 *
 * External projects are the interesting case and they are defined by being
 * somewhere else, so they cannot live under the test home. Tracked for removal
 * because nothing in the app will ever delete them — which is itself one of the
 * things being asserted.
 */
const external: string[] = [];

function makeExternalDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hyperion-proj-${label}-`));
  external.push(dir);
  return dir;
}

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

function projectFrom(body: Record<string, unknown>): Record<string, unknown> {
  const project = body.project;
  assert.ok(project !== undefined && typeof project === 'object', 'expected a project in the body');
  return project as Record<string, unknown>;
}

function errorCode(body: Record<string, unknown>): string {
  const error = body.error as { code?: string } | undefined;
  return error?.code ?? '';
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

// The scope root is process-wide state. Left pointing at one test's project it
// would silently decide the next test's containment assertions.
afterEach(() => {
  setProjectRoot(null);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of external) fs.rmSync(dir, { recursive: true, force: true });
  await cleanupHome();
});

describe('registering a project', () => {
  test('a project with no path gets a directory under the app-managed root', async () => {
    const { status, body } = await api('POST', '/api/projects', { name: 'Fresh Start' });

    assert.equal(status, 201);
    const project = projectFrom(body);
    assert.equal(project.managed, true);
    assert.equal(project.path, path.join(defaultProjectRoot(), 'Fresh Start'));
    assert.equal(
      fs.existsSync(project.path as string),
      true,
      'a managed project directory should be created for the user',
    );
  });

  test('a name that would escape the projects root is flattened, not obeyed', async () => {
    const { status, body } = await api('POST', '/api/projects', { name: '../../escape' });

    assert.equal(status, 201);
    const created = projectFrom(body).path as string;
    assert.equal(
      path.dirname(created),
      defaultProjectRoot(),
      'a traversal in the name must not move the directory out of the managed root',
    );
    assert.equal(isInScope('projects', created), true);
  });

  test('an existing directory is adopted as-is and marked unmanaged', async () => {
    const dir = makeExternalDir('adopt');
    const { status, body } = await api('POST', '/api/projects', { name: 'Adopted', path: dir });

    assert.equal(status, 201);
    const project = projectFrom(body);
    assert.equal(project.path, fs.realpathSync(dir));
    assert.equal(project.managed, false);
  });

  test('a path that does not exist is refused rather than created', async () => {
    const missing = path.join(makeExternalDir('missing'), 'not-there');
    const { status, body } = await api('POST', '/api/projects', { name: 'Ghost', path: missing });

    assert.equal(status, 400);
    assert.equal(errorCode(body), 'bad_request');
    assert.equal((body.error as { details?: { field?: string } }).details?.field, 'path');
    assert.equal(
      fs.existsSync(missing),
      false,
      'refusing a path must not leave the directory behind',
    );
  });

  test('a relative path is refused, because the server cwd is nobody\'s choice', async () => {
    const { status, body } = await api('POST', '/api/projects', { name: 'Rel', path: './somewhere' });

    assert.equal(status, 400);
    assert.equal(errorCode(body), 'bad_request');
  });

  test('a directory holding the app\'s own data cannot become a project', async () => {
    const { testHome } = await import('./helpers.ts');
    const { status, body } = await api('POST', '/api/projects', { name: 'Inside', path: testHome });

    assert.equal(status, 400);
    assert.match(
      String((body.error as { message?: string }).message),
      /overlaps/,
      'the refusal should say why, not just that it was refused',
    );
  });

  test('a directory containing the app home is refused too', async () => {
    const { testHome } = await import('./helpers.ts');
    const { status } = await api('POST', '/api/projects', {
      name: 'Outside',
      path: path.dirname(testHome),
    });

    assert.equal(
      status,
      400,
      'a parent of the data directory grants the same access as the directory itself',
    );
  });

  test('one directory cannot be registered twice', async () => {
    const dir = makeExternalDir('dupe');
    const first = await api('POST', '/api/projects', { name: 'First', path: dir });
    assert.equal(first.status, 201);

    const second = await api('POST', '/api/projects', { name: 'Second', path: dir });
    assert.equal(second.status, 409);
    assert.equal(errorCode(second.body), 'conflict');
  });

  test('a project needs a name', async () => {
    const blank = await api('POST', '/api/projects', { name: '   ' });
    assert.equal(blank.status, 400);

    const missing = await api('POST', '/api/projects', {});
    assert.equal(missing.status, 400);
  });
});

describe('opening a project', () => {
  test('opening moves the filesystem scope onto that project', async () => {
    const dir = makeExternalDir('scope');
    const project = createProject({ name: 'Scoped', path: dir, managed: false });

    // Before: an external directory is outside the default root.
    assert.equal(isInScope('projects', dir), false);

    const { status, body } = await api('POST', `/api/projects/${project.id}/open`);
    assert.equal(status, 200);
    assert.equal(body.activeRoot, fs.realpathSync(dir));

    const resolved = resolveInScope('projects', 'src/app.ts');
    assert.equal(
      resolved,
      path.join(fs.realpathSync(dir), 'src', 'app.ts'),
      'a relative path should now resolve inside the opened project',
    );
  });

  test('opening one project closes the boundary on the previous one', async () => {
    const first = createProject({
      name: 'One',
      path: makeExternalDir('first'),
      managed: false,
    });
    const second = createProject({
      name: 'Two',
      path: makeExternalDir('second'),
      managed: false,
    });

    switchActiveProject(first.id);
    assert.equal(isInScope('projects', first.path), true);

    switchActiveProject(second.id);
    assert.equal(isInScope('projects', second.path), true);
    assert.equal(
      isInScope('projects', first.path),
      false,
      'the previous project must fall out of scope — switching is a boundary, not a union',
    );
  });

  test('opening stamps last_opened_at and reports the project as active', async () => {
    const project = createProject({
      name: 'Stamped',
      path: makeExternalDir('stamped'),
      managed: false,
    });
    assert.equal(project.lastOpenedAt, null);

    const opened = await api('POST', `/api/projects/${project.id}/open`);
    assert.equal(typeof projectFrom(opened.body).lastOpenedAt, 'number');

    const list = await api('GET', '/api/projects');
    assert.equal(list.body.activeId, project.id);
  });

  test('opening a project that does not exist is a 404, not a silent no-op', async () => {
    const before = getRoot('projects');
    const { status, body } = await api('POST', '/api/projects/nope/open');

    assert.equal(status, 404);
    assert.equal(errorCode(body), 'not_found');
    assert.equal(getRoot('projects'), before, 'a failed open must not move the scope');
  });
});

describe('deleting a project', () => {
  test('deletion removes the registry row and leaves every file untouched', async () => {
    const dir = makeExternalDir('keep-files');
    const file = path.join(dir, 'important.txt');
    fs.writeFileSync(file, 'the user\'s work');

    const project = createProject({ name: 'Precious', path: dir, managed: false });
    const { status, body } = await api('DELETE', `/api/projects/${project.id}`);

    assert.equal(status, 200);
    assert.equal(body.filesRemoved, false);
    assert.equal(fs.existsSync(dir), true, 'the project directory must survive deletion');
    assert.equal(fs.readFileSync(file, 'utf8'), 'the user\'s work');
    assert.equal(
      listProjects().some((candidate) => candidate.id === project.id),
      false,
    );
  });

  test('a managed project keeps its directory too', async () => {
    const created = await api('POST', '/api/projects', { name: 'Managed Keep' });
    const dir = projectFrom(created.body).path as string;
    fs.writeFileSync(path.join(dir, 'notes.md'), '# notes');

    await api('DELETE', `/api/projects/${projectFrom(created.body).id as string}`);

    assert.equal(
      fs.existsSync(path.join(dir, 'notes.md')),
      true,
      'Hyperion having created the directory does not make its contents ours to delete',
    );
  });

  test('deleting the active project returns the scope to the default root', async () => {
    const project = createProject({
      name: 'Active Then Gone',
      path: makeExternalDir('gone'),
      managed: false,
    });

    switchActiveProject(project.id);
    assert.notEqual(getRoot('projects'), defaultProjectRoot());

    const { body } = await api('DELETE', `/api/projects/${project.id}`);

    assert.equal(body.activeRoot, defaultProjectRoot());
    assert.equal(getRoot('projects'), defaultProjectRoot());
    assert.equal(activeProject(), null);
  });

  test('deleting an unrelated project leaves the active one alone', async () => {
    const active = createProject({
      name: 'Stays',
      path: makeExternalDir('stays'),
      managed: false,
    });
    const other = createProject({
      name: 'Goes',
      path: makeExternalDir('goes'),
      managed: false,
    });

    switchActiveProject(active.id);
    await api('DELETE', `/api/projects/${other.id}`);

    assert.equal(activeProject()?.id, active.id);
    assert.equal(getRoot('projects'), fs.realpathSync(active.path));
  });
});

describe('the active project across a restart', () => {
  test('the stored choice is re-applied on boot', async () => {
    const project = createProject({
      name: 'Persisted',
      path: makeExternalDir('persisted'),
      managed: false,
    });
    switchActiveProject(project.id);

    // What a restart looks like to this module: the setting survives in the
    // database, the cached root does not.
    setProjectRoot(null);
    assert.equal(getRoot('projects'), defaultProjectRoot());

    const restored = restoreActiveProject();

    assert.equal(restored?.id, project.id);
    assert.equal(getRoot('projects'), fs.realpathSync(project.path));
  });

  test('no active project resolves to the default root rather than failing', () => {
    clearActive();

    assert.equal(restoreActiveProject(), null);
    assert.equal(getRoot('projects'), defaultProjectRoot());
  });

  test('an active id whose row is gone degrades to no project', async () => {
    const project = createProject({
      name: 'Vanishing',
      path: makeExternalDir('vanishing'),
      managed: false,
    });
    switchActiveProject(project.id);

    // A hand-edited database or a restored backup can leave the pointer dangling.
    const { getDb } = await import('../src/db/adapter.ts');
    getDb().prepare('DELETE FROM projects WHERE id = ?').run(project.id);

    assert.equal(
      restoreActiveProject(),
      null,
      'a dangling pointer must not break every path resolution in the app',
    );
    assert.equal(getRoot('projects'), defaultProjectRoot());
  });
});

describe('reading projects back', () => {
  test('details are returned for a known id and 404 for an unknown one', async () => {
    const project = createProject({
      name: 'Readable',
      path: makeExternalDir('readable'),
      managed: false,
    });

    const found = await api('GET', `/api/projects/${project.id}`);
    assert.equal(found.status, 200);
    assert.equal(projectFrom(found.body).name, 'Readable');
    assert.equal(typeof projectFrom(found.body).createdAt, 'number');

    const missing = await api('GET', '/api/projects/does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal(errorCode(missing.body), 'not_found');
  });

  test('renaming changes the label and never the path', async () => {
    const dir = makeExternalDir('rename');
    const project = createProject({ name: 'Before', path: dir, managed: false });

    const { status, body } = await api('PATCH', `/api/projects/${project.id}`, { name: 'After' });

    assert.equal(status, 200);
    assert.equal(projectFrom(body).name, 'After');
    assert.equal(projectFrom(body).path, project.path);
  });
});
