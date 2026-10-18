import { z } from 'zod';

/**
 * Wire contracts for /api/usage (Settings 2.5, slice 3b). Read against
 * `src/http/usage.ts` and `src/db/usage.ts` on 2026-10-18.
 *
 * The nullable measures are the contract, not decoration: cache tokens,
 * hit rate and durations are `null` when no row reported them, and the
 * backend is explicit that silence is not zero. The schemas keep them
 * nullable so the UI can say "not reported" instead of inventing a 0.
 */

export const usageBucketSchema = z.object({
  key: z.string(),
  requests: z.number(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  // Sum over priced rows only — read beside `unpricedRequests`, never alone.
  costUsd: z.number(),
  unpricedRequests: z.number(),
  cacheReadTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  cacheHitRate: z.number().nullable(),
  rowsWithCacheReporting: z.number(),
  rowsWithDuration: z.number(),
  meanDurationMs: z.number().nullable(),
  slowestDurationMs: z.number().nullable(),
});
export type UsageBucketWire = z.infer<typeof usageBucketSchema>;

export const usageSummaryResponseSchema = z.object({
  range: z.object({ from: z.number().nullable(), to: z.number().nullable() }),
  totals: usageBucketSchema,
  byTool: z.array(usageBucketSchema),
  byProvider: z.array(usageBucketSchema),
  byModel: z.array(usageBucketSchema),
  // Keys are local dates (`date(created_at/1000,'unixepoch','localtime')`).
  byDay: z.array(usageBucketSchema),
  hasUnpriced: z.boolean(),
});
export type UsageSummaryWire = z.infer<typeof usageSummaryResponseSchema>;

export const exposureBucketSchema = usageBucketSchema.extend({
  // Egress class: 'local' | 'remote' | 'unknown' — kept a plain string so
  // a bucket this build cannot name still renders instead of failing.
  providerTypes: z.array(z.string()),
});

export const zdrBucketSchema = usageBucketSchema.extend({
  preferenceUnmet: z.boolean(),
  requirements: z.array(z.string()),
});

export const exposureSummaryResponseSchema = z.object({
  range: z.object({ from: z.number().nullable(), to: z.number().nullable() }),
  totals: usageBucketSchema,
  byClass: z.array(exposureBucketSchema),
  hasUnclassified: z.boolean(),
  byZdrStatus: z.array(zdrBucketSchema),
  hasPreferenceUnmet: z.boolean(),
});
export type ExposureSummaryWire = z.infer<typeof exposureSummaryResponseSchema>;

export const modelPriceSchema = z.object({
  modelId: z.string(),
  // Null is the catch-all rate for every provider.
  providerId: z.string().nullable(),
  inputPer1mUsd: z.number(),
  outputPer1mUsd: z.number(),
});
export type ModelPriceWire = z.infer<typeof modelPriceSchema>;

export const pricesResponseSchema = z.object({
  prices: z.array(modelPriceSchema),
});

export const priceResponseSchema = z.object({
  price: modelPriceSchema,
});

export const priceDeletedResponseSchema = z.object({
  deleted: z.boolean(),
});
