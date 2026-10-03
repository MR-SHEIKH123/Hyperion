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

/**
 * A required string that is allowed to be blank, returning `null` when it is.
 *
 * `asString` refuses an empty string, which is right almost everywhere: a blank
 * title or filename is a mistake, not an intention. But for a free-text field
 * the user is meant to be able to *empty*, refusing blank makes the setting
 * impossible to clear — they select-all, delete, save, and get a 400 with no way
 * forward. Clearing must be reachable through the same control that set it.
 *
 * The field is still required, so an omitted key is an error rather than a
 * silent wipe; only an explicitly blank value means "unset".
 */
export function asClearableString(value: unknown, field: string): string | null {
  if (typeof value !== 'string') fail(`${field} is required and must be a string.`, field);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
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

/**
 * An optional positive integer, used for client-controlled durations and for
 * counts. `max` is optional because some callers (a token ceiling, a timeout)
 * have no meaningful upper bound; it is *not* optional for a row count — see
 * `queryLimit`.
 *
 * Fractions are refused rather than rounded: `2.5` is a client bug, and
 * answering a question nobody asked is worse than saying so.
 */
export function asPositiveInteger(
  value: unknown,
  field: string,
  max?: number,
): number | undefined {
  const parsed = asNumber(value, field);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`${field} must be a positive integer.`, field);
  }
  if (max !== undefined && parsed > max) {
    fail(`${field} must be a positive integer no greater than ${String(max)}.`, field);
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
/**
 * A request header, with an empty value read as absent.
 *
 * Headers are how a credential travels (S17's session token), and an empty string
 * is what a client that "sent the header" without a value produces — treating it as
 * a value would make `''` something a comparison has to reject rather than
 * something the caller never supplied.
 */
export function headerString(req: Request, name: string): string | undefined {
  const value = req.get(name);
  return value === undefined || value === '' ? undefined : value;
}

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

/**
 * A query-string value that must appear **at most once**.
 *
 * `?path=a&path=b` arrives as an array rather than a string, and the temptation
 * is to take the first element as `queryString` does. That is the wrong answer
 * for a parameter that selects *what is read*: the caller asked for two
 * different things, the server silently read one of them, and whichever half
 * the caller did not expect is now a question about the server instead of about
 * the request. It is refused with the field named, like every other malformed
 * input here.
 *
 * `queryString` keeps its first-element behaviour: for a filter or a limit the
 * duplicate is harmless, and changing it would alter routes this has nothing to
 * do with.
 */
export function querySingleString(req: Request, name: string): string | undefined {
  const raw: unknown = req.query[name];
  if (Array.isArray(raw)) fail(`${name} must be given at most once.`, name);
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  return raw.trim();
}

/** Query-string values preserving repeated keys, with boundary validation. */
export function queryStrings(req: Request, name: string): string[] {
  const raw: unknown = req.query[name];
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((value, index) => asString(value, `${name}[${index}]`));
}

/** A query-string value parsed as a number. */
export function queryNumber(req: Request, name: string): number | undefined {
  return asNumber(queryString(req, name), name);
}

/**
 * A row count from the query string: a positive whole number up to `max`, or
 * the route's default when omitted.
 *
 * Every list route takes its limit from here, because a limit is the one query
 * value whose *type* SQLite refuses to coerce: every other number arrives in a
 * comparison, where `2.5` compares fine, but the two ways an unchecked limit
 * bites are both invisible at the call site:
 *
 *   `LIMIT 2.5` — SQLite raises "datatype mismatch", which arrives at the client
 *                 as a 500 `internal_error` about the driver, not a 400 about
 *                 the field, and lands in `error_log` as a server fault
 *   `LIMIT -1`  — SQLite reads a negative limit as **no limit**, so a caller
 *                 asking for "-1 rows" is handed the entire table
 *
 * `max` is required rather than defaulted so that each route states its own
 * bound in its own code, and an out-of-range value is refused instead of
 * clamped — a caller handed 200 rows when it asked for 5000 concludes the table
 * only holds 200. The exception would have to be documented, and a silent
 * exception is how the routes drifted apart in the first place.
 */
export function queryLimit(
  req: Request,
  name: string,
  spec: { fallback: number; max: number },
): number {
  return asPositiveInteger(queryString(req, name), name, spec.max) ?? spec.fallback;
}

/**
 * A non-negative whole number from the query string, for `offset`.
 *
 * Zero is legitimate and is the default, so this is not `asPositiveInteger`
 * with different wording: the bound is `>= 0`, and a fractional offset is the
 * same driver error a fractional limit is.
 */
export function queryOffset(req: Request, name: string, fallback = 0): number {
  const parsed = queryNumber(req, name);
  if (parsed === undefined) return fallback;
  if (!Number.isInteger(parsed) || parsed < 0) {
    fail(`${name} must be a whole number of zero or more.`, name);
  }
  return parsed;
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
