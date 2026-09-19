import { taskStateResponseSchema, type taskToolSchema } from '../contracts/wire/tasks';
import { request } from './client';
import type { z } from 'zod';
type TaskTool=z.infer<typeof taskToolSchema>;
export const getTaskState=(tool:TaskTool,taskId:string,signal?:AbortSignal)=>request(`/api/${tool}/tasks/${encodeURIComponent(taskId)}/state`,taskStateResponseSchema,{...(signal===undefined?{}:{signal})});
