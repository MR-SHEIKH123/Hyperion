/**
 * Reading the version stack (Prompt 1.39 A6).
 *
 * The writers live where the work happens — `services/code/files.ts` snapshots a
 * file before each write, `services/design/tools.ts` saves design versions — and
 * they insert rows directly, because each needs the version number it just created
 * inside the same transaction. This module is the read side, and it exists so the
 * route does not carry SQL: it is also the place the *shape* of a version is
 * decided for callers, which is what lets `parentVersion` be derived once rather
 * than in each consumer.
 */
import { getDb } from './adapter.ts';

export interface ArtifactVersion {
  id: string;
  artifactKey: string;
  tool: string;
  version: number;
  label: string | null;
  /** Small artifacts are stored inline; large ones are files. Exactly one is set. */
  inline: boolean;
  bytes: number | null;
  sha256: string | null;
  createdAt: number;
  /**
   * The version this one replaced, or null for the first.
   *
   * Derived rather than stored — see the route's comment for why. The lookup is a
   * set membership check over the rows already fetched, so no extra query is made
   * for it.
   */
  parentVersion: number | null;
}

interface VersionRow {
  id: string;
  version: number;
  label: string | null;
  content: string | null;
  rel_path: string | null;
  bytes: number | null;
  sha256: string | null;
  created_at: number;
  tool: string;
}

/**
 * Newest first, because a timeline is read from the present backwards — and the
 * limit therefore drops the *oldest* versions, not the newest.
 *
 * An unknown key returns an empty list rather than a 404: "nothing has been
 * versioned under this key" is a true and useful answer (it is what a file that
 * has never been edited looks like), and the caller already knows the key it
 * asked for.
 */
export function listArtifactVersions(artifactKey: string, options: { limit?: number } = {}): ArtifactVersion[] {
  const limit = options.limit !== undefined && options.limit > 0 ? options.limit : 200;
  const rows = getDb()
    .prepare<VersionRow>(
      `SELECT id, tool, version, label, content, rel_path, bytes, sha256, created_at
         FROM artifact_versions
        WHERE artifact_key = ?
        ORDER BY version DESC
        LIMIT ?`,
    )
    .all(artifactKey, limit);

  const present = new Set(rows.map((row) => row.version));
  return rows.map((row) => ({
    id: row.id,
    artifactKey,
    tool: row.tool,
    version: row.version,
    label: row.label,
    // The table's CHECK guarantees one of the two is set; this reports which,
    // because a caller that wants the content should not have to know that.
    inline: row.content !== null,
    bytes: row.bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
    parentVersion: row.version > 1 && present.has(row.version - 1) ? row.version - 1 : null,
  }));
}
