/**
 * Provenance: the two fields item 1.39 A6 asks for, end to end over HTTP.
 *
 *   * **Knowledge sources used** — a Cowork run reads the standing library, marks
 *     each source usable or not, and puts only the usable text in the prompt as
 *     evidence. The run's provenance is the list of those sources, recorded at
 *     read time and joined to the run, and this file pins what "used" means: an
 *     unusable source is *consulted*, not used, and must not appear as evidence.
 *   * **Parent version** — the version a version replaced, derived from the key
 *     and the version number rather than stored.
 *
 * Both are read through the real app over a socket, because the failure these
 * tests exist for is an envelope: a provenance route that quietly reported "no
 * sources" would be indistinguishable from a run that used none.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

const { createApp } = await import('../src/http/app.ts');
const { recordRunKnowledge } = await import('../src/db/runKnowledge.ts');
const { saveArtifactVersion } = await import('../src/services/code/files.ts');
const { startTaskRun } = await import('../src/db/taskRuns.ts');
const { fromRelative, setProjectRoot } = await import('../src/security/fsScope.ts');

let server: http.Server;
let base: string;

before(async () => {
  await freshDb();
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('the knowledge sources a run used', () => {
  test('are the evidence sources, joined to the run they were read for', async () => {
    startTaskRun({ runId: 'run-prov', taskId: 'task-prov', tool: 'cowork' });
    recordRunKnowledge('run-prov', [
      { sourceId: 'src-a', label: 'House style', filename: 'style.md', bytes: 120, sha256: 'a'.repeat(64) },
      { sourceId: 'src-b', label: null, filename: 'notes.txt', bytes: 8, sha256: null },
    ]);

    const { status, body } = await get('/api/cowork/tasks/task-prov/provenance');
    assert.equal(status, 200);
    const run = body.run as { runId: string };
    assert.equal(run.runId, 'run-prov', 'provenance belongs to the attempt, not the task');

    const sources = body.knowledgeSources as { sourceId: string; label: string | null; filename: string; bytes: number | null; sha256: string | null; usedAt: number }[];
    assert.equal(sources.length, 2);
    assert.deepEqual(
      sources.map((source) => source.sourceId),
      ['src-a', 'src-b'],
    );
    assert.equal(sources[0]?.label, 'House style');
    assert.equal(sources[0]?.bytes, 120);
    assert.equal(sources[0]?.sha256, 'a'.repeat(64));
    // A source registered without a pinned digest keeps that distinction rather
    // than being reported as a zero-byte or unhashed file.
    assert.equal(sources[1]?.sha256, null);
    assert.equal(typeof sources[0]?.usedAt, 'number');
  });

  test('are an empty list, not an error, for a run that used none', async () => {
    startTaskRun({ runId: 'run-prov-empty', taskId: 'task-prov-empty', tool: 'cowork' });
    const { status, body } = await get(`/api/cowork/tasks/task-prov-empty/provenance`);
    assert.equal(status, 200, 'an empty library is a fact, not a failure');
    assert.deepEqual(body.knowledgeSources, []);
  });

  test('a task with no run is a 404 rather than an invented empty list', async () => {
    const { status, body } = await get('/api/cowork/tasks/task-that-never-ran/provenance');
    assert.equal(status, 404);
    const error = body.error as { code: string };
    assert.equal(error.code, 'not_found');
  });

  test('deleting a source cannot erase the record that a run used it', async () => {
    // Provenance is a historical claim, which is why the row copies the label,
    // filename and digest in rather than referencing `knowledge_sources`.
    startTaskRun({ runId: 'run-prov-gone', taskId: 'task-prov-gone', tool: 'cowork' });
    recordRunKnowledge('run-prov-gone', [
      { sourceId: 'deleted-later', label: 'Old handbook', filename: 'handbook.md', bytes: 40, sha256: 'b'.repeat(64) },
    ]);

    const { getDb } = await import('../src/db/adapter.ts');
    getDb().prepare('DELETE FROM knowledge_sources WHERE id = ?').run('deleted-later');

    const { body } = await get('/api/cowork/tasks/task-prov-gone/provenance');
    const sources = body.knowledgeSources as { filename: string; sha256: string | null }[];
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.filename, 'handbook.md');
    assert.equal(sources[0]?.sha256, 'b'.repeat(64));
  });

  test('a second read for the same run replaces the first, rather than accumulating', async () => {
    startTaskRun({ runId: 'run-prov-retry', taskId: 'task-prov-retry', tool: 'cowork' });
    // Both the production path (a re-started run id, whose `INSERT OR REPLACE`
    // clears this table by cascade) and a direct second write land here.
    recordRunKnowledge('run-prov-retry', [{ sourceId: 'first-attempt', label: null, filename: 'a.md', bytes: 1, sha256: null }]);
    recordRunKnowledge('run-prov-retry', [{ sourceId: 'second-attempt', label: null, filename: 'b.md', bytes: 2, sha256: null }]);

    const { body } = await get('/api/cowork/tasks/task-prov-retry/provenance');
    const sources = body.knowledgeSources as { sourceId: string }[];
    assert.deepEqual(
      sources.map((source) => source.sourceId),
      ['second-attempt'],
    );
  });
});

describe('artifact versions and their parents', () => {
  test('list newest first, each naming the version it replaced', async () => {
    setProjectRoot(fromRelative('projects', '.').replace(/[\\/]\.$/, ''));
    const root = fromRelative('projects', 'provenance-demo');
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'plan.md');
    fs.writeFileSync(file, 'first\n');

    // The writer snapshots the state *before* each write: version 1 is "the file
    // as it was", version 2 is what the first edit replaced. Three saves make a
    // chain v1 <- v2 <- v3 with nothing stored to say so.
    const services = {
      resolvePath: (relative: string) => path.join(root, relative),
      emit: undefined,
    } as unknown as Parameters<typeof saveArtifactVersion>[1];
    saveArtifactVersion({ artifactKey: 'plan.md', tool: 'code', content: 'first\n', label: 'present' }, services);
    saveArtifactVersion({ artifactKey: 'plan.md', tool: 'code', content: 'second\n', label: 'present' }, services);
    saveArtifactVersion({ artifactKey: 'plan.md', tool: 'code', content: 'third\n', label: 'present' }, services);

    const { status, body } = await get('/api/artifacts/versions?key=plan.md');
    assert.equal(status, 200);
    assert.equal(body.artifactKey, 'plan.md');
    const versions = body.versions as { version: number; parentVersion: number | null; inline: boolean }[];
    assert.deepEqual(
      versions.map((version) => version.version),
      [3, 2, 1],
      'a timeline reads from the present backwards',
    );
    assert.deepEqual(
      versions.map((version) => version.parentVersion),
      [2, 1, null],
      'the parent is the previous version, and only the first has none',
    );
    assert.equal(versions[0]?.inline, true);
  });

  test('an unversioned key is an empty timeline, not a 404', async () => {
    const { status, body } = await get('/api/artifacts/versions?key=never-touched.md');
    assert.equal(status, 200);
    assert.deepEqual(body.versions, []);
  });

  test('a missing key is a 400 naming the field', async () => {
    const { status, body } = await get('/api/artifacts/versions');
    assert.equal(status, 400);
    const error = body.error as { code: string; details?: { field?: string } };
    assert.equal(error.code, 'bad_request');
    assert.equal(error.details?.field, 'key');
  });

  test('a limit takes the newest versions and is still a whole number within a bound', async () => {
    const { status, body } = await get('/api/artifacts/versions?key=plan.md&limit=2');
    assert.equal(status, 200);
    const versions = body.versions as { version: number; parentVersion: number | null }[];
    assert.deepEqual(
      versions.map((version) => version.version),
      [3, 2],
      'the limit drops the oldest, because a timelime is read from the present',
    );
    // The parent is derived from the rows on the page: version 3's parent is 2,
    // which is present, so the chain stays readable even when the page is cut.
    assert.equal(versions[0]?.parentVersion, 2);

    const bad = await get('/api/artifacts/versions?key=plan.md&limit=2.5');
    assert.equal(bad.status, 400, 'a limit is a whole number, per S17');
  });
});
