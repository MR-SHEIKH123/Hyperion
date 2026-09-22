import { openedProjectResponseSchema, projectResponseSchema, projectsResponseSchema, projectTasksResponseSchema } from '../contracts/wire/projects';
import { request } from './client';
export const getProjects=(signal?:AbortSignal)=>request('/api/projects',projectsResponseSchema,{...(signal===undefined?{}:{signal})});
export const createProject=(input:{name:string;path?:string},signal?:AbortSignal)=>request('/api/projects',projectResponseSchema,{method:'POST',body:input,...(signal===undefined?{}:{signal})});
export const openProject=(id:string,signal?:AbortSignal)=>request(`/api/projects/${encodeURIComponent(id)}/open`,openedProjectResponseSchema,{method:'POST',body:{},...(signal===undefined?{}:{signal})});
/**
 * What is still unfinished in a project, for the warning shown before switching
 * away from it (`docs/API.md` §15). The response carries `unattributedActive`
 * beside the project's own list, and the surface this is for is not built yet —
 * see `frontend/contracts/gaps.md`.
 */
export const getProjectTasks=(id:string,signal?:AbortSignal)=>request(`/api/projects/${encodeURIComponent(id)}/tasks`,projectTasksResponseSchema,{...(signal===undefined?{}:{signal})});
