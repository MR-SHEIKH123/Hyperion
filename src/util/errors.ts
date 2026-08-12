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
  // capability gates and spending limits
  | 'capability_disabled'
  | 'network_egress_disabled'
  | 'spending_cap_reached'
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

  // 403 rather than 400: the request is well-formed and the caller cannot fix
  // it by resending. Something is switched off, and only changing a setting
  // changes the answer.
  capability_disabled: 403,
  network_egress_disabled: 403,
  // 429 rather than 403: a spending cap is a quota that lifts on its own at the
  // next daily boundary, which is what "too many requests" means and what
  // "forbidden" does not.
  spending_cap_reached: 429,

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

/** Reads the 4xx/5xx status Express and body-parser attach to their own errors. */
function taggedStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  for (const value of [candidate.status, candidate.statusCode]) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return undefined;
}

/** body-parser tags its failures with a `type`, e.g. `entity.parse.failed`. */
export function bodyParserType(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const type = (error as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

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

  // Express and body-parser reject malformed requests before any handler runs:
  // a bad percent-escape in the path throws URIError, and an unparseable JSON
  // body throws SyntaxError. Both arrive here already tagged with a 4xx status.
  // Without this they fell through to internal_error, telling the client "the
  // server broke" when in fact the request did — and putting a parser's message
  // (which quotes the offending body) into a 500 the frontend cannot act on.
  const status = taggedStatus(error);
  if (status !== undefined && status >= 400 && status < 500) {
    const type = bodyParserType(error);
    if (status === 413 || type === 'entity.too.large') {
      return new AppError('bad_request', 'The request body is too large.', {
        details: { limit: 'See HYPERION_MAX_UPLOAD_BYTES / the 25mb JSON limit.' },
        cause: error,
      });
    }
    if (error instanceof URIError) {
      return new AppError('bad_request', 'The request path is not correctly URL-encoded.', {
        cause: error,
      });
    }
    if (error instanceof SyntaxError || type !== undefined) {
      // The parser message quotes the offending input, so it stays server-side.
      return new AppError('bad_request', 'The request body is not valid JSON.', {
        privateDetails: { parserMessage: message },
        cause: error,
      });
    }
    return new AppError('bad_request', message, { cause: error });
  }

  return new AppError('internal_error', message, { cause: error });
}
