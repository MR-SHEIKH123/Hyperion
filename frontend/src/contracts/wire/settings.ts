import { z } from 'zod';
const capabilitySchema = z.record(z.string(), z.boolean());
export const capabilitiesResponseSchema = z.object({ capabilities:capabilitySchema, effective:capabilitySchema, updated:z.array(z.string()).optional() }).passthrough();
export const preferencesResponseSchema = z.object({ preferences:z.string() }).passthrough();
export const limitsResponseSchema = z.object({
  ceilings:z.object({tokenCeiling:z.number().int().positive(),iterationCeiling:z.number().int().positive(),subagentLimit:z.number().int().positive()}).passthrough(),
  spend:z.object({capUsd:z.number().nullable(),spentUsd:z.number(),remainingUsd:z.number().nullable(),capReached:z.boolean(),unpricedRequestsToday:z.number().int().nonnegative(),windowResetsAt:z.number()}).passthrough(),
  updated:z.array(z.string()).optional(),
}).passthrough();

/**
 * Settings 2.5 slice 2 (Safety and limits) — the typed sub-resources whose
 * shapes the generic key/value routes cannot validate (docs/API.md §20).
 * Descriptive constants (`requiresCodeExecution`, `enforced`, `allowed`) are
 * on the GETs only, so they are optional here: a PUT response that omitted
 * them must not read as the constant having changed.
 */
export const networkEgressResponseSchema = z.object({
  enabled: z.boolean(),
  effective: z.boolean(),
  requiresCodeExecution: z.literal(true).optional(),
  enforced: z.literal('command_prefix_match').optional(),
}).passthrough();
export const redactionCheckResponseSchema = z.object({
  enabled: z.boolean(),
  appliesTo: z.literal('remote'),
  enforced: z.literal('pattern_match').optional(),
}).passthrough();
export const zdrPolicyResponseSchema = z.object({
  requirement: z.enum(['off', 'prefer', 'require']),
  allowed: z.array(z.enum(['off', 'prefer', 'require'])).optional(),
  appliesTo: z.literal('remote').optional(),
  enforced: z.literal('provider_selection').optional(),
}).passthrough();
export const toolAccessModeResponseSchema = z.object({
  mode: z.enum(['always_loaded', 'load_when_needed']),
}).passthrough();
/** One profile as `reload-config` lists it: `body` is omitted by the backend. */
export const reloadProfileSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  builtin: z.boolean().optional(),
  hidden: z.boolean().optional(),
}).passthrough();
export const reloadConfigResponseSchema = z.object({
  project: z.string(),
  settings: z.record(z.string(), z.string().nullable()),
  defaultAgentProfile: z.string().nullable(),
  permissions: z.record(z.string(), z.unknown()),
  profiles: z.array(reloadProfileSchema),
  validated: z.literal(true),
}).passthrough();

export type NetworkEgressWire = z.infer<typeof networkEgressResponseSchema>;
export type RedactionCheckWire = z.infer<typeof redactionCheckResponseSchema>;
export type ZdrPolicyWire = z.infer<typeof zdrPolicyResponseSchema>;
export type ToolAccessModeWire = z.infer<typeof toolAccessModeResponseSchema>['mode'];
export type LimitsWire = z.infer<typeof limitsResponseSchema>;
export type ReloadConfigWire = z.infer<typeof reloadConfigResponseSchema>;
