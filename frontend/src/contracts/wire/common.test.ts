/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cwd } from 'node:process';

import { describe, expect, it } from 'vitest';

import { errorCodeSchema, errorEnvelopeSchema } from './common';

/**
 * The backend's `ErrorCode` union, read from its source.
 *
 * This is a drift test, not a snapshot of today's list: the expected set is
 * parsed out of `src/util/errors.ts` at test time, so adding a code there
 * (or removing one here) fails this file until the frontend enum is synced.
 * Before this test the enum lagged the union by three codes
 * (`approval_required`, `permission_denied`, `zdr_requirement_unmet`) with
 * nothing failing: a JSON error envelope carrying one of them fell back to
 * `invalid_response` in `api/errors.ts`.
 */
function backendErrorCodes(): string[] {
  // Walk up from the frontend package to the repository root: this file is
  // `frontend/src/...`, the backend union is `src/util/errors.ts` beside it.
  // (`import.meta.url` is an http URL under Vitest's jsdom environment, so
  // it cannot be used to locate a file on disk.)
  let dir = cwd();
  let backendPath = path.join(dir, 'src/util/errors.ts');
  while (!existsSync(backendPath)) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('could not locate src/util/errors.ts above the frontend package');
    }
    dir = parent;
    backendPath = path.join(dir, 'src/util/errors.ts');
  }
  const source = readFileSync(backendPath, 'utf8');
  const start = source.indexOf('export type ErrorCode =');
  const end = source.indexOf('const STATUS', start);
  if (start === -1 || end === -1) {
    throw new Error('could not locate the backend ErrorCode union in src/util/errors.ts');
  }
  // Strip comments first: the union is documented inline, and prose must not
  // be able to mint (or hide) a code.
  const union = source
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const codes = [...union.matchAll(/'([a-z][a-z0-9_]*)'/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  if (codes.length === 0) {
    throw new Error('parsed no backend error codes from src/util/errors.ts');
  }
  return [...new Set(codes)].sort();
}

describe('errorCodeSchema', () => {
  it('matches the backend ErrorCode union exactly', () => {
    expect([...errorCodeSchema.options].sort()).toEqual(backendErrorCodes());
  });

  it('parses an error envelope carrying every backend code', () => {
    for (const code of backendErrorCodes()) {
      const parsed = errorEnvelopeSchema.safeParse({
        error: { code, message: 'refused', retryable: false },
      });
      expect(parsed.success, `backend code ${code} should parse`).toBe(true);
    }
  });

  it('still refuses a code neither side has', () => {
    expect(errorCodeSchema.safeParse('not_a_real_code').success).toBe(false);
  });
});
