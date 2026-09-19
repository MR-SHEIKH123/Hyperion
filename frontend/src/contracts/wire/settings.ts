import { z } from 'zod';
const capabilitySchema = z.record(z.string(), z.boolean());
export const capabilitiesResponseSchema = z.object({ capabilities:capabilitySchema, effective:capabilitySchema, updated:z.array(z.string()).optional() }).passthrough();
export const preferencesResponseSchema = z.object({ preferences:z.string() }).passthrough();
export const limitsResponseSchema = z.object({
  ceilings:z.object({tokenCeiling:z.number().int().positive(),iterationCeiling:z.number().int().positive(),subagentLimit:z.number().int().positive()}).passthrough(),
  spend:z.object({capUsd:z.number().nullable(),spentUsd:z.number(),remainingUsd:z.number().nullable(),capReached:z.boolean(),unpricedRequestsToday:z.number().int().nonnegative(),windowResetsAt:z.number()}).passthrough(),
  updated:z.array(z.string()).optional(),
}).passthrough();
