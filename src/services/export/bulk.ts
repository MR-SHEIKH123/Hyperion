/**
 * Bulk export — Part 1.20.
 *
 * A zip of many items, built by calling the *same* per-item functions
 * `/api/chats/:id/export` and `/api/artifacts/:id/export` use. That reuse is the
 * point: two implementations of "export a chat" would drift, and the one nobody
 * looks at is the one that quietly starts producing a broken file.
 *
 * This is not a backup. `services/backup/` exists for disaster recovery and
 * round-trips the database, the keys and the runtime tree; this produces
 * readable documents for a person to keep or send somewhere. Neither can
 * substitute for the other, so neither is built on the other.
 *
 * Nothing here writes to the database, and a temporary chat cannot appear in the
 * output because it was never stored in the first place — see
 * `docs/CONTRACTS.md`.
 */

import AdmZip from 'adm-zip';

import { getDb } from '../../db/adapter.ts';
import { AppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';
import { exportArtifact, exportChat } from './index.ts';

const log = createLogger('export.bulk');

/** What to put in the archive. `all` means chats *and* artifacts. */
export type BulkContentType = 'chats' | 'artifacts' | 'all';

export interface BulkTimeframe {
  /** Inclusive epoch ms. */
  from?: number;
  /** Inclusive epoch ms. */
  to?: number;
}

export interface BulkExportRequest {
  timeframe?: BulkTimeframe;
  contentType?: BulkContentType;
}

export interface BulkExportResult {
  filename: string;
  contentType: string;
  body: Buffer;
  /** Per-kind counts, so the caller can say what it actually got. */
  counts: { chats: number; artifacts: number };
  /**
   * Items that were selected but could not be read.
   *
   * Reported rather than thrown. One artifact whose backing file has been
   * deleted should not cost the user the other forty, but it must not vanish
   * silently either — a zip that is quietly short is worse than one that says
   * what is missing. The same list is written into `MANIFEST.json`.
   */
  skipped: Array<{ kind: 'chat' | 'artifact'; id: string; reason: string }>;
}

interface ChatIdRow {
  id: string;
  title: string;
  updated_at: number;
}

interface ArtifactIdRow {
  id: string;
  artifact_key: string;
  version: number;
  created_at: number;
}

/**
 * Both queries filter on the timestamp that answers "when was this mine" —
 * `updated_at` for a chat, because a conversation the user returned to
 * yesterday belongs in yesterday's export, and `created_at` for an artifact
 * version, because a version is immutable once written.
 */
function selectChats(timeframe: BulkTimeframe): ChatIdRow[] {
  const clauses: string[] = [];
  const values: number[] = [];
  if (timeframe.from !== undefined) {
    clauses.push('updated_at >= ?');
    values.push(timeframe.from);
  }
  if (timeframe.to !== undefined) {
    clauses.push('updated_at <= ?');
    values.push(timeframe.to);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return getDb()
    .prepare<ChatIdRow>(`SELECT id, title, updated_at FROM chats ${where} ORDER BY updated_at DESC`)
    .all(...values);
}

function selectArtifacts(timeframe: BulkTimeframe): ArtifactIdRow[] {
  const clauses: string[] = [];
  const values: number[] = [];
  if (timeframe.from !== undefined) {
    clauses.push('created_at >= ?');
    values.push(timeframe.from);
  }
  if (timeframe.to !== undefined) {
    clauses.push('created_at <= ?');
    values.push(timeframe.to);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return getDb()
    .prepare<ArtifactIdRow>(
      `SELECT id, artifact_key, version, created_at FROM artifact_versions ${where}
        ORDER BY created_at DESC`,
    )
    .all(...values);
}

/**
 * Two items can legitimately produce the same filename — two chats called
 * "Notes", or one artifact key exported at two versions whose stems collide
 * after sanitising. AdmZip would happily store both under one name and the
 * second would win on extraction, so a suffix is appended instead.
 */
function uniqueName(used: Set<string>, name: string): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function stamp(now: number): string {
  // Local date, not UTC: the user asked for "today's" export in their own day.
  const date = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * Build the archive.
 *
 * An empty selection is a **200 with an empty archive plus a manifest**, not a
 * 404: "nothing matched that timeframe" is an answer, and the manifest says so
 * in a form the user can read. Returning an error would make the caller guess
 * whether the request was malformed or the range was simply quiet.
 */
export function exportBulk(request: BulkExportRequest = {}, now = Date.now()): BulkExportResult {
  const timeframe = request.timeframe ?? {};
  if (
    timeframe.from !== undefined &&
    timeframe.to !== undefined &&
    timeframe.from > timeframe.to
  ) {
    throw new AppError('bad_request', 'timeframe.from must not be later than timeframe.to.', {
      details: { field: 'timeframe' },
    });
  }

  const contentType: BulkContentType = request.contentType ?? 'all';
  const wantChats = contentType === 'chats' || contentType === 'all';
  const wantArtifacts = contentType === 'artifacts' || contentType === 'all';

  const zip = new AdmZip();
  const used = new Set<string>();
  const skipped: BulkExportResult['skipped'] = [];
  const manifestChats: Array<{ id: string; title: string; file: string }> = [];
  const manifestArtifacts: Array<{ id: string; artifactKey: string; version: number; file: string }> = [];

  if (wantChats) {
    for (const row of selectChats(timeframe)) {
      try {
        // Markdown rather than JSON: the archive is for reading. The JSON form
        // stays available per item for anything that needs to parse it back.
        const exported = exportChat(row.id, 'markdown');
        const name = uniqueName(used, `chats/${exported.filename}`);
        zip.addFile(name, Buffer.from(exported.content, 'utf8'));
        manifestChats.push({ id: row.id, title: row.title, file: name });
      } catch (error) {
        skipped.push({
          kind: 'chat',
          id: row.id,
          reason: error instanceof AppError ? error.message : String(error),
        });
      }
    }
  }

  if (wantArtifacts) {
    for (const row of selectArtifacts(timeframe)) {
      try {
        const exported = exportArtifact(row.id);
        const name = uniqueName(used, `artifacts/${exported.filename}`);
        zip.addFile(name, Buffer.from(exported.content, 'utf8'));
        manifestArtifacts.push({
          id: row.id,
          artifactKey: row.artifact_key,
          version: row.version,
          file: name,
        });
      } catch (error) {
        skipped.push({
          kind: 'artifact',
          id: row.id,
          reason: error instanceof AppError ? error.message : String(error),
        });
      }
    }
  }

  const manifest = {
    generatedAt: now,
    contentType,
    timeframe: {
      from: timeframe.from ?? null,
      to: timeframe.to ?? null,
    },
    counts: { chats: manifestChats.length, artifacts: manifestArtifacts.length },
    chats: manifestChats,
    artifacts: manifestArtifacts,
    // Present even when empty, so its absence never has to be interpreted.
    skipped,
  };
  zip.addFile('MANIFEST.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));

  log.info('bulk export built', {
    contentType,
    chats: manifestChats.length,
    artifacts: manifestArtifacts.length,
    skipped: skipped.length,
  });

  return {
    filename: `hyperion-export-${stamp(now)}.zip`,
    contentType: 'application/zip',
    body: zip.toBuffer(),
    counts: { chats: manifestChats.length, artifacts: manifestArtifacts.length },
    skipped,
  };
}
