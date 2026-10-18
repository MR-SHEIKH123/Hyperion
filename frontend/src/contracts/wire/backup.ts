import { z } from 'zod';

/**
 * Wire contracts for /api/backup (Settings 2.5, slice 3b).
 *
 * Read against `src/http/backup.ts`, `src/services/backup/export.ts`,
 * `src/services/backup/import.ts`, `src/services/backup/destinations.ts`
 * and `src/db/restoreAudit.ts` on 2026-10-18.
 *
 * Two routes here do not answer JSON: `GET /export` and `POST /export`
 * stream the archive binary. They are not parsed against a schema; the
 * typed client reads the export response's `x-hyperion-s3-key` header and
 * turns failures into the shared error envelope before touching the blob.
 *
 * The S3 secret access key is write-only across this whole API: the
 * public config carries `hasSecret` and nothing else, and no schema here
 * has a field that could hold the value coming back.
 */

export const backupFileSchema = z.object({
  filename: z.string(),
  bytes: z.number(),
  createdAt: z.number(),
});
export type BackupFileWire = z.infer<typeof backupFileSchema>;

export const backupListResponseSchema = z.object({
  backups: z.array(backupFileSchema),
});

export const s3FieldSchema = z.enum(['endpoint', 'region', 'bucket', 'prefix', 'accessKeyId', 'secretAccessKey']);
export type S3FieldWire = z.infer<typeof s3FieldSchema>;

export const s3PublicConfigSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  missing: z.array(s3FieldSchema),
  endpoint: z.string().nullable(),
  region: z.string(),
  bucket: z.string().nullable(),
  prefix: z.string().nullable(),
  accessKeyId: z.string().nullable(),
  hasSecret: z.boolean(),
});
export type S3PublicConfigWire = z.infer<typeof s3PublicConfigSchema>;

export const backupDestinationsResponseSchema = z.object({
  local: z.object({
    directory: z.string(),
    mirror: z.string().nullable(),
  }),
  s3: s3PublicConfigSchema,
});

export const s3ConfigResponseSchema = z.object({
  s3: s3PublicConfigSchema,
});

export const s3ProbeStepSchema = z.object({
  step: z.enum(['put', 'head', 'delete']),
  ok: z.boolean(),
  status: z.number().optional(),
  etag: z.string().optional(),
  error: z.string().optional(),
  warning: z.string().optional(),
});

export const s3TestResponseSchema = z.object({
  ok: z.boolean(),
  key: z.string().optional(),
  error: z.string().optional(),
  missing: z.array(s3FieldSchema).optional(),
  steps: z.array(s3ProbeStepSchema),
});
export type S3TestReportWire = z.infer<typeof s3TestResponseSchema>;

export const backupManifestSchema = z.object({
  format: z.number(),
  app: z.string(),
  createdAt: z.number(),
  createdAtIso: z.string(),
  schemaMigrations: z.array(z.string()),
  contents: z.object({
    database: z.boolean(),
    mcpConfig: z.boolean(),
    skills: z.number(),
    attachments: z.number(),
    encryptionKey: z.boolean(),
  }),
  counts: z.record(z.string(), z.number()),
  encrypted: z.boolean().optional(),
  warning: z.string().optional(),
});

export const tableDeltaSchema = z.object({
  table: z.string(),
  current: z.number(),
  archive: z.number(),
  delta: z.number(),
});

export const archiveInspectionSchema = z.object({
  valid: z.boolean(),
  encrypted: z.boolean(),
  manifest: backupManifestSchema.nullable(),
  hasDatabase: z.boolean(),
  hasMcpConfig: z.boolean(),
  hasEncryptionKey: z.boolean(),
  skillFiles: z.number(),
  attachmentFiles: z.number(),
  counts: z.record(z.string(), z.number()),
  diff: z.object({
    tables: z.array(tableDeltaSchema),
    onlyInArchive: z.array(z.string()),
    onlyHere: z.array(z.string()),
    missingFromArchive: z.array(z.string()),
    currentMigrations: z.number(),
    archiveMigrations: z.number(),
  }),
  problems: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type ArchiveInspectionWire = z.infer<typeof archiveInspectionSchema>;

export const inspectResponseSchema = z.object({
  inspection: archiveInspectionSchema,
});

export const restoreResultSchema = z.object({
  restored: z.boolean(),
  dryRun: z.boolean(),
  inspection: archiveInspectionSchema,
  preRestoreBackup: z.string().nullable(),
  filesWritten: z.object({
    database: z.boolean(),
    mcpConfig: z.boolean(),
    skills: z.number(),
    attachments: z.number(),
  }),
  restartRequired: z.boolean(),
});
export type RestoreResultWire = z.infer<typeof restoreResultSchema>;

export const restoreAuditEntrySchema = z.object({
  id: z.number(),
  createdAt: z.number(),
  filename: z.string().nullable(),
  bytes: z.number(),
  sha256: z.string(),
  encrypted: z.boolean(),
  dryRun: z.boolean(),
  restored: z.boolean(),
  outcome: z.enum(['dry_run', 'restored', 'refused']),
  detail: z.string().nullable(),
  preRestoreBackup: z.string().nullable(),
});
export type RestoreAuditEntryWire = z.infer<typeof restoreAuditEntrySchema>;

export const restoreAuditResponseSchema = z.object({
  restores: z.array(restoreAuditEntrySchema),
});
