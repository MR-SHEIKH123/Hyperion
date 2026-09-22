/**
 * Knowledge sources a run used, read and written (Prompt 1.39 A6).
 *
 * The write happens where the sources are read, before the agent loop starts,
 * and it is deliberately **best-effort**: a provenance row is a record of the
 * past, and failing to write one must not fail the run that produced it. Nothing
 * about the answer depends on this table.
 *
 * The write **replaces** the run's set rather than adding to it: provenance is
 * "the sources in force for this attempt", not an accumulating log. Two things
 * make that the right contract and not merely a convenience:
 *
 *   * A retried run id is the same run being restarted (`startTaskRun`
 *     documents it), so a second read must not leave the first attempt's sources
 *     looking like evidence for the second. The foreign key's `ON DELETE CASCADE`
 *     already covers the production path — `INSERT OR REPLACE` on `task_runs`
 *     deletes and re-inserts, which clears this table with it, exactly as it
 *     clears `task_steps`. The delete here is what makes the module correct for
 *     *any* caller rather than only for the one that re-starts the run first.
 *   * A task-level record would be the wrong shape anyway: a task can be restarted
 *     while its id stays, so hanging provenance off the run is what keeps two
 *     attempts from being read as one.
 */
import { getDb } from './adapter.ts';

export interface RunKnowledgeRow {
  runId: string;
  sourceId: string;
  label: string | null;
  filename: string;
  bytes: number | null;
  sha256: string | null;
  usedAt: number;
}

export interface RunKnowledgeEntry {
  sourceId: string;
  label: string | null;
  filename: string;
  bytes: number | null;
  sha256: string | null;
}

/** One row per source, for one run. An empty list writes nothing. */
export function recordRunKnowledge(runId: string, entries: readonly RunKnowledgeEntry[]): number {
  if (entries.length === 0) return 0;
  const now = Date.now();
  const statement = getDb().prepare(
    `INSERT OR REPLACE INTO run_knowledge_sources
       (run_id, source_id, label, filename, bytes, sha256, used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const write = getDb().transaction(() => {
    getDb().prepare('DELETE FROM run_knowledge_sources WHERE run_id = ?').run(runId);
    for (const entry of entries) {
      statement.run(runId, entry.sourceId, entry.label, entry.filename, entry.bytes, entry.sha256, now);
    }
  });
  write();
  return entries.length;
}

/** Everything one run used, newest read first is meaningless here — by source id. */
export function listRunKnowledge(runId: string): RunKnowledgeRow[] {
  return getDb()
    .prepare<{
      source_id: string;
      label: string | null;
      filename: string;
      bytes: number | null;
      sha256: string | null;
      used_at: number;
    }>(
      `SELECT source_id, label, filename, bytes, sha256, used_at
         FROM run_knowledge_sources WHERE run_id = ? ORDER BY source_id ASC`,
    )
    .all(runId)
    .map((row) => ({
      runId,
      sourceId: row.source_id,
      label: row.label,
      filename: row.filename,
      bytes: row.bytes,
      sha256: row.sha256,
      usedAt: row.used_at,
    }));
}
