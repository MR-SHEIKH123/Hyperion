import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getPreviewStatus, mintPreview, revokePreview } from '../../api/canvas';
import { ApiError } from '../../api/errors';
import styles from './PreviewRow.module.css';

/**
 * The live preview for a Code task: whether one is running, where, and the two
 * controls that change that (the session panel's second slice).
 *
 * **Why it reads instead of minting to display.** Minting *replaces* the session
 * — that is how revocation works — so a row that minted in order to show a link
 * would revoke the one a user already has open, on every render. `GET
 * .../preview` changes nothing, which is what lets this be a plain query.
 *
 * **Three states that are not the same thing, and are not rendered as one.**
 *
 *   1. *The listener is off on this host* — the read answers `capability_disabled`
 *      and the row says so, naming `HYPERION_PREVIEW_PORT` as the setting. This
 *      is a fact about the host, not about the task, and offering a Start button
 *      here would promise something the server will refuse.
 *   2. *No preview is running* — a fact about the task; the row offers to start
 *      one.
 *   3. *A preview is live* — the row shows its origin, offers to open it, and
 *      offers to stop it. The URL is shown rather than hidden behind a button
 *      because the origin **is** the answer: a reader wants to know what is
 *      being served and from where.
 *
 * The expiry is stated when it is close. A row that showed a link which silently
 * stopped working 30 minutes after minting would be the same class of lie as a
 * dropped read rendered as an empty list.
 */

/** Under this, the remaining life is worth saying out loud. */
const EXPIRY_NOTICE_MS = 5 * 60 * 1000;

function describeRemaining(expiresAt: number, now = Date.now()): string | null {
  const remaining = expiresAt - now;
  if (remaining <= 0) return 'expired';
  if (remaining > EXPIRY_NOTICE_MS) return null;
  const minutes = Math.max(1, Math.round(remaining / 60_000));
  return `expires in ${String(minutes)} min`;
}

export function PreviewRow({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['canvas', 'preview', taskId],
    queryFn: ({ signal }) => getPreviewStatus(taskId, signal),
    retry: false,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['canvas', 'preview', taskId] });
  };

  const start = useMutation({ mutationFn: () => mintPreview(taskId), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: () => revokePreview(taskId), onSuccess: invalidate });

  const disabled =
    query.error instanceof ApiError && query.error.code === 'capability_disabled'
      ? query.error
      : null;
  const preview = query.data?.preview ?? null;
  const failure = start.error ?? stop.error;
  const busy = start.isPending || stop.isPending;

  return (
    <div className={styles.panel}>
      <h3 className={styles.heading}>Preview</h3>

      {query.isPending ? (
        <p className={styles.state} role="status">
          Reading the preview…
        </p>
      ) : disabled !== null ? (
        // Named, not merely refused: the reader can act on a setting name.
        <p className={styles.state}>
          Previews are off on this host
          {typeof disabled.details?.setting === 'string' ? (
            <>
              {' '}
              — set <code className={styles.code}>{disabled.details.setting}</code> to a port to
              enable them.
            </>
          ) : (
            '.'
          )}
        </p>
      ) : query.isError ? (
        <p className={styles.state} role="alert">
          {query.error instanceof Error ? query.error.message : 'The preview state could not be read.'}
        </p>
      ) : preview === null ? (
        <>
          <p className={styles.state}>No preview is running for this task.</p>
          <button
            type="button"
            className={styles.action}
            disabled={busy}
            onClick={() => {
              start.mutate();
            }}
          >
            {start.isPending ? 'Starting…' : 'Start preview'}
          </button>
        </>
      ) : (
        <>
          <p className={styles.state}>
            Serving <span className={styles.origin}>{previewOrigin(preview.url)}</span>
          </p>
          {describeRemaining(preview.expiresAt) !== null && (
            <p className={styles.meta}>{describeRemaining(preview.expiresAt)}</p>
          )}
          <div className={styles.actions}>
            <a className={styles.action} href={preview.url} target="_blank" rel="noreferrer" aria-label="Open preview">
              Open
            </a>
            <button
              type="button"
              className={styles.action}
              disabled={busy}
              onClick={() => {
                stop.mutate();
              }}
            >
              {stop.isPending ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        </>
      )}

      {failure !== null && (
        <p className={styles.state} role="alert">
          {failure instanceof Error ? failure.message : 'The preview could not be changed.'}
        </p>
      )}
    </div>
  );
}

function previewOrigin(value: string): string {
  try { return new URL(value).origin; } catch { return 'Preview origin unavailable'; }
}
