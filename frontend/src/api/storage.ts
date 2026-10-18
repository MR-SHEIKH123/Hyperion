import {
  assetDeletedResponseSchema,
  assetListingResponseSchema,
  assetResponseSchema,
  cleanupLogResponseSchema,
  cleanupResultSchema,
  storageStatsResponseSchema,
} from '../contracts/wire/storage';
import { request } from './client';

/**
 * Storage stats, cleanup, and assets — the Settings 2.5 slice-3b client
 * (src/http/storage.ts). It deliberately has no worktree functions: those
 * routes belong to Code recovery, and the data section must not grow a
 * second worktree surface.
 */

export const getStorageStats = (signal?: AbortSignal) =>
  request('/api/storage/stats', storageStatsResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export const getCleanupLog = (signal?: AbortSignal) =>
  request('/api/storage/cleanup/log', cleanupLogResponseSchema, { ...(signal === undefined ? {} : { signal }) });

/** `dryRun: true` is the preview the cleanup confirmation is built from. */
export const runCleanup = (dryRun: boolean, signal?: AbortSignal) =>
  request('/api/storage/cleanup', cleanupResultSchema, {
    method: 'POST',
    body: { dryRun },
    ...(signal === undefined ? {} : { signal }),
  });

export const listAssets = (signal?: AbortSignal) =>
  request('/api/storage/assets', assetListingResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export const setAssetPinned = (id: string, pinned: boolean, signal?: AbortSignal) =>
  request(`/api/storage/assets/${encodeURIComponent(id)}/pin`, assetResponseSchema, {
    method: 'POST',
    body: { pinned },
    ...(signal === undefined ? {} : { signal }),
  });

/** Deletes the database row and its file; the answer reports the bytes freed. */
export const deleteAsset = (id: string, signal?: AbortSignal) =>
  request(`/api/storage/assets/${encodeURIComponent(id)}`, assetDeletedResponseSchema, {
    method: 'DELETE',
    ...(signal === undefined ? {} : { signal }),
  });
