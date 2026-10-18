import type {
  ArchiveInspectionWire,
  BackupFileWire,
  RestoreAuditEntryWire,
  S3PublicConfigWire,
  S3TestReportWire,
} from '../../contracts/wire/backup';
import type { AssetWire, CleanupResultWire, StorageStatsWire } from '../../contracts/wire/storage';
import type {
  ExposureSummaryWire,
  ModelPriceWire,
  UsageBucketWire,
  UsageSummaryWire,
} from '../../contracts/wire/usage';

/**
 * Data fixtures for the dev harness (Settings 2.5, slice 3b), typed
 * against the wire schemas. The unpriced requests, the null cache
 * measures, and the failed-delete warning step are deliberate: those are
 * the shapes a tidy fixture would hide and the UI must not.
 */

export const backupFilesFixture: BackupFileWire[] = [
  { filename: 'hyperion-2026-10-17.zip', bytes: 48_200_000, createdAt: Date.parse('2026-10-17T21:03:00') },
  { filename: 'hyperion-2026-10-10.hypbak', bytes: 47_900_000, createdAt: Date.parse('2026-10-10T21:03:00') },
];

export const s3ConfiguredFixture: S3PublicConfigWire = {
  enabled: true,
  configured: true,
  missing: [],
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'hyperion-backups',
  prefix: 'laptop',
  accessKeyId: 'AKIAEXAMPLE',
  hasSecret: true,
};

export const s3UnconfiguredFixture: S3PublicConfigWire = {
  enabled: false,
  configured: false,
  missing: ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'],
  endpoint: null,
  region: 'us-east-1',
  bucket: null,
  prefix: null,
  accessKeyId: null,
  hasSecret: false,
};

/** A working destination whose probe object was left behind: warning, not failure. */
export const s3TestReportFixture: S3TestReportWire = {
  ok: true,
  key: 'laptop/.hyperion-probe-1728000000',
  steps: [
    { step: 'put', ok: true, status: 200, etag: '"abc123"' },
    { step: 'head', ok: true, status: 200 },
    {
      step: 'delete',
      ok: false,
      status: 403,
      error: 'Probe cleanup failed (HTTP 403).',
      warning: 'Probe object left behind at laptop/.hyperion-probe-1728000000; remove it from the bucket.',
    },
  ],
};

export const inspectionFixture: ArchiveInspectionWire = {
  valid: true,
  encrypted: true,
  manifest: {
    format: 1,
    app: 'Hyperion',
    createdAt: Date.parse('2026-10-10T21:03:00'),
    createdAtIso: '2026-10-10T21:03:00.000Z',
    schemaMigrations: ['001', '002'],
    contents: { database: true, mcpConfig: false, skills: 3, attachments: 12, encryptionKey: false },
    counts: { chats: 41 },
  },
  hasDatabase: true,
  hasMcpConfig: false,
  hasEncryptionKey: false,
  skillFiles: 3,
  attachmentFiles: 12,
  counts: { chats: 41 },
  diff: {
    tables: [
      { table: 'chats', current: 58, archive: 41, delta: -17 },
      { table: 'usage_log', current: 1204, archive: 990, delta: -214 },
      { table: 'settings', current: 22, archive: 22, delta: 0 },
    ],
    onlyInArchive: [],
    onlyHere: ['restore_audit'],
    missingFromArchive: [],
    currentMigrations: 21,
    archiveMigrations: 21,
  },
  problems: [],
  warnings: ['The archive was created by an older build; its data will be migrated on first use after the restore.'],
};

export const restoresFixture: RestoreAuditEntryWire[] = [
  {
    id: 3,
    createdAt: Date.parse('2026-10-11T09:00:00'),
    filename: 'hyperion-2026-10-10.hypbak',
    bytes: 47_900_000,
    sha256: 'beef',
    encrypted: true,
    dryRun: false,
    restored: true,
    outcome: 'restored',
    detail: null,
    preRestoreBackup: 'pre-restore-2026-10-11.zip',
  },
  {
    id: 2,
    createdAt: Date.parse('2026-10-11T08:55:00'),
    filename: 'hyperion-2026-10-10.hypbak',
    bytes: 47_900_000,
    sha256: 'beef',
    encrypted: true,
    dryRun: true,
    restored: false,
    outcome: 'dry_run',
    detail: null,
    preRestoreBackup: null,
  },
  {
    id: 1,
    createdAt: Date.parse('2026-10-02T10:00:00'),
    filename: 'corrupt.zip',
    bytes: 1200,
    sha256: 'cafe',
    encrypted: false,
    dryRun: false,
    restored: false,
    outcome: 'refused',
    detail: 'This archive cannot be restored: no database inside.',
    preRestoreBackup: null,
  },
];

export const storageStatsFixture: StorageStatsWire = {
  assets: { count: 132, bytes: 812_000_000, pinned: 5, missing: 2 },
  chats: { count: 58, pinned: 3 },
  byTool: [
    { key: 'code', count: 70, bytes: 500_000_000 },
    { key: 'design', count: 62, bytes: 312_000_000 },
  ],
  byOrigin: [
    { key: 'generated', count: 90, bytes: 600_000_000 },
    { key: 'uploaded', count: 42, bytes: 212_000_000 },
  ],
};

export const cleanupDryRunFixture: CleanupResultWire = {
  ranAt: Date.parse('2026-10-18T10:00:00'),
  dryRun: true,
  assetTtlDays: 90,
  chatTtlDays: 180,
  chatsDeleted: 4,
  assetsDeleted: 11,
  bytesFreed: 96_000_000,
  emptyDirsRemoved: 2,
  stagingPruned: 1,
  snapshotsCleared: 0,
  detail: {
    chats: [{ id: 'chat-old', title: 'Old brainstorm', lastOpenedAt: Date.parse('2026-01-01T00:00:00') }],
    assets: [
      { id: 'ast-1', filename: 'screenshot-old.png', bytes: 2_400_000, reason: 'expired' },
      { id: 'ast-2', filename: 'missing.txt', bytes: 0, reason: 'file_missing' },
    ],
  },
};

export const assetsFixture: AssetWire[] = [
  {
    id: 'ast-1',
    chatId: 'chat-9',
    messageId: null,
    filename: 'logo-final.png',
    relPath: 'attachments/2026-10/ast-1-logo-final.png',
    mimeType: 'image/png',
    bytes: 84_000,
    sha256: 'aa',
    origin: 'uploaded',
    tool: null,
    pinned: true,
    brandApproved: true,
    brandApprovedAt: Date.parse('2026-10-05T00:00:00'),
    createdAt: Date.parse('2026-10-05T00:00:00'),
    lastAccessedAt: Date.parse('2026-10-17T00:00:00'),
    missing: false,
    url: '/api/storage/assets/ast-1/file',
  },
  {
    id: 'ast-2',
    chatId: null,
    messageId: null,
    filename: 'render.webp',
    relPath: 'attachments/2026-10/ast-2-render.webp',
    mimeType: 'image/webp',
    bytes: 1_900_000,
    sha256: 'bb',
    origin: 'generated',
    tool: 'design',
    pinned: false,
    brandApproved: false,
    brandApprovedAt: null,
    createdAt: Date.parse('2026-10-16T00:00:00'),
    lastAccessedAt: Date.parse('2026-10-16T00:00:00'),
    missing: true,
    url: '/api/storage/assets/ast-2/file',
  },
];

function bucket(partial: Partial<UsageBucketWire> & { key: string }): UsageBucketWire {
  return {
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    unpricedRequests: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    cacheHitRate: null,
    rowsWithCacheReporting: 0,
    rowsWithDuration: 0,
    meanDurationMs: null,
    slowestDurationMs: null,
    ...partial,
  };
}

export const usageSummaryFixture: UsageSummaryWire = {
  range: { from: null, to: null },
  totals: bucket({
    key: 'total',
    requests: 1204,
    tokensIn: 8_400_000,
    tokensOut: 1_100_000,
    costUsd: 14.2035,
    unpricedRequests: 37,
  }),
  byTool: [bucket({ key: 'chat', requests: 900, costUsd: 9.1, unpricedRequests: 37 })],
  byProvider: [bucket({ key: 'Wire provider', requests: 1204, costUsd: 14.2035, unpricedRequests: 37 })],
  byModel: [bucket({ key: 'wire-model', requests: 1167, costUsd: 14.2035 }), bucket({ key: 'wire-unpriced', requests: 37, unpricedRequests: 37 })],
  byDay: [
    bucket({ key: '2026-10-16', requests: 300, costUsd: 3.4 }),
    bucket({ key: '2026-10-17', requests: 500, costUsd: 6.2, unpricedRequests: 12 }),
    bucket({ key: '2026-10-18', requests: 404, costUsd: 4.6035, unpricedRequests: 25 }),
  ],
  hasUnpriced: true,
};

export const emptyUsageFixture: UsageSummaryWire = {
  range: { from: null, to: null },
  totals: bucket({ key: 'total' }),
  byTool: [],
  byProvider: [],
  byModel: [],
  byDay: [],
  hasUnpriced: false,
};

export const exposureFixture: ExposureSummaryWire = {
  range: { from: null, to: null },
  totals: bucket({ key: 'total', requests: 1204, costUsd: 14.2035, unpricedRequests: 37 }),
  byClass: [
    bucket({ key: 'local', requests: 200, costUsd: 0, unpricedRequests: 200 }),
    bucket({ key: 'remote', requests: 967, costUsd: 14.2035, unpricedRequests: 12 }),
    bucket({ key: 'unknown', requests: 37, unpricedRequests: 37 }),
  ].map((entry) => ({ ...entry, providerTypes: entry.key === 'remote' ? ['remote'] : [] })),
  hasUnclassified: true,
  byZdrStatus: [
    { ...bucket({ key: 'zero_retention', requests: 800, costUsd: 11 }), preferenceUnmet: false, requirements: ['prefer'] },
    { ...bucket({ key: 'unrecorded', requests: 404, costUsd: 3.2035, unpricedRequests: 37 }), preferenceUnmet: false, requirements: [] },
  ],
  hasPreferenceUnmet: false,
};

export const pricesFixture: ModelPriceWire[] = [
  { modelId: 'wire-model', providerId: null, inputPer1mUsd: 10, outputPer1mUsd: 30 },
  { modelId: 'wire-model', providerId: 'provider-1', inputPer1mUsd: 9, outputPer1mUsd: 27 },
];
