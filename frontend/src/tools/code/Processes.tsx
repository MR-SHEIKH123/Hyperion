import { useQuery } from '@tanstack/react-query';

import { getTerminalSessions } from '../../api/terminal';
import { relativeTime } from '../../attention/links';
import styles from './Processes.module.css';

/**
 * Processes — what is running right now, over `GET /api/terminal/sessions`
 * (the session panel's third slice).
 *
 * **What "running" means here, and why it is not the count the route reports.**
 * The store retains the last 50 *ended* sessions for the audit trail, and the
 * list returns them, so `count` is the size of the audit list rather than the
 * number of live processes. A panel that showed it as "Processes 1" with a
 * finished session in it would be wrong in the one way this panel exists to
 * avoid. Live means `endedAt === null`.
 *
 * **No close control, and the reason is in the data.** Closing authenticates
 * with the session's token, which is minted with the session and returned exactly
 * once, to the client that opened it; the list never carries tokens. This screen
 * opens no sessions (there is no browser terminal yet), so it holds no token and
 * can end nothing. A greyed-out button would suggest a permission the reader
 * might be granted; a sentence says what is true.
 *
 * Ended sessions are not rendered at all: the heading is "Processes", and history
 * is not a process. The count beside the heading is the live one.
 */
export function Processes({ taskId }: { taskId: string | null }) {
  const query = useQuery({
    queryKey: ['terminal', 'sessions'],
    queryFn: ({ signal }) => getTerminalSessions(signal),
    retry: false,
    // A session can expire or be opened while this panel is open, and the idle
    // deadline is stated in wall-clock time — a list that never refreshed would
    // report a deadline that has already passed.
    refetchInterval: 10_000,
  });

  if (query.isPending) {
    return (
      <div className={styles.panel}>
        <h3 className={styles.heading}>Processes</h3>
        <p className={styles.state} role="status">
          Reading sessions…
        </p>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className={styles.panel}>
        <h3 className={styles.heading}>Processes</h3>
        <p className={styles.state} role="alert">
          {query.error instanceof Error ? query.error.message : 'The session list could not be read.'}
        </p>
      </div>
    );
  }

  // Scope note: the route lists every session in the process. `taskId` is used to
  // mark the ones bound to the selected task, not to hide the others — hiding
  // them would make the panel claim a host has no running work when it does.
  const live = query.data.sessions.filter((session) => session.endedAt === null);

  return (
    <div className={styles.panel}>
      <h3 className={styles.heading}>
        Processes {live.length > 0 && <span className={styles.count}>{live.length}</span>}
      </h3>
      {live.length === 0 ? (
        <p className={styles.state}>Nothing is running.</p>
      ) : (
        <ul className={styles.list}>
          {live.map((session) => (
            <li key={session.id} className={styles.session}>
              <span className={styles.id} title={session.id}>
                {session.id.replace(/^tsess_/, '').slice(0, 8)}
              </span>
              <span className={styles.meta}>
                {session.client ?? 'unknown client'} ·{' '}
                {session.taskId === null
                  ? 'no task'
                  : session.taskId === taskId
                    ? 'this task'
                    : `task ${session.taskId}`}{' '}
                · opened {relativeTime(session.openedAt, Date.now())} · idle closes{' '}
                {new Date(session.expiresAt).toLocaleTimeString()}
              </span>
            </li>
          ))}
        </ul>
      )}
      {live.length > 0 && (
        <p className={styles.footnote}>
          Read-only: a session is closed by whoever holds the token it was opened with, and the
          list never carries one.
        </p>
      )}
    </div>
  );
}
