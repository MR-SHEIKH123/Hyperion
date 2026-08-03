/**
 * Resource detection endpoint.
 *
 * A single question: "what is at this URL?" The answer never changes anything.
 * Nothing is fetched to disk, nothing is registered, no token is asked for —
 * the user pastes a link, is told what it looks like, and then chooses to
 * install it as a skill (`POST /api/skills/fetch`) or add it as an MCP server
 * (`POST /api/mcp`).
 *
 * That separation is the point. A link that turns out to be both a skill and an
 * MCP server is genuinely ambiguous, and guessing on the user's behalf would
 * install the wrong one silently. Detection reports; the user decides.
 */

import { Router } from 'express';

import { detectResource } from '../services/resources/detect.ts';
import { wrap } from './errors.ts';
import { asString, body } from './params.ts';

export const resourcesRouter: Router = Router();

/**
 * Classifies a URL as a skill, an MCP server, both, or invalid.
 *
 * Always 200 when the URL is well-formed, including when the answer is
 * `invalid`: an unreachable host or a repository full of nothing recognisable
 * is a *result*, not a failed request, and the reason is in the payload for the
 * UI to show. Only a malformed or non-http(s) URL is a 400, because that is the
 * one case the user can fix by retyping.
 */
resourcesRouter.post(
  '/detect',
  wrap(async (req, res) => {
    const result = await detectResource(asString(body(req).url, 'url'));
    res.json(result);
  }),
);
