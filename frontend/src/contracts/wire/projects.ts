import { z } from 'zod';
export const projectSchema = z.object({
  id:z.string(), name:z.string(), path:z.string(), managed:z.boolean(),
  createdAt:z.number(), updatedAt:z.number(), lastOpenedAt:z.number().nullable(),
}).passthrough();
export const projectsResponseSchema = z.object({ projects:z.array(projectSchema), activeId:z.string().nullable(), activeRoot:z.string(), defaultRoot:z.string() }).passthrough();
export const projectResponseSchema = z.object({ project:projectSchema }).passthrough();
export const openedProjectResponseSchema = z.object({ project:projectSchema, activeRoot:z.string() }).passthrough();
