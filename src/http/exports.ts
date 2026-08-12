/**
 * Bulk export — `POST /api/export/bulk`.
 *
 * POST rather than GET even though nothing is created: the selection is a body
 * with a nested timeframe, and encoding that into a query string would make the
 * one endpoint the user is most likely to bookmark the hardest one to read.
 */

import { Router } from 'express';

import { attachDownloadHeaders } from './download.ts';
import { wrap } from './errors.ts';
import { asEnum, asNumber, body } from './params.ts';
import { exportBulk } from '../services/export/bulk.ts';
import { AppError } from '../util/errors.ts';

import type { BulkContentType, BulkTimeframe } from '../services/export/bulk.ts';

const CONTENT_TYPES = ['chats', 'artifacts', 'all'] as const;

/**
 * `timeframe` is optional, and so is each end of it — an open-ended range is a
 * legitimate request ("everything before I started paying attention").
 */
function parseTimeframe(value: unknown): BulkTimeframe | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('bad_request', 'timeframe must be an object with optional from/to.', {
      details: { field: 'timeframe' },
    });
  }

  const raw = value as Record<string, unknown>;
  const from = asNumber(raw.from, 'timeframe.from');
  const to = asNumber(raw.to, 'timeframe.to');
  if (from === undefined && to === undefined) return undefined;

  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

export const exportsRouter = Router();

/**
 * Responds with the zip itself rather than a JSON envelope pointing at one.
 *
 * The counts and the skip list would be useful in a body, but they are already
 * in `MANIFEST.json` inside the archive, and a two-step download would leave a
 * temporary file on disk to expire. The header carries the summary for a client
 * that wants it without opening the zip.
 */
exportsRouter.post(
  '/bulk',
  wrap(async (req, res) => {
    const payload = body(req);
    const contentType = asEnum<BulkContentType>(payload.contentType, 'contentType', CONTENT_TYPES);
    const timeframe = parseTimeframe(payload.timeframe);

    const result = exportBulk({
      ...(timeframe === undefined ? {} : { timeframe }),
      ...(contentType === undefined ? {} : { contentType }),
    });

    attachDownloadHeaders(res, result.filename, result.contentType);
    // A custom header, not a body field, because the body is the file. Named
    // with the X- prefix so it cannot be mistaken for a standard field.
    res.setHeader(
      'X-Export-Summary',
      JSON.stringify({ counts: result.counts, skipped: result.skipped.length }),
    );
    res.send(result.body);
  }),
);
