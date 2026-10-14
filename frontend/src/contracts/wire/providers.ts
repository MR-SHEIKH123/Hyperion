import { z } from 'zod';

export const providerTypeSchema = z.enum(['remote', 'local', 'opencodex', 'colibri', 'puter']);
export const zdrSupportSchema = z.enum([
  'unknown', 'supported_default', 'supported_opt_in', 'not_supported', 'not_applicable',
]);
/**
 * Per-provider zero-data-retention facts, exactly as `toPublic` serves them
 * (docs/API.md §3.1). Required on every provider read: the settings surface
 * edits this record, and a schema that let it be absent would render "nothing
 * recorded" for a payload that simply did not say. `requestFlag.value` is a
 * policy declaration the backend returns in plaintext (never a credential —
 * the write path refuses credential-shaped values), so it is modelled here.
 */
export const providerZdrSchema = z.object({
  support: zdrSupportSchema,
  requestFlag: z.object({
    location: z.enum(['header', 'body']),
    key: z.string(),
    value: z.string(),
  }).passthrough().nullable(),
  confirmedAt: z.number().nullable(),
  confirmedNote: z.string().nullable(),
}).passthrough();
export const providerSchema = z.object({
  id:z.string(), name:z.string(), type:providerTypeSchema, baseUrl:z.string(),
  hasKey:z.boolean(), apiKeyHint:z.string().nullable(), enabled:z.boolean(), priority:z.number(),
  healthStatus:z.enum(['unknown','healthy','degraded','unhealthy']),
  lastError:z.string().nullable(), lastErrorAt:z.number().nullable(), lastSuccessAt:z.number().nullable(),
  modelCount:z.number().int().nonnegative().nullable(), modelsFetchedAt:z.number().nullable(), modelsError:z.string().nullable(),
  /**
   * The provider's declared context ceiling (1.28), or null for none.
   *
   * Declared here rather than left to `passthrough()` so it is a *contract*: the
   * backend serves it on every provider read, and a settings screen that could
   * not see it could not edit it. Nothing renders it yet — the settings surface
   * is still missing, which `frontend/contracts/gaps.md` records.
   */
  maxContextTokens:z.number().int().positive().nullable(),
  /**
   * The cooldown this provider is serving (1.36), or null when it is not cooling.
   *
   * Enumerated fields rather than `z.unknown()`: the class decides what the user
   * is told to fix (a rejected key and an exhausted balance are both refusals, and
   * the fix is not the same), and `until` is a deadline a countdown can be built on
   * — a length would keep counting after the wait was over. Required-and-nullable
   * because every provider read sends it: a frontend that treated a missing field
   * as "not cooling" would render the state it most needs to disclose as its
   * absence.
   */
  cooldown:z.object({
    until:z.number(),
    failureClass:z.enum(['auth','payment','rate_limit','not_found','server','network']),
    source:z.enum(['table','retry_after']),
    reason:z.string(),
  }).nullable(),
  /**
   * The egress proxy as a read may disclose it: the redacted string
   * (`user:***@host:port` at most), or null. Not the structured object the
   * `/active` route serves — on a provider read the only consumer is the
   * disclosure, and a structure would invite reconstructing the dial URL.
   */
  egressProxy:z.string().nullable(),
  zdr:providerZdrSchema,
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
/**
 * The proxy a provider's traffic is tunnelled through (Part 1.37).
 *
 * Required-and-nullable rather than optional, and structured rather than a bare
 * string: the disclosure has to be able to say *both* "through a proxy" and
 * "through a proxy that is not on this machine", and the second is what changes
 * what the egress class means. `redacted` is the only URL form the backend sends.
 */
export const egressProxySchema = z.object({
  redacted:z.string(), authority:z.string(), scheme:z.enum(['http','https']),
  hasCredentials:z.boolean(), offMachine:z.boolean(),
}).passthrough();
export const activeProviderResponseSchema = z.object({
  provider:providerSchema.nullable(), egress:egressClassSchema, redactionCheckEnabled:z.boolean(),
  egressProxy:egressProxySchema.nullable(),
  // Required, not `.optional()`: the route always sends it, and a frontend that
  // treated a missing retention story as an absent one would render no badge
  // where the honest answer is "nothing has been recorded".
  zdr:z.object({ status:zdrStatusSchema.nullable(), requirement:zdrRequirementSchema }).passthrough(),
}).passthrough();
/**
 * Enable/disable answers: the provider plus the registry summary the backend
 * spreads in (docs/API.md §3.2). The summary is what reports which provider
 * is active after the change — enabling demotes the previous one to standby.
 */
export const providerEnabledResponseSchema = z.object({
  provider:providerSchema,
  activeProviderId:z.string().nullable(), activeProviderName:z.string().nullable(),
  providerCount:z.number().int().nonnegative(), hasAnyProvider:z.boolean(),
}).passthrough();
export const providerModelsResponseSchema = z.object({
  providerId:z.string(), models:z.array(modelSchema),
}).passthrough();
/** Bare answer of POST /:id/test — informational, never a gate on saving. */
export const connectionTestSchema = z.object({
  ok:z.boolean(), message:z.string(),
  modelCount:z.number().int().nonnegative().optional(), code:z.string().optional(),
}).passthrough();
/** Bare answer of POST /detect-local: 200 even when nothing was detected. */
export const localDetectionSchema = z.object({
  detected:z.boolean(), baseUrl:z.string(), models:z.array(modelSchema),
  attempts:z.number().int().nonnegative(), reason:z.string().optional(),
  providerId:z.string().optional(),
}).passthrough();
export const colibriProbeSchema = z.object({
  detected:z.boolean(), baseUrl:z.string(), models:z.array(modelSchema),
  reason:z.string().optional(), defaultBaseUrl:z.string(),
}).passthrough();
export const puterAdvisorySchema = z.object({
  type:z.literal('puter'), defaultBaseUrl:z.string(), credential:z.literal('auth_token'),
  egress:z.literal('remote'), catalogueUrl:z.string(), requiresPaidPlan:z.literal(true),
  note:z.string(),
}).passthrough();
export const colibriAdvisorySchema = z.object({
  type:z.literal('colibri'), defaultBaseUrl:z.string(), caveat:z.string(),
  acknowledgementRequired:z.literal(true), acknowledgementField:z.literal('acknowledgeSlow'),
}).passthrough();
export type ProviderWire = z.infer<typeof providerSchema>;
export type ProviderZdrWire = z.infer<typeof providerZdrSchema>;
export type ZdrSupportWire = z.infer<typeof zdrSupportSchema>;
export type PuterAdvisoryWire = z.infer<typeof puterAdvisorySchema>;
export type ColibriAdvisoryWire = z.infer<typeof colibriAdvisorySchema>;
export type LocalDetectionWire = z.infer<typeof localDetectionSchema>;
export type ConnectionTestWire = z.infer<typeof connectionTestSchema>;
export type ProviderCooldownWire = NonNullable<ProviderWire['cooldown']>;
export type ModelWire = z.infer<typeof modelSchema>;
export type EgressClassWire = z.infer<typeof egressClassSchema>;
export type EgressProxyWire = z.infer<typeof egressProxySchema>;
export type ZdrStatusWire = z.infer<typeof zdrStatusSchema>;
export type ZdrRequirementWire = z.infer<typeof zdrRequirementSchema>;
