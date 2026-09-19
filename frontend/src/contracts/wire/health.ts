import { z } from 'zod';

const statusSchema = z.enum(['ok', 'degraded', 'error']);
const componentBase = z.object({ status: statusSchema, detail: z.string() }).passthrough();

export const livenessSchema = z.object({
  ok: z.literal(true), name: z.string(), uptimeSec: z.number().nonnegative(), loopback: z.boolean(),
}).passthrough();

export const healthSummarySchema = z.object({
  status: statusSchema,
  checkedAt: z.number(),
  uptimeSec: z.number().nonnegative(),
  components: z.object({
    providers: componentBase.extend({
      total: z.number().int().nonnegative(),
      active: z.object({ id: z.string(), name: z.string(), health: z.enum(['unknown','healthy','degraded','unhealthy']) }).nullable(),
      failoverCandidates: z.number().int().nonnegative(), healthy: z.number().int().nonnegative(),
      degraded: z.number().int().nonnegative(), unhealthy: z.number().int().nonnegative(), unknown: z.number().int().nonnegative(),
    }),
    mcp: componentBase.extend({ managed: z.boolean(), total: z.number().int().nonnegative(), running: z.number().int().nonnegative(), errored: z.number().int().nonnegative() }),
    errors: componentBase.extend({ windowMs: z.number().positive(), count: z.number().int().nonnegative() }),
  }).passthrough(),
}).passthrough();
