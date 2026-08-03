import { Router } from 'express';

import { wrap } from './errors.ts';
import { pathParam, queryNumber, queryString } from './params.ts';
import {
  clearMemories,
  deleteMemory,
  listMemories,
  memoryStatus,
  resetMemory,
  setMemoryEnabled,
} from '../services/memory/index.ts';

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
      limit: queryNumber(req, 'limit'),
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
