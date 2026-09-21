/**
 * The attention queue endpoint.
 *
 * `GET /api/attention` is a read of live state, so it takes no parameters: the
 * queue is "everything waiting on you", and a filter would make the frontend
 * responsible for deciding what the user should be shown. Narrowing is a
 * presentation concern, and the `kind`/`tool` fields are there for it.
 *
 * Always a 200, for the same reason `/api/health/summary` is: an empty queue and a
 * queue with a hundred prompts are both answers, and a status code that changed
 * with the content would force every client to special-case the state it exists to
 * display.
 */

import { Router } from 'express';

import { attentionQueue } from '../services/attention/queue.ts';
import { wrap } from './errors.ts';

export const attentionRouter: Router = Router();

attentionRouter.get(
  '/',
  wrap((_req, res) => {
    res.json(attentionQueue());
  }),
);
