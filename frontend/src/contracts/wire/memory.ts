import { z } from 'zod';

/**
 * Memory (Settings 2.5, slice 3a) — docs/API.md and `src/http/memory.ts`.
 *
 * The status object is the single place that distinguishes "off", "on but
 * the backend would not load", and "on": the list route answers an empty
 * list for both of the first two, so a schema that merged them would let a
 * panel render a broken backend as a tidy empty store.
 */
export const memoryStatusSchema = z.object({
  enabled: z.boolean(),
  available: z.boolean(),
  error: z.string().nullable(),
  llmModel: z.string(),
  embedModel: z.string(),
  retrieveLimit: z.number().int().nonnegative(),
  storeDir: z.string(),
}).passthrough();
export const memoryStatusResponseSchema = z.object({ status: memoryStatusSchema }).passthrough();

export const memoryEntrySchema = z.object({
  id: z.string(),
  memory: z.string(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  score: z.number().nullable(),
  tool: z.string().nullable(),
  chatId: z.string().nullable(),
}).passthrough();
export const memoryListResponseSchema = z.object({ memories: z.array(memoryEntrySchema) }).passthrough();

export const memoryStoredResponseSchema = z.object({ stored: z.literal(true) }).passthrough();

export const memoryImportFileSchema = z.object({
  name: z.string(),
  imported: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  found: z.number().int().nonnegative(),
  error: z.string().nullable(),
}).passthrough();
export const memoryImportResponseSchema = z.object({
  imported: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  found: z.number().int().nonnegative(),
  error: z.string().nullable(),
  files: z.array(memoryImportFileSchema).optional(),
}).passthrough();

export const memoryDeletedResponseSchema = z.object({ deleted: z.boolean() }).passthrough();
export const memoryClearedResponseSchema = z.object({ cleared: z.boolean() }).passthrough();

export type MemoryStatusWire = z.infer<typeof memoryStatusSchema>;
export type MemoryEntryWire = z.infer<typeof memoryEntrySchema>;
export type MemoryImportWire = z.infer<typeof memoryImportResponseSchema>;
