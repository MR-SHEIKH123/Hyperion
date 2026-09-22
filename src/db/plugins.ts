/**
 * Per-tool plugin availability, stored (migration `025`).
 *
 * The table this reads holds **deviations only**: no row for (plugin, tool) means
 * the default, which is available. Everything that needs to reason about a
 * plugin is therefore split in two halves — this module stores what the user
 * decided, and `services/plugins/availability.ts` answers the question with the
 * default folded in. Keeping the fold out of here matters: a reader that treated
 * "no row" as "off" would be reading a different table than the writer writes.
 */
import { getDb } from './adapter.ts';

export interface PluginAvailabilityRow {
  pluginId: string;
  tool: string;
  available: boolean;
  updatedAt: number;
}

interface Row {
  plugin_id: string;
  tool: string;
  available: number;
  updated_at: number;
}

function mapRow(row: Row): PluginAvailabilityRow {
  return {
    pluginId: row.plugin_id,
    tool: row.tool,
    available: row.available === 1,
    updatedAt: row.updated_at,
  };
}

/** Every recorded override, for a hub read. Order is the primary key's. */
export function listPluginAvailability(): PluginAvailabilityRow[] {
  const rows = getDb()
    .prepare('SELECT plugin_id, tool, available, updated_at FROM plugin_availability ORDER BY plugin_id, tool')
    .all() as Row[];
  return rows.map(mapRow);
}

/** The overrides recorded for one plugin — at most one row per tool. */
export function findPluginAvailability(pluginId: string): PluginAvailabilityRow[] {
  const rows = getDb()
    .prepare('SELECT plugin_id, tool, available, updated_at FROM plugin_availability WHERE plugin_id = ? ORDER BY tool')
    .all(pluginId) as Row[];
  return rows.map(mapRow);
}

/**
 * Record an override, or clear one.
 *
 * `available: null` **deletes** the row rather than storing a third state, so
 * "back to the default" is the absence of a decision instead of a decision that
 * happens to agree with the default. The two are the same to every reader; they
 * are not the same to a user who later changes the default, and the API sentence
 * that offers the reset ("use the default") is only true for the deletion.
 */
export function setPluginAvailability(
  pluginId: string,
  tool: string,
  available: boolean | null,
): PluginAvailabilityRow | null {
  const db = getDb();
  if (available === null) {
    db.prepare('DELETE FROM plugin_availability WHERE plugin_id = ? AND tool = ?').run(pluginId, tool);
    return null;
  }
  const updatedAt = Date.now();
  db.prepare(
    `INSERT INTO plugin_availability (plugin_id, tool, available, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(plugin_id, tool) DO UPDATE SET available = excluded.available, updated_at = excluded.updated_at`,
  ).run(pluginId, tool, available ? 1 : 0, updatedAt);
  return { pluginId, tool, available, updatedAt };
}

/**
 * Drop overrides whose plugin no longer exists.
 *
 * Called by the hub's write path — never by a reader, because a GET that deletes
 * rows is a GET that can fail on a read-only database. The ids are supplied by
 * the caller that knows what exists rather than queried here, since "exists" is
 * a fact about three registries, not about this table.
 */
export function prunePluginAvailability(keep: readonly string[]): number {
  const db = getDb();
  if (keep.length === 0) {
    const before = countPluginAvailability();
    db.prepare('DELETE FROM plugin_availability').run();
    return before;
  }
  const placeholders = keep.map(() => '?').join(', ');
  const result = db
    .prepare(`DELETE FROM plugin_availability WHERE plugin_id NOT IN (${placeholders})`)
    .run(...keep);
  return result.changes;
}

/** How many overrides are stored at all — the denominator for orphan reporting. */
export function countPluginAvailability(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM plugin_availability').get() as { n: number };
  return row.n;
}
