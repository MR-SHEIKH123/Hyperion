/**
 * The Pulse fetch audit trail (1.30).
 *
 * The stored shapes live here rather than in the service so the dependency
 * runs the usual way (service imports db, never the reverse): the fetch
 * record is what `GET /api/cowork/pulse/fetches` returns, verbatim.
 */
import { getDb } from './adapter.ts';

export interface PulseItem {
  source: string;
  title: string;
  url: string | null;
  snippet: string | null;
  publishedAt: string | null;
  score: number | null;
}

export interface PulseSourceOutcome {
  source: string;
  ok: boolean;
  count: number;
  error: string | null;
  ms: number;
}

export interface PulseFetchRow {
  id: number;
  createdAt: number;
  query: string;
  tier: string;
  sources: PulseSourceOutcome[];
  items: PulseItem[];
}

interface PulseFetchDbRow {
  id: number;
  created_at: number;
  query: string;
  tier: string;
  sources_json: string;
  items_json: string;
}

export function recordPulseFetch(input: {
  query: string;
  tier: string;
  sources: PulseSourceOutcome[];
  items: PulseItem[];
}): number {
  const result = getDb()
    .prepare(
      `INSERT INTO pulse_fetches (created_at, query, tier, sources_json, items_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(Date.now(), input.query, input.tier, JSON.stringify(input.sources), JSON.stringify(input.items));
  return Number(result.lastInsertRowid);
}

function toPublic(row: PulseFetchDbRow): PulseFetchRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    query: row.query,
    tier: row.tier,
    sources: JSON.parse(row.sources_json) as PulseSourceOutcome[],
    items: JSON.parse(row.items_json) as PulseItem[],
  };
}

/** Newest first. The limit is clamped; the table is append-only and small per row. */
export function listPulseFetches(limit: number): PulseFetchRow[] {
  const clamped = Math.min(Math.max(1, Math.floor(limit)), 500);
  return getDb()
    .prepare<PulseFetchDbRow>(`SELECT * FROM pulse_fetches ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(clamped)
    .map(toPublic);
}
