import './helpers.ts';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const { cleanupHome, freshDb, testHome } = await import('./helpers.ts');
const { AppError } = await import('../src/util/errors.ts');
const {
  readCodeFile,
  restoreArtifactVersion,
  writeCodeFile,
} = await import('../src/services/code/files.ts');
const { getDb } = await import('../src/db/adapter.ts');

const root = path.join(testHome, 'code-files');
const taskId = 'task-code-files';

function services() {
  return {
    taskId,
    resolvePath(candidate: string): string {
      const absolute = path.resolve(root, candidate);
      const relative = path.relative(root, absolute);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new AppError('scope_violation', 'path outside test workspace');
      }
      return absolute;
    },
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof AppError ? error.code : undefined;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

before(async () => {
  await freshDb();
  await fs.mkdir(root, { recursive: true });
});

after(async () => {
  await cleanupHome();
});

describe('scoped Code file mutation', () => {
  it('creates a missing file only when absence was observed and snapshots that absence', async () => {
    const result = await writeCodeFile(
      { path: 'new.ts', content: 'export const value = 1;\n', expectedSha256: null },
      services(),
    );

    assert.equal(result.path, 'new.ts');
    assert.equal(result.version, 1);
    assert.equal(await fs.readFile(path.join(root, 'new.ts'), 'utf8'), 'export const value = 1;\n');

    const snapshot = getDb()
      .prepare<{ content: string | null; label: string | null }>(
        'SELECT content, label FROM artifact_versions WHERE artifact_key = ? AND version = 1',
      )
      .get(`code:file:${taskId}:new.ts`);
    assert.deepEqual(snapshot, { content: '', label: 'code-file:absent' });
  });

  it('rejects a stale hash without changing the file or creating a snapshot', async () => {
    const file = path.join(root, 'stale.ts');
    await fs.writeFile(file, 'current', 'utf8');

    await assert.rejects(
      writeCodeFile({ path: 'stale.ts', content: 'replacement', expectedSha256: 'wrong' }, services()),
      (error: unknown) => errorCode(error) === 'conflict',
    );
    assert.equal(await fs.readFile(file, 'utf8'), 'current');
    const count = getDb()
      .prepare<{ count: number }>(
        'SELECT COUNT(*) AS count FROM artifact_versions WHERE artifact_key = ?',
      )
      .get(`code:file:${taskId}:stale.ts`);
    assert.equal(count?.count, 0);
  });

  it('snapshots an existing empty file as present, then restores it', async () => {
    const file = path.join(root, 'empty.ts');
    await fs.writeFile(file, '', 'utf8');

    const written = await writeCodeFile(
      { path: 'empty.ts', content: 'changed', expectedSha256: sha256('') },
      services(),
    );
    assert.equal(written.version, 1);

    const snapshot = getDb()
      .prepare<{ content: string | null; label: string | null }>(
        'SELECT content, label FROM artifact_versions WHERE artifact_key = ? AND version = 1',
      )
      .get(`code:file:${taskId}:empty.ts`);
    assert.deepEqual(snapshot, { content: '', label: 'code-file:present' });

    const restored = await restoreArtifactVersion(
      {
        artifactKey: `code:file:${taskId}:empty.ts`,
        version: 1,
        path: 'empty.ts',
        expectedSha256: written.sha256,
      },
      services(),
    );
    assert.equal(restored.sha256, sha256(''));
    assert.equal(await fs.readFile(file, 'utf8'), '');
  });

  it('restores an absent snapshot by deleting the file and leaves an undo snapshot', async () => {
    const restored = await restoreArtifactVersion(
      {
        artifactKey: `code:file:${taskId}:new.ts`,
        version: 1,
        path: 'new.ts',
        expectedSha256: sha256('export const value = 1;\n'),
      },
      services(),
    );

    assert.equal(restored.sha256, null);
    await assert.rejects(fs.access(path.join(root, 'new.ts')));
    assert.equal(restored.version, 2);
  });

  it('refuses to restore when the current file changed after the caller observed it', async () => {
    const file = path.join(root, 'restore-conflict.ts');
    await fs.writeFile(file, 'before', 'utf8');
    const written = await writeCodeFile(
      { path: 'restore-conflict.ts', content: 'after', expectedSha256: sha256('before') },
      services(),
    );
    await fs.writeFile(file, 'external change', 'utf8');

    await assert.rejects(
      restoreArtifactVersion(
        {
          artifactKey: `code:file:${taskId}:restore-conflict.ts`,
          version: 1,
          path: 'restore-conflict.ts',
          expectedSha256: written.sha256,
        },
        services(),
      ),
      (error: unknown) => errorCode(error) === 'conflict',
    );
    assert.equal(await fs.readFile(file, 'utf8'), 'external change');
    const count = getDb()
      .prepare<{ count: number }>(
        'SELECT COUNT(*) AS count FROM artifact_versions WHERE artifact_key = ?',
      )
      .get(`code:file:${taskId}:restore-conflict.ts`);
    assert.equal(count?.count, 1);
  });

  it('rejects paths outside the task workspace', async () => {
    await assert.rejects(
      readCodeFile('../outside.ts', services()),
      (error: unknown) => errorCode(error) === 'scope_violation',
    );
  });
});