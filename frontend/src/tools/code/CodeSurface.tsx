import { Link } from 'react-router-dom';
import type { z } from 'zod';

import { ErrorNotice } from '../../components/ErrorNotice/ErrorNotice';
import styles from './CodeSurface.module.css';

type Lane = z.infer<typeof import('../../contracts/wire/tasks').codeLaneSchema>;
type TaskSpend = z.infer<typeof import('../../contracts/wire/tasks').taskUsageSchema>;

/**
 * The Code lane's rail, and a task's recorded spend — split out of the page so the
 * dev harness can render every state without a server (1.39 A4), and so the two
 * facts that are easy to render dishonestly get named once.
 *
 * The honesty rules live here rather than in the page: `requests: 0` is reported as
 * *nothing recorded* rather than a zero, a null cost is *unpriced* rather than
 * `$0.00`, and parked tasks are listed apart from running ones because they hold
 * disk, not a lane slot.
 */
export function CodeLaneRail({
  lane,
  isPending,
  isError,
  selectedTaskId,
}: {
  lane: Lane | undefined;
  isPending: boolean;
  isError: boolean;
  selectedTaskId: string | null;
}) {
  if (isPending) return <p className={styles.idle}>Reading the lane…</p>;
  if (isError || lane === undefined) return <ErrorNotice />;
  return (
    <div className={styles.rail}>
      <p className={styles.capacity}>
        {lane.running} of {lane.limit} lane slots running
        {lane.queued > 0 ? ` · ${String(lane.queued)} queued` : ''}
      </p>

      {lane.active.length === 0 ? (
        <p className={styles.idle}>Nothing is running on the Code lane right now.</p>
      ) : (
        <ul className={styles.list} aria-label="Running code tasks">
          {lane.active.map((slot) => (
            <li key={slot.id}>
              {slot.taskId === null ? (
                <span className={styles.meta}>{slot.label ?? 'A task with no id yet'}</span>
              ) : (
                <Link
                  className={slot.taskId === selectedTaskId ? styles.selected : styles.link}
                  to={`/code?task=${encodeURIComponent(slot.taskId)}`}
                  aria-current={slot.taskId === selectedTaskId ? 'true' : undefined}
                >
                  {slot.label ?? slot.taskId}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      {lane.held.length > 0 && (
        <>
          {/* Held worktrees are named separately because they mean something
              different from "running": the task is parked, and its directory is
              being kept on purpose. */}
          <h3 className={styles.heading}>Parked, holding their worktree</h3>
          <ul className={styles.list} aria-label="Parked code tasks">
            {lane.held.map((held) => (
              <li key={held.taskId}>
                <Link
                  className={held.taskId === selectedTaskId ? styles.selected : styles.link}
                  to={`/code?task=${encodeURIComponent(held.taskId)}`}
                  aria-current={held.taskId === selectedTaskId ? 'true' : undefined}
                >
                  {held.taskId}
                </Link>
                <span className={styles.meta}> · {held.state ?? 'state unknown'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}


export function TaskSpend({
  taskId,
  usage,
  isPending,
  isError,
}: {
  taskId: string;
  usage: TaskSpend | undefined;
  isPending: boolean;
  isError: boolean;
}) {
  if (isPending) return <p className={styles.idle} role="status">Reading the task…</p>;
  if (isError || usage === undefined) return <ErrorNotice />;
  const unpriced = usage.unpricedRequests > 0;
  return (
    <div className={styles.summary}>
      <h2 className={styles.taskTitle}>{taskId}</h2>
      <dl className={styles.facts}>
        <div>
          <dt>Requests recorded</dt>
          <dd>{usage.requests === 0 ? 'none — nothing was recorded, which is not the same as free' : String(usage.requests)}</dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>{usage.runs}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>
            {usage.tokensIn} in · {usage.tokensOut} out
          </dd>
        </div>
        <div>
          <dt>Spend</dt>
          <dd>
            {usage.costUsd === null
              ? 'unpriced — no price row matched this model'
              : `$${usage.costUsd.toFixed(4)}${usage.priced ? '' : ' (a floor: some requests are unpriced)'}`}
            {unpriced ? ` · ${String(usage.unpricedRequests)} unpriced` : ''}
          </dd>
        </div>
      </dl>
    </div>
  );
}

