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
const summary = { activeProviderId:z.string().nullable(), activeProviderName:z.string().nullable(), providerCount:z.number().int().nonnegative(), hasAnyProvider:z.boolean() };
export const providersResponseSchema = z.object({ providers:z.array(providerSchema), ...summary }).passthrough();
export const activeModelsResponseSchema = z.object({ providerId:z.string(), providerName:z.string(), models:z.array(modelSchema) }).passthrough();
export const providerResponseSchema = z.object({ provider:providerSchema }).passthrough();
export const activeProviderResponseSchema = z.object({
  provider:providerSchema.nullable(), egress:z.enum(['local','remote','unknown']), redactionCheckEnabled:z.boolean(),
  zdr:z.object({ status:z.unknown().nullable(), requirement:z.unknown() }).passthrough().optional(),
}).passthrough();
export type ProviderWire = z.infer<typeof providerSchema>;
export type ModelWire = z.infer<typeof modelSchema>;
