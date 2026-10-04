import { terminalSessionsSchema } from '../contracts/wire/terminal';
import { request } from './client';

/**
 * Interactive terminal sessions (docs/API.md §12.6c).
 *
 * This module is a **read**, and the asymmetry is deliberate rather than
 * unfinished: opening a session mints the id and the token server-side and
 * returns the token once, and closing authenticates with that token. A screen
 * that lists sessions holds no tokens, so it can close nothing — and a route that
 * let it would delete the property the session exists to provide, which is that
 * "this command came from a person, right now" is evidence rather than a flag.
 *
 * The list is used for what it can honestly answer: what is running, bound to
 * which task, opened by which client, and when its idle deadline is. It contains
 * recently ended sessions too (`endedAt !== null`), which the caller must filter
 * rather than count.
 */
export const getTerminalSessions = (signal?: AbortSignal) =>
  request('/api/terminal/sessions', terminalSessionsSchema, {
    ...(signal === undefined ? {} : { signal }),
  });
