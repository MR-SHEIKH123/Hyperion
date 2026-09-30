/**
 * Scoped, clobber-safe text file mutation for the Code agent.
 *
 * Every path is resolved by the task's AgentContext before disk access. Writes
 * require the caller's hash of the state it observed (or null for an expected
 * absence), so a model cannot silently replace work that changed after its
 * read. The previous state is stored inline before replacement; file-backed
 * artifact references are intentionally never used for undo because they are
 * mutable by definition.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getDb } from '../../db/adapter.ts';
import { assertNoSymlinkedTraversal, assertStillInside } from '../../security/toctou.ts';
import { AppError } from '../../util/errors.ts';

import type { ToolName } from '../../types/core.ts';

const PRESENT_LABEL = 'code-file:present';
const ABSENT_LABEL = 'code-file:absent';

export interface ArtifactVersionInput {
  artifactKey: string;
  tool: ToolName;
  content?: string;
  relPath?: string;
  label?: string;
}

export interface ArtifactVersionServices {
  resolvePath(candidate: string): string;
  emit?(artifactKey: string, version: number, label: string | null): void;
}

interface ArtifactRow {
  artifact_key: string;
  tool: string;
  version: number;
  content: string | null;
  rel_path: string | null;
  label: string | null;
}

interface FileState {
  exists: boolean;
  content: string;
  sha256: string | null;
  bytes: number;
}

export interface CodeFileServices extends ArtifactVersionServices {
  taskId: string;
}

export function saveArtifactVersion(
  artifact: ArtifactVersionInput,
  services: ArtifactVersionServices,
): { version: number } {
  const key = artifact.artifactKey.trim();
  if (!key) throw new AppError('bad_request', 'artifactKey is required');
  if (artifact.content === undefined && !artifact.relPath) {
    throw new AppError('bad_request', 'Either content or relPath is required');
  }

  let relPath: string | null = null;
  let bytes: number | null = null;
  let sha256: string | null = null;
  if (artifact.content !== undefined) {
    bytes = Buffer.byteLength(artifact.content, 'utf8');
    sha256 = hash(artifact.content);
  }
  if (artifact.relPath) {
    const absolute = services.resolvePath(artifact.relPath);
    relPath = artifact.relPath;
    if (bytes === null) bytes = fileBytes(absolute);
  }

  const db = getDb();
  const inserted = db.transaction(() => {
    const current = db
      .prepare<{ maxVersion: number | null }>(
        'SELECT MAX(version) AS maxVersion FROM artifact_versions WHERE artifact_key = ?',
      )
      .get(key);
    const version = (current?.maxVersion ?? 0) + 1;
    db.prepare(
      `INSERT INTO artifact_versions
         (id, artifact_key, tool, version, content, rel_path, label, bytes, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      key,
      artifact.tool,
      version,
      artifact.content ?? null,
      relPath,
      artifact.label ?? null,
      bytes,
      sha256,
      Date.now(),
    );
    return version;
  })();

  services.emit?.(key, inserted, artifact.label ?? null);
  return { version: inserted };
}

export async function readCodeFile(
  candidate: string,
  services: CodeFileServices,
): Promise<{ path: string; content: string; sha256: string; bytes: number }> {
  const location = locate(candidate, services);
  const state = await readState(location.absolute);
  if (!state.exists || state.sha256 === null) {
    throw new AppError('not_found', `Code file "${location.relative}" was not found.`, {
      details: { path: location.relative },
    });
  }
  return { path: location.relative, content: state.content, sha256: state.sha256, bytes: state.bytes };
}

export async function writeCodeFile(
  input: { path: string; content: string; expectedSha256: string | null },
  services: CodeFileServices,
): Promise<{ path: string; sha256: string; version: number }> {
  const location = locate(input.path, services);
  const before = await readState(location.absolute);
  assertExpected(location.relative, before, input.expectedSha256);

  const saved = saveArtifactVersion(
    {
      artifactKey: location.artifactKey,
      tool: 'code',
      content: before.content,
      label: before.exists ? PRESENT_LABEL : ABSENT_LABEL,
    },
    services,
  );
  await atomicReplace(location.absolute, input.content, before, location.relative);
  return { path: location.relative, sha256: hash(input.content), version: saved.version };
}

export async function restoreArtifactVersion(
  input: { artifactKey: string; version: number; path: string; expectedSha256: string | null },
  services: CodeFileServices,
): Promise<{ path: string; sha256: string | null; version: number }> {
  const location = locate(input.path, services);
  if (input.artifactKey !== location.artifactKey) {
    throw new AppError('bad_request', 'The artifact key does not belong to the requested file.', {
      details: { artifactKey: input.artifactKey, path: location.relative },
    });
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new AppError('bad_request', 'version must be a positive integer');
  }

  const artifact = getDb()
    .prepare<ArtifactRow>(
      `SELECT artifact_key, tool, version, content, rel_path, label
         FROM artifact_versions WHERE artifact_key = ? AND version = ?`,
    )
    .get(input.artifactKey, input.version);
  if (!artifact) throw new AppError('not_found', 'The requested artifact version was not found.');
  if (
    artifact.tool !== 'code' ||
    artifact.rel_path !== null ||
    artifact.content === null ||
    (artifact.label !== PRESENT_LABEL && artifact.label !== ABSENT_LABEL)
  ) {
    throw new AppError('bad_request', 'Only inline Code file snapshots can be restored.');
  }

  const current = await readState(location.absolute);
  assertExpected(location.relative, current, input.expectedSha256);
  const undo = saveArtifactVersion(
    {
      artifactKey: location.artifactKey,
      tool: 'code',
      content: current.content,
      label: current.exists ? PRESENT_LABEL : ABSENT_LABEL,
    },
    services,
  );

  if (artifact.label === ABSENT_LABEL) {
    await assertUnchanged(location.relative, location.absolute, current);
    if (current.exists) await fs.promises.unlink(location.absolute);
    return { path: location.relative, sha256: null, version: undo.version };
  }

  await atomicReplace(location.absolute, artifact.content, current, location.relative);
  return { path: location.relative, sha256: hash(artifact.content), version: undo.version };
}

/**
 * Segment spellings that name git's own directory.
 *
 * Compared after lower-casing and after stripping trailing dots and spaces,
 * because Windows silently strips both when opening a path: `.git.` and
 * `.git ` open `.git` there, and a check that compared the literal string
 * would wave them through on the one platform where it matters.
 */
function isGitSegment(segment: string): boolean {
  return segment.toLowerCase().replace(/[. ]+$/, '') === '.git';
}

function locate(candidate: string, services: CodeFileServices): {
  absolute: string;
  relative: string;
  artifactKey: string;
} {
  const root = services.resolvePath('.');
  // Point-of-use revalidation (prompt-1 item P1-S4), in the only order that
  // works: the spelling first, because the resolver below canonicalises symlinks
  // away and would leave nothing for a traversal check to see; then the resolved
  // path against the task's own boundary, which the scope-wide resolver cannot
  // express — two tasks in one `projects` scope are both "in scope" and are not
  // each other's workspace.
  assertNoSymlinkedTraversal(root, candidate);
  const absolute = assertStillInside(root, services.resolvePath(candidate));
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (!relative || relative === '.' || relative.startsWith('../')) {
    throw new AppError('bad_request', 'A Code file path must name a file inside the task workspace.');
  }

  // Containment is not enough for `.git`. In `direct` mode the task root *is*
  // the project directory, so `.git/config` is legitimately inside the
  // boundary — and writing it turns `diff.<driver>.textconv`, `filter.*.clean`,
  // `core.fsmonitor` and `.git/hooks/post-checkout` into commands Hyperion
  // itself will execute, unapproved, the next time it runs git (the patch
  // export, a worktree release, or the orphan scan at boot). In worktree mode
  // `.git` is a *file* holding the gitdir pointer, and rewriting it redirects
  // the repository wholesale.
  //
  // `gitHardening.ts` neutralizes the execution at each git call site; this
  // closes the write that arms it. Two layers, because the whole class of bug
  // is "one path missed the check". `.gitignore`, `.gitattributes` and
  // `.github/` are ordinary tracked files and stay writable — only the `.git`
  // directory (or pointer file) itself is refused.
  const offending = relative.split('/').find((segment) => isGitSegment(segment));
  if (offending !== undefined) {
    throw new AppError('scope_violation', 'A Code file path may not reach into the .git directory.', {
      details: { path: relative, segment: offending },
    });
  }

  return { absolute, relative, artifactKey: `code:file:${services.taskId}:${relative}` };
}

async function readState(absolute: string): Promise<FileState> {
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(absolute);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { exists: false, content: '', sha256: null, bytes: 0 };
    if (hasCode(error, 'EISDIR')) throw new AppError('bad_request', 'The requested Code path is a directory.');
    throw error;
  }

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new AppError('bad_request', 'The Code file is not valid UTF-8 text.', { cause: error });
  }
  return { exists: true, content, sha256: hash(bytes), bytes: bytes.byteLength };
}

function assertExpected(relative: string, state: FileState, expected: string | null): void {
  const matches = expected === null ? !state.exists : state.exists && state.sha256 === expected;
  if (matches) return;
  throw new AppError('conflict', `Code file "${relative}" changed after it was read.`, {
    details: { path: relative, expectedSha256: expected, actualSha256: state.sha256 },
  });
}

async function assertUnchanged(relative: string, absolute: string, expected: FileState): Promise<void> {
  const latest = await readState(absolute);
  const unchanged = latest.exists === expected.exists && latest.sha256 === expected.sha256;
  if (!unchanged) {
    throw new AppError('conflict', `Code file "${relative}" changed while the update was being prepared.`, {
      details: { path: relative, expectedSha256: expected.sha256, actualSha256: latest.sha256 },
    });
  }
}

async function atomicReplace(
  absolute: string,
  content: string,
  expected: FileState,
  relative: string,
): Promise<void> {
  const parent = path.dirname(absolute);
  await fs.promises.mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(absolute)}.hyperion-${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await assertUnchanged(relative, absolute, expected);
    await fs.promises.rename(temporary, absolute);
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileBytes(absolute: string): number | null {
  try {
    return fs.statSync(absolute).size;
  } catch {
    return null;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === code;
}
