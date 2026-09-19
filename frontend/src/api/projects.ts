import { openedProjectResponseSchema, projectResponseSchema, projectsResponseSchema } from '../contracts/wire/projects';
import { request } from './client';
export const getProjects=(signal?:AbortSignal)=>request('/api/projects',projectsResponseSchema,{...(signal===undefined?{}:{signal})});
export const createProject=(input:{name:string;path?:string},signal?:AbortSignal)=>request('/api/projects',projectResponseSchema,{method:'POST',body:input,...(signal===undefined?{}:{signal})});
export const openProject=(id:string,signal?:AbortSignal)=>request(`/api/projects/${encodeURIComponent(id)}/open`,openedProjectResponseSchema,{method:'POST',body:{},...(signal===undefined?{}:{signal})});
