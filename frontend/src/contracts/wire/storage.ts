import { z } from 'zod';

/**
 * Wire contracts for /api/storage stats, cleanup and assets (Settings
 * 2.5, slice 3b). Read against `src/http/storage.ts` and
 * `src/services/storage/gallery.ts` / `src/services/storage/cleanup.ts`
 * on 2026-10-18.
 *
 * The worktree routes in the same router belong to Code recovery and are
 * deliberately not modelled here: the data section must not grow a
 * second worktree surface.
 */

export const storageStatsResponseSchema = z.object({
  assets: z.object({
    count: z.number(),
    bytes: z.number(),
    pinned: z.number(),
    missing: z.number(),
  }),
  chats: z.object({
    count: z.number(),
    pinned: z.number(),
  }),
  byTool: z.array(z.object({ key: z.string(), count: z.number(), bytes: z.number() })),
  byOrigin: z.array(z.object({ key: z.string(), count: z.number(), bytes: z.number() })),
});
export type StorageStatsWire = z.infer<typeof storageStatsResponseSchema>;

export const cleanupResultSchema = z.object({
  ranAt: z.number(),
  dryRun: z.boolean(),
  assetTtlDays: z.number(),
  chatTtlDays: z.number(),
  chatsDeleted: z.number(),
  assetsDeleted: z.number(),
  bytesFreed: z.number(),
  emptyDirsRemoved: z.number(),
  stagingPruned: z.number(),
  snapshotsCleared: z.number(),
  detail: z.object({
    chats: z.array(z.object({ id: z.string(), title: z.string().nullable(), lastOpenedAt: z.number() })),
    assets: z.array(
      z.object({
        id: z.string(),
        filename: z.string(),
        bytes: z.number(),
        reason: z.enum(['expired', 'file_missing']),
      }),
    ),
  }),
});
export type CleanupResultWire = z.infer<typeof cleanupResultSchema>;

export const cleanupLogEntrySchema = z.object({
  id: z.number(),
  ranAt: z.number(),
  chatsDeleted: z.number(),
  assetsDeleted: z.number(),
  bytesFreed: z.number(),
  dryRun: z.boolean(),
  // The log stores the detail blob as JSON; its shape is the cleanup
  // result's detail above, but the log is history and is rendered as
  // counts, so the blob itself stays unmodelled rather than re-validated.
  detail: z.unknown(),
});

export const cleanupLogResponseSchema = z.object({
  entries: z.array(cleanupLogEntrySchema),
});

export const assetSchema = z.object({
  id: z.string(),
  chatId: z.string().nullable(),
  messageId: z.string().nullable(),
  filename: z.string(),
  relPath: z.string(),
  mimeType: z.string().nullable(),
  bytes: z.number(),
  sha256: z.string().nullable(),
  origin: z.enum(['uploaded', 'generated']),
  tool: z.string().nullable(),
  pinned: z.boolean(),
  brandApproved: z.boolean(),
  brandApprovedAt: z.number().nullable(),
  createdAt: z.number(),
  lastAccessedAt: z.number(),
  missing: z.boolean(),
  url: z.string(),
});
export type AssetWire = z.infer<typeof assetSchema>;

export const assetListingResponseSchema = z.object({
  assets: z.array(assetSchema),
  total: z.number(),
  totalBytes: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export const assetResponseSchema = z.object({
  asset: assetSchema,
});

export const assetDeletedResponseSchema = z.object({
  deleted: z.boolean(),
  keepFile: z.boolean(),
  bytesFreed: z.number(),
});
