import {
  agentProfilesResponseSchema,
  agentsSettingsPutResponseSchema,
  agentsSettingsResponseSchema,
  permissionsResponseSchema,
  profileImportResponseSchema,
  projectAgentsResponseSchema,
  projectCommandsResponseSchema,
  rulesResponseSchema,
  type ProfileImportWire,
} from '../contracts/wire/agents';
import { request } from './client';
import { ApiError, networkError, responseError } from './errors';
import type { z } from 'zod';

/**
 * Agent profiles, the default profile, profile import, and the read-only
 * permission layers (Settings 2.5, slice 4), read against
 * `src/http/settings.ts` and `src/http/agents.ts`.
 *
 * The import is the only multipart call: the rest are JSON. The sections
 * that use this client are read-only beyond the default-profile setting
 * and the import itself — permission rules live in project files, and no
 * function here pretends otherwise.
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

/** Hidden profiles are included: hidden is a listing concern, and an editor that cannot see one cannot un-hide it. */
export const getAgentProfiles = (signal?: AbortSignal) =>
  request('/api/settings/agent-profiles?includeHidden=true', agentProfilesResponseSchema, {
    ...(signal === undefined ? {} : { signal }),
  });

export const getAgentsSettings = (signal?: AbortSignal) =>
  request('/api/settings/agents', agentsSettingsResponseSchema, { ...(signal === undefined ? {} : { signal }) });

/**
 * Sets the stored default. Clearing is spelled `''` by the route
 * (`asClearableString` requires a string), so a null name is sent as an
 * empty string; each mode then resolves to its own built-in.
 */
export const setDefaultAgentProfile = (name: string | null, signal?: AbortSignal) =>
  request('/api/settings/agents', agentsSettingsPutResponseSchema, {
    method: 'PUT',
    body: { defaultAgentProfile: name ?? '' },
    ...(signal === undefined ? {} : { signal }),
  });

export type ImportConflictPolicy = 'skip' | 'rename' | 'overwrite';

/**
 * Files `.md` profiles into the active project's `.hyperion/agents/`.
 * `confirm` is sent only alongside `overwrite` and only after the UI's
 * own confirmation — the route refuses the whole batch without it. A
 * 409 (`no_active_project`) is the honest "open a project first" state
 * and arrives as the shared error envelope.
 */
export async function importAgentProfiles(
  files: readonly File[],
  options: { onConflict: ImportConflictPolicy; confirm?: boolean },
  signal?: AbortSignal,
): Promise<ProfileImportWire> {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  form.append('onConflict', options.onConflict);
  if (options.onConflict === 'overwrite' && options.confirm === true) form.append('confirm', 'true');
  let response: Response;
  try {
    response = await fetch('/api/code/agents/import', {
      method: 'POST',
      body: form,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw networkError(error);
  }
  return parseWith(response, profileImportResponseSchema);
}

export const getPermissions = (options: { mode?: string; profile?: string } = {}, signal?: AbortSignal) => {
  const params = new URLSearchParams();
  if (options.mode !== undefined) params.set('mode', options.mode);
  if (options.profile !== undefined && options.profile !== '') params.set('profile', options.profile);
  const query = params.toString();
  return request(`/api/code/permissions${query === '' ? '' : `?${query}`}`, permissionsResponseSchema, {
    ...(signal === undefined ? {} : { signal }),
  });
};

export const getProjectRules = (signal?: AbortSignal) =>
  request('/api/code/rules', rulesResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export const getProjectAgents = (signal?: AbortSignal) =>
  request('/api/code/agents', projectAgentsResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export const getProjectCommands = (signal?: AbortSignal) =>
  request('/api/code/commands', projectCommandsResponseSchema, { ...(signal === undefined ? {} : { signal }) });
