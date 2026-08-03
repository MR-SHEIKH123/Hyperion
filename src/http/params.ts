/**
 * Request parsing helpers.
 *
 * Everything the frontend sends arrives as `unknown`, so each route narrows it
 * here rather than trusting the shape. All failures surface as
 * `AppError('bad_request', ...)` with the offending field named, because the UI
 * shows the message verbatim next to the form control.
 *
 * The optional-value helpers (`asNumber`, `asBool`, ...) return `undefined` for
 * absent input instead of throwing. That lets PATCH routes pass their result
 * straight through to an `update*()` call, where `undefined` already means
 * "leave this column alone".
 */

import type { Request } from 'express';

import { AppError } from '../util/errors.ts';
import { isToolName, type ToolName } from '../types/core.ts';

function fail(message: string, field: string): never {
  throw new AppError('bad_request', message, { details: { field } });
}

/** True for values the client omitted. `null` counts as omitted, not invalid. */
function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * The parsed JSON body as a plain object.
 *
 * Express leaves `req.body` as `undefined` when there is no payload and no
 * `Content-Type`, so an empty object is substituted to keep field access safe.
 * Arrays are rejected: no endpoint in this API takes a top-level array.
 */
export function body(req: Request): Record<string, unknown> {
  const raw: unknown = req.body;
  if (absent(raw)) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('bad_request', 'Request body must be a JSON object.');
  }
  return raw as Record<string, unknown>;
}

/** A required, non-empty string. Returns the trimmed value. */
export function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(`${field} is required and must be a string.`, field);
  const trimmed = value.trim();
  if (trimmed === '') fail(`${field} must not be empty.`, field);
  return trimmed;
}

/** An optional non-empty string; `undefined` when omitted. */
export function asOptionalString(value: unknown, field: string): string | undefined {
  if (absent(value)) return undefined;
  return asString(value, field);
}

/**
 * An optional string that is allowed to be explicitly cleared.
 * Returns `null` when the client sent `null`, which callers persist as "unset".
 */
export function asNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return asString(value, field);
}

/** An optional finite number; rejects NaN and numeric-looking junk. */
export function asNumber(value: unknown, field: string): number | undefined {
  if (absent(value)) return undefined;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    fail(`${field} must be a number.`, field);
  }
  return parsed;
}

/** A required finite number. */
export function requireNumber(value: unknown, field: string): number {
  const parsed = asNumber(value, field);
  if (parsed === undefined) fail(`${field} is required.`, field);
  return parsed;
}

/** An optional boolean. Accepts the strings "true"/"false" for query strings. */
export function asBool(value: unknown, field: string): boolean | undefined {
  if (absent(value)) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fail(`${field} must be a boolean.`, field);
}

/** An optional array of non-empty strings. */
export function asStringArray(value: unknown, field: string): string[] | undefined {
  if (absent(value)) return undefined;
  if (!Array.isArray(value)) fail(`${field} must be an array of strings.`, field);
  return value.map((entry, index) => asString(entry, `${field}[${index}]`));
}

/** An optional flat string→string map, used for env vars and headers. */
export function asStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (absent(value)) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} must be an object.`, field);
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = asString(entry, `${field}.${key}`);
  }
  return result;
}

/** An optional value constrained to a fixed set. */
export function asEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (absent(value)) return undefined;
  const parsed = asString(value, field);
  if (!(allowed as readonly string[]).includes(parsed)) {
    fail(`${field} must be one of: ${allowed.join(', ')}.`, field);
  }
  return parsed as T;
}

/** An optional tool name, validated against the canonical TOOLS list. */
export function asTool(value: unknown, field = 'tool'): ToolName | undefined {
  if (absent(value)) return undefined;
  const parsed = asString(value, field);
  if (!isToolName(parsed)) fail(`${field} is not a known tool.`, field);
  return parsed;
}

/** A required tool name. */
export function requireTool(value: unknown, field = 'tool'): ToolName {
  const parsed = asTool(value, field);
  if (parsed === undefined) fail(`${field} is required.`, field);
  return parsed;
}

/**
 * A route parameter as a plain string.
 *
 * Express 5 types params as `string | string[] | undefined`, and
 * `noUncheckedIndexedAccess` keeps that union intact at every use site. This
 * collapses it once, so routes can read `pathParam(req, 'id')` without a cast.
 */
export function pathParam(req: Request, name: string): string {
  const raw: unknown = (req.params as Record<string, unknown>)[name];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AppError('bad_request', `Missing "${name}" in the request path.`, {
      details: { field: name },
    });
  }
  return raw;
}

/** A query-string value as a single string, ignoring repeated keys. */
export function queryString(req: Request, name: string): string | undefined {
  const raw: unknown = req.query[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.trim();
}

/** A query-string value parsed as a number. */
export function queryNumber(req: Request, name: string): number | undefined {
  return asNumber(queryString(req, name), name);
}

/**
 * A query-string flag. Bare presence (`?refresh`) counts as true, matching how
 * links are written by hand during debugging.
 */
export function queryBool(req: Request, name: string): boolean | undefined {
  const raw: unknown = req.query[name];
  if (raw === '') return true;
  return asBool(queryString(req, name), name);
}
