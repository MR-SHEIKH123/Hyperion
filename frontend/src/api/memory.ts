import {
  memoryClearedResponseSchema,
  memoryDeletedResponseSchema,
  memoryImportResponseSchema,
  memoryListResponseSchema,
  memoryStatusResponseSchema,
  memoryStoredResponseSchema,
} from '../contracts/wire/memory';
import { parseResponse, request } from './client';
import { networkError } from './errors';

/**
 * Memory — the Settings 2.5 slice-3a client (src/http/memory.ts).
 *
 * One route does not fit `request()`: the folder import is a multipart
 * upload, so it is fetched here directly and its answer held to the same
 * wire schema and the same error envelope as every JSON call. Memory text
 * is content, not a credential — but it is still never put in an error
 * message or a log by this module; failures quote the backend's refusal
 * only.
 */

export const getMemoryStatus = (signal?: AbortSignal) =>
  request('/api/memory/status', memoryStatusResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export const enableMemory = (signal?: AbortSignal) =>
  request('/api/memory/enable', memoryStatusResponseSchema, {
    method: 'POST',
    body: {},
    ...(signal === undefined ? {} : { signal }),
  });

export const disableMemory = (signal?: AbortSignal) =>
  request('/api/memory/disable', memoryStatusResponseSchema, {
    method: 'POST',
    body: {},
    ...(signal === undefined ? {} : { signal }),
  });

export const getMemories = (limit = 200, signal?: AbortSignal) =>
  request(`/api/memory?limit=${limit}`, memoryListResponseSchema, {
    ...(signal === undefined ? {} : { signal }),
  });

export const addMemory = (text: string, signal?: AbortSignal) =>
  request('/api/memory', memoryStoredResponseSchema, {
    method: 'POST',
    body: { text },
    ...(signal === undefined ? {} : { signal }),
  });

export const importMemoryText = (text: string, signal?: AbortSignal) =>
  request('/api/memory/import', memoryImportResponseSchema, {
    method: 'POST',
    body: { text },
    ...(signal === undefined ? {} : { signal }),
  });


/** Folder import: up to 50 files, one `files` part each, as the route takes them. */
export async function importMemoryFiles(files: readonly File[], signal?: AbortSignal) {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  let response: Response;
  try {
    response = await fetch('/api/memory/import', {
      method: 'POST',
      body: form,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw networkError(error);
  }
  return parseResponse(response, memoryImportResponseSchema);
}

export const deleteMemory = (id: string, signal?: AbortSignal) =>
  request(`/api/memory/${encodeURIComponent(id)}`, memoryDeletedResponseSchema, {
    method: 'DELETE',
    ...(signal === undefined ? {} : { signal }),
  });

export const clearMemories = (signal?: AbortSignal) =>
  request('/api/memory', memoryClearedResponseSchema, {
    method: 'DELETE',
    ...(signal === undefined ? {} : { signal }),
  });
