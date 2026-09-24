/**
 * Profile import (1.28): file `.md` agent profiles from an upload into the
 * active project's `.hyperion/agents/`, alongside the profiles already there.
 *
 * This is the first writer to the profile set — every other profile surface is
 * read-only — so the policy is stated as refusals:
 *
 *   1. **Never overwrites without explicit confirmation.** A name collision
 *      defaults to skipping the file; `rename` files it under `<stem>-2.md`
 *      (mirroring `freePath`'s suffix scheme); `overwrite` additionally
 *      requires `confirm: true`, and the policy is validated before the first
 *      byte is written, so a missing confirmation refuses the whole request
 *      rather than importing half the batch.
 *   2. **Only `.md`, only small, only parseable.** Anything else is reported
 *      per file as `invalid` — never silently dropped, never filed anyway.
 *      The parse is `parseProfileDocument` plus `profileFields`, the same two
 *      functions that will read the file back, so an import the scanner cannot
 *      read is unrepresentable.
 *   3. **Nowhere else.** Filenames are sanitized with `safeFilename` and
 *      resolved through the `projects` scope, which follows the active
 *      project — managed or not — so a traversal spelling cannot escape the
 *      destination directory. With no project open there is no destination,
 *      and the request is a 409 rather than a write into the scope fallback.
 *
 * Writes use the default file mode, not `0o600`: these are the user's own
 * project files, meant to be opened in an editor, unlike the app-managed
 * knowledge bytes. A batch is not atomic — files land sequentially and each
 * result says what happened to it — because a filesystem has no transaction
 * to roll back, and pretending otherwise would be the lie.
 */

import fs from 'node:fs';
import path from 'node:path';

import { activeProject } from '../../db/projects.ts';
import {
  ensureDirInScope,
  resolveInScope,
  safeFilename,
} from '../../security/fsScope.ts';
import { AppError, toAppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';
import { profileFields } from '../agent/profiles.ts';

import { parseProfileDocument } from './projectContext.ts';

const log = createLogger('profiles');

/** More files than this in one request is a script, not an import. */
export const PROFILE_IMPORT_MAX_FILES = 50;

/**
 * A profile is a prompt with front matter, not a document of record: 64 KiB is
 * already generous, and anything larger is reported per file rather than
 * failing the batch.
 */
export const PROFILE_IMPORT_MAX_BYTES = 64 * 1024;

export type OnConflict = 'skip' | 'rename' | 'overwrite';

export interface ProfileImportFile {
  filename: string;
  buffer: Buffer;
}

export type ProfileImportStatus = 'imported' | 'overwritten' | 'renamed' | 'skipped' | 'invalid';

export interface ProfileImportResult {
  /** The filename as uploaded, so the caller can match results to files. */
  filename: string;
  /** The resolved profile name, or null when the file never parsed. */
  name: string | null;
  status: ProfileImportStatus;
  /** Project-relative destination (`.hyperion/agents/<file>`) when written. */
  path?: string;
  /** Human reason for `skipped` and `invalid`. */
  error?: string;
}

export interface ProfileImportOutcome {
  project: { id: string; name: string };
  imported: number;
  results: ProfileImportResult[];
}

const AGENTS_DIR = path.join('.hyperion', 'agents');
/** Reporting prefix: project-relative paths use forward slashes on every OS. */
const AGENTS_PREFIX = '.hyperion/agents';

export function parseOnConflict(value: unknown): OnConflict {
  if (value === undefined || value === null || value === '') return 'skip';
  if (value === 'skip' || value === 'rename' || value === 'overwrite') return value;
  throw new AppError('bad_request', 'onConflict must be one of: skip, rename, overwrite.', {
    details: { field: 'onConflict', value },
  });
}

export function importProfiles(
  files: readonly ProfileImportFile[],
  options: { onConflict?: OnConflict; confirm?: boolean } = {},
): ProfileImportOutcome {
  const onConflict = options.onConflict ?? 'skip';

  // Policy before bytes: a refusal here must not leave half a batch behind.
  if (onConflict === 'overwrite' && options.confirm !== true) {
    throw new AppError(
      'bad_request',
      'Overwriting existing profiles requires confirm: true alongside onConflict: "overwrite".',
      { details: { field: 'confirm' } },
    );
  }
  if (files.length > PROFILE_IMPORT_MAX_FILES) {
    throw new AppError(
      'bad_request',
      `At most ${PROFILE_IMPORT_MAX_FILES} files may be imported at once.`,
      { details: { field: 'files', count: files.length } },
    );
  }

  const project = activeProject();
  if (!project) {
    throw new AppError('conflict', 'Open a project before importing agent profiles.', {
      details: { reason: 'no_active_project' },
    });
  }

  // The `projects` scope follows the active project (set on open, restored at
  // boot), so this is the active project's agents directory whether the project
  // is managed or lives anywhere else on disk.
  const dir = resolveInScope('projects', AGENTS_DIR);
  ensureDirInScope('projects', dir);

  const results: ProfileImportResult[] = [];
  for (const file of files) {
    results.push(importOneFile(dir, file, onConflict));
  }

  const imported = results.filter(
    (r) => r.status === 'imported' || r.status === 'overwritten' || r.status === 'renamed',
  ).length;
  log.info('profiles imported', { project: project.id, files: files.length, imported, onConflict });
  return { project: { id: project.id, name: project.name }, imported, results };
}

function importOneFile(dir: string, file: ProfileImportFile, onConflict: OnConflict): ProfileImportResult {
  const filename = safeFilename(file.filename, 'profile.md');
  if (!filename.toLowerCase().endsWith('.md')) {
    return { filename: file.filename, name: null, status: 'invalid', error: 'Only .md files can be imported as agent profiles.' };
  }
  if (file.buffer.byteLength > PROFILE_IMPORT_MAX_BYTES) {
    return {
      filename: file.filename,
      name: null,
      status: 'invalid',
      error: `Larger than the ${PROFILE_IMPORT_MAX_BYTES / 1024} KiB profile limit.`,
    };
  }

  let name: string;
  try {
    const doc = parseProfileDocument(filename, file.buffer.toString('utf8'));
    // Throws on unknown enums — the malformed front matter this must refuse.
    // Anything else a profile may declare is validated again on read.
    profileFields(doc.raw, doc.name);
    name = doc.name;
  } catch (error) {
    return { filename: file.filename, name: null, status: 'invalid', error: toAppError(error).message };
  }

  const dest = resolveInScope('projects', path.join(AGENTS_DIR, filename));
  if (!fs.existsSync(dest)) {
    fs.writeFileSync(dest, file.buffer);
    return { filename: file.filename, name, status: 'imported', path: `${AGENTS_PREFIX}/${filename}` };
  }

  if (onConflict === 'skip') {
    return {
      filename: file.filename,
      name,
      status: 'skipped',
      error: `"${filename}" already exists; re-send with onConflict rename or overwrite to file it anyway.`,
    };
  }
  if (onConflict === 'overwrite') {
    fs.writeFileSync(dest, file.buffer);
    return { filename: file.filename, name, status: 'overwritten', path: `${AGENTS_PREFIX}/${filename}` };
  }

  const renamed = nextFreeFilename(dir, filename);
  fs.writeFileSync(resolveInScope('projects', path.join(AGENTS_DIR, renamed)), file.buffer);
  return { filename: file.filename, name, status: 'renamed', path: `${AGENTS_PREFIX}/${renamed}` };
}

/** `<stem>-2.md`, `<stem>-3.md`, … — the same suffix scheme `freePath` uses. */
function nextFreeFilename(dir: string, filename: string): string {
  const stem = filename.slice(0, -'.md'.length);
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}.md`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}
