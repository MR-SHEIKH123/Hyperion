import type { ZodType } from 'zod';
import { ApiError, networkError, responseError } from './errors';

export interface RequestOptions extends Omit<RequestInit, 'body'> { body?: unknown; }

export async function request<T>(path: string, schema: ZodType<T>, options: RequestOptions = {}): Promise<T> {
  if (!path.startsWith('/api/')) throw new Error(`API paths must be relative and start with /api/: ${path}`);
  const { body, headers, ...init } = options;
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept:'application/json', ...(body === undefined ? {} : {'Content-Type':'application/json'}), ...headers },
      ...(body === undefined ? {} : { body:JSON.stringify(body) }),
    });
  } catch (error) { throw networkError(error); }
  if (!response.ok) throw await responseError(response);
  let payload: unknown;
  try { payload = await response.json(); } catch (error) {
    throw new ApiError('Hyperion returned an unreadable response.', 'invalid_response', response.status, false, undefined, {cause:error});
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new ApiError('Hyperion returned a response that does not match this frontend version.', 'invalid_response', response.status, false, {issues:parsed.error.issues});
  return parsed.data;
}
