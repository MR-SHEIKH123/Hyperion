import { Router } from 'express';

import { wrap } from './errors.ts';
import {
  asNullableString,
  asString,
  asTool,
  body,
  queryNumber,
  queryString,
  requireNumber,
} from './params.ts';
import {
  deletePrice,
  listPrices,
  recordedZdrStatuses,
  setPrice,
  summarizeExposure,
  summarizeUsage,
} from '../db/usage.ts';
import { ZDR_STATUSES } from '../types/core.ts';
import { AppError } from '../util/errors.ts';

import type { Request } from 'express';
import type { PriceInput, UsageQuery, ZdrBucketKey } from '../db/usage.ts';
import type { ZdrStatus } from '../types/core.ts';

export const usageRouter = Router();

/**
 * Accepted values for `?zdrStatus=`: every status, plus `unrecorded` for the rows
 * written before 1.26.
 *
 * Derived from `ZDR_STATUSES` rather than restated, so a new status is filterable
 * the moment it exists — the alternative is a hand-maintained list that silently
 * rejects the newest status with a 400.
 */
const ZDR_STATUS_FILTERS: readonly (ZdrStatus | 'unrecorded')[] = [...ZDR_STATUSES, 'unrecorded'];

/**
 * Validate `?zdrStatus=`, accepting anything the log actually contains.
 *
 * Two rules that pull in opposite directions, and both matter. A typo must be a 400
 * rather than an empty summary, because an empty summary reads exactly like "you
 * have no remote traffic" — the most dangerous wrong answer this endpoint can give.
 * But a status stamped by a newer build is *real data*, reported verbatim as its own
 * bucket, and rejecting it would leave those rows visible in the summary yet
 * impossible to select. Checking the compiled-in enum first and the stored values
 * second satisfies both: unknown *and* absent is a mistake, unknown but *present* is
 * history.
 */
function zdrStatusFilter(req: Request): ZdrBucketKey | undefined {
  const raw = queryString(req, 'zdrStatus');
  if (raw === undefined) return undefined;
  if ((ZDR_STATUS_FILTERS as readonly string[]).includes(raw)) return raw;
  if (recordedZdrStatuses().includes(raw)) return raw;
  throw new AppError(
    'bad_request',
    `zdrStatus must be one of: ${ZDR_STATUS_FILTERS.join(', ')} — or a status present in the log.`,
    { details: { field: 'zdrStatus', allowed: ZDR_STATUS_FILTERS } },
  );
}

/**
 * Usage rollup. `hasUnpriced` rides along in the summary so the UI can caveat
 * totals instead of presenting a partial figure as the full spend.
 */
usageRouter.get(
  '/',
  wrap(async (req, res) => {
    const query: UsageQuery = {
      from: queryNumber(req, 'from'),
      to: queryNumber(req, 'to'),
      tool: asTool(queryString(req, 'tool')),
      providerId: queryString(req, 'providerId'),
    };
    res.json(summarizeUsage(query));
  }),
);

/**
 * The same spend, grouped by whether it left the machine (Part 1.23) and by the
 * retention status that applied to it (Part 1.26).
 *
 * A sibling of `/` rather than a field on it: the totals answer "what did this
 * cost", and this answers "how much of my work went to somebody else's server,
 * and under what promise". Mixing them would make every existing caller pay for a
 * second aggregation it did not ask for.
 *
 * `hasUnclassified` is reported rather than hidden. Rows written before
 * migration 013, or by a provider since deleted, have no type to classify, and
 * quietly filing them under `local` would understate exposure — the one direction
 * this feature must never err in. `byZdrStatus` carries the pre-1.26 rows in the
 * same spirit, as their own `unrecorded` bucket.
 *
 * `zdrStatus` filters to one recorded status; `zdrStatus=unrecorded` selects the
 * rows written before the policy existed.
 */
usageRouter.get(
  '/exposure-summary',
  wrap(async (req, res) => {
    const query: UsageQuery = {
      from: queryNumber(req, 'from'),
      to: queryNumber(req, 'to'),
      tool: asTool(queryString(req, 'tool')),
      providerId: queryString(req, 'providerId'),
      // Validated rather than passed through: an unrecognised status that is not in
      // the log is a typo, and answering it with an empty summary would read exactly
      // like "you have no remote traffic".
      zdrStatus: zdrStatusFilter(req),
    };
    res.json(summarizeExposure(query));
  }),
);

usageRouter.get(
  '/prices',
  wrap(async (_req, res) => {
    res.json({ prices: listPrices() });
  }),
);

/** Upsert on (modelId, providerId). A null providerId is the catch-all rate. */
function upsertHandler(): ReturnType<typeof wrap> {
  return wrap(async (req, res) => {
    const payload = body(req);
    const providerId = asNullableString(payload.providerId, 'providerId');
    const input: PriceInput = {
      modelId: asString(payload.modelId, 'modelId'),
      providerId: providerId ?? null,
      inputPer1mUsd: requireNumber(payload.inputPer1mUsd, 'inputPer1mUsd'),
      outputPer1mUsd: requireNumber(payload.outputPer1mUsd, 'outputPer1mUsd'),
    };
    setPrice(input);
    res.json({ price: input });
  });
}

usageRouter.put('/prices', upsertHandler());
usageRouter.post('/prices', upsertHandler());

usageRouter.delete(
  '/prices',
  wrap(async (req, res) => {
    const payload = body(req);
    const modelId = asString(payload.modelId ?? queryString(req, 'modelId'), 'modelId');
    const providerId =
      asNullableString(payload.providerId, 'providerId') ?? queryString(req, 'providerId') ?? null;
    res.json({ deleted: deletePrice(modelId, providerId) });
  }),
);
