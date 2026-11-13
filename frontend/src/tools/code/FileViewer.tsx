/**
 * The Files tab's read pane (docs/API.md §27.2): one file's text, line-numbered,
 * and every refusal the route can answer rendered as the sentence it wrote.
 *
 * **The states are the backend's refusals, not invented ones.** Too large is
 * 400 `bad_request` with `details.bytes` and `details.limitBytes` — both
 * numbers, shown, because "too large" without the two figures is a claim the
 * user cannot check. A file that is no longer there is 404 — and this workspace
 * changes while the user looks at it, so the honest sentence is that the agent
 * has since deleted it, not a generic not-found. Non-UTF8 is the route's own
 * "not valid UTF-8 text" line, upgraded with the byte count from the tree's
 * listing (the same cached root read the tree makes, so no second request). A
 * scope violation (a symlink the reader will not cross, `.git`) renders as the
 * refusal it is.
 *
 * **The content is text and only text.** Line numbers are `aria-hidden`
 * decoration; the file's own bytes are children of a `<code>` element — HTML
 * in a file is displayed, never parsed, which the tests pin by planting a
 * tag in the payload and asserting the document does not grow the element it
 * names.
 */
import { useQuery } from '@tanstack/react-query';

import { getTaskFile, getTaskFiles } from '../../api/canvas';
import { ApiError } from '../../api/errors';
import styles from './CanvasTabs.module.css';

export function FileViewer({ taskId, path }: { taskId: string; path: string | null }) {
  // The tree's root listing, by the same key: one network read serves both
  // panes, and its entries carry the byte count a binary refusal needs.
  const root = useQuery({
    queryKey: ['canvas', 'files', taskId, '.'],
    queryFn: ({ signal }) => getTaskFiles(taskId, '.', signal),
    retry: false,
  });
  const bytesFor = (target: string): number | null =>
    root.data?.entries.find((entry) => entry.path === target)?.bytes ?? null;

  const file = useQuery({
    queryKey: ['canvas', 'file', taskId, path ?? ''],
    queryFn: ({ signal }) => getTaskFile(taskId, path ?? '', signal),
    enabled: path !== null && path !== '',
    retry: false,
  });

  if (path === null || path === '') {
    return (
      <div className={styles.viewer}>
        <p className={styles.note}>Select a file to read it.</p>
      </div>
    );
  }
  if (file.isPending) {
    return (
      <div className={styles.viewer} aria-busy="true">
        <p role="status" className={styles.note}>
          Reading file…
        </p>
      </div>
    );
  }
  if (file.isError) {
    const error = file.error;
    const bytes = bytesFor(path);
    if (error instanceof ApiError && error.code === 'bad_request') {
      const details = (error.details ?? {}) as { bytes?: number; limitBytes?: number };
      if (typeof details.bytes === 'number' && typeof details.limitBytes === 'number') {
        return (
          <div className={styles.viewer}>
            <p role="alert">
              {path} is too large to show: {String(details.bytes)} bytes read, the{' '}
              {String(details.limitBytes)}-byte limit.
            </p>
          </div>
        );
      }
      if (/not valid UTF-8 text/i.test(error.message)) {
        return (
          <div className={styles.viewer}>
            <p role="alert">
              {path} is a binary file
              {bytes !== null ? `, ${String(bytes)} bytes` : ''} — only text files are shown.
            </p>
          </div>
        );
      }
    }
    if (error instanceof ApiError && error.code === 'not_found') {
      return (
        <div className={styles.viewer}>
          <p role="alert">{path} is not in the workspace — the agent has since deleted it.</p>
        </div>
      );
    }
    return (
      <div className={styles.viewer}>
        <p role="alert">{path} could not be read: {error.message}</p>
      </div>
    );
  }

  const content = file.data.content;
  const lines = content.split('\n');
  // A trailing newline is a real empty last line, not a terminator to swallow:
  // the reader sees the file exactly as the backend sent it.
  const total = content.endsWith('\n') ? lines.length - 1 : lines.length;

  return (
    <div className={styles.viewer}>
      <p className={styles.note}>
        {path} · {String(total)} {total === 1 ? 'line' : 'lines'}
      </p>
      <pre className={styles.code}>
        <code>
          {lines.slice(0, content.endsWith('\n') ? -1 : undefined).map((line, index) => (
            <span key={index} className={styles.line}>
              <span className={styles.lineNumber} aria-hidden="true">
                {String(index + 1).padStart(String(Math.max(total, 1)).length, ' ')}
              </span>
              {line === '' ? ' ' : line}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
