import {
  capabilitiesResponseSchema,
  limitsResponseSchema,
  networkEgressResponseSchema,
  preferencesResponseSchema,
  redactionCheckResponseSchema,
  reloadConfigResponseSchema,
  toolAccessModeResponseSchema,
  zdrPolicyResponseSchema,
  type ToolAccessModeWire,
} from '../contracts/wire/settings';
import type { ZdrRequirementWire } from '../contracts/wire/providers';
import { request } from './client';

/**
 * Settings — the typed sub-resources (docs/API.md §11, §20).
 *
 * The generic key/value routes are deliberately not used here: each control
 * below has a shape the untyped writer cannot validate (a closed enum, a
 * positive integer, a boolean with a derived `effective`), and the typed
 * route is the one that refuses a typo instead of storing it. Write
 * responses are subsets of the reads (the descriptive constants live on the
 * GETs only), so callers merge rather than replace what they display.
 */

export const getCapabilities = (signal?: AbortSignal) =>
  request('/api/settings/capabilities', capabilitiesResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export const getPreferences = (signal?: AbortSignal) =>
  request('/api/settings/preferences', preferencesResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export const getLimits = (signal?: AbortSignal) =>
  request('/api/settings/limits', limitsResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export interface UpdateLimitsInput {
  /** 0 clears the cap; omit to leave it unchanged. */
  dailySpendCapUsd?: number;
  tokenCeiling?: number;
  iterationCeiling?: number;
  subagentLimit?: number;
}

export const updateLimits = (input: UpdateLimitsInput, signal?: AbortSignal) =>
  request('/api/settings/limits', limitsResponseSchema, {
    method: 'PUT',
    body: input,
    ...(signal === undefined ? {} : { signal }),
  });

export const getNetworkEgress = (signal?: AbortSignal) =>
  request('/api/settings/network-egress', networkEgressResponseSchema, {
    ...(signal === undefined ? {} : { signal }),
  });

export const setNetworkEgress = (enabled: boolean, signal?: AbortSignal) =>
  request('/api/settings/network-egress', networkEgressResponseSchema, {
    method: 'PUT',
    body: { enabled },
    ...(signal === undefined ? {} : { signal }),
  });

export const getRedactionCheck = (signal?: AbortSignal) =>
  request('/api/settings/redaction-check', redactionCheckResponseSchema, {
    ...(signal === undefined ? {} : { signal }),
  });

export const setRedactionCheck = (enabled: boolean, signal?: AbortSignal) =>
  request('/api/settings/redaction-check', redactionCheckResponseSchema, {
    method: 'PUT',
    body: { enabled },
    ...(signal === undefined ? {} : { signal }),
  });

export const getZdrPolicy = (signal?: AbortSignal) =>
  request('/api/settings/zdr', zdrPolicyResponseSchema, { ...(signal === undefined ? {} : { signal }) });

export const setZdrRequirement = (requirement: ZdrRequirementWire, signal?: AbortSignal) =>
  request('/api/settings/zdr', zdrPolicyResponseSchema, {
    method: 'PUT',
    body: { requirement },
    ...(signal === undefined ? {} : { signal }),
  });

export const getToolAccessMode = (signal?: AbortSignal) =>
  request('/api/settings/tool-access-mode', toolAccessModeResponseSchema, {
    ...(signal === undefined ? {} : { signal }),
  });

export const setToolAccessMode = (mode: ToolAccessModeWire, signal?: AbortSignal) =>
  request('/api/settings/tool-access-mode', toolAccessModeResponseSchema, {
    method: 'PUT',
    body: { mode },
    ...(signal === undefined ? {} : { signal }),
  });

/**
 * Re-read and validate the on-disk configuration. Adds no cache — settings
 * are un-cached and project files are read per task — so a success means
 * "the files parse", and a refusal names the file that does not.
 */
export const reloadConfig = (project?: string, signal?: AbortSignal) =>
  request('/api/settings/reload-config', reloadConfigResponseSchema, {
    method: 'POST',
    body: project === undefined || project === '' ? {} : { project },
    ...(signal === undefined ? {} : { signal }),
  });
