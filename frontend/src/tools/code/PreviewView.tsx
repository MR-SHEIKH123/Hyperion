/**
 * The Preview tab's view (Addendum 2.4; docs/API.md §27.4) — presentational:
 * it renders one `PreviewVm` and calls back. The fetching shell is
 * `PreviewTab`; the dev harness renders these same states as fixtures, so
 * what the harness shows is the production component, not a picture of one.
 *
 * **The token never appears as text.** The iframe's `src` and the Open link's
 * `href` are the preview URL — that is what a preview *is* — but everything a
 * human reads shows the origin only. The token is authorization: printed into
 * a page it leaks to shoulder-surfers, screenshots and copied text alike, and
 * this surface also never writes it to storage or into the app's own URL.
 *
 * **The iframe is sandboxed exactly as far as a preview needs and no
 * further.** `allow-scripts allow-forms allow-pointer-lock` — scripts run
 * (a preview with no JS is not a preview), forms submit and pointer lock
 * works (a game page needs it), and `allow-same-origin` is deliberately
 * absent: the content is agent-authored and runs in an opaque origin, unable
 * to touch the app that embedded it. `referrerPolicy="no-referrer"` keeps
 * the token-bearing URL out of Referer headers when the preview's own links
 * are followed, and `title` is what names the frame to a screen reader.
 *
 * **Reload is a remount, not a location poke.** The preview is a different
 * origin, so `contentWindow.location.reload()` is a cross-origin access the
 * browser will refuse; changing the iframe's `key` makes React mount a fresh
 * frame at the same URL, which is the reload. `frameKey` is bumped by the
 * tab's debounced artifact counter and by the manual Reload button — there
 * is no file watcher by design (the backend has none; bash-only edits never
 * produce an `artifact` frame), and a button is the honest way to say so.
 */
import styles from './CanvasTabs.module.css';

/** Every state the preview region can be in — one member per honest answer. */
export type PreviewVm =
  /** The status read is in flight. */
  | { kind: 'reading' }
  /** The listener is off on this host; `setting` is the only recourse. */
  | { kind: 'disabled'; setting: string | null }
  /** The read failed (network, 5xx) — rendered with its message and a retry. */
  | { kind: 'failed'; message: string }
  /** The task no longer holds a workspace the listener will serve. */
  | { kind: 'gone'; message: string }
  /** No session has been minted for this task (by this client, anyway). */
  | { kind: 'no-session' }
  /** A session was live and is not any more; the poll said so. */
  | { kind: 'expired' }
  /** The mint (or revoke) is in flight. */
  | { kind: 'minting' }
  /** Live, but the workspace root has no `index.html` — the root URL 404s. */
  | { kind: 'no-root-html'; origin: string }
  /** Live: the frame is (or is being checked for) the root entry page. */
  | { kind: 'checking' }
  | { kind: 'live'; url: string; origin: string; expiresAt: number };

/** Under this, the remaining life is worth saying out loud. */
export const EXPIRY_NOTICE_MS = 5 * 60 * 1000;

/** `null` when the remaining life is not worth stating; `expired` past the deadline. */
export function describeRemaining(expiresAt: number, now = Date.now()): string | null {
  const remaining = expiresAt - now;
  if (remaining <= 0) return 'expired';
  if (remaining > EXPIRY_NOTICE_MS) return null;
  const minutes = Math.max(1, Math.round(remaining / 60_000));
  return `expires in ${String(minutes)} min`;
}

export interface PreviewViewProps {
  taskId: string;
  vm: PreviewVm;
  /** Explicit mint — never called by a render or a poll. */
  onStart?: () => void;
  onStop?: () => void;
  /** Manual reload, for edits that produce no `artifact` frame. */
  onReload?: () => void;
  /** The no-root-HTML state's way out: the Files tab. */
  onOpenFiles?: () => void;
  /** Bumped by the tab to remount the frame (the only reload available cross-origin). */
  frameKey?: number;
  busy?: boolean;
  /**
   * The frame's `contentWindow` on load — a handle, never its properties:
   * the preview is another origin, and this is what the Console tab's
   * message filter checks its `event.source` against so a message can only
   * come from the frame this tab loaded.
   */
  onFrameLoad?: ((win: Window | null) => void) | undefined;
}

export function PreviewView({
  taskId,
  vm,
  onStart,
  onStop,
  onReload,
  onOpenFiles,
  frameKey = 0,
  busy = false,
  onFrameLoad,
}: PreviewViewProps) {
  if (vm.kind === 'reading') {
    return (
      <p role="status">
        Reading the preview…
      </p>
    );
  }
  if (vm.kind === 'disabled') {
    return (
      <p>
        Previews are off on this host
        {vm.setting === null ? '.' : (
          <>
            {' '}— set <code>{vm.setting}</code> to a port to enable them.
          </>
        )}
      </p>
    );
  }
  if (vm.kind === 'failed' || vm.kind === 'gone') {
    return (
      <p role="alert">
        {vm.message}
      </p>
    );
  }
  if (vm.kind === 'minting') {
    return (
      <p role="status">
        Starting the preview…
      </p>
    );
  }
  if (vm.kind === 'no-session') {
    return (
      <>
        <p>No preview is running for this task.</p>
        <button type="button" disabled={busy} onClick={onStart}>
          {busy ? 'Starting…' : 'Start preview'}
        </button>
      </>
    );
  }
  if (vm.kind === 'expired') {
    return (
      <>
        <p>This task&apos;s preview expired. The URL it had is no longer served.</p>
        <button type="button" disabled={busy} onClick={onStart}>
          {busy ? 'Renewing…' : 'Renew preview'}
        </button>
      </>
    );
  }
  if (vm.kind === 'no-root-html') {
    return (
      <>
        <p>
          The preview is running on <span>{vm.origin}</span>, but this workspace has no{' '}
          <code>index.html</code> at its root, so the root URL would show the listener&apos;s
          404 rather than the task&apos;s work.
        </p>
        <p>Open the Files tab and add an <code>index.html</code>, or serve the site from the root.</p>
        <button type="button" onClick={onOpenFiles}>
          Open Files
        </button>
      </>
    );
  }
  if (vm.kind === 'checking') {
    return <p role="status">Checking the workspace&apos;s entry page…</p>;
  }

  const remaining = describeRemaining(vm.expiresAt);
  return (
    <>
      <p>
        Serving <span>{vm.origin}</span>
        {remaining !== null && <span> · {remaining}</span>}
      </p>
      <div className={styles.previewActions}>
        <a href={vm.url} target="_blank" rel="noreferrer">
          Open
        </a>
        <button type="button" onClick={onReload}>
          Reload
        </button>
        <button type="button" disabled={busy} onClick={onStop}>
          {busy ? 'Stopping…' : 'Stop'}
        </button>
      </div>
      {/* The token lives here — in the URL the frame loads — and nowhere a
          reader can select, copy or screenshot as text. */}
      <iframe
        key={frameKey}
        className={styles.previewFrame}
        src={vm.url}
        title={`Preview of task ${taskId}`}
        sandbox="allow-scripts allow-forms allow-pointer-lock"
        referrerPolicy="no-referrer"
        onLoad={(event) => {
          onFrameLoad?.(event.currentTarget.contentWindow);
        }}
      />
    </>
  );
}
