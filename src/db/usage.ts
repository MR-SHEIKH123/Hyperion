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
import { classifyProviderType } from '../services/safety/outbound.ts';
import { zdrPreferenceUnmet } from '../services/safety/zdr.ts';
import { isZdrRequirement } from '../types/core.ts';
import { createLogger } from '../util/logger.ts';

import type { ProviderType, ToolName, ZdrRequirement, ZdrStatus } from '../types/core.ts';
import type { EgressClass } from '../services/safety/outbound.ts';

const log = createLogger('usage');

export interface RecordUsageInput {
  chatId?: string | null;
  messageId?: string | null;
  tool: ToolName;
  modelId: string;
  providerId?: string | null;
  providerName?: string | null;
  /**
   * The provider's type at the time of the request (Part 1.23).
   *
   * Optional, and stored as NULL when absent. A caller that cannot say is not
   * refused: `recordUsage` swallows its own errors, so a stricter contract here
   * would trade a missing classification for a missing spend row.
   */
  providerType?: ProviderType | null;
  /**
   * What ZDR status actually applied, and what the policy demanded (Part 1.26).
   *
   * Two fields rather than one derived verdict: "was that acceptable?" can only
   * be answered later if the log holds both the fact and the rule it was judged
   * against. `zdrPreferenceUnmet` is computed from the pair on read.
   *
   * Optional and stored as NULL when absent, for the same reason as
   * `providerType` — a caller that cannot say must not lose its spend row.
   */
  zdrStatus?: ZdrStatus | null;
  zdrRequirement?: ZdrRequirement | null;
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
           (chat_id, message_id, tool, model_id, provider_id, provider_name, provider_type,
            zdr_status, zdr_requirement, tokens_in, tokens_out, cost_usd, status, duration_ms,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        temporary ? null : input.chatId ?? null,
        temporary ? null : input.messageId ?? null,
        input.tool,
        input.modelId,
        input.providerId ?? null,
        input.providerName ?? null,
        // Stamped at write time rather than joined on read: a provider row can be
        // retyped or deleted afterwards, and history must not change retroactively.
        input.providerType ?? null,
        // Same rule, and it matters more here: a provider's recorded ZDR support
        // can be edited or attested at any time, and a row that re-derived its
        // status on read would silently restate history as the current settings.
        input.zdrStatus ?? null,
        input.zdrRequirement ?? null,
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
  /**
   * Narrow to one recorded ZDR status (Part 1.26).
   *
   * Answers "show me only what went out under standard retention", which is the
   * question a user asks once they have turned the policy on. `'unrecorded'`
   * selects the pre-1.26 rows, whose column is NULL: they are reachable rather
   * than invisible, because an audit that silently omitted them would report a
   * cleaner history than actually exists.
   *
   * Typed as `ZdrBucketKey` so a bucket the summary reports can always be fetched
   * by its own key — including a raw status from a newer build. A filter that
   * accepted only the statuses this build knows would leave those rows visible in
   * the summary but impossible to select, which is worse than either.
   */
  zdrStatus?: ZdrBucketKey;
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
  if (query.zdrStatus === 'unrecorded') {
    // `= NULL` is never true in SQL, so the pre-1.26 rows need the IS form. This
    // is the whole reason the filter is not just a string compare.
    clauses.push('zdr_status IS NULL');
  } else if (query.zdrStatus) {
    clauses.push('zdr_status = ?');
    values.push(query.zdrStatus);
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

// --- outbound exposure (Part 1.23) -----------------------------------------

export interface ExposureBucket extends UsageBucket {
  /** `local`, `remote` or `unknown` — see `services/safety/outbound.ts`. */
  key: EgressClass;
  /** The raw provider types folded into this bucket, for the tooltip. */
  providerTypes: string[];
}

export interface ExposureSummary {
  range: { from: number | null; to: number | null };
  /** Every row in range, regardless of where it went. */
  totals: UsageBucket;
  /** One entry per egress class present, ordered local, remote, unknown. */
  byClass: ExposureBucket[];
  /**
   * True when at least one row could not be classified. Surfaced separately so
   * the UI can say "and N requests we cannot account for" rather than quietly
   * presenting an egress figure that is missing some of the traffic.
   */
  hasUnclassified: boolean;
  /** One entry per recorded ZDR status present (Part 1.26). */
  byZdrStatus: ZdrBucket[];
  /**
   * True when at least one row in range was served by a provider that fell short
   * of a `prefer` policy.
   *
   * This is the compensating control for `prefer`'s residual failover gap: the
   * policy cannot prevent a mid-run switch onto an ineligible provider, so the
   * record has to be able to say that it happened. Never true for `require`, which
   * refuses instead, or for `off`, which demands nothing.
   */
  hasPreferenceUnmet: boolean;
}

/**
 * A ZDR bucket key: a status this build knows, `unrecorded` for a NULL column, or
 * a raw value stamped by a build that knew more.
 *
 * The third case is not hypothetical. Migration `016` deliberately omits a `CHECK`
 * so the status enum can widen, which means a downgrade leaves rows carrying a
 * status this build cannot name. Those are reported **verbatim** rather than
 * folded into `unrecorded`, because `unrecorded` asserts something specific — "no
 * policy was recorded when this row was written" — and saying that about a row
 * that *did* record one understates what happened, which is the one error this
 * layer must never make. `ExposureBucket.providerTypes` keeps unrecognised
 * provider types visible for the same reason.
 */
export type ZdrBucketKey = ZdrStatus | 'unrecorded' | (string & {});

/** Spend grouped by the ZDR status that actually applied to it. */
export interface ZdrBucket extends UsageBucket {
  /** See `ZdrBucketKey`: a known status, `unrecorded` for NULL, or a raw value. */
  key: ZdrBucketKey;
  /**
   * True when this bucket's status did not satisfy a `prefer` policy that was in
   * force at the time.
   *
   * Computed from the stored `(zdr_status, zdr_requirement)` pair rather than
   * stored as a verdict of its own. The log holds facts; a conclusion drawn from
   * them can be re-derived if the definition changes, whereas a stored verdict
   * would silently keep the old definition forever.
   */
  preferenceUnmet: boolean;
  /**
   * The requirements in force across these rows, for the tooltip.
   *
   * Raw stored values, including one this build does not recognise. A requirement
   * that was dropped for failing a type guard would make the bucket claim a policy
   * was absent when the row says otherwise.
   */
  requirements: string[];
}

interface ExposureRow extends AggRow {
  provider_type: string | null;
}

interface ZdrRow extends AggRow {
  zdr_status: string | null;
  zdr_requirement: string | null;
}

const CLASS_ORDER: readonly EgressClass[] = ['local', 'remote', 'unknown'];

/**
 * Display order for the ZDR buckets: safest first, then the ones that need
 * attention, with the unrecordable ones last.
 *
 * A fixed list rather than "whatever SQL returned", so the same summary always
 * reads in the same order and a bucket cannot appear to have moved because its
 * cost changed. Statuses not named here are appended in the order encountered,
 * which keeps a future status visible instead of dropping it.
 */
const ZDR_ORDER: readonly (ZdrStatus | 'unrecorded')[] = [
  'local_no_egress',
  'zdr_confirmed',
  'zdr_requested',
  'zdr_not_applied',
  'zdr_unknown',
  'standard_retention',
  'egress_unknown',
  'unrecorded',
];

/**
 * Spend grouped by the ZDR status recorded on each row.
 *
 * Grouped in SQL but *interpreted* in TypeScript, the same split as
 * `summarizeExposure`: SQLite sums the numbers, and `zdrPreferenceUnmet` decides
 * what a `(status, requirement)` pair means. The judgement stays in one module.
 *
 * A row is grouped by both columns and then merged by status, because a single
 * status can have been reached under different policies — the same
 * `standard_retention` send is unremarkable under `off` and a broken promise
 * under `prefer`, and the bucket has to be able to say which rows were which.
 *
 * **The type guards classify; they never discard.** An earlier revision used
 * `isZdrStatus`/`isZdrRequirement` to decide whether to *keep* a stored value, so
 * anything a newer build had written folded into `unrecorded` and its requirement
 * vanished — three lies at once: the bucket disagreed with the `?zdrStatus=` filter
 * over the same rows, it reported a requirement while claiming none was recorded,
 * and a `prefer` shortfall on an unrecognised status read as satisfied because the
 * status reached `zdrPreferenceUnmet` as `null`. Stored values are now passed
 * through as they are, and only a genuine NULL becomes `unrecorded`.
 */
function summarizeZdr(query: UsageQuery): { buckets: ZdrBucket[]; hasPreferenceUnmet: boolean } {
  const { sql, values } = where(query);

  const rows = getDb()
    .prepare<ZdrRow>(
      `SELECT zdr_status, zdr_requirement, zdr_status AS key, ${AGG_COLUMNS}
         FROM usage_log ${sql}
        GROUP BY zdr_status, zdr_requirement`,
    )
    .all(...values);

  const merged = new Map<
    ZdrBucketKey,
    { bucket: UsageBucket; requirements: Set<string>; preferenceUnmet: boolean }
  >();
  let hasPreferenceUnmet = false;

  for (const row of rows) {
    // Only NULL is `unrecorded`. Any stored string is its own bucket, recognised
    // or not.
    const key: ZdrBucketKey = row.zdr_status ?? 'unrecorded';
    const requirement = row.zdr_requirement;
    // The raw status goes in: `zdrPreferenceUnmet` treats a value it cannot name as
    // unmet rather than as satisfied, which is the only safe direction.
    const unmet = zdrPreferenceUnmet(
      row.zdr_status,
      isZdrRequirement(requirement) ? requirement : null,
    );
    if (unmet) hasPreferenceUnmet = true;

    const bucket = mapBucket(row, key);
    const existing = merged.get(key);
    if (existing) {
      existing.bucket.requests += bucket.requests;
      existing.bucket.tokensIn += bucket.tokensIn;
      existing.bucket.tokensOut += bucket.tokensOut;
      existing.bucket.costUsd += bucket.costUsd;
      existing.bucket.unpricedRequests += bucket.unpricedRequests;
      existing.preferenceUnmet = existing.preferenceUnmet || unmet;
      if (requirement !== null) existing.requirements.add(requirement);
    } else {
      merged.set(key, {
        bucket: { ...bucket, key },
        requirements: new Set(requirement !== null ? [requirement] : []),
        preferenceUnmet: unmet,
      });
    }
  }

  const ordered: ZdrBucketKey[] = [
    ...ZDR_ORDER.filter((key) => merged.has(key)),
    ...[...merged.keys()].filter((key) => !(ZDR_ORDER as readonly string[]).includes(key)),
  ];

  const buckets = ordered.map((key) => {
    // Present by construction: `ordered` is built from this map's own keys.
    const entry = merged.get(key) as { bucket: UsageBucket; requirements: Set<string>; preferenceUnmet: boolean };
    return {
      ...entry.bucket,
      key,
      preferenceUnmet: entry.preferenceUnmet,
      requirements: [...entry.requirements].sort(),
    };
  });

  return { buckets, hasPreferenceUnmet };
}

/**
 * How much of this machine's traffic actually left it, grouped by egress class.
 *
 * Grouped in TypeScript rather than in SQL on purpose. The provider-type →
 * egress-class mapping is a product decision (`opencodex` is remote despite the
 * name; `colibri` is local despite being slow), and encoding it in a CASE
 * expression here would put a second copy of that judgement somewhere nobody
 * would think to update. `classifyProviderType` stays the single definition, and
 * this function only sums what it is told.
 *
 * Rows with no recorded type are reported as `unknown`, never merged into a
 * neighbouring bucket: understating egress is a safety claim we cannot support,
 * and overstating it trains the user to ignore the number.
 */
export function summarizeExposure(query: UsageQuery = {}): ExposureSummary {
  const { sql, values } = where(query);

  const rows = getDb()
    .prepare<ExposureRow>(
      `SELECT provider_type, provider_type AS key, ${AGG_COLUMNS}
         FROM usage_log ${sql}
        GROUP BY provider_type`,
    )
    .all(...values);

  const merged = new Map<EgressClass, { bucket: UsageBucket; types: Set<string> }>();
  for (const row of rows) {
    const cls = classifyProviderType(row.provider_type as ProviderType | null);
    const bucket = mapBucket(row, cls);
    const existing = merged.get(cls);
    if (existing) {
      existing.bucket.requests += bucket.requests;
      existing.bucket.tokensIn += bucket.tokensIn;
      existing.bucket.tokensOut += bucket.tokensOut;
      existing.bucket.costUsd += bucket.costUsd;
      existing.bucket.unpricedRequests += bucket.unpricedRequests;
      if (row.provider_type !== null) existing.types.add(row.provider_type);
    } else {
      merged.set(cls, {
        bucket: { ...bucket, key: cls },
        types: new Set(row.provider_type !== null ? [row.provider_type] : []),
      });
    }
  }

  const byClass: ExposureBucket[] = [];
  for (const cls of CLASS_ORDER) {
    const entry = merged.get(cls);
    if (!entry) continue;
    byClass.push({ ...entry.bucket, key: cls, providerTypes: [...entry.types].sort() });
  }

  const totals = byClass.reduce<UsageBucket>(
    (accumulator, bucket) => ({
      key: 'total',
      requests: accumulator.requests + bucket.requests,
      tokensIn: accumulator.tokensIn + bucket.tokensIn,
      tokensOut: accumulator.tokensOut + bucket.tokensOut,
      costUsd: accumulator.costUsd + bucket.costUsd,
      unpricedRequests: accumulator.unpricedRequests + bucket.unpricedRequests,
    }),
    { key: 'total', requests: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, unpricedRequests: 0 },
  );

  const zdr = summarizeZdr(query);

  return {
    range: { from: query.from ?? null, to: query.to ?? null },
    totals,
    byClass,
    hasUnclassified: byClass.some((bucket) => bucket.key === 'unknown'),
    byZdrStatus: zdr.buckets,
    hasPreferenceUnmet: zdr.hasPreferenceUnmet,
  };
}

/**
 * Every distinct non-NULL `zdr_status` actually present in the log.
 *
 * Exists so the HTTP layer can accept a filter for a status this build does not
 * know while still rejecting a typo. Validating against the compiled-in enum alone
 * would 400 on real stored data — the rows a downgrade leaves behind — and those
 * are exactly the rows an audit most needs to reach.
 */
export function recordedZdrStatuses(): string[] {
  return getDb()
    .prepare<{ zdr_status: string }>(
      `SELECT DISTINCT zdr_status FROM usage_log WHERE zdr_status IS NOT NULL ORDER BY zdr_status`,
    )
    .all()
    .map((row) => row.zdr_status);
}
