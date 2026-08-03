/**
 * Typed application errors.
 *
 * Every error that can reach the frontend carries a stable machine-readable
 * `code`. Sol's UI branches on the code, never on the HTTP status or on message
 * text — status codes are too coarse to distinguish "the provider is down" from
 * "the provider does not offer that model", and message strings change.
 */

export type ErrorCode =
  // request/validation
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  // providers
  | 'no_active_provider'
  | 'no_provider_for_model'
  | 'provider_unreachable'
  | 'provider_error'
  | 'provider_auth_failed'
  | 'provider_timeout'
  | 'no_healthy_provider'
  | 'local_provider_not_detected'
  // orchestration
  | 'busy'
  | 'run_not_paused'
  | 'run_not_found'
  | 'aborted'
  // agents
  | 'agent_not_registered'
  | 'terminal_not_registered'
  // security / storage
  | 'scope_violation'
  | 'encryption_failed'
  | 'storage_error'
  | 'internal_error';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,

  no_active_provider: 409,
  no_provider_for_model: 409,
  provider_unreachable: 502,
  provider_error: 502,
  provider_auth_failed: 401,
  provider_timeout: 504,
  no_healthy_provider: 503,
  local_provider_not_detected: 404,

  busy: 409,
  run_not_paused: 409,
  run_not_found: 404,
  aborted: 499,

  agent_not_registered: 501,
  terminal_not_registered: 501,

  scope_violation: 403,
  encryption_failed: 500,
  storage_error: 500,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  /**
   * Diagnostic context that must never cross the wire.
   *
   * `details` is serialized to the browser, so anything placed there is public.
   * Some context is worth keeping but not worth exposing — chiefly a provider's
   * raw error body, which frequently echoes the API key it was sent. SPEC line
   * 68 requires that a provider key never reach the frontend, even transiently,
   * so that material goes here instead: logged server-side, omitted by
   * `toJSON()`.
   */
  readonly privateDetails: Record<string, unknown> | undefined;
  /**
   * Whether trying the exact same request again could plausibly succeed.
   * Drives the pause/resume machine: a capability mismatch is never retryable
   * against the same provider, while a timeout is.
   */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      details?: Record<string, unknown>;
      privateDetails?: Record<string, unknown>;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code] ?? 500;
    this.details = options.details;
    this.privateDetails = options.privateDetails;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(code);
  }

  /**
   * Shape sent to the frontend.
   *
   * Only `details` is included. `privateDetails` is withheld by design — it is
   * where credentials-adjacent diagnostic context lives, so adding it here
   * would defeat the reason it exists.
   */
  toJSON(): { error: { code: ErrorCode; message: string; retryable: boolean; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/** Failures that a plain retry might resolve. */
const DEFAULT_RETRYABLE = new Set<ErrorCode>([
  'provider_unreachable',
  'provider_timeout',
  'provider_error',
  'busy',
]);

/** Normalize anything thrown into an AppError. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  const message = error instanceof Error ? error.message : String(error);

  // fsScope throws its own tagged error rather than an AppError, to keep the
  // security module free of dependencies on the HTTP layer.
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: unknown }).code === 'scope_violation'
  ) {
    return new AppError('scope_violation', message, { cause: error });
  }

  return new AppError('internal_error', message, { cause: error });
}
