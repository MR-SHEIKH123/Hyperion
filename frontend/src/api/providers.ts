import { activeModelsResponseSchema, activeProviderResponseSchema, providerResponseSchema, providersResponseSchema } from '../contracts/wire/providers';
import { request } from './client';
export const getProviders=(signal?:AbortSignal)=>request('/api/providers',providersResponseSchema,{...(signal===undefined?{}:{signal})});
export const getActiveProvider=(signal?:AbortSignal)=>request('/api/providers/active',activeProviderResponseSchema,{...(signal===undefined?{}:{signal})});
export const getActiveModels=(signal?:AbortSignal)=>request('/api/providers/active/models',activeModelsResponseSchema,{...(signal===undefined?{}:{signal})});
export const enableProvider=(id:string,signal?:AbortSignal)=>request(`/api/providers/${encodeURIComponent(id)}/enable`,providerResponseSchema,{method:'POST',...(signal===undefined?{}:{signal}),body:{}});
