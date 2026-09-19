import { healthSummarySchema, livenessSchema } from '../contracts/wire/health';
import { request } from './client';
export const getLiveness = (signal?:AbortSignal) => request('/api/health',livenessSchema,{...(signal===undefined?{}:{signal})});
export const getHealthSummary = (signal?:AbortSignal) => request('/api/health/summary',healthSummarySchema,{...(signal===undefined?{}:{signal})});
