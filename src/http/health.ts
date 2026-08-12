/**
 * Health endpoints.
 *
 * Two routes with deliberately different jobs. `GET /api/health` is the liveness
 * probe — it answers "is the process up" and touches nothing that could fail, so
 * a supervisor polling it can never be told the app is down because a query was
 * slow. `GET /api/health/summary` is the dashboard's question, and it does read
 * the database and the provider table.
 *
 * Keeping the cheap one cheap is the point of the split: folding them together
 * would make the probe's answer depend on the health of the things it reports.
 */

import { Router } from 'express';

import { env } from '../config/env.ts';
import { healthSummary } from '../services/health/summary.ts';
import { wrap } from './errors.ts';

export const healthRouter: Router = Router();

/** Liveness. Unchanged shape — existing clients poll this. */
healthRouter.get('/', (_req, res) => {
  res.json({
    ok: true,
    name: 'hyperion',
    uptimeSec: Math.round(process.uptime()),
    loopback: env.bindIsLoopback,
  });
});

/**
 * GET /api/health/summary — one verdict over providers, MCP and recent errors.
 *
 * Always a 200. A degraded or failing component is the *answer*, not a failure
 * of the request, and a dashboard that got a 503 here would have to special-case
 * the very state it exists to display.
 */
healthRouter.get(
  '/summary',
  wrap((_req, res) => {
    res.json(healthSummary());
  }),
);
