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
  setPrice,
  summarizeExposure,
  summarizeUsage,
} from '../db/usage.ts';
import type { PriceInput, UsageQuery } from '../db/usage.ts';

export const usageRouter = Router();

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
 * The same spend, grouped by whether it left the machine (Part 1.23).
 *
 * A sibling of `/` rather than a field on it: the totals answer "what did this
 * cost", and this answers "how much of my work went to somebody else's server".
 * Mixing them would make every existing caller pay for a second aggregation it
 * did not ask for.
 *
 * `hasUnclassified` is reported rather than hidden. Rows written before
 * migration 013, or by a provider since deleted, have no type to classify, and
 * quietly filing them under `local` would understate exposure — the one direction
 * this feature must never err in.
 */
usageRouter.get(
  '/exposure-summary',
  wrap(async (req, res) => {
    const query: UsageQuery = {
      from: queryNumber(req, 'from'),
      to: queryNumber(req, 'to'),
      tool: asTool(queryString(req, 'tool')),
      providerId: queryString(req, 'providerId'),
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
