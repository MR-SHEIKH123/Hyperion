/**
 * Backup destinations (1.29): where a finished archive goes besides the
 * backups root.
 *
 * Two destinations, deliberately asymmetric:
 *
 *   - **Local mirror** — the pre-existing `HYPERION_BACKUP_DEST` copy, moved
 *     here unchanged so both fan-out paths live in one module. Still env-only:
 *     CONTRACTS.md ("Automatic backups can be mirrored off the machine")
 *     explains why a filesystem path must never arrive in a request body, and
 *     nothing here reopens that.
 *
 *   - **S3-compatible object storage** — configured over HTTP because, unlike
 *     the mirror, it accepts no local path: an endpoint, a bucket, a key
 *     prefix and credentials can only address the remote bucket, never this
 *     machine's filesystem. The secret access key is keystore-encrypted in the
 *     settings table (see `SECRET_SETTING_KEYS`) and is never returned by any
 *     read. Signing is SigV4 implemented on `node:crypto` — no SDK dependency —
 *     speaking path-style URLs (`{endpoint}/{bucket}/{key}`), which every
 *     S3-compatible service (AWS, MinIO, GCS, R2) accepts.
 *
 * Failure semantics differ by caller, on purpose. An *explicit* upload
 * (`uploadFileToS3`, used by `POST /api/backup/export` with `uploadToS3`) throws
 * on any failure: the user asked for the upload, so a silent skip would lie.
 * The *automatic* path (`maybeUploadToS3`, used by the nightly run) never
 * throws: the archive is already safely written, so a downed endpoint degrades
 * to `s3Key: null`, a warning, and an `error_log` row the Attention queue
 * surfaces as a backup failure.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { env } from '../../config/env.ts';
import { getSetting, setSetting } from '../../db/settings.ts';
import { logError } from '../../db/errorLog.ts';
import { encrypt, tryDecrypt } from '../../security/keystore.ts';
import { createLogger } from '../../util/logger.ts';
import { AppError } from '../../util/errors.ts';

import { isLoopbackHost } from '../safety/outbound.ts';

import { backupPath } from './export.ts';

const log = createLogger('backup:destinations');

/** Single-PUT object ceiling. Past this, S3 requires multipart upload. */
export const MAX_SINGLE_PUT_BYTES = 4 * 1024 * 1024 * 1024;

/** One object upload must finish inside this, or the attempt is abandoned. */
const S3_REQUEST_TIMEOUT_MS = 60_000;

/** Upper bound on an S3 error body kept for server-side diagnosis. */
const S3_ERROR_BODY_LIMIT = 4096;

const DEFAULT_REGION = 'us-east-1';

export const S3_SETTINGS_KEYS = {
  endpoint: 'backup_s3_endpoint',
  region: 'backup_s3_region',
  bucket: 'backup_s3_bucket',
  prefix: 'backup_s3_prefix',
  accessKeyId: 'backup_s3_access_key_id',
  secretAccessKey: 'backup_s3_secret_access_key',
  enabled: 'backup_s3_enabled',
} as const;

type S3SettingField = keyof typeof S3_SETTINGS_KEYS;

export interface S3PublicConfig {
  enabled: boolean;
  /** True when every required field is present and the secret decrypts. */
  configured: boolean;
  /** Required fields still missing (`secretAccessKey` also covers a stored secret that no longer decrypts). */
  missing: S3SettingField[];
  endpoint: string | null;
  region: string;
  bucket: string | null;
  prefix: string | null;
  accessKeyId: string | null;
  /** Whether a secret is stored — never the secret itself. */
  hasSecret: boolean;
}

interface S3Resolved {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

// ---------------------------------------------------------------------------
// Local mirror (moved verbatim from schedule.ts; behavior unchanged)
// ---------------------------------------------------------------------------

/**
 * Copy the finished archive into `HYPERION_BACKUP_DEST`, when one is set.
 *
 * Named after the machinery in CONTRACTS.md ("Automatic backups can be mirrored
 * off the machine"), which still governs it: the backups root is what
 * `listBackups()`, `GET /api/backup`, `POST /api/backup/inspect`, import and
 * retention all read, and relocating the only archive would break every one of
 * them.
 *
 * Never allowed to fail the run. The archive is already safely written by the
 * time this is called, so a full destination or an unmounted network drive
 * makes the *mirror* unavailable, not the backup. It is logged as a warning and
 * reported as `null`.
 */
export function mirrorToLocalDestination(filename: string): string | null {
  if (env.backupDest === '') return null;

  const target = path.join(path.resolve(env.backupDest), filename);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(backupPath(filename), target);
    return target;
  } catch (error) {
    log.warn('could not copy the backup to HYPERION_BACKUP_DEST', {
      dest: env.backupDest,
      error: String(error),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// S3 configuration
// ---------------------------------------------------------------------------

function blank(value: string | null): boolean {
  return value === null || value.trim() === '';
}

function fieldError(field: S3SettingField, message: string): AppError {
  return new AppError('bad_request', message, { details: { field } });
}

function assertValidEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fieldError('endpoint', 'S3 endpoint must be a URL, e.g. https://s3.example.com or http://127.0.0.1:9000.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw fieldError('endpoint', 'S3 endpoint must be http or https.');
  }
  if (url.username !== '' || url.password !== '') {
    throw fieldError('endpoint', 'S3 endpoint must not contain credentials; they travel in the signed headers.');
  }
  if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
    throw fieldError('endpoint', 'S3 endpoint must be an origin only — no path, query or fragment. Put the path in the prefix.');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    // The Authorization header carries the credential on every request. Plain
    // http to a remote host would broadcast it; loopback (local MinIO) is the
    // only case with no network to sniff.
    throw fieldError('endpoint', 'S3 over plain http is allowed only for loopback hosts (local MinIO-style endpoints). Use https.');
  }
  return url.origin;
}

function assertValidBucket(raw: string): string {
  const bucket = raw.trim();
  if (bucket.length < 3 || bucket.length > 63) {
    throw fieldError('bucket', 'S3 bucket must be 3–63 characters.');
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) || bucket.includes('..')) {
    throw fieldError('bucket', 'S3 bucket must be lowercase letters, digits, dots and hyphens, starting and ending alphanumeric.');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bucket)) {
    throw fieldError('bucket', 'S3 bucket must not be formatted as an IP address.');
  }
  return bucket;
}

function assertValidRegion(raw: string): string {
  const region = raw.trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(region)) {
    throw fieldError('region', 'S3 region must be 1–64 letters, digits or hyphens.');
  }
  return region;
}

function assertValidPrefix(raw: string): string {
  const prefix = raw.trim().replace(/^\/+|\/+$/g, '');
  if (prefix.length > 512) {
    throw fieldError('prefix', 'S3 prefix must be at most 512 characters.');
  }
  if (prefix !== '' && (prefix.includes('//') || prefix.split('/').includes('..'))) {
    throw fieldError('prefix', 'S3 prefix must not contain empty segments or "..".');
  }
  return prefix;
}

function assertValidAccessKeyId(raw: string): string {
  const keyId = raw.trim();
  if (!/^\S{1,128}$/.test(keyId)) {
    throw fieldError('accessKeyId', 'S3 access key id must be 1–128 non-whitespace characters.');
  }
  return keyId;
}

function readS3Config(): { resolved: S3Resolved | null; missing: S3SettingField[]; hasSecret: boolean } {
  const endpoint = getSetting(S3_SETTINGS_KEYS.endpoint);
  const region = getSetting(S3_SETTINGS_KEYS.region);
  const bucket = getSetting(S3_SETTINGS_KEYS.bucket);
  const prefix = getSetting(S3_SETTINGS_KEYS.prefix);
  const accessKeyId = getSetting(S3_SETTINGS_KEYS.accessKeyId);
  const storedSecret = getSetting(S3_SETTINGS_KEYS.secretAccessKey);
  // Null both when absent and when undecryptable (a master-key rotation
  // orphans it); `hasSecret` lets the reader tell the two apart.
  const secretAccessKey = tryDecrypt(storedSecret);

  const missing: S3SettingField[] = [];
  if (blank(endpoint)) missing.push('endpoint');
  if (blank(bucket)) missing.push('bucket');
  if (blank(accessKeyId)) missing.push('accessKeyId');
  if (secretAccessKey === null || secretAccessKey === '') missing.push('secretAccessKey');

  const resolved =
    missing.length > 0 || endpoint === null || bucket === null || accessKeyId === null || secretAccessKey === null
      ? null
      : {
          enabled: getSetting(S3_SETTINGS_KEYS.enabled) === '1',
          endpoint: endpoint.trim(),
          region: blank(region) ? DEFAULT_REGION : (region as string).trim(),
          bucket: bucket.trim(),
          prefix: blank(prefix) ? '' : (prefix as string).trim(),
          accessKeyId: accessKeyId.trim(),
          secretAccessKey,
        };
  return { resolved, missing, hasSecret: storedSecret !== null };
}

export function getS3PublicConfig(): S3PublicConfig {
  const { resolved, missing, hasSecret } = readS3Config();
  return {
    enabled: resolved?.enabled ?? getSetting(S3_SETTINGS_KEYS.enabled) === '1',
    configured: resolved !== null,
    missing,
    endpoint: resolved?.endpoint ?? null,
    region: resolved?.region ?? DEFAULT_REGION,
    bucket: resolved?.bucket ?? null,
    prefix: resolved?.prefix === '' || resolved?.prefix === undefined ? null : resolved.prefix,
    accessKeyId: resolved?.accessKeyId ?? null,
    hasSecret,
  };
}

const S3_PATCH_FIELDS: ReadonlySet<string> = new Set([
  'endpoint',
  'region',
  'bucket',
  'prefix',
  'accessKeyId',
  'secretAccessKey',
  'enabled',
]);

/**
 * Partial update of the S3 destination: omitted fields are left alone, an
 * explicit null or empty string clears a field. Unknown fields are rejected —
 * a typo'd key silently ignored would read as configured when it is not.
 */
export function saveS3Config(patch: Record<string, unknown>): S3PublicConfig {
  for (const key of Object.keys(patch)) {
    if (!S3_PATCH_FIELDS.has(key)) {
      throw new AppError('bad_request', `Unknown S3 setting: ${key}.`, { details: { field: key } });
    }
  }

  const cleared = (value: unknown): boolean => value === null || (typeof value === 'string' && value.trim() === '');
  const asText = (value: unknown, field: S3SettingField): string => {
    if (typeof value !== 'string') throw fieldError(field, `S3 ${field} must be a string or null.`);
    return value;
  };

  if ('endpoint' in patch) {
    const value = patch.endpoint;
    setSetting(S3_SETTINGS_KEYS.endpoint, cleared(value) ? null : assertValidEndpoint(asText(value, 'endpoint')));
  }
  if ('region' in patch) {
    const value = patch.region;
    setSetting(S3_SETTINGS_KEYS.region, cleared(value) ? null : assertValidRegion(asText(value, 'region')));
  }
  if ('bucket' in patch) {
    const value = patch.bucket;
    setSetting(S3_SETTINGS_KEYS.bucket, cleared(value) ? null : assertValidBucket(asText(value, 'bucket')));
  }
  if ('prefix' in patch) {
    const value = patch.prefix;
    setSetting(S3_SETTINGS_KEYS.prefix, cleared(value) ? null : assertValidPrefix(asText(value, 'prefix')));
  }
  if ('accessKeyId' in patch) {
    const value = patch.accessKeyId;
    setSetting(S3_SETTINGS_KEYS.accessKeyId, cleared(value) ? null : assertValidAccessKeyId(asText(value, 'accessKeyId')));
  }
  if ('secretAccessKey' in patch) {
    const value = patch.secretAccessKey;
    if (cleared(value)) {
      setSetting(S3_SETTINGS_KEYS.secretAccessKey, null);
    } else {
      const secret = asText(value, 'secretAccessKey');
      if (secret.length > 4096) throw fieldError('secretAccessKey', 'S3 secret access key is implausibly long.');
      setSetting(S3_SETTINGS_KEYS.secretAccessKey, encrypt(secret));
    }
  }
  if ('enabled' in patch) {
    const value = patch.enabled;
    if (typeof value !== 'boolean') throw fieldError('enabled', 'S3 enabled must be a boolean.');
    setSetting(S3_SETTINGS_KEYS.enabled, value ? '1' : '0');
  }

  const config = getS3PublicConfig();
  log.info('S3 backup destination updated', {
    enabled: config.enabled,
    configured: config.configured,
    ...(config.missing.length > 0 ? { missing: config.missing } : {}),
  });
  return config;
}

// ---------------------------------------------------------------------------
// SigV4 signing (no SDK; `node:crypto` only)
// ---------------------------------------------------------------------------

function sha256Hex(data: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Percent-encode one path segment per RFC 3986 (S3 signs this form). */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface CanonicalRequestInput {
  method: string;
  canonicalUri: string;
  canonicalQuery?: string;
  /** Header pairs in any case; the builder lowercases, trims, sorts and joins them. */
  headers: [string, string][];
  payloadHash: string;
}

/**
 * The SigV4 canonical request. Exported so the tests can pin it against the
 * AWS documentation's worked example — canonicalization (encoding, header
 * sorting, whitespace folding) is where signing bugs live; the HMAC chain
 * below it is four standard HMACs.
 */
export function buildCanonicalRequest(input: CanonicalRequestInput): {
  canonicalRequest: string;
  signedHeaders: string;
} {
  const normalized = input.headers
    .map(([name, value]) => [name.trim().toLowerCase(), value.trim().replace(/\s+/g, ' ')] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = normalized.map(([name, value]) => `${name}:${value}\n`).join('');
  const signedHeaders = normalized.map(([name]) => name).join(';');
  const canonicalRequest = [input.method, input.canonicalUri, input.canonicalQuery ?? '', canonicalHeaders, signedHeaders, input.payloadHash].join(
    '\n',
  );
  return { canonicalRequest, signedHeaders };
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function amzDates(now = new Date()): { amzDate: string; datestamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, datestamp: amzDate.slice(0, 8) };
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

function signS3Request(config: S3Resolved, method: string, key: string, payloadHash: string): SignedRequest {
  const encodedKey = key
    .split('/')
    .map((segment) => encodeSegment(segment))
    .join('/');
  const canonicalUri = `/${config.bucket}/${encodedKey}`;
  // `host` keeps the port (MinIO on :9000) and drops it for default ports —
  // exactly what the server sees in the Host header, which is what is signed.
  const host = new URL(config.endpoint).host;
  const { amzDate, datestamp } = amzDates();
  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method,
    canonicalUri,
    headers: [
      ['host', host],
      ['x-amz-content-sha256', payloadHash],
      ['x-amz-date', amzDate],
    ],
    payloadHash,
  });

  const scope = `${datestamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmacSha256(
    hmacSha256(hmacSha256(hmacSha256(`AWS4${config.secretAccessKey}`, datestamp), config.region), 's3'),
    'aws4_request',
  );
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');

  return {
    url: `${config.endpoint}${canonicalUri}`,
    headers: {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

// ---------------------------------------------------------------------------
// S3 object operations
// ---------------------------------------------------------------------------

function s3Failure(op: string, status: number, bodyText: string): AppError {
  // S3 errors are small XML documents; the Code is the diagnosable part
  // (SignatureDoesNotMatch, AccessDenied, NoSuchBucket). The full body goes to
  // privateDetails — it can echo request material — while the wire message
  // carries only the status and code.
  const code = /<Code>([^<]{1,128})<\/Code>/.exec(bodyText)?.[1];
  return new AppError('storage_error', `S3 ${op} failed: HTTP ${status}${code ? ` (${code})` : ''}.`, {
    privateDetails: { s3Code: code ?? null, s3Body: bodyText.slice(0, S3_ERROR_BODY_LIMIT) },
  });
}

interface S3Response {
  status: number;
  headers: Headers;
  text: string;
}

async function s3Request(config: S3Resolved, op: string, method: string, key: string, body?: Buffer): Promise<S3Response> {
  // The real payload hash, never UNSIGNED-PAYLOAD: some S3-compatible services
  // reject unsigned payloads, and backups fit in memory anyway.
  const payloadHash = sha256Hex(body ?? '');
  const signed = signS3Request(config, method, key, payloadHash);
  let res: Response;
  try {
    res = await fetch(signed.url, {
      method,
      headers: {
        ...signed.headers,
        ...(body !== undefined
          ? { 'content-type': 'application/octet-stream', 'content-length': String(body.length) }
          : {}),
      },
      ...(body !== undefined ? { body: new Uint8Array(body) } : {}),
      signal: AbortSignal.timeout(S3_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new AppError('storage_error', `S3 ${op} timed out after ${S3_REQUEST_TIMEOUT_MS / 1000}s.`, {
        cause: error,
        retryable: true,
      });
    }
    throw new AppError('storage_error', `S3 ${op} failed: cannot reach ${config.endpoint}.`, { cause: error });
  }
  const text = method === 'HEAD' ? '' : await res.text().catch(() => '');
  return { status: res.status, headers: res.headers, text };
}

export interface S3UploadResult {
  key: string;
  etag: string;
  bytes: number;
}

function s3ObjectKey(prefix: string, filename: string): string {
  return prefix === '' ? filename : `${prefix}/${filename}`;
}

/**
 * Upload one archive already on disk. Explicit path: throws on misconfiguration
 * (409) and on any failure (500 `storage_error`) — the caller asked for this
 * upload, so a silent skip would lie about where the archive is.
 *
 * The `enabled` toggle is deliberately *not* consulted: it gates the automatic
 * run, and an explicit per-request upload overrides it the way pressing "back
 * up now" would override a disabled schedule.
 */
export async function uploadFileToS3(absPath: string, filename: string): Promise<S3UploadResult> {
  const { resolved, missing } = readS3Config();
  if (!resolved) {
    throw new AppError('conflict', 'S3 backup destination is not configured.', {
      details: { reason: 's3_not_configured', missing },
    });
  }

  // Before reading: a file past the single-PUT ceiling must fail without
  // spending 4 GiB of RAM proving it.
  const size = fs.statSync(absPath).size;
  if (size > MAX_SINGLE_PUT_BYTES) {
    throw new AppError(
      'storage_error',
      `S3 upload refused: ${filename} is past the 4 GiB single-request limit (multipart upload is not implemented).`,
      { details: { reason: 's3_object_too_large', bytes: size } },
    );
  }

  const key = s3ObjectKey(resolved.prefix, filename);
  const bytes = fs.readFileSync(absPath);
  const put = await s3Request(resolved, 'upload', 'PUT', key, bytes);
  if (put.status < 200 || put.status >= 300) {
    throw s3Failure('upload', put.status, put.text);
  }
  // S3 answers every successful PUT with an ETag. Its absence means something
  // between us and the bucket is not speaking S3 — accept the 200 and the
  // archive's presence becomes a guess.
  const etag = put.headers.get('etag');
  if (!etag) {
    throw new AppError('storage_error', 'S3 upload failed: the service answered 200 without an ETag.', {
      details: { reason: 's3_missing_etag' },
    });
  }
  log.info('backup uploaded to S3', { key, bytes: bytes.length });
  return { key, etag, bytes: bytes.length };
}

export interface S3ProbeStep {
  step: 'put' | 'head' | 'delete';
  ok: boolean;
  status?: number;
  etag?: string;
  error?: string;
  warning?: string;
}

export interface S3TestReport {
  ok: boolean;
  key?: string;
  error?: string;
  missing?: S3SettingField[];
  steps: S3ProbeStep[];
}

/**
 * Round-trip probe: PUT a small marker, HEAD it back, DELETE it. A diagnostic,
 * so it never throws for S3-side failures — it returns them. (And a failed
 * probe is deliberately *not* written to `error_log`: the Attention queue reads
 * that table as real backup failures, and a user pressing "test" is not one.)
 */
export async function testS3Connection(): Promise<S3TestReport> {
  const { resolved, missing } = readS3Config();
  if (!resolved) {
    return { ok: false, error: 'S3 backup destination is not configured.', missing, steps: [] };
  }

  const key = s3ObjectKey(resolved.prefix, `.hyperion-probe-${Date.now()}`);
  const probe = Buffer.from(`hyperion-s3-probe ${new Date().toISOString()}`, 'utf8');
  const steps: S3ProbeStep[] = [];

  try {
    const put = await s3Request(resolved, 'probe upload', 'PUT', key, probe);
    if (put.status < 200 || put.status >= 300) {
      steps.push({ step: 'put', ok: false, status: put.status, error: s3Failure('probe upload', put.status, put.text).message });
      return { ok: false, key, steps };
    }
    steps.push({ step: 'put', ok: true, status: put.status, etag: put.headers.get('etag') ?? undefined });
  } catch (error) {
    steps.push({ step: 'put', ok: false, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, key, steps };
  }

  try {
    const head = await s3Request(resolved, 'probe check', 'HEAD', key);
    const length = head.headers.get('content-length');
    if (head.status !== 200 || (length !== null && Number(length) !== probe.length)) {
      steps.push({
        step: 'head',
        ok: false,
        status: head.status,
        error:
          head.status !== 200
            ? `Probe object did not read back (HTTP ${head.status}).`
            : `Probe object came back the wrong size (expected ${probe.length} bytes, got ${length}).`,
      });
    } else {
      steps.push({ step: 'head', ok: true, status: head.status });
    }
  } catch (error) {
    steps.push({ step: 'head', ok: false, error: error instanceof Error ? error.message : String(error) });
  }

  try {
    const deleted = await s3Request(resolved, 'probe cleanup', 'DELETE', key);
    if (deleted.status < 200 || deleted.status >= 300) {
      steps.push({
        step: 'delete',
        ok: false,
        status: deleted.status,
        error: `Probe cleanup failed (HTTP ${deleted.status}).`,
        warning: `Probe object left behind at ${key}; remove it from the bucket.`,
      });
    } else {
      steps.push({ step: 'delete', ok: true, status: deleted.status });
    }
  } catch (error) {
    steps.push({
      step: 'delete',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      warning: `Probe object left behind at ${key}; remove it from the bucket.`,
    });
  }

  return { ok: steps.every((step) => step.ok), key, steps };
}

/**
 * The automatic run's S3 leg. Never throws: consults `enabled`, uploads when
 * configured, and degrades any failure to a warning plus an `error_log` row —
 * the Attention queue's backup-failure source reads that table, so a silently
 * skipped off-machine copy would be invisible nowhere else.
 */
export async function maybeUploadToS3(absPath: string, filename: string): Promise<string | null> {
  const { resolved } = readS3Config();
  if (!resolved || !resolved.enabled) return null;
  try {
    const uploaded = await uploadFileToS3(absPath, filename);
    return uploaded.key;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('automatic backup was not uploaded to S3', { filename, error: message });
    try {
      logError({
        timestamp: Date.now(),
        severity: 'error',
        endpoint: '/api/backup/destinations/s3',
        error_code: 'storage_error',
        error_message: `S3 upload of ${filename} failed: ${message}`,
        ...(error instanceof Error && error.stack !== undefined ? { stack_trace: error.stack } : {}),
      });
    } catch {
      // The warning above already carries it; error_log being unavailable
      // must not fail a backup that succeeded.
    }
    return null;
  }
}
