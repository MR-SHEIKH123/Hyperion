import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getTaskRecovery } from '../../api/tasks';
import { discardWorktree } from '../../api/worktrees';
import { Button } from '../../design-system/components/Button/Button';
import { ErrorNotice } from '../ErrorNotice/ErrorNotice';
import { relativeTime } from '../../attention/links';
import styles from './RecoveryPanel.module.css';

import type { taskToolSchema } from '../../contracts/wire/tasks';
import type { z } from 'zod';

type TaskTool = z.infer<typeof taskToolSchema>;

/**
 * What an interrupted run left, and the three things a person can do about it
 * (1.31; the read is `GET /api/{tool}/tasks/:taskId/recovery`, docs/API.md §12.4a).
 *
 * **Why this panel exists at all.** A restart demotes every `running` task run to
 * `interrupted`, and until now the only place that fact surfaced was a badge in the
 * state banner and an item in the Attention Center. Neither could answer the
 * question the state raises — what did it get as far as doing, are my edits still
 * on disk — and the answer to the second one is time-limited, because a re-run
 * adopts the leftover checkout and an orphan scan removes nothing but a human
 * eventually does.
 *
 * **The three verbs, and how honest each one can be here.** *View partial* is fully
 * wired: the step list is a real read of `task_steps`, bounded to the tail with the
 * totals over every step and `omitted` stating the difference. *Discard* is fully
 * wired: it is one JSON call, and the confirm step mirrors the backend's own rule,
 * which refuses a checkout holding work unless the caller asks twice. *Resume* is a
 * re-run (`POST /api/{tool}/run-task` with the same task id), so it only became a
 * gesture once a surface could start runs: with an `onResume` host the panel hands the
 * task id to the Code composer, and without one — Cowork and Design have no surface
 * yet, and neither does any other host — it keeps reporting the verb, its route and
 * why it cannot be pressed. The `tasks.recovery` contract stays `partial` for the
 * second reason and no longer for the first.
 *
 * **Nothing here is inferred from a missing value.** A checkout whose risk check
 * could not run is not "provably empty", an absent `stop` is "nothing was recorded
 * about why", and a bounded step list never reads as a complete one.
 */
export function RecoveryPanel({
  tool,
  taskId,
  onResume,
}: {
  tool: TaskTool;
  taskId: string;
  /**
   * A host that can start a run, which is what makes resume a gesture instead of a
   * sentence.
   *
   * Resuming an interrupted run *is* a re-run through `POST /api/{tool}/run-task` with
   * the same task id (the route whose provisioning re-attaches the leftover checkout),
   * so the verb only becomes actionable once a surface can start runs — the Code
   * composer. The host is given the task id and decides where the composer lives;
   * without one, the panel keeps reporting the verb and its route rather than showing a
   * button that would do nothing.
   */
  onResume?: (taskId: string) => void;
}) {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const query = useQuery({
    queryKey: ['recovery', tool, taskId],
    queryFn: ({ signal }) => getTaskRecovery(tool, taskId, signal),
    retry: false,
  });

  const discard = useMutation({
    mutationFn: (force: boolean) =>
      discardWorktree(query.data?.actions.discard.name ?? '', { force }),
    onSuccess: async () => {
      setConfirming(false);
      // The report and the Code lane both change the moment a directory goes away:
      // the lane counts parked tasks, and `actions.discard` describes a checkout
      // that is no longer there.
      await client.invalidateQueries();
    },
  });

  if (query.isPending) {
    return (
      <section className={styles.panel} aria-busy="true">
        <p className={styles.pending} role="status">
          Reading what the run left…
        </p>
      </section>
    );
  }

  if (query.isError) {
    return <ErrorNotice onRetry={() => void query.refetch()} />;
  }

  const report = query.data;
  const { run, partial, worktree, actions } = report;
  // The cause, as words — null when neither a code nor a message was recorded.
  const stopCaused = report.stop === null ? null : (report.stop.message ?? report.stop.code);

  if (!report.interrupted) {
    // A real answer, not a failure: the state moved on between the list and the
    // click, and saying so is more useful than an error that reads like the task
    // never existed.
    return (
      <section className={styles.panel}>
        <h3 className={styles.heading}>Nothing to recover</h3>
        <p className={styles.plain}>
          This run is <strong>{run.state}</strong>, not interrupted — it ended on its own terms, so
          there is nothing left to resume or discard.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby={`recovery-heading-${taskId}`}>
      <h3 className={styles.heading} id={`recovery-heading-${taskId}`}>
        What the run left
      </h3>

      <p className={styles.stop}>
        {stopCaused === null ? (
          // `stop` non-null is not the same as a cause being recorded: the backend
          // builds it from the reason columns, and a row can carry a completion
          // time with nothing saying why. A cause-less stop reads as what it is.
          <>Nothing was recorded about why it ended — the process went away with the run.</>
        ) : (
          <>
            {stopCaused} —{' '}
            <span title={report.stop?.at == null ? '' : new Date(report.stop.at).toLocaleString()}>
              {report.stop?.at == null ? 'time not recorded' : relativeTime(report.stop.at, Date.now())}
            </span>
          </>
        )}
      </p>

      <p className={styles.summary}>
        {partial.summary.steps} step{partial.summary.steps === 1 ? '' : 's'} ·{' '}
        {partial.summary.toolCalls} tool call{partial.summary.toolCalls === 1 ? '' : 's'} ·{' '}
        {partial.summary.failures} failure{partial.summary.failures === 1 ? '' : 's'} ·{' '}
        {partial.summary.complete
          ? `${partial.summary.tokensIn.toLocaleString()} in / ${partial.summary.tokensOut.toLocaleString()} out`
          : `${partial.summary.tokensIn.toLocaleString()} in / ${partial.summary.tokensOut.toLocaleString()} out, at least — some steps reported no counts`}
      </p>

      <h4 className={styles.subheading}>What it did</h4>
      {partial.steps.length === 0 ? (
        <p className={styles.plain}>Nothing was recorded before it stopped.</p>
      ) : (
        <ol className={styles.steps} aria-label="Recorded steps">
          {partial.steps.map((step) => (
            <li className={styles.step} key={step.step} data-ok={step.ok === false ? 'false' : 'true'}>
              <span className={styles.stepIndex}>#{step.step}</span>
              <span className={styles.stepKind}>{kindLabel(step.kind)}</span>
              {step.toolName === null ? null : <code className={styles.stepTool}>{step.toolName}</code>}
              {step.ok === false ? <span className={styles.failed}>failed</span> : null}
              {step.detail === null ? null : <span className={styles.stepDetail}>{step.detail}</span>}
            </li>
          ))}
        </ol>
      )}
      {partial.omitted > 0 ? (
        <p className={styles.omitted}>
          …and {partial.omitted} earlier step{partial.omitted === 1 ? '' : 's'} not shown: the list is
          bounded, the totals above are over all of them.
        </p>
      ) : null}

      <p className={styles.conversation}>
        {partial.conversation.durable
          ? `${partial.conversation.messages} message(s) from its last stopping point survived the restart — a re-run still starts a fresh conversation, because a killed process left no turn to answer.`
          : 'The run’s own words did not survive the restart, so a re-run starts a fresh conversation.'}
      </p>

      <h4 className={styles.subheading}>Your edits</h4>
      {worktree === null ? (
        /* Why there is nothing is the discard section's answer, not a second copy
           of it here — the two are the same fact and the action is the reason. */
        <p className={styles.plain}>No leftover checkout is on disk for this task.</p>
      ) : (
        <p className={styles.plain}>
          <code className={styles.stepTool}>{worktree.name}</code> is still on disk, last written{' '}
          <span title={new Date(worktree.lastModified).toLocaleString()}>
            {relativeTime(worktree.lastModified, Date.now())}
          </span>
          .{' '}
          {worktree.checked
            ? (worktree.risk ?? 'The check found nothing in it that a discard would lose.')
            : 'It could not be checked, so a discard would be removing it unexamined.'}{' '}
          A re-run of this task id re-attaches it (§8.1).
        </p>
      )}

      <h4 className={styles.subheading}>Resume</h4>
      {actions.resume.possible ? (
        onResume === undefined ? (
          <p className={styles.plain}>
            Resuming here means <strong>starting the task again with the same id</strong>, which
            re-attaches the checkout above. It is a re-run rather than a continuation: the continuation
            routes only move a parked run, and this one was killed mid-flight. This surface cannot start
            a run, so the request is{' '}
            <code className={styles.stepTool}>POST /api/{tool}/run-task</code> with{' '}
            <code className={styles.stepTool}>taskId {taskId}</code> — the API, the scheduler or Cowork
            can make it today.
          </p>
        ) : (
          <>
            <p className={styles.plain}>
              Resuming means <strong>starting the task again with the same id</strong>, which re-attaches
              the checkout above. It is a re-run rather than a continuation — the continuation routes
              only move a parked run, and this one was killed mid-flight — and it needs an instruction,
              because the agent rebuilds its prompt each turn and this run has no stored conversation to
              replay.
            </p>
            <div className={styles.buttons}>
              <Button
                variant="primary"
                onClick={() => {
                  onResume(taskId);
                }}
              >
                Resume in the composer
              </Button>
            </div>
          </>
        )
      ) : (
        <p className={styles.plain}>{actions.resume.reason ?? 'A re-run is not available.'}</p>
      )}

      <h4 className={styles.subheading}>Discard the leftover checkout</h4>
      {!actions.discard.possible || actions.discard.name === null ? (
        <p className={styles.plain}>
          {actions.discard.reason ?? 'There is nothing here to discard.'}
        </p>
      ) : confirming ? (
        <div className={styles.confirm} role="alert">
          <p>
            This removes <code className={styles.stepTool}>{actions.discard.name}</code> and everything
            in it.{' '}
            {worktree?.checked === false
              ? 'The check could not run, so nothing about its contents is known.'
              : (worktree?.risk ?? 'The check found nothing a discard would lose.')}
          </p>
          <div className={styles.buttons}>
            <Button
              variant="primary"
              disabled={discard.isPending}
              onClick={() => discard.mutate(actions.discard.requiresForce)}
            >
              {discard.isPending ? 'Discarding…' : 'Yes, discard it'}
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.buttons}>
          <Button disabled={discard.isPending} onClick={() => setConfirming(true)}>
            Discard the leftover checkout
          </Button>
          {actions.discard.requiresForce ? (
            <p className={styles.plain}>
              It holds work, so the backend will refuse a plain discard — this asks you first and then
              says so explicitly, rather than sending <code className={styles.stepTool}>force</code>{' '}
              quietly.
            </p>
          ) : null}
        </div>
      )}
      {discard.isError ? (
        <p className={styles.failure} role="alert">
          {discard.error instanceof Error ? discard.error.message : 'The discard failed.'}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The recorded kind, as words.
 *
 * Unknown kinds fall through to the raw value rather than to a placeholder: the
 * union is open by design (migration `017` dropped the CHECK that used to constrain
 * the column), so a new kind must render as itself the first time it appears.
 */
function kindLabel(kind: string): string {
  switch (kind) {
    case 'tool_call':
      return 'tool call';
    case 'compression':
      return 'compaction';
    default:
      return kind;
  }
}
