import {
  backupDestinationsResponseSchema,
  backupListResponseSchema,
  inspectResponseSchema,
  restoreAuditResponseSchema,
  restoreResultSchema,
  s3ConfigResponseSchema,
  s3TestResponseSchema,
  type ArchiveInspectionWire,
  type RestoreResultWire,
} from '../contracts/wire/backup';
import { request } from './client';
import { ApiError, networkError, responseError } from './errors';
import type { z } from 'zod';

/**
 * Backup, restore, and S3 destination — the Settings 2.5 slice-3b client
 * (src/http/backup.ts).
 *
 * Two answers here are not JSON at all: the exports stream the archive
 * binary, so they are fetched directly and only the failure envelope is
 * parsed. The passphrase and the S3 secret follow the standing secret
 * rules: component state only, sent in a body (JSON for export, a
 * multipart field for inspect/restore — never a URL), cleared by the
 * caller after use, and never quoted into an error: failures quote the
 * backend's refusal envelope or a fixed local string.
 */

async function parseWith<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError('Hyperion returned an unreadable response.', 'invalid_response', response.status, false);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(
      'Hyperion returned a response that does not match this frontend version.',
      'invalid_response',
      response.status,
      false,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

/* --- exports (binary) ---------------------------------------------------- */

export interface ExportBackupOptions {
  includeKeys: boolean;
  includeAttachments: boolean;
  /** Write-only. Empty or omitted exports a plain archive. */
  passphrase?: string;
  /** Also upload the finished archive to the configured S3 destination. */
  uploadToS3?: boolean;
}

export interface ExportOutcome {
  filename: string;
  bytes: number;
  /** The object key when the archive was also uploaded to S3, else null. */
  s3Key: string | null;
}

/** Filename from Content-Disposition, falling back to the backend's own convention. */
function downloadFilename(response: Response): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  return match?.[1] ?? 'hyperion-backup.zip';
}

/**
 * Builds an archive via `POST /api/backup/export` and hands the bytes to
 * the browser as a download. An `uploadToS3` failure refuses the download
 * (the route's message names the locally saved archive), which is why the
 * error envelope is read before the blob is touched.
 */
export async function exportBackupToDownload(
  options: ExportBackupOptions,
  signal?: AbortSignal,
): Promise<ExportOutcome> {
  let response: Response;
  try {
    response = await fetch('/api/backup/export', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        includeKeys: options.includeKeys,
        includeAttachments: options.includeAttachments,
        ...(options.passphrase !== undefined && options.passphrase !== ''
          ? { passphrase: options.passphrase }
          : {}),
        ...(options.uploadToS3 === true ? { uploadToS3: true } : {}),
      }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok) throw await responseError(response);
  const blob = await response.blob();
  const filename = downloadFilename(response);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick: revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { filename, bytes: blob.size, s3Key: response.headers.get('x-hyperion-s3-key') };
}

/* --- JSON surface ---------------------------------------------------------- */

export const listBackups = (signal?: AbortSignal) =>
  request('/api/backup', backupListResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export const getBackupDestinations = (signal?: AbortSignal) =>
  request('/api/backup/destinations', backupDestinationsResponseSchema, {
    ...(signal === undefined ? {} : { signal }),
  });

/** Partial update: omitted fields are untouched; '' or null clears a field. The secret is write-only. */
export const saveS3Config = (patch: Record<string, string | boolean | null>, signal?: AbortSignal) =>
  request('/api/backup/destinations/s3', s3ConfigResponseSchema, {
    method: 'PUT',
    body: patch,
    ...(signal === undefined ? {} : { signal }),
  });

export const testS3Destination = (signal?: AbortSignal) =>
  request('/api/backup/destinations/s3/test', s3TestResponseSchema, {
    method: 'POST',
    body: {},
    ...(signal === undefined ? {} : { signal }),
  });

export const listRestores = (signal?: AbortSignal) =>
  request('/api/backup/restores', restoreAuditResponseSchema, { ...(signal === undefined ? {} : { signal }) });

/* --- inspect and restore ----------------------------------------------------- */

export type ArchiveSource = { file: File } | { filename: string };

function archiveForm(source: ArchiveSource, passphrase?: string): FormData | null {
  if (!('file' in source)) return null;
  const form = new FormData();
  form.append('file', source.file, source.file.name);
  if (passphrase !== undefined && passphrase !== '') form.append('passphrase', passphrase);
  return form;
}

async function postArchive<T>(
  path: string,
  source: ArchiveSource,
  fields: Record<string, string>,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const form = archiveForm(source, fields['passphrase']);
  if (form === null) {
    const body: Record<string, unknown> = { file: (source as { filename: string }).filename };
    for (const [key, value] of Object.entries(fields)) {
      body[key] = key === 'dryRun' || key === 'includeAttachments' ? value === 'true' : value;
    }
    return request(path, schema, { method: 'POST', body, ...(signal === undefined ? {} : { signal }) });
  }
  for (const [key, value] of Object.entries(fields)) {
    if (key !== 'passphrase') form.append(key, value);
  }
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', body: form, ...(signal === undefined ? {} : { signal }) });
  } catch (error) {
    throw networkError(error);
  }
  return parseWith(response, schema);
}

export async function inspectArchive(
  source: ArchiveSource,
  passphrase?: string,
  signal?: AbortSignal,
): Promise<ArchiveInspectionWire> {
  const result = await postArchive(
    '/api/backup/inspect',
    source,
    passphrase === undefined || passphrase === '' ? {} : { passphrase },
    inspectResponseSchema,
    signal,
  );
  return result.inspection;
}

export function restoreArchive(
  source: ArchiveSource,
  options: { dryRun: boolean; includeAttachments: boolean; passphrase?: string },
  signal?: AbortSignal,
): Promise<RestoreResultWire> {
  return postArchive(
    '/api/backup/import',
    source,
    {
      dryRun: String(options.dryRun),
      includeAttachments: String(options.includeAttachments),
      ...(options.passphrase === undefined || options.passphrase === '' ? {} : { passphrase: options.passphrase }),
    },
    restoreResultSchema,
    signal,
  );
}
