/**
 * Activity feed API — the chronological, human-readable record.
 *
 * Read-only, and deliberately not the debug console: see
 * `src/services/activity/feed.ts` for what is included and why delegation
 * events are not.
 */

import { Router } from 'express';

import { activityFeed } from '../services/activity/feed.ts';
import { AppError } from '../util/errors.ts';
import { queryNumber } from './params.ts';
import { wrap } from './errors.ts';

export const activityRouter: Router = Router();

const DEFAULT_LIMIT = 50;

/**
 * Both queries take `limit` rows, so an unbounded value is an unbounded scan of
 * two tables. Capped rather than silently clamped — a caller asking for 5000
 * should be told it will not happen, not handed 200 and left to conclude the
 * feed only ever holds that many.
 */
const MAX_LIMIT = 200;

/**
 * GET /api/activity — merged task and scheduled-task runs, newest first.
 *
 * `before` is a cursor, not a filter: pass back the `nextBefore` of the previous
 * page. It is exclusive, so a page never repeats the entry it ended on.
 */
activityRouter.get(
  '/',
  wrap((req, res) => {
    const limit = queryNumber(req, 'limit') ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new AppError(
        'bad_request',
        `limit must be a whole number between 1 and ${MAX_LIMIT}.`,
        { details: { field: 'limit' } },
      );
    }

    const before = queryNumber(req, 'before');
    if (before !== undefined && (!Number.isInteger(before) || before < 0)) {
      throw new AppError(
        'bad_request',
        'before must be a timestamp in epoch milliseconds.',
        { details: { field: 'before' } },
      );
    }

    res.json(activityFeed({ limit, ...(before === undefined ? {} : { before }) }));
  }),
);
