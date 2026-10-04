import { ErrorNotice } from '../../components/ErrorNotice/ErrorNotice';
import { VersionTimeline } from '../../components/Provenance/ProvenancePanel';
import { relativeTime } from '../../attention/links';
import styles from './SelectionTimeline.module.css';

import type { ArtifactVersion } from '../../contracts/wire/provenance';
import type { recoveryReportSchema } from '../../contracts/wire/tasks';
import type { z } from 'zod';

type RecoveryReport = z.infer<typeof recoveryReportSchema>;

/**
 * The rail's two reads, side by side: the selected file's version stack and the
 * task's step list (the session panel's fourth slice).
 *
 * **Why they are side by side and not joined.** Arena scopes a diff to the last
 * turn; Hyperion cannot, and the reason is in the data rather than in the UI: an
 * `artifact_versions` row records the file it replaced, not the step that wrote
 * it, and no run or step id is stored with it. A view that showed a version "as of
 * step k" would be inventing the relation. So the two lists sit beside each other
 * with a sentence saying what they are, and the reader does the correlating.
 *
 * **Every absence is named.** No file selected says how to select one; no task
 * selected says that; a run with no steps says so rather than rendering an empty
 * box; a failed read is a failure with a retry, never an empty list. The version
 * list itself keeps the component that already states its own empty case (a file
 * that has never been edited through the tools has no versions).
 *
 * Presentational on purpose — the surface owns the queries, exactly as
 * `ProvenancePanel` splits its query from its views, so this can be tested and
 * read without a server.
 */

interface QueryView<T> {
  isPending: boolean;
  isError: boolean;
  data: T | undefined;
}

export function StepList({ report }: { report: RecoveryReport }) {
  const { steps, summary, omitted } = report.partial;
  if (steps.length === 0) {
    return <p className={styles.empty}>No steps are recorded for this run.</p>;
  }
  return (
    <>
      <p className={styles.summary}>
        {summary.steps} steps · {summary.toolCalls} tool calls · {summary.failures} failures
        {/* `complete: false` means at least one step had no counts to add, so the
            totals are a floor — carried through rather than smoothed over. */}
        {summary.complete ? '' : ' · some steps reported no counts, so these are floors'}
      </p>
      <ol className={styles.list} aria-label="Run steps">
        {steps.map((step) => (
          <li className={styles.step} key={`${step.runId}:${String(step.step)}`}>
            <span className={styles.stepNumber}>#{step.step}</span>
            <span className={styles.stepBody}>
              <span className={styles.stepKind}>
                {step.kind}
                {step.toolName === null ? '' : ` · ${step.toolName}`}
                {step.ok === null ? '' : step.ok ? ' · ok' : ' · failed'}
              </span>
              <span className={styles.stepMeta}>
                {relativeTime(step.createdAt, Date.now())}
                {step.detail === null ? '' : ` · ${step.detail}`}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {omitted > 0 && (
        // The list is tail-bounded, and the bound is stated: a list that silently
        // showed the last 20 steps would read as the whole run.
        <p className={styles.note}>
          Showing the last {steps.length} of {summary.steps} steps; {omitted} earlier{' '}
          {omitted === 1 ? 'step is' : 'steps are'} not listed.
        </p>
      )}
    </>
  );
}

export interface SelectionTimelineProps {
  /** The task whose steps to show, or null when none is selected. */
  taskId: string | null;
  /** The file whose versions to show, or null when none is selected. */
  file: string | null;
  versions: QueryView<ArtifactVersion[]>;
  onRetryVersions: () => void;
  steps: QueryView<RecoveryReport>;
  onRetrySteps: () => void;
}

export function SelectionTimeline(props: SelectionTimelineProps) {
  const { taskId, file, versions, steps } = props;
  return (
    <div className={styles.panel}>
      <div className={styles.column}>
        <h3 className={styles.heading}>Versions</h3>
        {file === null ? (
          <p className={styles.empty}>
            Name a file with <code>?file=</code> — the list above writes it — to see its version
            history. Versions are written per file, before each edit, so they belong to a file
            rather than to the task.
          </p>
        ) : versions.isPending ? (
          <p className={styles.empty} role="status">
            Reading versions…
          </p>
        ) : versions.isError ? (
          <ErrorNotice onRetry={props.onRetryVersions} />
        ) : (
          <VersionTimeline versions={versions.data ?? []} />
        )}
      </div>
      <div className={styles.column}>
        <h3 className={styles.heading}>Steps</h3>
        {taskId === null ? (
          <p className={styles.empty}>Select a task to see the steps its run recorded.</p>
        ) : file === null ? (
          // The read is deliberately not made until a file is named: the recovery
          // route runs a worktree check for every caller, and this column is only
          // meaningful beside a version stack.
          <p className={styles.empty}>
            Select a changed file to read the run's steps beside its versions.
          </p>
        ) : steps.isPending ? (
          <p className={styles.empty} role="status">
            Reading steps…
          </p>
        ) : steps.isError ? (
          <ErrorNotice onRetry={props.onRetrySteps} />
        ) : steps.data === undefined ? (
          <p className={styles.empty}>No steps are recorded for this run.</p>
        ) : (
          <StepList report={steps.data} />
        )}
      </div>
      <p className={styles.note}>
        These two lists are not joined: a version records the file it replaced, not the step that
        wrote it, so nothing here shows "content as of step k".
      </p>
    </div>
  );
}
