/**
 * The Plugins hub endpoints (Prompt 1.34).
 *
 * Two routes, and the split between them is the whole design:
 *
 *   * `GET /api/plugins` **reads** — the catalogue, each plugin's own switch,
 *     who may use it, and the offline scan. No network, no spawn, no write; a
 *     settings screen should not be able to change the machine by being opened.
 *   * `PATCH /api/plugins/:id/availability` **decides** — one tool, one plugin,
 *     `true`/`false`/`null`, where `null` restores the default rather than
 *     storing a third state. The body names the tool because the path cannot:
 *     a plugin is available to five tools at once, and a route that took only a
 *     boolean would have to guess which one the user meant.
 *
 * A refused write is specific about which half was wrong — an unknown plugin is a
 * `404` naming the id, an unknown tool is a `400` listing the ones that exist —
 * because "the request failed" is the least useful sentence a hub can return.
 */
import { Router } from 'express';

import { wrap } from './errors.ts';
import { asBool, body, pathParam, requireTool } from './params.ts';
import { listPlugins, setPluginAvailabilityFor } from '../services/plugins/hub.ts';
import { AppError } from '../util/errors.ts';

export const pluginsRouter = Router();

/** Every plugin, with availability folded in and the scan's caveat attached. */
pluginsRouter.get(
  '/',
  wrap((_req, res) => {
    res.json(listPlugins());
  }),
);

pluginsRouter.patch(
  '/:id/availability',
  wrap((req, res) => {
    const id = pathParam(req, 'id');
    const payload = body(req);
    const tool = requireTool(payload.tool);

    // `null` is the reset, and it has to be written explicitly: an absent field
    // would make a typo (`avalible`) silently mean "use the default" instead of
    // "field is required".
    let available: boolean | null;
    if (payload.available === null) {
      available = null;
    } else {
      const parsed = asBool(payload.available, 'available');
      if (parsed === undefined) {
        throw new AppError(
          'bad_request',
          'available must be true, false, or null — null restores the default, which is available.',
          { details: { field: 'available' } },
        );
      }
      available = parsed;
    }

    const result = setPluginAvailabilityFor(id, tool, available);
    if (result === null) {
      throw new AppError('not_found', `No plugin with id ${id}.`, { details: { field: 'id' } });
    }
    res.json({ plugin: result.plugin, pruned: result.pruned });
  }),
);
