import {
  exposureSummaryResponseSchema,
  priceDeletedResponseSchema,
  priceResponseSchema,
  pricesResponseSchema,
  usageSummaryResponseSchema,
} from '../contracts/wire/usage';
import { request } from './client';

/**
 * Usage summaries and model prices — the Settings 2.5 slice-3b client
 * (src/http/usage.ts). No range or filter parameters are sent: the data
 * section shows the whole recorded history, and a filter the UI cannot
 * explain would risk reading as "nothing happened".
 */

export const getUsageSummary = (signal?: AbortSignal) =>
  request('/api/usage', usageSummaryResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export const getExposureSummary = (signal?: AbortSignal) =>
  request('/api/usage/exposure-summary', exposureSummaryResponseSchema, {
    ...(signal === undefined ? {} : { signal }),
  });

export const listPrices = (signal?: AbortSignal) =>
  request('/api/usage/prices', pricesResponseSchema, { ...(signal === undefined ? {} : { signal }) });

/** Upsert on (modelId, providerId); a null providerId is the catch-all rate. */
export const savePrice = (
  price: { modelId: string; providerId: string | null; inputPer1mUsd: number; outputPer1mUsd: number },
  signal?: AbortSignal,
) =>
  request('/api/usage/prices', priceResponseSchema, {
    method: 'PUT',
    body: price,
    ...(signal === undefined ? {} : { signal }),
  });

export const deletePrice = (price: { modelId: string; providerId: string | null }, signal?: AbortSignal) =>
  request('/api/usage/prices', priceDeletedResponseSchema, {
    method: 'DELETE',
    body: price,
    ...(signal === undefined ? {} : { signal }),
  });
