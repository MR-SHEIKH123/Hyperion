/**
 * Cowork knowledge sources — the standing reference library.
 *
 * These are documents the user wants Cowork to be able to consult
 * indefinitely: a style guide, a contract template, a spec they keep
 * returning to. They follow the same storage convention as attachments —
 * metadata in the table, bytes on disk under a scoped root, paths stored
 * RELATIVE so a restored database still resolves — but they differ from
 * attachments in one decisive way, and the whole design follows from it:
 *
 *   **Knowledge sources never expire.**
 *
 * The 3-month asset sweep reaps attachments by `last_accessed_at`. A reference
 * library that vanishes because nobody opened it since spring is not a
 * reference library. So the exemption is structural rather than a flag the
 * sweep has to remember to check: this table has no `last_accessed_at` and no
 * `pinned` column, lives under its own `knowledge` fsScope root rather than
 * inside `attachments/`, and `cleanup.ts` never names it. There is no query
 * that could reap these rows even if someone wrote one carelessly, and a future
 * change to the attachments sweep cannot reach these files by accident.
 *
 * They go away when the user deletes them. That is the only way.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getDb } from '../../db/adapter.ts';
import {
  ensureDirInScope,
  fromRelative,
  resolveInScope,
  safeFilename,
  toRelative,
} from '../../security/fsScope.ts';
import { AppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';

const log = createLogger('cowork');

export interface KnowledgeRow {
  id: string;
  label: string | null;
  filename: string;
  rel_path: string;
  mime_type: string | null;
  bytes: number;
  sha256: string | null;
  created_at: number;
}

export interface KnowledgeSource {
  id: string;
  label: string | null;
  filename: string;
  relPath: string;
  mimeType: string | null;
  bytes: number;
  sha256: string | null;
  createdAt: number;
}

/**
 * What the UI and the Cowork agent both receive. `missing` reports the row
 * surviving a file that does not — same drift problem the gallery has, same
 * answer: say so rather than throwing or pretending.
 */
export interface KnowledgePublic extends KnowledgeSource {
  missing: boolean;
  url: string;
}

function mapRow(row: KnowledgeRow): KnowledgeSource {
  return {
    id: row.id,
    label: row.label,
    filename: row.filename,
    relPath: row.rel_path,
    mimeType: row.mime_type,
    bytes: row.bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

/** Absolute path, always re-resolved through fsScope so a tampered
 *  `rel_path` fails loudly instead of escaping the root. */
export function knowledgePath(source: KnowledgeSource): string {
  return fromRelative('knowledge', source.relPath);
}

export function knowledgeExists(source: KnowledgeSource): boolean {
  try {
    return fs.statSync(knowledgePath(source)).isFile();
  } catch {
    return false;
  }
}

export function toPublic(source: KnowledgeSource): KnowledgePublic {
  return {
    ...source,
    missing: !knowledgeExists(source),
    url: `/api/cowork/knowledge/${encodeURIComponent(source.id)}/file`,
  };
}

// --- queries ---------------------------------------------------------------

export function listKnowledgeSources(): KnowledgePublic[] {
  const rows = getDb()
    .prepare<KnowledgeRow>(
      `SELECT id, label, filename, rel_path, mime_type, bytes, sha256, created_at
         FROM knowledge_sources
        ORDER BY created_at DESC`,
    )
    .all();
  return rows.map((row) => toPublic(mapRow(row)));
}

export function findKnowledgeSource(id: string): KnowledgeSource | null {
  const row = getDb()
    .prepare<KnowledgeRow>(
      `SELECT id, label, filename, rel_path, mime_type, bytes, sha256, created_at
         FROM knowledge_sources WHERE id = ?`,
    )
    .get(id);
  return row ? mapRow(row) : null;
}

export function requireKnowledgeSource(id: string): KnowledgeSource {
  const source = findKnowledgeSource(id);
  if (!source) {
    throw new AppError('not_found', `Knowledge source "${id}" does not exist.`);
  }
  return source;
}

// --- writes ----------------------------------------------------------------

export interface SaveKnowledgeInput {
  filename: string;
  buffer: Buffer;
  /** Optional short name the user can recognise the document by. */
  label?: string | null;
  mimeType?: string | null;
}

function knowledgeId(): string {
  return `kns_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Store a reference document. Bytes land on disk first and the row is inserted
 * only once the write succeeded, so a failed write never leaves a phantom
 * entry pointing at nothing.
 *
 * Unlike `saveAsset`, nothing is downscaled or re-encoded here. An attachment
 * exists so a vision model can see it, and shrinking it loses nothing that
 * matters; a knowledge source is a document of record, and silently rewriting
 * the user's reference copy would be a different file than the one they filed.
 */
export function saveKnowledgeSource(input: SaveKnowledgeInput): KnowledgeSource {
  const now = Date.now();
  const id = knowledgeId();
  const filename = safeFilename(input.filename, 'document');

  const dir = resolveInScope('knowledge', String(new Date(now).getFullYear()));
  ensureDirInScope('knowledge', dir);
  const abs = path.join(dir, `${id}-${filename}`);

  fs.writeFileSync(abs, input.buffer, { mode: 0o600 });
  const relPath = toRelative('knowledge', abs);
  const bytes = input.buffer.byteLength;
  const sha256 = createHash('sha256').update(input.buffer).digest('hex');

  const label = input.label?.trim();

  getDb()
    .prepare(
      `INSERT INTO knowledge_sources
         (id, label, filename, rel_path, mime_type, bytes, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, label || null, filename, relPath, input.mimeType ?? null, bytes, sha256, now);

  log.info('knowledge source saved', { id, filename, bytes });
  return requireKnowledgeSource(id);
}

/**
 * Remove a source and its bytes. A missing file is not an error — the point of
 * the call is that the source is gone afterwards, and it is. Returns the bytes
 * freed.
 */
export function deleteKnowledgeSource(id: string): number {
  const source = requireKnowledgeSource(id);
  let freed = 0;

  try {
    const abs = knowledgePath(source);
    freed = fs.statSync(abs).size;
    fs.rmSync(abs, { force: true });
  } catch (error) {
    log.debug('knowledge file already gone', { id, error: String(error) });
  }

  getDb().prepare('DELETE FROM knowledge_sources WHERE id = ?').run(id);
  log.info('knowledge source deleted', { id, freed });
  return freed;
}
