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
