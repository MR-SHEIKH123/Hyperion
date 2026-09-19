import { capabilitiesResponseSchema, limitsResponseSchema, preferencesResponseSchema } from '../contracts/wire/settings';
import { request } from './client';
export const getCapabilities=(signal?:AbortSignal)=>request('/api/settings/capabilities',capabilitiesResponseSchema,{...(signal===undefined?{}:{signal})});
export const getPreferences=(signal?:AbortSignal)=>request('/api/settings/preferences',preferencesResponseSchema,{...(signal===undefined?{}:{signal})});
export const getLimits=(signal?:AbortSignal)=>request('/api/settings/limits',limitsResponseSchema,{...(signal===undefined?{}:{signal})});
