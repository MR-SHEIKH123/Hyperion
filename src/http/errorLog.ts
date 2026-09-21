/**
 * Error log API — the debug console's read access to structured error records.
 *
 * Read-only by design. Entries are written by the error middleware and the
 * process-level handlers; nothing here creates or deletes them, because a log
 * a caller can edit is not evidence of anything.
 *
 * The rows themselves already exclude request bodies and secret-bearing
 * headers (see `sanitizeRequestContext` in `errors.ts`), so this route can
 * serve them verbatim without a second filtering pass that could drift out of
 * step with the first.
 */

import { Router } from 'express';

import { countErrors, queryErrorLog } from '../db/errorLog.ts';
import { asEnum, queryLimit, queryNumber, queryString } from './params.ts';
import { wrap } from './errors.ts';

export const errorLogRouter: Router = Router();

const SEVERITIES = ['warning', 'error'] as const;

/**
 * GET /api/errors — recent error records, newest first.
 *
 * `limit` (default 100), `severity` (`warning` | `error`) and `since` (epoch
 * milliseconds) all narrow the result. `total` counts every row matching the
 * same filters ignoring `limit`, so the console can say "showing 100 of 4213"
 * without a second request.
 */
errorLogRouter.get(
  '/',
  wrap((req, res) => {
    const limit = queryLimit(req, 'limit', { fallback: 100, max: 500 });
    const severity = asEnum(queryString(req, 'severity'), 'severity', SEVERITIES);
    const since = queryNumber(req, 'since');

    const filters = {
      ...(severity === undefined ? {} : { severity }),
      ...(since === undefined ? {} : { since }),
    };

    res.json({
      entries: queryErrorLog({ limit, ...filters }),
      total: countErrors(filters),
    });
  }),
);
