import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { getTaskDiff } from '../../api/canvas';
import { ErrorNotice } from '../../components/ErrorNotice/ErrorNotice';
import { splitPatch } from './patch';
import styles from './ChangedFiles.module.css';

/**
 * The changed-file list for a Code task (the session panel's first slice).
 *
 * **What it is for.** The question a reader has about a task that has been
 * running is "what did it actually change", and the answer is a list of paths
 * with how much moved in each — not a wall of patch. Clicking a file hands the
 * path to the surface, which is what fills the frame's other regions: the file
 * becomes `?file=`, and the version timeline reads it from there.
 *
 * **What it deliberately does not claim.** The diff is against the task's
 * **base commit**, not against the previous step. The backend cannot answer "what
 * changed in step k" — `artifact_versions` rows carry no step id, and rows backed
 * by `rel_path` die with the worktree — so this list is not labelled per turn and
 * must never be. The header names the base commit instead, which is the fact the
 * route actually reports.
 *
 * **Every empty and missing case is named.** A direct-mode task has no base
 * commit, and the backend answers with a reasoned 400 rather than an empty patch
 * — that refusal is rendered as written. A task that has changed nothing renders
 * as "no changes", which is an answer; a *failed* read renders as a failure. The
 * one thing this must never do is show a dropped read as an empty list.
 */
export function ChangedFiles({
  taskId,
  selectedPath,
  onSelect,
}: {
  taskId: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const query = useQuery({
    queryKey: ['canvas', 'diff', taskId],
    queryFn: ({ signal }) => getTaskDiff(taskId, signal),
    retry: false,
  });

  // Parsing is pure, so it belongs in render but not in it twice: a poll that
  // returns the same patch string must not re-parse a 400-file diff.
  const patch = query.data?.patch ?? '';
  const summary = useMemo(() => splitPatch(patch), [patch]);

  return (
    <div className={styles.panel}>
      <h3 className={styles.heading}>Changes</h3>

      {query.isPending ? (
        <p className={styles.empty} role="status">
          Reading the task&apos;s diff…
        </p>
      ) : query.isError ? (
        // The backend's own sentence, code included: for a direct-mode task that
        // is the explanation of why there is no diff to show.
        <ErrorNotice onRetry={() => void query.refetch()} />
      ) : (
        <>
          <p className={styles.totals}>
            {summary.files.length === 0
              ? 'No changes against the base commit.'
              : `${String(summary.files.length)} file${summary.files.length === 1 ? '' : 's'} · +${String(summary.additions)} −${String(summary.deletions)}`}
          </p>
          {summary.files.length > 0 && (
            <ul className={styles.list}>
              {summary.files.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    className={file.path === selectedPath ? styles.fileSelected : styles.file}
                    onClick={() => {
                      onSelect(file.path);
                    }}
                    title={file.isBinary ? `${file.path} (binary)` : file.path}
                  >
                    <span className={styles.path}>{file.path}</span>
                    <span className={styles.counts} aria-label="lines changed">
                      {file.isBinary ? (
                        <span className={styles.binary}>binary</span>
                      ) : (
                        <>
                          <span className={styles.added}>+{file.additions}</span>
                          <span className={styles.removed}>−{file.deletions}</span>
                        </>
                      )}
                    </span>
                  </button>
                  {(file.isNew || file.isDeleted) && (
                    <span className={styles.badge}>
                      {file.isNew ? 'added' : 'deleted'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className={styles.meta}>against {query.data.baseCommit.slice(0, 12)}</p>
        </>
      )}
    </div>
  );
}
