/**
 * Profile import files `.md` agent profiles into the active project's
 * `.hyperion/agents/` — the profile set's first writer.
 *
 * Real HTTP against a real app, real project directories on disk: the policy
 * under test is about where bytes land, so a unit test against the service
 * alone could not pin the containment half (a traversal spelling must land
 * inside the agents directory, and land nowhere else).
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

const { cleanupHome, freshDb, testHome } = await import('./helpers.ts');
const { createProject } = await import('../src/db/projects.ts');
const { clearActive, switchActiveProject } = await import('../src/services/projects/active.ts');
const { createApp } = await import('../src/http/app.ts');

interface ImportResult {
  filename: string;
  name: string | null;
  status: string;
  path?: string;
  error?: string;
}

interface ImportBody {
  project: { id: string; name: string };
  imported: number;
  count: number;
  results: ImportResult[];
}

let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let base = '';
let projectId = '';
let projectDir = '';

async function postImport(
  files: { filename: string; content: string | Buffer }[],
  fields: Record<string, string> = {},
): Promise<{ status: number; body: ImportBody & { error?: string; details?: unknown } }> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const file of files) {
    const bytes = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content;
    form.append('files', new Blob([new Uint8Array(bytes)]), file.filename);
  }
  const res = await fetch(`${base}/api/code/agents/import`, { method: 'POST', body: form });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as ImportBody };
}

const VALID = (name: string): string =>
  `---\nname: ${name}\nmode: plan\n---\n\n# ${name}\n\nYou review, you never write.\n`;

function agentsDir(): string {
  return path.join(projectDir, '.hyperion', 'agents');
}

function listed(): string[] {
  return fs.existsSync(agentsDir()) ? fs.readdirSync(agentsDir()).sort() : [];
}

before(async () => {
  await freshDb();
  projectDir = fs.mkdtempSync(path.join(testHome, 'import-project-'));
  const project = createProject({ name: 'Import Target', path: projectDir, managed: false });
  projectId = project.id;

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

beforeEach(() => {
  fs.rmSync(path.join(projectDir, '.hyperion'), { recursive: true, force: true });
  switchActiveProject(projectId);
});

afterEach(() => {
  clearActive();
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

describe('POST /api/code/agents/import', () => {
  it('files valid profiles into the active project and lists them back', async () => {
    const { status, body } = await postImport([
      { filename: 'reviewer.md', content: VALID('Reviewer') },
      { filename: 'scribe.md', content: '# Scribe\n\nNo front matter at all.\n' },
    ]);
    assert.equal(status, 200);
    assert.equal(body.project.id, projectId);
    assert.equal(body.imported, 2);
    assert.equal(body.count, 2);
    assert.deepEqual(
      body.results.map((r) => [r.filename, r.status, r.name]),
      [
        ['reviewer.md', 'imported', 'Reviewer'],
        ['scribe.md', 'imported', 'Scribe'],
      ],
    );
    assert.deepEqual(listed(), ['reviewer.md', 'scribe.md']);
    assert.equal(fs.readFileSync(path.join(agentsDir(), 'reviewer.md'), 'utf8'), VALID('Reviewer'));

    // Read back through the same parser that will serve them: an import the
    // scanner cannot read is a file the user filed and the app cannot see.
    const list = await fetch(`${base}/api/code/agents`);
    const listed2 = (await list.json()) as { count: number; agents: { name: string }[] };
    assert.equal(listed2.count, 2);
    assert.deepEqual(
      listed2.agents.map((a) => a.name).sort(),
      ['Reviewer', 'Scribe'],
    );
  });

  it('reports a non-.md file as invalid and files nothing', async () => {
    const { status, body } = await postImport([{ filename: 'notes.txt', content: 'not a profile\n' }]);
    assert.equal(status, 200);
    assert.equal(body.imported, 0);
    assert.equal(body.results[0]?.status, 'invalid');
    assert.match(body.results[0]?.error ?? '', /Only \.md files/);
    assert.deepEqual(listed(), []);
  });

  it('reports malformed front matter as invalid and files nothing', async () => {
    const { status, body } = await postImport([
      { filename: 'broken.md', content: '---\nmode: hyperdrive\n---\n\nNonsense mode.\n' },
    ]);
    assert.equal(status, 200);
    assert.equal(body.imported, 0);
    assert.equal(body.results[0]?.status, 'invalid');
    assert.match(body.results[0]?.error ?? '', /unknown mode/);
    assert.deepEqual(listed(), []);
  });

  it('reports an oversize file as invalid and files nothing', async () => {
    const big = `# Big\n\n${'x'.repeat(70 * 1024)}\n`;
    const { status, body } = await postImport([{ filename: 'big.md', content: big }]);
    assert.equal(status, 200);
    assert.equal(body.results[0]?.status, 'invalid');
    assert.match(body.results[0]?.error ?? '', /64 KiB/);
    assert.deepEqual(listed(), []);
  });

  it('skips a colliding name by default and leaves the original untouched', async () => {
    const before = VALID('Original');
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.writeFileSync(path.join(agentsDir(), 'helper.md'), before);

    const { status, body } = await postImport([{ filename: 'helper.md', content: VALID('Replacement') }]);
    assert.equal(status, 200);
    assert.equal(body.imported, 0);
    assert.equal(body.results[0]?.status, 'skipped');
    assert.match(body.results[0]?.error ?? '', /already exists/);
    assert.equal(fs.readFileSync(path.join(agentsDir(), 'helper.md'), 'utf8'), before);
  });

  it('rename files a colliding import under a -2 suffix', async () => {
    const before = VALID('Original');
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.writeFileSync(path.join(agentsDir(), 'helper.md'), before);

    const { status, body } = await postImport(
      [{ filename: 'helper.md', content: VALID('Replacement') }],
      { onConflict: 'rename' },
    );
    assert.equal(status, 200);
    assert.equal(body.imported, 1);
    assert.equal(body.results[0]?.status, 'renamed');
    assert.equal(body.results[0]?.path, '.hyperion/agents/helper-2.md');
    assert.equal(fs.readFileSync(path.join(agentsDir(), 'helper.md'), 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(agentsDir(), 'helper-2.md'), 'utf8'), VALID('Replacement'));
  });

  it('overwrite without confirm refuses the whole request before anything lands', async () => {
    const { status, body } = await postImport(
      [
        { filename: 'one.md', content: VALID('One') },
        { filename: 'two.md', content: VALID('Two') },
      ],
      { onConflict: 'overwrite' },
    );
    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /confirm/);
    // Policy before bytes: neither file landed.
    assert.deepEqual(listed(), []);
  });

  it('overwrite with confirm replaces the original', async () => {
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.writeFileSync(path.join(agentsDir(), 'helper.md'), VALID('Original'));

    const { status, body } = await postImport(
      [{ filename: 'helper.md', content: VALID('Replacement') }],
      { onConflict: 'overwrite', confirm: 'true' },
    );
    assert.equal(status, 200);
    assert.equal(body.results[0]?.status, 'overwritten');
    assert.equal(fs.readFileSync(path.join(agentsDir(), 'helper.md'), 'utf8'), VALID('Replacement'));
  });

  it('refuses an empty upload naming the field', async () => {
    const { status, body } = await postImport([]);
    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /files/);
  });

  it('a traversal spelling lands inside the agents directory and nowhere else', async () => {
    const { status, body } = await postImport([
      { filename: '../../evil.md', content: VALID('Evil') },
    ]);
    assert.equal(status, 200);
    assert.equal(body.results[0]?.status, 'imported');
    assert.equal(body.results[0]?.path, '.hyperion/agents/evil.md');
    assert.deepEqual(listed(), ['evil.md']);
    assert.equal(fs.existsSync(path.join(projectDir, 'evil.md')), false);
    assert.equal(fs.existsSync(path.join(path.dirname(projectDir), 'evil.md')), false);
  });

  it('with no project open there is no destination, and it says so', async () => {
    clearActive();
    const { status, body } = await postImport([{ filename: 'orphan.md', content: VALID('Orphan') }]);
    assert.equal(status, 409);
    assert.match(JSON.stringify(body), /no_active_project/);
  });

  it('more than fifty files is refused before anything lands', async () => {
    const files = Array.from({ length: 51 }, (_, n) => ({
      filename: `bulk-${n}.md`,
      content: VALID(`Bulk ${n}`),
    }));
    const { status, body } = await postImport(files);
    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /50/);
    assert.deepEqual(listed(), []);
  });

  it('an unknown onConflict names the field', async () => {
    const { status, body } = await postImport([{ filename: 'x.md', content: VALID('X') }], {
      onConflict: 'merge',
    });
    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /onConflict/);
    assert.deepEqual(listed(), []);
  });
});
