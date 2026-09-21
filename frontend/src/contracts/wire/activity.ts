import { z } from 'zod';
const linkSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('chat'),chatId:z.string()}),
  z.object({kind:z.literal('artifact'),key:z.string(),version:z.number().int().positive()}),
]);
export const activityEntrySchema = z.object({
  id:z.string(), kind:z.enum(['task','scheduled-task','subagent']), timestamp:z.number(),
  status:z.enum(['running','paused','success','failed','stopped','interrupted','skipped']), title:z.string(), detail:z.string().nullable(), link:linkSchema.nullable(),
}).passthrough();
export const activityPageSchema = z.object({ entries:z.array(activityEntrySchema), nextBefore:z.number().nullable() }).passthrough();
