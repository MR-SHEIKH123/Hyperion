import { z } from 'zod';
import { taskRunStateSchema, taskToolSchema } from './tasks';
/**
 * A project, as `GET /api/projects` and its siblings return it.
 *
 * `updatedAt` used to be required here and the backend has never sent it: the
 * response is `{id, name, path, managed, createdAt, lastOpenedAt}`, so the
 * requirement made every project response fail as `invalid_response`. Nothing
 * called this module, so nothing noticed — the pair is fixed together on
 * 2026-09-22, with `projects.test.ts` beside it parsing the shapes the routes
 * actually return.
 */
export const projectSchema = z.object({
  id:z.string(), name:z.string(), path:z.string(), managed:z.boolean(),
  createdAt:z.number(), lastOpenedAt:z.number().nullable(),
}).passthrough();
export const projectsResponseSchema = z.object({ projects:z.array(projectSchema), activeId:z.string().nullable(), activeRoot:z.string(), defaultRoot:z.string() }).passthrough();
export const projectResponseSchema = z.object({ project:projectSchema }).passthrough();
export const openedProjectResponseSchema = z.object({ project:projectSchema, activeRoot:z.string() }).passthrough();
/**
 * One unfinished task in a project (`GET /api/projects/:id/tasks`, docs/API.md §15).
 *
 * The state comes from `taskRunStateSchema` rather than a second enum: this is the
 * same run state the per-task state route reports, and two spellings of it would be
 * two things to keep in step. `runId` is the run to watch — the listing reports the
 * latest run per `(tool, taskId)`, not every attempt.
 */
export const projectTaskSchema = z.object({
  tool:taskToolSchema, taskId:z.string(), runId:z.string(), state:taskRunStateSchema,
  pauseReason:z.string().nullable(), chatId:z.string().nullable(),
  startedAt:z.number(), updatedAt:z.number(),
}).passthrough();
/**
 * `unattributedActive` is required, not optional, and it is the point of the shape.
 *
 * It counts the active runs that name **no** project — started with nothing open, or
 * written before migration `027` — which are deliberately not folded into whichever
 * project is open. A client that rendered only `tasks` would be presenting a partial
 * answer as the whole one, so a response that omitted the count would fail to parse
 * here rather than read as zero.
 *
 * `counts` carries every state key at zero, so a branch on `counts.blocked` never has
 * to tell "none" from "not said".
 */
export const projectTasksResponseSchema = z.object({
  project:projectSchema, active:z.boolean(), tasks:z.array(projectTaskSchema),
  counts:z.object({ total:z.number().int().nonnegative(), running:z.number().int().nonnegative(), paused:z.number().int().nonnegative(), blocked:z.number().int().nonnegative(), ready_for_review:z.number().int().nonnegative() }).passthrough(),
  unattributedActive:z.number().int().nonnegative(),
}).passthrough();
export type ProjectTask = z.infer<typeof projectTaskSchema>;
export type ProjectTasks = z.infer<typeof projectTasksResponseSchema>;
