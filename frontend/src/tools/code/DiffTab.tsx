/**
 * The Diff tab (Addendum 2.4; docs/API.md §27.3): the task's changes in the
 * main surface, with the selected file's own patch as text.
 *
 * **The list is the inspector's list, not a second one.** `ChangedFiles` is
 * embedded whole — one query key, one parser, one set of states — so the two
 * surfaces cannot drift into disagreeing about what changed. What the tab adds
 * is what the session panel's slice has no room for: the selected file's
 * section of the patch, rendered as text (a text node, so HTML in a patch
 * stays display), and the states that name their facts.
 *
 * **The direct-mode state is the backend's sentence with its facts beside
 * it.** A `direct` task has no base commit; the exporter answers 400 with
 * `details.mode` and `details.reason`, and §27.3 prescribes exactly what a
 * caller does with that: an honest empty state — "no base to compare against"
 * — never a blank panel and never an empty change list. The generic
 * section-failure notice would be a *different* claim (something broke) about
 * a fact (this task never had a base), so it is not used here.
 *
 * **A file that is not in the diff says so.** `?file=` is shared with the
 * tree and the versions timeline, so it can legitimately name a file the task
 * did not change — the tab says that rather than showing nothing where a
 * patch was promised.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { getTaskDiff } from '../../api/canvas';
import { ApiError } from '../../api/errors';
import { ChangedFiles } from './ChangedFiles';
import { splitPatch } from './patch';
import styles from './CanvasTabs.module.css';

type DirectModeRefusal = { message: string; mode: string; reason: string | null };

/** The exporter's 400 for a task with no base commit, or null for anything else. */
function directModeRefusal(error: unknown): DirectModeRefusal | null {
  if (!(error instanceof ApiError) || error.code !== 'bad_request') return null;
  const details = (error.details ?? {}) as { mode?: unknown; reason?: unknown };
  if (typeof details.mode !== 'string') return null;
  return {
    message: error.message,
    mode: details.mode,
    reason: typeof details.reason === 'string' ? details.reason : null,
  };
}

export function DiffTab({
  taskId,
  file,
  onSelectFile,
}: {
  taskId: string;
  file: string | null;
  onSelectFile: (path: string) => void;
}) {
  const query = useQuery({
    queryKey: ['canvas', 'diff', taskId],
    queryFn: ({ signal }) => getTaskDiff(taskId, signal),
    retry: false,
  });

  // Same key as the inspector's list: one network read serves both, and this
  // parse runs only when the patch string actually changes.
  const summary = useMemo(
    () => splitPatch(query.data?.patch ?? ''),
    [query.data?.patch],
  );

  if (query.isPending) {
    return (
      <p className={styles.note} role="status">
        Reading the task&apos;s diff…
      </p>
    );
  }

  if (query.isError) {
    const refusal = directModeRefusal(query.error);
    if (refusal !== null) {
      return (
        <div className={styles.diffState} role="alert">
          <p>
            <strong>No base to compare against.</strong> {refusal.message}
          </p>
          <p className={styles.note}>
            This task ran in <code>{refusal.mode}</code> mode
            {refusal.reason === null ? '' : <>: {refusal.reason}</>} — the diff route works only
            for a task whose worktree was cut from a commit.
          </p>
        </div>
      );
    }
    return (
      <div className={styles.diffState} role="alert">
        <p>The task&apos;s diff could not be read: {query.error.message}</p>
        <button type="button" className={styles.retry} onClick={() => void query.refetch()}>
          Try again
        </button>
      </div>
    );
  }

  const selected = file === null ? undefined : summary.files.find((entry) => entry.path === file);

  return (
    <div className={styles.diffLayout}>
      {/* The inspector's own list, embedded: totals, per-file counts, the
          base commit, the truncation notice. One implementation. */}
      <ChangedFiles taskId={taskId} selectedPath={file} onSelect={onSelectFile} />
      <div className={styles.diffPatch}>
        {file === null ? (
          <p className={styles.note}>Select a changed file to read its patch here.</p>
        ) : selected === undefined ? (
          // `?file=` is shared with the tree and the timeline; a file the task
          // did not change is a fact about the file, not a failure of the diff.
          <p className={styles.note}>
            {file} is not among this task&apos;s changed files.
          </p>
        ) : (
          <>
            <p className={styles.note}>
              {selected.path}
              {selected.isNew ? ' · added' : selected.isDeleted ? ' · deleted' : ''}
              {selected.isBinary ? ' · binary' : ''}
            </p>
            <pre className={styles.code}>
              {/* One text node: patch text is data, and a `<` in it is a
                  character, never a tag. */}
              {selected.patch}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
