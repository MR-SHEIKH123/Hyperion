import type { S3FieldWire, S3ProbeStepWire } from '../../contracts/wire/backup';
import type { UsageBucketWire } from '../../contracts/wire/usage';

/**
 * Pure helpers for the Data section (Settings 2.5, slice 3b): formatting
 * and validation only, no fetching. The honesty rules of the surfaces
 * live here so the views and the tests read the same words.
 */

/** Shown beside every cost figure when some requests had no price. */
export function unpricedNote(bucket: UsageBucketWire): string | null {
  if (bucket.unpricedRequests === 0) return null;
  const noun = bucket.unpricedRequests === 1 ? 'request has' : 'requests have';
  return `${formatCount(bucket.unpricedRequests)} ${noun} no recorded price and ${bucket.unpricedRequests === 1 ? 'is' : 'are'} not in this figure.`;
}

/**
 * The one-line cost answer for a bucket. Nothing recorded is its own
 * sentence — a row of zeros would claim a measurement that never
 * happened, and "free" would claim a price nobody set.
 */
export function costSummary(bucket: UsageBucketWire): string {
  if (bucket.requests === 0) return 'Nothing was recorded.';
  return formatUsd(bucket.costUsd);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]!}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** "Not reported" is an answer; 0 would be a different, false one. */
export function reportedOrNot(value: number | null, format: (value: number) => string): string {
  return value === null ? 'Not reported' : format(value);
}

export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Price validation mirroring the route: `requireNumber` accepts any
 * finite number (a string is coerced). There is no positivity rule to
 * invent — a negative price is nonsense the backend tolerates, and the
 * UI's job is to refuse the unparseable, not to add rules of its own.
 */
export function validatePriceField(raw: string, label: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return `${label} is required.`;
  if (!Number.isFinite(Number(trimmed))) return `${label} must be a number.`;
  return null;
}

export const S3_FIELD_LABELS: Record<S3FieldWire, string> = {
  endpoint: 'Endpoint',
  region: 'Region',
  bucket: 'Bucket',
  prefix: 'Prefix',
  accessKeyId: 'Access key ID',
  secretAccessKey: 'Secret access key',
};

/**
 * A failed delete step in the S3 probe is a warning, not a failure: the
 * destination works, it just left a probe object behind. That mirrors
 * the backend, which reports the step with `warning` set rather than
 * failing the test.
 */
export function probeStepTone(step: S3ProbeStepWire): 'ok' | 'warning' | 'failure' {
  if (step.ok) return 'ok';
  return step.warning !== undefined ? 'warning' : 'failure';
}

export const PROBE_STEP_LABELS: Record<S3ProbeStepWire['step'], string> = {
  put: 'Upload a probe object',
  head: 'Read it back',
  delete: 'Delete the probe object',
};

/** A restore replaces; it never merges. Said before the confirmation, not after. */
export const RESTORE_REPLACES_LINE =
  'A restore replaces the current database with the archive’s — nothing is merged. A snapshot of what you have now is taken first, and Hyperion needs a restart afterwards.';

/** The scheduled-backup mirror may fail freely; the local archive is the backup. */
export const DESTINATION_FAILURE_LINE =
  'A destination that fails never fails the local backup: the archive is written to this machine first, and only an export that explicitly asks for the upload reports an upload failure.';

/** Export carries keys only when asked, and the asking is the warning's subject. */
export const EXPORT_KEYS_LINE =
  'Provider API keys are left out unless you include them. An archive with keys in it is a credential — protect it accordingly.';
