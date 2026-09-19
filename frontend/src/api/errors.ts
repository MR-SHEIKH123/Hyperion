import { errorEnvelopeSchema, type ErrorCode } from '../contracts/wire/common';

export class ApiError extends Error {
  readonly name = 'ApiError';
  constructor(
    message: string,
    readonly code: ErrorCode | 'invalid_response' | 'network_error',
    readonly status: number | null,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) { super(message, options); }
}

export async function responseError(response: Response): Promise<ApiError> {
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = null; }
  const parsed = errorEnvelopeSchema.safeParse(payload);
  if (parsed.success) {
    return new ApiError(parsed.data.error.message, parsed.data.error.code, response.status, parsed.data.error.retryable, parsed.data.error.details);
  }
  return new ApiError(
    response.status === 413 ? 'The selected file is too large.' : 'Hyperion returned an unreadable error response.',
    'invalid_response', response.status, false,
  );
}

export function networkError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  return new ApiError('Hyperion could not be reached.', 'network_error', null, true, undefined, { cause });
}
