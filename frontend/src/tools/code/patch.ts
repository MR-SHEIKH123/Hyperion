/**
 * A unified diff, split into the files it touches.
 *
 * **Why this lives in the frontend.** `GET /api/code/tasks/:taskId/diff`
 * answers with one patch string, and that shape is ratified in docs/API.md §27:
 * the backend runs `git diff` once and hands the text over. Widening the wire
 * with a per-file array would put a parser in the backend and change a frozen
 * contract for the benefit of one screen; parsing it here keeps the route
 * exactly as documented and keeps the parser next to the list that displays it.
 *
 * **Why it is a pure function over a string.** It is the only part of the panel
 * that can be wrong in a way the eye cannot catch — a count that is off by one
 * per hunk, a new file counted as a deletion — so it is tested against fixed
 * patches rather than against a repository that has to be set up first.
 *
 * **Checked against real git, not only against fixed strings.** A scratch
 * repository carrying every change kind at once (modify, add, delete, rename,
 * binary, a quoted path with a space, a mode-only change) was diffed and this
 * parser compared against `git diff --numstat`; the one disagreement was the
 * comparison's own fault — `--numstat` writes a rename as `old => new`, which is
 * its display notation rather than a path. That scratch check is not a committed
 * test because this project is browser-typed and spawning git is not: the fixed
 * patches in `patch.test.ts` are the standing guarantee.
 *
 * **What it deliberately does not do.** No hunks, no line numbers, no word-level
 * diff, no syntax. The panel lists files with their counts and shows the patch as
 * text; a hunk model is a larger thing the backend does not promise, and a
 * half-built one in the browser would disagree with `git` in ways nobody could
 * check. Binary files, renames and mode-only changes are recognised so a reader
 * is told the truth about them rather than shown `0 +0 −0`.
 */

export interface PatchFile {
  /**
   * The path to open: the new path, or the old one when the file is gone.
   *
   * A deletion has no new path — `+++` is `/dev/null` — so a list that named only
   * the new side would show a deleted file as an empty string.
   */
  path: string;
  additions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
}

export interface PatchSummary {
  files: PatchFile[];
  /** Totals across every file, so a header does not have to add them up again. */
  additions: number;
  deletions: number;
}

/** Strip a `a/` or `b/` prefix — and only those, so `avarice/x` survives. */
function stripSide(path: string): string {
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

/**
 * Undo git's quoting for a path with special characters in it.
 *
 * git writes `"a/with space"` rather than `a/with space`, and escapes what it
 * quotes. A parser that skipped this would show a path with literal quotes in
 * it, which is a path that does not exist — worse than a wrong count, because it
 * looks right.
 */
function unquote(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const inner = raw.slice(1, -1);
  return inner.replace(/\\(\\|"|t|n|r|[0-7]{3})/g, (match, escape: string) => {
    if (escape === 't') return '\t';
    if (escape === 'n') return '\n';
    if (escape === 'r') return '\r';
    if (/^[0-7]{3}$/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8));
    return escape;
  });
}

/** The `b/…` side of `diff --git a/… b/…`, used when no `+++` line names a path. */
function pathFromHeader(line: string): string {
  const rest = line.slice('diff --git '.length).trim();
  // Prefer a quoted `b/…`, so a path containing ` b/` cannot split the header at
  // the wrong place. git quotes exactly the paths where that would be ambiguous.
  const quoted = rest.match(/"b\/(?:[^"\\]|\\.)*"$/);
  if (quoted !== null) return stripSide(unquote(quoted[0]));
  const index = rest.lastIndexOf(' b/');
  return index < 0 ? '' : stripSide(rest.slice(index + 1));
}

function blankFile(path: string): PatchFile {
  return { path, additions: 0, deletions: 0, isNew: false, isDeleted: false, isBinary: false };
}

/**
 * Split `patch` into its files, with per-file additions and deletions.
 *
 * An empty patch is an empty summary, not an error: "no changes" is an answer.
 */
export function splitPatch(patch: string): PatchSummary {
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let oldPath: string | null = null;
  let newPath: string | null = null;
  /**
   * Inside a `@@` hunk the `---`/`+++` prefixes are content, not headers.
   *
   * Without this, deleting a line whose text begins with two dashes and a space
   * — `--- ` — would be read as a file header and the path would change under the
   * reader. Hunk state is the only thing that tells the two apart.
   */
  let inHunk = false;

  const flush = (): void => {
    if (current === null) return;
    // The new side names the file as it is now; for a deletion that is nothing,
    // so the old path is the one a reader can still do something with.
    current.path = newPath ?? oldPath ?? current.path;
    files.push(current);
    current = null;
    oldPath = null;
    newPath = null;
    inHunk = false;
  };

  // `split('\n')` on a patch that ends in a newline leaves a trailing empty
  // string; it matches no prefix below, so it is harmless.
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      current = blankFile(pathFromHeader(line));
      continue;
    }

    // A plain `diff -u` has no `diff --git` header at all — the `---` line is the
    // first thing that names a file. Starting a record here is what lets the same
    // parser read both, instead of answering "no files" for a real diff.
    if (current === null && !inHunk && line.startsWith('--- ')) {
      current = blankFile('');
    }
    if (current === null) continue;

    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk && line.startsWith('--- ')) {
      const value = line.slice(4).trim();
      if (value !== '/dev/null') oldPath = stripSide(unquote(value));
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const value = line.slice(4).trim();
      if (value !== '/dev/null') newPath = stripSide(unquote(value));
      continue;
    }
    if (line.startsWith('new file mode ')) {
      current.isNew = true;
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      current.isDeleted = true;
      continue;
    }
    if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
      oldPath = stripSide(unquote(line.slice(line.indexOf(' from ') + 6).trim()));
      continue;
    }
    if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      newPath = stripSide(unquote(line.slice(line.indexOf(' to ') + 4).trim()));
      continue;
    }
    // Binary diffs carry no `+`/`-` lines at all; without this the file would be
    // listed as an empty textual change, which reads as "nothing happened".
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.isBinary = true;
      continue;
    }
    // Outside a hunk, `+++`/`---` were the file headers and were handled above;
    // inside one they are content and fall through to be counted. `\ No newline
    // at end of file` starts with a backslash and is never counted.
    if (line.startsWith('+')) {
      current.additions += 1;
      continue;
    }
    if (line.startsWith('-')) {
      current.deletions += 1;
    }
  }
  flush();

  return {
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}
