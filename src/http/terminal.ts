/**
 * Interactive terminal sessions (S17).
 *
 * A session exists so that "this command came from a person, right now" can be
 * *checked* instead of claimed. It is opened here — the server mints the id and the
 * token, and returns the token once — and it is presented by the command route in
 * a header, where a credential belongs: not a body field, and never a boolean the
 * client controls.
 *
 * The routes are deliberately three and small: open, close, list. There is no
 * "heartbeat" and no "renew" because an authenticated command *is* the heartbeat —
 * a session that is doing something is alive, and one that is not expires.
 *
 * No client opens or closes these yet: the browser terminal surface they are for
 * does not exist (recorded as a gap). `GET /sessions` is read by the Code surface's
 * Processes row, which lists what is running and closes nothing — the list carries
 * no token, and closing needs the one its opener holds. The open and close routes
 * are here because the token has to be minted by the server for the exemption to be
 * structural at all, and a minting operation with no way to reach it would be a
 * claim rather than a mechanism.
 */
import { Router } from 'express';

import { terminalSessions } from '../services/terminal/sessions.ts';
import { AppError } from '../util/errors.ts';
import { wrap } from './errors.ts';
import { asOptionalString, body, headerString, pathParam } from './params.ts';

/** The session a command claims, and the token that authenticates the claim. */
export const SESSION_HEADER = 'x-hyperion-session';
export const SESSION_TOKEN_HEADER = 'x-hyperion-session-token';

export const terminalRouter: Router = Router();

/**
 * Open a session.
 *
 * `taskId` is optional and, when given, is what the session's commands are
 * contained to: the terminal route tightens its boundary to that task's worktree
 * exactly as an agent's `executeCommand` does. A client cannot widen its own
 * boundary by naming a task — the containment check runs against the named task,
 * so the worst a false claim achieves is a narrower scope it is then refused from.
 */
terminalRouter.post(
  '/sessions',
  wrap(async (req, res) => {
    const payload = body(req);
    const taskId = asOptionalString(payload.taskId, 'taskId');
    const client = asOptionalString(payload.client, 'client');

    const opened = terminalSessions.open({ taskId: taskId ?? null, client: client ?? null });

    // The token appears in this response and in no response after it: `GET
    // /sessions` lists the sessions, never their tokens, because a listed token is
    // a token anybody reading the list can use.
    res.status(201).json({
      session: opened.session,
      token: opened.token,
      expiresAt: opened.session.expiresAt,
    });
  }),
);

/**
 * Close a session.
 *
 * The token is required: without it, one client could end another's session and
 * turn a live human's next command into a permission evaluation. A wrong token and
 * an unknown id are answered identically — 404, the same sentence — so the route
 * cannot be used to discover which session ids exist.
 */
terminalRouter.post(
  '/sessions/:sessionId/close',
  wrap(async (req, res) => {
    const sessionId = pathParam(req, 'sessionId');
    const token = headerString(req, SESSION_TOKEN_HEADER);

    const closed = terminalSessions.close({ sessionId, token });
    if (!closed.ok) {
      throw new AppError('not_found', 'No live terminal session with that id belongs to this caller.', {
        details: { sessionId },
      });
    }
    res.json({ closed: true, session: closed.session });
  }),
);

/** Live sessions, newest first. Never a token, and never a closed one's secret. */
terminalRouter.get('/sessions', (_req, res) => {
  const sessions = terminalSessions.list();
  res.json({ count: sessions.length, sessions });
});
