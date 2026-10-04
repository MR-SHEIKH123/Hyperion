import { z } from 'zod';

/**
 * Interactive terminal sessions (`GET /api/terminal/sessions`, docs/API.md §12.6c).
 *
 * **The list is not "live sessions" only, whatever the route's own comment says.**
 * `terminalSessions.list()` returns every record the store still holds, and the
 * store retains the last 50 ended ones for the audit trail — so an entry with
 * `endedAt !== null` is history, not a process. `endedAt` is therefore the field a
 * caller must test, and `endedReason` says how it ended (`closed` by the token
 * holder, `idle` past the idle deadline, `expired` past the absolute cap).
 *
 * **No token is ever in this response, and that is the reason the panel cannot
 * close anything**: `POST /sessions/:sessionId/close` authenticates with the
 * session's token, which is returned exactly once, to the client that opened it.
 * A list is public within the app; a close control over a list would be a control
 * that turns one client's session off from another's screen.
 */
export const terminalSessionSchema = z
  .object({
    id: z.string(),
    /** The task the opener bound the session to, or null for an unbound one. */
    taskId: z.string().nullable(),
    /** Free-form label for the audit trail: which browser, which window. */
    client: z.string().nullable(),
    openedAt: z.number(),
    /** Last authenticated command. A session that keeps being used stays alive. */
    lastSeenAt: z.number(),
    /** The idle deadline, renewed by every authenticated command. */
    expiresAt: z.number(),
    /** The absolute deadline, never renewed. */
    hardExpiresAt: z.number(),
    /** Non-null once the session has ended; the field that separates live from history. */
    endedAt: z.number().nullable(),
    endedReason: z.enum(['closed', 'idle', 'expired']).nullable(),
  })
  .passthrough();

export const terminalSessionsSchema = z
  .object({
    count: z.number().int().nonnegative(),
    sessions: z.array(terminalSessionSchema),
  })
  .passthrough();

export type TerminalSession = z.infer<typeof terminalSessionSchema>;
export type TerminalSessions = z.infer<typeof terminalSessionsSchema>;
