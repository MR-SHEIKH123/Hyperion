import { Router } from 'express';

import { AppError } from '../util/errors.ts';
import { wrap } from './errors.ts';
import { asString, body, pathParam, queryLimit, queryString } from './params.ts';
import {
  MEMORY_IMPORT_MAX_CHARS,
  MEMORY_MAX_CHARS,
  addMemory,
  clearMemories,
  deleteMemory,
  importMemories,
  listMemories,
  memoryStatus,
  resetMemory,
  setMemoryEnabled,
} from '../services/memory/index.ts';

/**
 * The largest paste the import route will look at, against the splitter's own
 * character bound. Generous on purpose: a paste over this is refused with a
 * number rather than quietly truncated to it, because "we stored part of what
 * you sent" has to be said out loud, and the splitter can only say it for text
 * it was allowed to read.
 */
const MEMORY_IMPORT_MAX_REQUEST_CHARS = MEMORY_IMPORT_MAX_CHARS * 5;

/** Memory is opt-in, so a write against a disabled plugin is a capability answer, not a failure. */
function assertMemoryEnabled(): void {
  if (!memoryStatus().enabled) {
    throw new AppError('capability_disabled', 'The Memory plugin is off, so nothing was stored.', {
      details: { setting: 'plugins.memory.enabled' },
    });
  }
}

export const memoryRouter = Router();

/**
 * Read surface for the Settings panel. `query` runs a semantic search, omitting
 * it lists everything stored. Returns an empty list rather than an error when
 * the toggle is off or the backend could not load, so the panel renders the
 * same either way and `GET /status` is the single place that explains why.
 */
memoryRouter.get(
  '/',
  wrap(async (req, res) => {
    const memories = await listMemories({
      query: queryString(req, 'query'),
      limit: queryLimit(req, 'limit', { fallback: 50, max: 200 }),
    });
    res.json({ memories });
  }),
);

/**
 * Never starts the backend, so the panel can show the toggle state and the
 * reason a previous load failed without paying for a model round-trip.
 */
memoryRouter.get(
  '/status',
  wrap(async (_req, res) => {
    res.json({ status: memoryStatus() });
  }),
);

/**
 * Flipping the toggle drops the cached client so a previously failed load is
 * retried on the next turn instead of staying broken until a restart.
 */
function toggleHandler(on: boolean): ReturnType<typeof wrap> {
  return wrap(async (_req, res) => {
    setMemoryEnabled(on);
    resetMemory();
    res.json({ status: memoryStatus() });
  });
}

memoryRouter.post('/enable', toggleHandler(true));
memoryRouter.post('/disable', toggleHandler(false));

/**
 * Store one memory the user wrote (item 1.21).
 *
 * The three refusals are distinguished because they need different responses: a
 * disabled plugin is a capability answer (turn it on), an empty body is a
 * validation answer, and a backend that will not load is a failure to report —
 * and none of them may be answered with a cheerful `200 {}`, which is how a
 * silent no-op would look to the Settings panel.
 */
memoryRouter.post(
  '/',
  wrap(async (req, res) => {
    assertMemoryEnabled();
    const text = asString(body(req).text, 'text');
    if (text.trim().length === 0) {
      throw new AppError('bad_request', 'text must not be empty', { details: { field: 'text' } });
    }
    if (text.length > MEMORY_MAX_CHARS) {
      throw new AppError('bad_request', `text must be at most ${MEMORY_MAX_CHARS} characters`, {
        details: { field: 'text', max: MEMORY_MAX_CHARS },
      });
    }
    const outcome = await addMemory(text);
    if (outcome === 'empty') {
      throw new AppError('bad_request', 'text must not be empty', { details: { field: 'text' } });
    }
    if (outcome === 'unavailable') {
      throw new AppError('storage_error', 'The memory backend is not available, so nothing was stored.', {
        details: { reason: memoryStatus().error },
      });
    }
    res.status(201).json({ stored: true });
  }),
);

/**
 * Import pasted text as memories (item 1.21).
 *
 * The counts are the answer, including a partial one: a paste is not one piece
 * of work, and a route that answered 500 because chunk 41 of 60 failed would
 * throw away the fact that 40 landed. So the response always carries
 * `imported`/`dropped`/`found`, and `error` names what stopped a run early —
 * with one exception, where nothing at all was stored, because a success-shaped
 * response for zero work is the one reading this route must not allow.
 */
memoryRouter.post(
  '/import',
  wrap(async (req, res) => {
    assertMemoryEnabled();
    const text = asString(body(req).text, 'text');
    if (text.length > MEMORY_IMPORT_MAX_REQUEST_CHARS) {
      throw new AppError('bad_request', `text must be at most ${MEMORY_IMPORT_MAX_REQUEST_CHARS} characters`, {
        details: { field: 'text', max: MEMORY_IMPORT_MAX_REQUEST_CHARS },
      });
    }
    if (text.trim().length === 0) {
      throw new AppError('bad_request', 'text must not be empty', { details: { field: 'text' } });
    }
    const outcome = await importMemories(text);
    if (outcome.imported === 0 && outcome.error !== null) {
      throw new AppError('storage_error', 'No memories were imported: the memory backend is not available.', {
        details: { reason: memoryStatus().error, found: outcome.found },
      });
    }
    res.json(outcome);
  }),
);

/** Clears every stored memory. The toggle itself is left untouched. */
memoryRouter.delete(
  '/',
  wrap(async (_req, res) => {
    const cleared = await clearMemories();
    res.json({ cleared });
  }),
);

memoryRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const deleted = await deleteMemory(pathParam(req, 'id'));
    res.json({ deleted });
  }),
);
