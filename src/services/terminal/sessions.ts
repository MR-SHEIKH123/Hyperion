/**
 * Live interactive terminal sessions (S17).
 *
 * A human typing a command into a terminal they opened is the authority for that
 * command, so the permission engine's `ask`/`deny` evaluation does not govern it:
 * asking somebody to confirm the thing they just typed is a prompt with one
 * answer. What that exemption needs is *evidence* — not a flag the client sends,
 * because a flag is the exemption itself — and the evidence that a human is
 * present right now is a session the server opened for one.
 *
 * The shape:
 *
 *   - The client opens a session; **the server mints the id and the token** and
 *     returns the token exactly once. Nothing about the token is derived from
 *     anything a client sent.
 *   - The token authenticates with a timing-safe comparison (`security/tokens.ts`)
 *     on **every** command that claims the exemption, and a successful
 *     authentication is what keeps the session alive.
 *   - A session ends when it is closed, when it goes idle, or when it reaches an
 *     absolute maximum age. The first two are the spec's "expire on session close
 *     or timeout"; the third exists because a stolen token that is being used is
 *     otherwise renewable forever.
 *   - Closing requires the token, so one client cannot end another's session, and
 *     closing destroys the token rather than marking a row: a closed session
 *     cannot be reopened by presenting the same string again.
 *
 * Deliberately in memory. A terminal session is the presence of a person at a
 * keyboard in this process's lifetime; persisting it would make a restart resume a
 * "live" session nobody is in front of, which is precisely the claim this module
 * exists to make checkable. The cost is that a server restart ends every session,
 * and that is the honest outcome: the humans are gone, and they can open another.
 *
 * What the exemption covers is decided by the caller, not here — this module
 * answers "is a human session live, and is this the token it was minted with?" and
 * nothing else.
 */
import { randomUUID } from 'node:crypto';

import { mintToken, tokensMatch } from '../../security/tokens.ts';

/** Idle sessions expire. Long enough to read a command's output, short enough to matter. */
const IDLE_TIMEOUT_MS = 15 * 60_000;
/** Absolute cap on one session, so a used token cannot renew itself forever. */
const MAX_SESSION_MS = 8 * 60 * 60_000;
/** How many ended sessions are kept for the audit view. */
const RETAINED_ENDED = 50;

export interface TerminalSession {
  id: string;
  /** The task this session is bound to, when the client opened it against one. */
  taskId: string | null;
  /** Free-form label for the audit trail: which browser, which window. */
  client: string | null;
  openedAt: number;
  lastSeenAt: number;
  /** The idle deadline, renewed by an authenticated command. */
  expiresAt: number;
  /** The absolute deadline, never renewed. */
  hardExpiresAt: number;
  endedAt: number | null;
  endedReason: 'closed' | 'idle' | 'expired' | null;
}

/** Why a claim was not accepted. Each has its own sentence at the call site. */
export type SessionRefusal = 'missing_token' | 'unknown' | 'ended';

export interface SessionAuthentication {
  ok: boolean;
  /** Set when `ok`. */
  session?: TerminalSession;
  /** Set when not `ok`. */
  refusal?: SessionRefusal;
}

export interface OpenSessionInput {
  taskId?: string | null;
  client?: string | null;
  now?: number;
}

export interface SessionStore {
  open(input?: OpenSessionInput): { session: TerminalSession; token: string };
  /** Validate a claim, renewing the session when it holds. */
  authenticate(input: { sessionId: unknown; token: unknown; now?: number }): SessionAuthentication;
  /** Validate a claim and end the session. Only the token holder can. */
  close(input: { sessionId: unknown; token: unknown; now?: number }): SessionAuthentication;
  list(): TerminalSession[];
}

interface SessionRecord {
  session: TerminalSession;
  /** Cleared on close, so a closed session cannot be reopened with the token. */
  token: string | null;
}

function view(session: TerminalSession): TerminalSession {
  return { ...session };
}

export function createSessionStore(): SessionStore {
  const records = new Map<string, SessionRecord>();

  /** Expire anything past its deadline, so a stale record cannot authenticate. */
  function reap(now: number): void {
    for (const record of records.values()) {
      const { session } = record;
      if (session.endedAt !== null) continue;
      if (now >= session.hardExpiresAt) end(record, 'expired', now);
      else if (now >= session.expiresAt) end(record, 'idle', now);
    }
    evictEnded();
  }

  function end(record: SessionRecord, reason: NonNullable<TerminalSession['endedReason']>, now: number): void {
    record.session.endedAt = now;
    record.session.endedReason = reason;
    record.token = null;
  }

  function evictEnded(): void {
    const ended = [...records.values()].filter((record) => record.session.endedAt !== null);
    for (const record of ended.slice(0, Math.max(0, ended.length - RETAINED_ENDED))) {
      records.delete(record.session.id);
    }
  }

  /**
   * Look up a presented claim. The two failure modes are reported separately for
   * the *caller's* logs, but every call site answers them the same way: a claim
   * that is not authenticated is not a human, so the command goes through normal
   * permission evaluation. Nothing here tells a client whether a session id exists.
   */
  function resolve(input: { sessionId: unknown; token: unknown; now?: number }): {
    record?: SessionRecord;
    refusal?: SessionRefusal;
    now: number;
  } {
    const now = input.now ?? Date.now();
    reap(now);
    if (typeof input.sessionId !== 'string' || input.sessionId === '') return { refusal: 'missing_token', now };
    const record = records.get(input.sessionId);
    if (record === undefined) return { refusal: 'unknown', now };
    if (record.token === null || !tokensMatch(record.token, input.token)) return { refusal: 'missing_token', now };
    if (record.session.endedAt !== null) return { refusal: 'ended', now };
    return { record, now };
  }

  return {
    open(input = {}) {
      const now = input.now ?? Date.now();
      reap(now);
      const session: TerminalSession = {
        id: `tsess_${randomUUID()}`,
        taskId: input.taskId ?? null,
        client: input.client ?? null,
        openedAt: now,
        lastSeenAt: now,
        expiresAt: now + IDLE_TIMEOUT_MS,
        hardExpiresAt: now + MAX_SESSION_MS,
        endedAt: null,
        endedReason: null,
      };
      const token = mintToken();
      records.set(session.id, { session, token });
      return { session: view(session), token };
    },

    authenticate(input) {
      const { record, refusal, now } = resolve(input);
      if (record === undefined) return { ok: false, refusal: refusal ?? 'unknown' };
      // A live session is one that keeps being used: this is the "right now" half
      // of the claim, and it is renewed only by an authenticated command.
      record.session.lastSeenAt = now;
      record.session.expiresAt = Math.min(now + IDLE_TIMEOUT_MS, record.session.hardExpiresAt);
      return { ok: true, session: view(record.session) };
    },

    close(input) {
      const { record, refusal, now } = resolve(input);
      if (record === undefined) return { ok: false, refusal: refusal ?? 'unknown' };
      end(record, 'closed', now);
      return { ok: true, session: view(record.session) };
    },

    list() {
      reap(Date.now());
      return [...records.values()].map((record) => view(record.session)).reverse();
    },
  };
}

/** The store the HTTP surface uses. One process, one set of live sessions. */
export const terminalSessions = createSessionStore();
