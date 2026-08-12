/**
 * Asset registry + gallery listing.
 *
 * The `attachments` table holds metadata only; the bytes live on disk under
 * ~/Hyperion/attachments/. Two consequences drive the design here:
 *
 *   1. Every path stored is RELATIVE to the attachments root. Absolute paths
 *      would break the moment the DB is restored on another machine (or under
 *      a different user account), and they'd let a corrupt row point anywhere
 *      on the filesystem. Resolution back to an absolute path always goes
 *      through fsScope, so a malformed rel_path fails loudly instead of
 *      escaping the root.
 *
 *   2. The disk and the table can drift (a manual delete, an interrupted
 *      write). Listing therefore reports `missing: true` for rows whose file
 *      is gone rather than pretending the asset is fine or throwing — the
 *      gallery can grey those out, and cleanup can reap them.
 *
 * `last_accessed_at` is what the 3-month cleanup timer reads, so anything that
 * counts as the user "touching" an asset (viewing it, downloading it, an agent
 * reading it) should call `touchAsset()`. Listing the gallery deliberately
 * does NOT touch anything: scrolling past a thumbnail is not use, and if it
 * were, nothing would ever expire.
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
import { processImage } from './images.ts';

const log = createLogger('storage');

export type AssetOrigin = 'uploaded' | 'generated';

export interface AssetRow {
  id: string;
  chat_id: string | null;
  message_id: string | null;
  filename: string;
  rel_path: string;
  mime_type: string | null;
  bytes: number;
  sha256: string | null;
  origin: string;
  tool: string | null;
  pinned: number;
  is_brand_approved: number;
  brand_approved_at: number | null;
  created_at: number;
  last_accessed_at: number;
}

export interface AssetRecord {
  id: string;
  chatId: string | null;
  messageId: string | null;
  filename: string;
  relPath: string;
  mimeType: string | null;
  bytes: number;
  sha256: string | null;
  origin: AssetOrigin;
  tool: string | null;
  pinned: boolean;
  /**
   * Distinct from `pinned` (see migration 011): a pin means "do not auto-delete
   * this", approval means "this IS the brand" — the asset an agent should reach
   * for when it needs the real logo rather than a lookalike. Approval implies
   * the cleanup exemption, but the reverse is not true.
   */
  brandApproved: boolean;
  /** When approval was granted; null whenever `brandApproved` is false. */
  brandApprovedAt: number | null;
  createdAt: number;
  lastAccessedAt: number;
}

/** What the gallery UI receives. Never includes an absolute path. */
export interface AssetPublic extends AssetRecord {
  /** True when the row survives but the file on disk does not. */
  missing: boolean;
  /** Convenience for the frontend: where to GET the bytes. */
  url: string;
}

function mapRow(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    messageId: row.message_id,
    filename: row.filename,
    relPath: row.rel_path,
    mimeType: row.mime_type,
    bytes: row.bytes,
    sha256: row.sha256,
    origin: row.origin === 'generated' ? 'generated' : 'uploaded',
    tool: row.tool,
    pinned: row.pinned === 1,
    brandApproved: row.is_brand_approved === 1,
    brandApprovedAt: row.brand_approved_at,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
  };
}

/**
 * Absolute path for an asset. Goes through fsScope so a rel_path that has been
 * tampered with (or hand-edited into the DB) cannot resolve outside the root.
 */
export function assetPath(asset: AssetRecord): string {
  return fromRelative('attachments', asset.relPath);
}

export function assetExists(asset: AssetRecord): boolean {
  try {
    return fs.statSync(assetPath(asset)).isFile();
  } catch {
    return false;
  }
}

export function toPublic(asset: AssetRecord): AssetPublic {
  return {
    ...asset,
    missing: !assetExists(asset),
    url: `/api/storage/assets/${encodeURIComponent(asset.id)}/file`,
  };
}

// --- queries ---------------------------------------------------------------

export interface AssetQuery {
  chatId?: string;
  tool?: string;
  origin?: AssetOrigin;
  /** Only pinned (true) or only unpinned (false); omit for both. */
  pinned?: boolean;
  /** Only brand-approved (true) or only unapproved (false); omit for both. */
  brandApproved?: boolean;
  /** Substring match on the original filename. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface AssetListing {
  assets: AssetPublic[];
  total: number;
  totalBytes: number;
  limit: number;
  offset: number;
}

function buildWhere(query: AssetQuery): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (query.chatId) {
    clauses.push('chat_id = ?');
    params.push(query.chatId);
  }
  if (query.tool) {
    clauses.push('tool = ?');
    params.push(query.tool);
  }
  if (query.origin) {
    clauses.push('origin = ?');
    params.push(query.origin);
  }
  if (typeof query.pinned === 'boolean') {
    clauses.push('pinned = ?');
    params.push(query.pinned ? 1 : 0);
  }
  if (typeof query.brandApproved === 'boolean') {
    clauses.push('is_brand_approved = ?');
    params.push(query.brandApproved ? 1 : 0);
  }
  if (query.search) {
    clauses.push('filename LIKE ?');
    params.push(`%${query.search}%`);
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

export function listAssets(query: AssetQuery = {}): AssetListing {
  const db = getDb();
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 1_000);
  const offset = Math.max(query.offset ?? 0, 0);
  const where = buildWhere(query);

  const totals = db
    .prepare<{ n: number; bytes: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM attachments ${where.sql}`,
    )
    .get(...(where.params as never[]));

  const rows = db
    .prepare<AssetRow>(
      `SELECT * FROM attachments ${where.sql}
        ORDER BY pinned DESC, created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...([...where.params, limit, offset] as never[]));

  return {
    assets: rows.map((row) => toPublic(mapRow(row))),
    total: totals?.n ?? 0,
    totalBytes: totals?.bytes ?? 0,
    limit,
    offset,
  };
}

export function findAsset(id: string): AssetRecord | null {
  const row = getDb().prepare<AssetRow>('SELECT * FROM attachments WHERE id = ?').get(id);
  return row ? mapRow(row) : null;
}

export function requireAsset(id: string): AssetRecord {
  const asset = findAsset(id);
  if (!asset) throw new AppError('not_found', `No asset with id "${id}".`);
  return asset;
}

// --- mutations -------------------------------------------------------------

export interface SaveAssetInput {
  filename: string;
  /** Provide exactly one of these. */
  buffer?: Buffer;
  /** A file already written somewhere inside the attachments scope. */
  relPath?: string;
  chatId?: string | null;
  messageId?: string | null;
  mimeType?: string | null;
  origin?: AssetOrigin;
  tool?: string | null;
  pinned?: boolean;
}

function assetId(): string {
  return `ast_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Lay assets out as attachments/<yyyy-mm>/<id>-<safe name> so a long-lived
 * install doesn't end up with one directory holding tens of thousands of
 * entries (which some filesystems and every file picker handle badly), and so
 * two uploads of "screenshot.png" can't collide.
 */
function monthBucket(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Register an asset. When `buffer` is given the bytes are written inside the
 * scoped root first; the row is only inserted once the write succeeded, so a
 * failed write never leaves a phantom gallery entry.
 *
 * Images are downscaled before they are written — see `images.ts`. That resize
 * is the only asynchronous step, and it lives here rather than at each call
 * site so there is no way to store an oversized image by forgetting to call it.
 * `bytes` and `sha256` therefore describe **what was stored**, not what
 * arrived, so the gallery's numbers always match the files on disk.
 */
export async function saveAsset(input: SaveAssetInput): Promise<AssetRecord> {
  const now = Date.now();
  const id = assetId();
  const filename = safeFilename(input.filename, 'file');

  let relPath: string;
  let bytes = 0;
  let sha256: string | null = null;

  if (input.buffer) {
    const dir = resolveInScope('attachments', monthBucket(now));
    ensureDirInScope('attachments', dir);
    const abs = path.join(dir, `${id}-${filename}`);

    // Generated assets go through this too: an image a tool produced oversized
    // is no more useful on disk than one a user uploaded oversized.
    const image = await processImage(input.buffer, input.mimeType);
    if (image.processed) {
      log.info('downscaled image before storing', {
        id,
        from: input.buffer.byteLength,
        to: image.buffer.byteLength,
        sourceWidth: image.width,
        sourceHeight: image.height,
      });
    }

    fs.writeFileSync(abs, image.buffer, { mode: 0o600 });
    relPath = toRelative('attachments', abs);
    bytes = image.buffer.byteLength;
    sha256 = createHash('sha256').update(image.buffer).digest('hex');
  } else if (input.relPath) {
    // Re-resolve through the scope: a caller-supplied relative path is still
    // untrusted input.
    const abs = fromRelative('attachments', input.relPath);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) {
      throw new AppError('bad_request', `"${input.relPath}" is not a file.`);
    }
    relPath = toRelative('attachments', abs);
    bytes = stat.size;
    sha256 = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } else {
    throw new AppError('bad_request', 'saveAsset requires either buffer or relPath.');
  }

  getDb()
    .prepare(
      `INSERT INTO attachments
         (id, chat_id, message_id, filename, rel_path, mime_type, bytes, sha256,
          origin, tool, pinned, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.chatId ?? null,
      input.messageId ?? null,
      filename,
      relPath,
      input.mimeType ?? null,
      bytes,
      sha256,
      input.origin ?? 'uploaded',
      input.tool ?? null,
      input.pinned ?? false,
      now,
      now,
    );

  log.debug('asset saved', { id, filename, bytes });
  return requireAsset(id);
}

/**
 * Bump `last_accessed_at`. This is the only thing standing between an asset
 * and the 3-month reaper, so call it wherever the user or an agent actually
 * reads the file.
 */
export function touchAsset(id: string, at = Date.now()): void {
  getDb().prepare('UPDATE attachments SET last_accessed_at = ? WHERE id = ?').run(at, id);
}

/** Toggle or set the pin. Pinned assets are exempt from cleanup entirely. */
export function setAssetPinned(id: string, pinned?: boolean): AssetRecord {
  const asset = requireAsset(id);
  const next = pinned ?? !asset.pinned;
  getDb().prepare('UPDATE attachments SET pinned = ? WHERE id = ?').run(next, id);
  return requireAsset(id);
}

/**
 * Toggle or set brand approval. Approved assets are exempt from cleanup for the
 * same reason pinned ones are — the exemption lives in `cleanup.ts`'s WHERE
 * clauses, so read that file too before assuming this flag only affects sorting.
 *
 * The timestamp is cleared on unapproval rather than kept as history: a stale
 * `brand_approved_at` on a revoked asset would make the approved listing's
 * ordering depend on decisions the user has since taken back.
 */
export function setAssetBrandApproved(id: string, approved?: boolean): AssetRecord {
  const asset = requireAsset(id);
  const next = approved ?? !asset.brandApproved;
  getDb()
    .prepare('UPDATE attachments SET is_brand_approved = ?, brand_approved_at = ? WHERE id = ?')
    .run(next, next ? Date.now() : null, id);
  return requireAsset(id);
}

/**
 * The brand's approved assets, most recently approved first — what an agent
 * asks for when it needs the real logo instead of generating a lookalike.
 * Ordered by approval time rather than creation time because the newest
 * decision is the current one.
 */
export function listApprovedAssets(limit = 100): AssetPublic[] {
  const rows = getDb()
    .prepare<AssetRow>(
      `SELECT * FROM attachments
        WHERE is_brand_approved = 1
        ORDER BY brand_approved_at DESC
        LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 500));
  return rows.map((row) => toPublic(mapRow(row)));
}

/**
 * Delete an asset row and its bytes. A missing file is not an error — the
 * point of the call is that the asset should be gone afterwards, and it is.
 */
export function deleteAsset(id: string, options: { keepFile?: boolean } = {}): number {
  const asset = requireAsset(id);
  let freed = 0;

  if (!options.keepFile) {
    try {
      const abs = assetPath(asset);
      const stat = fs.statSync(abs);
      freed = stat.size;
      fs.rmSync(abs, { force: true });
    } catch (error) {
      log.debug('asset file already gone', { id, error: String(error) });
    }
  }

  getDb().prepare('DELETE FROM attachments WHERE id = ?').run(id);
  return freed;
}

// --- aggregate for the storage panel ---------------------------------------

export interface StorageStats {
  assets: { count: number; bytes: number; pinned: number; missing: number };
  chats: { count: number; pinned: number };
  byTool: { key: string; count: number; bytes: number }[];
  byOrigin: { key: string; count: number; bytes: number }[];
}

export function storageStats(): StorageStats {
  const db = getDb();

  const assets = db
    .prepare<{ n: number; bytes: number; pinned: number }>(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(bytes), 0) AS bytes,
              COALESCE(SUM(pinned), 0) AS pinned
         FROM attachments`,
    )
    .get();

  const chats = db
    .prepare<{ n: number; pinned: number }>(
      'SELECT COUNT(*) AS n, COALESCE(SUM(pinned), 0) AS pinned FROM chats',
    )
    .get();

  const byTool = db
    .prepare<{ key: string | null; n: number; bytes: number }>(
      `SELECT tool AS key, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes
         FROM attachments GROUP BY tool ORDER BY bytes DESC`,
    )
    .all();

  const byOrigin = db
    .prepare<{ key: string | null; n: number; bytes: number }>(
      `SELECT origin AS key, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes
         FROM attachments GROUP BY origin ORDER BY bytes DESC`,
    )
    .all();

  // Counting missing files means one stat() per row; the gallery is small
  // enough (thousands, not millions) that this stays cheap, and knowing the
  // DB and disk disagree is worth more than shaving the syscalls.
  let missing = 0;
  const rows = db.prepare<{ rel_path: string }>('SELECT rel_path FROM attachments').all();
  for (const row of rows) {
    try {
      fs.statSync(fromRelative('attachments', row.rel_path));
    } catch {
      missing += 1;
    }
  }

  return {
    assets: {
      count: assets?.n ?? 0,
      bytes: assets?.bytes ?? 0,
      pinned: assets?.pinned ?? 0,
      missing,
    },
    chats: { count: chats?.n ?? 0, pinned: chats?.pinned ?? 0 },
    byTool: byTool.map((r) => ({ key: r.key ?? 'unassigned', count: r.n, bytes: r.bytes })),
    byOrigin: byOrigin.map((r) => ({ key: r.key ?? 'unknown', count: r.n, bytes: r.bytes })),
  };
}
