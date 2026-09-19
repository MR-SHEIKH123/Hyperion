import { z } from 'zod';

export const errorCodeSchema = z.enum([
  'bad_request', 'not_found', 'conflict', 'no_active_provider', 'no_provider_for_model',
  'provider_unreachable', 'provider_error', 'provider_auth_failed', 'provider_timeout',
  'no_healthy_provider', 'local_provider_not_detected', 'busy', 'run_not_paused',
  'run_not_found', 'aborted', 'agent_not_registered', 'terminal_not_registered',
  'capability_disabled', 'network_egress_disabled', 'spending_cap_reached',
  'redaction_flagged', 'scope_violation', 'encryption_failed', 'storage_error', 'internal_error',
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
}).passthrough();

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
