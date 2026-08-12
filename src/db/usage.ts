/**
 * Usage logging and cost aggregation.
 *
 * A deliberate distinction runs through this module: **unpriced is not free.**
 * `cost_usd` is NULL unless a matching row exists in `model_prices`, and the
 * aggregates report priced and unpriced traffic separately. Defaulting unknown
 * prices to zero would make the dashboard confidently wrong, which is worse
 * than admitting it does not know.
 *
 * The same instinct governs `chat_id`: a temporary chat's id is written as NULL
 * rather than as itself, because `usage_log.chat_id` has a real foreign key to
 * `chats` and a temporary chat has no row there. See `recordUsage`.
 */

import { getDb } from './adapter.ts';
import { isTemporaryChat } from './temporaryChats.ts';
import { createLogger } from '../util/logger.ts';

import type { ToolName } from '../types/core.ts';

const log = createLogger('usage');

export interface RecordUsageInput {
  chatId?: string | null;
  messageId?: string | null;
  tool: ToolName;
  modelId: string;
  providerId?: string | null;
  providerName?: string | null;
  tokensIn: number;
  tokensOut: number;
  status?: 'ok' | 'error' | 'partial';
  durationMs?: number | null;
}

/** Price per 1M tokens, or null when this model/provider pair is unpriced. */
export function findPrice(
  modelId: string,
  providerId: string | null,
): { inputPer1m: number; outputPer1m: number } | null {
  const db = getDb();
  // Provider-specific price wins; a NULL provider_id row is the global default.
  const row = db
    .prepare<{ input_per_1m_usd: number; output_per_1m_usd: number }>(
      `SELECT input_per_1m_usd, output_per_1m_usd
         FROM model_prices
        WHERE model_id = ? AND (provider_id = ? OR provider_id IS NULL)
        ORDER BY provider_id IS NULL
        LIMIT 1`,
    )
    .get(modelId, providerId);
  if (!row) return null;
  return { inputPer1m: row.input_per_1m_usd, outputPer1m: row.output_per_1m_usd };
}

export function computeCost(
  modelId: string,
  providerId: string | null,
  tokensIn: number,
  tokensOut: number,
): number | null {
  const price = findPrice(modelId, providerId);
  if (!price) return null;
  return (tokensIn / 1_000_000) * price.inputPer1m + (tokensOut / 1_000_000) * price.outputPer1m;
}

/**
 * Appends a usage row. Never throws — a failure to log spend must not fail the
 * request that produced it.
 *
 * A temporary chat contributes an **anonymous** row: real tokens and real cost,
 * but `chat_id` and `message_id` NULL. Two independent reasons demand this, and
 * either alone would be enough.
 *
 * The first is correctness. `usage_log.chat_id` is
 * `REFERENCES chats (id) ON DELETE SET NULL` and FK enforcement is on, so an
 * insert naming a chat with no row raises SQLITE_CONSTRAINT — which the catch
 * below would swallow, discarding the spend entirely. That is precisely the cap
 * bypass this feature promised to close: toggling incognito would have made the
 * tokens free as far as `assertWithinSpendCap` could tell. Found by
 * `test/temporarychats.test.ts`.
 *
 * The second is privacy. A temporary chat's id must not reach disk at all, or a
 * row in `usage_log` would attest that a private session happened, and when —
 * which is metadata the user asked not to keep.
 */
export function recordUsage(input: RecordUsageInput): void {
  try {
    const cost = computeCost(input.modelId, input.providerId ?? null, input.tokensIn, input.tokensOut);
    const temporary = input.chatId != null && isTemporaryChat(input.chatId);
    if (temporary) {
      // The cost is the point of the row, so log that it was kept while the
      // linkage was dropped; otherwise an anonymous row looks like a bug later.
      log.debug('recording anonymous usage for a temporary chat', {
        tool: input.tool,
        modelId: input.modelId,
      });
    }
    getDb()
      .prepare(
        `INSERT INTO usage_log
           (chat_id, message_id, tool, model_id, provider_id, provider_name,
            tokens_in, tokens_out, cost_usd, status, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        temporary ? null : input.chatId ?? null,
        temporary ? null : input.messageId ?? null,
        input.tool,
        input.modelId,
        input.providerId ?? null,
        input.providerName ?? null,
        Math.max(0, Math.round(input.tokensIn)),
        Math.max(0, Math.round(input.tokensOut)),
        cost,
        input.status ?? 'ok',
        input.durationMs ?? null,
        Date.now(),
      );
  } catch {
    // Intentionally swallowed. See the doc comment above.
  }
}

// --- aggregation -----------------------------------------------------------

export interface UsageQuery {
  from?: number;
  to?: number;
  tool?: ToolName;
  providerId?: string;
}

export interface UsageBucket {
  key: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  /** Sum over priced rows only. */
  costUsd: number;
  /** Rows whose model/provider pair has no price entry. */
  unpricedRequests: number;
}

export interface UsageSummary {
  range: { from: number | null; to: number | null };
  totals: UsageBucket;
  byTool: UsageBucket[];
  byProvider: UsageBucket[];
  byModel: UsageBucket[];
  byDay: UsageBucket[];
  /** True when any row in range lacks a price, so the UI can caveat the total. */
  hasUnpriced: boolean;
}

interface AggRow {
  key: string | null;
  requests: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  unpriced: number;
}

function where(query: UsageQuery): { sql: string; values: (string | number)[] } {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  if (query.from !== undefined) {
    clauses.push('created_at >= ?');
    values.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push('created_at <= ?');
    values.push(query.to);
  }
  if (query.tool) {
    clauses.push('tool = ?');
    values.push(query.tool);
  }
  if (query.providerId) {
    clauses.push('provider_id = ?');
    values.push(query.providerId);
  }
  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

const AGG_COLUMNS = `
  COUNT(*)                                      AS requests,
  COALESCE(SUM(tokens_in), 0)                    AS tokens_in,
  COALESCE(SUM(tokens_out), 0)                   AS tokens_out,
  COALESCE(SUM(cost_usd), 0)                     AS cost_usd,
  SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
`;

function mapBucket(row: AggRow, fallbackKey = 'unknown'): UsageBucket {
  return {
    key: row.key ?? fallbackKey,
    requests: Number(row.requests ?? 0),
    tokensIn: Number(row.tokens_in ?? 0),
    tokensOut: Number(row.tokens_out ?? 0),
    costUsd: Number(row.cost_usd ?? 0),
    unpricedRequests: Number(row.unpriced ?? 0),
  };
}

function groupBy(query: UsageQuery, expression: string): UsageBucket[] {
  const { sql, values } = where(query);
  return getDb()
    .prepare<AggRow>(
      `SELECT ${expression} AS key, ${AGG_COLUMNS} FROM usage_log ${sql} GROUP BY key ORDER BY cost_usd DESC, requests DESC`,
    )
    .all(...values)
    .map((row) => mapBucket(row));
}

export function summarizeUsage(query: UsageQuery = {}): UsageSummary {
  const { sql, values } = where(query);
  const totalRow = getDb()
    .prepare<AggRow>(`SELECT 'total' AS key, ${AGG_COLUMNS} FROM usage_log ${sql}`)
    .get(...values);
  const totals = totalRow ? mapBucket(totalRow, 'total') : mapBucket({
    key: 'total',
    requests: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    unpriced: 0,
  });

  return {
    range: { from: query.from ?? null, to: query.to ?? null },
    totals,
    byTool: groupBy(query, 'tool'),
    byProvider: groupBy(query, `COALESCE(provider_name, provider_id, 'unknown')`),
    byModel: groupBy(query, 'model_id'),
    // Local date, computed by SQLite from epoch ms; good enough for a dashboard
    // on a single-user machine.
    byDay: groupBy(query, `date(created_at / 1000, 'unixepoch', 'localtime')`),
    hasUnpriced: totals.unpricedRequests > 0,
  };
}

export interface PriceInput {
  modelId: string;
  providerId?: string | null;
  inputPer1mUsd: number;
  outputPer1mUsd: number;
}

/** Upserts a price. The user supplies these; nothing is bundled or guessed. */
export function setPrice(input: PriceInput): void {
  getDb()
    .prepare(
      `INSERT INTO model_prices (model_id, provider_id, input_per_1m_usd, output_per_1m_usd, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(model_id, provider_id) DO UPDATE SET
         input_per_1m_usd = excluded.input_per_1m_usd,
         output_per_1m_usd = excluded.output_per_1m_usd,
         updated_at = excluded.updated_at`,
    )
    .run(input.modelId, input.providerId ?? null, input.inputPer1mUsd, input.outputPer1mUsd, Date.now());
}

export function listPrices(): PriceInput[] {
  return getDb()
    .prepare<{ model_id: string; provider_id: string | null; input_per_1m_usd: number; output_per_1m_usd: number }>(
      `SELECT model_id, provider_id, input_per_1m_usd, output_per_1m_usd FROM model_prices ORDER BY model_id`,
    )
    .all()
    .map((row) => ({
      modelId: row.model_id,
      providerId: row.provider_id,
      inputPer1mUsd: row.input_per_1m_usd,
      outputPer1mUsd: row.output_per_1m_usd,
    }));
}

export function deletePrice(modelId: string, providerId: string | null): boolean {
  const result = getDb()
    .prepare(
      `DELETE FROM model_prices WHERE model_id = ? AND ((provider_id IS NULL AND ? IS NULL) OR provider_id = ?)`,
    )
    .run(modelId, providerId, providerId);
  return Number(result.changes ?? 0) > 0;
}
