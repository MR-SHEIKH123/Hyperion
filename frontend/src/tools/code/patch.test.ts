import { describe, expect, it } from 'vitest';

import { splitPatch } from './patch';

/**
 * The patch parser (1.40's Canvas, rendered).
 *
 * Every case here is a fixed patch string, because a parser tested against a
 * live repository tests the repository as much as the parser — and the failures
 * that matter are the quiet ones: a new file counted as a deletion, a binary
 * change shown as an empty one, a path that keeps its quotes. Each test states
 * the git output it is standing in for.
 */

const MODIFIED = [
  'diff --git a/src/index.ts b/src/index.ts',
  'index 1111111..2222222 100644',
  '--- a/src/index.ts',
  '+++ b/src/index.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' export { a, b };',
  '',
].join('\n');

describe('splitPatch', () => {
  it('counts one modified file, and does not count the file headers', () => {
    const summary = splitPatch(MODIFIED);
    expect(summary.files).toEqual([
      {
        path: 'src/index.ts',
        additions: 2,
        deletions: 1,
        isNew: false,
        isDeleted: false,
        isBinary: false,
      },
    ]);
    expect(summary.additions).toBe(2);
    expect(summary.deletions).toBe(1);
  });

  it('splits several files and totals them', () => {
    const patch = [
      MODIFIED,
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');

    const summary = splitPatch(patch);
    expect(summary.files.map((file) => file.path)).toEqual(['src/index.ts', 'README.md']);
    expect(summary.additions).toBe(3);
    expect(summary.deletions).toBe(2);
  });

  it('names an added file, and does not read /dev/null as its path', () => {
    const patch = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
      '',
    ].join('\n');

    const summary = splitPatch(patch);
    expect(summary.files).toHaveLength(1);
    expect(summary.files[0]).toMatchObject({
      path: 'src/new.ts',
      additions: 2,
      deletions: 0,
      isNew: true,
    });
  });

  it('names a deleted file by its old path, because the new one is gone', () => {
    const patch = [
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      '',
    ].join('\n');

    const summary = splitPatch(patch);
    // Not '' and not '/dev/null' — the reader has to be able to name what died.
    expect(summary.files[0]?.path).toBe('src/gone.ts');
    expect(summary.files[0]).toMatchObject({ deletions: 2, isDeleted: true });
  });

  it('reports a rename at its new path with no line counts', () => {
    const patch = [
      'diff --git a/src/old.ts b/src/renamed.ts',
      'similarity index 100%',
      'rename from src/old.ts',
      'rename to src/renamed.ts',
      '',
    ].join('\n');

    const summary = splitPatch(patch);
    expect(summary.files[0]).toMatchObject({
      path: 'src/renamed.ts',
      additions: 0,
      deletions: 0,
    });
  });

  it('flags a binary change instead of reporting it as an empty one', () => {
    const patch = [
      'diff --git a/logo.png b/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n');

    const summary = splitPatch(patch);
    expect(summary.files[0]).toMatchObject({ path: 'logo.png', isBinary: true });
  });

  it('flags a GIT binary patch too, which carries no +/- lines at all', () => {
    const patch = [
      'diff --git a/blob.bin b/blob.bin',
      'new file mode 100644',
      'index 0000000..4444444',
      'GIT binary patch',
      'literal 3',
      'KcmZQzU|?VY00',
      '',
    ].join('\n');

    const summary = splitPatch(patch);
    expect(summary.files[0]).toMatchObject({ path: 'blob.bin', isBinary: true, isNew: true });
    // The encoded body is not diff syntax, so nothing in it may be counted.
    expect(summary.additions).toBe(0);
    expect(summary.deletions).toBe(0);
  });

  it('keeps a quoted path as the path, without its quotes', () => {
    const patch = [
      'diff --git "a/docs/my file.md" "b/docs/my file.md"',
      '--- "a/docs/my file.md"',
      '+++ "b/docs/my file.md"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');

    const summary = splitPatch(patch);
    expect(summary.files[0]?.path).toBe('docs/my file.md');
  });

  it('reads a plain diff -u, which has no diff --git header', () => {
    const patch = ['--- old.txt', '+++ new.txt', '@@ -1 +1 @@', '-a', '+b', ''].join('\n');
    const summary = splitPatch(patch);
    expect(summary.files.map((file) => file.path)).toEqual(['new.txt']);
    expect(summary.additions).toBe(1);
    expect(summary.deletions).toBe(1);
  });

  it('treats a deleted line of dashes as content, not as a file header', () => {
    const patch = [
      'diff --git a/notes.md b/notes.md',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1 +1 @@',
      '--- a line that happens to start with dashes',
      '+replaced',
      '',
    ].join('\n');

    const summary = splitPatch(patch);
    expect(summary.files).toHaveLength(1);
    expect(summary.files[0]).toMatchObject({ path: 'notes.md', deletions: 1, additions: 1 });
  });

  it('does not count the no-newline marker', () => {
    const patch = [
      'diff --git a/x.txt b/x.txt',
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -1 +1 @@',
      '-a',
      '\\ No newline at end of file',
      '+b',
      '\\ No newline at end of file',
      '',
    ].join('\n');

    const summary = splitPatch(patch);
    expect(summary.files[0]).toMatchObject({ additions: 1, deletions: 1 });
  });

  it('answers an empty patch with an empty summary, not with a file', () => {
    expect(splitPatch('')).toEqual({ files: [], additions: 0, deletions: 0 });
  });

  it('does not mistake a mode-only change for a textual one', () => {
    const patch = [
      'diff --git a/tool.sh b/tool.sh',
      'old mode 100644',
      'new mode 100755',
      '',
    ].join('\n');

    const summary = splitPatch(patch);
    expect(summary.files).toEqual([
      {
        path: 'tool.sh',
        additions: 0,
        deletions: 0,
        isNew: false,
        isDeleted: false,
        isBinary: false,
      },
    ]);
  });
});
