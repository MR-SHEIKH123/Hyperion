import { z } from 'zod';
export const taskToolSchema = z.enum(['code','cowork','design']);
export const taskRunStateSchema = z.enum(['running','paused','blocked','ready_for_review','complete','error','stopped','interrupted']);
export const taskStateResponseSchema = z.object({ run:z.object({
  runId:z.string(), taskId:z.string(), tool:taskToolSchema, state:taskRunStateSchema,
  pauseReason:z.string().nullable(), errorCode:z.string().nullable(), errorMessage:z.string().nullable(),
  startedAt:z.number(), updatedAt:z.number(), completedAt:z.number().nullable(),
}).passthrough() }).passthrough();
