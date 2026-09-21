import { z } from 'zod';

export const providerTypeSchema = z.enum(['remote', 'local', 'opencodex', 'colibri']);
export const providerSchema = z.object({
  id:z.string(), name:z.string(), type:providerTypeSchema, baseUrl:z.string(),
  hasKey:z.boolean(), apiKeyHint:z.string().nullable(), enabled:z.boolean(), priority:z.number(),
  healthStatus:z.enum(['unknown','healthy','degraded','unhealthy']),
  lastError:z.string().nullable(), lastErrorAt:z.number().nullable(), lastSuccessAt:z.number().nullable(),
  modelCount:z.number().int().nonnegative().nullable(), modelsFetchedAt:z.number().nullable(), modelsError:z.string().nullable(),
  createdAt:z.number(), updatedAt:z.number(),
}).passthrough();
export const modelSchema = z.object({ id:z.string(), label:z.string().optional(), ownedBy:z.string().optional(), contextLength:z.number().int().positive().optional() }).passthrough();
/**
 * Where a request is answered, and what the provider has been recorded as doing
 * with it (docs/API.md §6). The backend computes both and serves them; this
 * schema only refuses to guess at values it was not given.
 *
 * Enumerated rather than `z.unknown()`: a status this frontend does not know is
 * a status it cannot label honestly at the point of send, and silently
 * rendering it as a generic badge would put "we don't know this value" and
 * "this provider retains your data" in the same slot.
 */
export const egressClassSchema = z.enum(['local', 'remote', 'unknown']);
export const zdrStatusSchema = z.enum([
  'local_no_egress','zdr_confirmed','zdr_requested','zdr_not_applied','standard_retention','zdr_unknown','egress_unknown',
]);
export const zdrRequirementSchema = z.enum(['off', 'prefer', 'require']);
const summary = { activeProviderId:z.string().nullable(), activeProviderName:z.string().nullable(), providerCount:z.number().int().nonnegative(), hasAnyProvider:z.boolean() };
export const providersResponseSchema = z.object({ providers:z.array(providerSchema), ...summary }).passthrough();
export const activeModelsResponseSchema = z.object({ providerId:z.string(), providerName:z.string(), models:z.array(modelSchema) }).passthrough();
export const providerResponseSchema = z.object({ provider:providerSchema }).passthrough();
export const activeProviderResponseSchema = z.object({
  provider:providerSchema.nullable(), egress:egressClassSchema, redactionCheckEnabled:z.boolean(),
  // Required, not `.optional()`: the route always sends it, and a frontend that
  // treated a missing retention story as an absent one would render no badge
  // where the honest answer is "nothing has been recorded".
  zdr:z.object({ status:zdrStatusSchema.nullable(), requirement:zdrRequirementSchema }).passthrough(),
}).passthrough();
export type ProviderWire = z.infer<typeof providerSchema>;
export type ModelWire = z.infer<typeof modelSchema>;
export type EgressClassWire = z.infer<typeof egressClassSchema>;
export type ZdrStatusWire = z.infer<typeof zdrStatusSchema>;
export type ZdrRequirementWire = z.infer<typeof zdrRequirementSchema>;
