/**
 * The Preview tab's shell (Addendum 2.4; docs/API.md §27.4): reads the
 * session, derives one `PreviewVm`, and owns the three pieces of state the
 * view cannot — the last expiry it saw, the debounced reload counter, and
 * the frame handle the Console tab will filter messages by.
 *
 * **A read, never a mint, to display.** `POST .../preview` replaces the
 * session — that is how revocation works — so a tab that minted in order to
 * show a frame would revoke the URL the user already has open, on every
 * render and every poll. The query is a `GET` with a 10-second interval
 * (paused with the tab, like every interval the app sets), and minting
 * happens on the Start button and nowhere else.
 *
 * **"Expired" is a fact the client remembers, because the server forgets.**
 * An expired session is *dropped* (§27.4): the next poll answers
 * `{preview: null}`, which is indistinguishable from "never started" unless
 * something saw the session while it lived. The tab remembers the last
 * `expiresAt` it was told about and reads the flip to null against it — a
 * dropped read is never rendered as an empty state, and an expired session
 * is never rendered as "no preview running", because those are different
 * answers to "where did it go". A `404` outranks both: a released worktree
 * is a gone workspace, not an expiry.
 *
 * **Reload on `artifact` frames, debounced, with a manual escape.** The
 * agent stream's `artifact` channel is what a save/edit produces, so the
 * frame remounts 350 ms after the burst settles — one reload per save, not
 * one per frame of a multi-file write. The counter only advances for the
 * task this tab is showing (the surface may be streaming a different task's
 * run), starts at the value already on screen (no reload on mount), and
 * carries a manual Reload for the edits that make no frame at all: bash
 * writes produce no `artifact`, and the backend has no file watcher to
 * notice them with — a button states that boundary instead of pretending
 * the frame is live-watched.
 *
 * **The entry page comes from the tree, not from loading the URL.** The
 * root URL serves `index.html` or a 404 (§27.4, `previewServer.ts`), so
 * whether to embed at all is answered by the same cached root listing the
 * Files tab reads — probing the preview URL with a hidden frame would show
 * the user the 404 first and ask questions later.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getPreviewStatus, getTaskFiles, mintPreview, revokePreview } from '../../api/canvas';
import { ApiError } from '../../api/errors';
import { PreviewView, type PreviewVm } from './PreviewView';

/** One reload per settled burst of `artifact` frames, not one per frame. */
const RELOAD_DEBOUNCE_MS = 350;

export function PreviewTab({
  taskId,
  writeRevision = 0,
  onOpenFiles,
  onFrameLoad,
}: {
  taskId: string;
  /**
   * A counter of `artifact` frames for *this* task from the surface's run
   * stream — bumped by saves and edits, and by nothing else.
   */
  writeRevision?: number;
  onOpenFiles: () => void;
  /**
   * The frame's `contentWindow` on load — handed up so the Console tab can
   * check `event.source` against the frame this surface loaded. A handle
   * only: cross-origin, it proves which frame spoke and reads nothing.
   */
  onFrameLoad?: (win: Window | null) => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['canvas', 'preview', taskId],
    queryFn: ({ signal }) => getPreviewStatus(taskId, signal),
    retry: false,
    refetchInterval: 10_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['canvas', 'preview', taskId] });
  };
  const mint = useMutation({ mutationFn: () => mintPreview(taskId), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: () => revokePreview(taskId), onSuccess: invalidate });

  const preview = query.data?.preview ?? null;

  // The last session this tab was told about. Kept across polls that answer
  // null, so the flip from "live" to "null" reads as an expiry rather than
  // as never having run. The component remounts per task (the surface keys
  // it), so this cannot leak one task's session into another's states.
  const [lastExpiry, setLastExpiry] = useState<number | null>(null);
  if (preview !== null && lastExpiry !== preview.expiresAt) {
    setLastExpiry(preview.expiresAt);
  }

  // The workspace root's `index.html` — from the same cached listing the
  // Files tab reads, and only once there is a session to embed.
  const tree = useQuery({
    queryKey: ['canvas', 'files', taskId, '.'],
    queryFn: ({ signal }) => getTaskFiles(taskId, '.', signal),
    enabled: preview !== null,
    retry: false,
  });

  // Debounced reload: one remount after an artifact burst settles. The
  // initial value is the revision already on screen — mounting the tab must
  // not reload a frame that just loaded.
  const [frameKey, setFrameKey] = useState(0);
  const appliedRevision = useRef(writeRevision);
  useEffect(() => {
    if (writeRevision === appliedRevision.current) return;
    appliedRevision.current = writeRevision;
    const timer = setTimeout(() => setFrameKey((key) => key + 1), RELOAD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [writeRevision]);

  const vm: PreviewVm = useMemo(() => {
    if (query.isPending) return { kind: 'reading' };
    if (query.isError) {
      const error = query.error;
      if (error instanceof ApiError && error.code === 'capability_disabled') {
        const setting =
          typeof error.details?.setting === 'string' ? error.details.setting : null;
        return { kind: 'disabled', setting };
      }
      if (error instanceof ApiError && error.code === 'not_found') {
        return { kind: 'gone', message: error.message };
      }
      return {
        kind: 'failed',
        message: error instanceof Error ? error.message : 'The preview state could not be read.',
      };
    }
    if (mint.isPending || stop.isPending) return { kind: 'minting' };
    if (preview !== null) {
      // No clock read here: the server drops an expired session before it
      // answers (§27.4), so a session in the payload is a live one, and the
      // flip to null is what `lastExpiry` turns into the expired state. The
      // view states the remaining life itself, from its own render clock.
      if (tree.isPending) return { kind: 'checking' };
      if (tree.isError) {
        // The secondary read failed; the frame itself is the authority on
        // what the root serves, so it loads and the reader sees the truth.
        return {
          kind: 'live',
          url: preview.url,
          origin: new URL(preview.url).origin,
          expiresAt: preview.expiresAt,
        };
      }
      const hasRootHtml = tree.data.entries.some((entry) => entry.path === 'index.html');
      if (!hasRootHtml) {
        return { kind: 'no-root-html', origin: new URL(preview.url).origin };
      }
      return {
        kind: 'live',
        url: preview.url,
        origin: new URL(preview.url).origin,
        expiresAt: preview.expiresAt,
      };
    }
    if (lastExpiry !== null) return { kind: 'expired' };
    return { kind: 'no-session' };
  }, [
    query.isPending,
    query.isError,
    query.error,
    mint.isPending,
    stop.isPending,
    preview,
    tree.isPending,
    tree.isError,
    tree.data,
    lastExpiry,
  ]);

  return (
    <PreviewView
      taskId={taskId}
      vm={vm}
      frameKey={frameKey}
      busy={mint.isPending || stop.isPending}
      onStart={() => {
        mint.mutate();
      }}
      onStop={() => {
        stop.mutate();
      }}
      onReload={() => setFrameKey((key) => key + 1)}
      onOpenFiles={onOpenFiles}
      onFrameLoad={onFrameLoad}
    />
  );
}
