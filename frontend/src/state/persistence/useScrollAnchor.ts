import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { usePersistenceStore } from './PersistenceProvider';
import {
  anchorForRows,
  isAtBottom,
  scrollTopForAnchor,
  type RowBox,
  type ScrollMetrics,
} from './scrollAnchor';

/**
 * Remembers where the reader was in a scrolling surface, and stops following the
 * tail the moment they scroll away from it (1.39 A5, presentation memory only).
 *
 * Three rules, in the order they matter:
 *
 * 1. **Restore before paint, once per view.** The remembered anchor is applied in a
 *    layout effect so a reopened conversation appears where it was left rather than
 *    flashing at the bottom and jumping. If the anchored row is gone — a tail that
 *    scrolled out of the loaded page — the anchor is dropped rather than guessed at,
 *    and the view falls back to the bottom, which is the honest default.
 * 2. **Follow only while at the bottom.** Growth moves the view only if the viewport
 *    was already at the end; scrolling up suspends following until the reader returns
 *    to the bottom themselves. This is the difference between a transcript and a page
 *    that fights the reader on every streamed token.
 * 3. **Record the anchor, debounced, and on the way out.** Scroll events fire in
 *    bursts; the write is debounced, and the last position is flushed when the surface
 *    unmounts (navigating away is exactly when the position needs saving).
 *
 * The write goes through `PersistenceStore`, so the remembered value is a number and
 * an id — never the content of what was being read.
 */
export function useScrollAnchor(
  containerRef: RefObject<HTMLElement | null>,
  viewKey: string,
  rows: readonly { id: string }[],
  options: { enabled?: boolean } = {},
): void {
  const store = usePersistenceStore();
  const enabled = options.enabled ?? true;
  const restoredFor = useRef<string | null>(null);
  const following = useRef(true);
  const timer = useRef<number | null>(null);
  const rowCount = rows.length;

  const readRows = useCallback((container: HTMLElement): { rows: RowBox[]; metrics: ScrollMetrics } => {
    const containerTop = container.getBoundingClientRect().top;
    const boxes: RowBox[] = [];
    for (const element of container.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const id = element.dataset.messageId;
      if (id === undefined || id === '') continue;
      const rect = element.getBoundingClientRect();
      // Rows are read in the container's frame, so every rule below is stated
      // against 0 rather than against wherever the container happens to sit.
      boxes.push({ id, top: rect.top - containerTop, bottom: rect.bottom - containerTop });
    }
    return {
      rows: boxes,
      metrics: {
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
      },
    };
  }, []);

  const record = useCallback(
    (container: HTMLElement) => {
      const { rows: boxes } = readRows(container);
      const anchor = anchorForRows(boxes);
      if (anchor !== null) store.setScrollAnchor(viewKey, anchor);
    },
    [readRows, store, viewKey],
  );

  // Position: restore once per view, then follow the tail only if allowed to.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!enabled || container === null || rowCount === 0) return;

    if (restoredFor.current !== viewKey) {
      restoredFor.current = viewKey;
      const anchor = store.snapshot().scrollAnchors[viewKey];
      if (anchor !== undefined) {
        const { rows: boxes, metrics } = readRows(container);
        const row = boxes.find((box) => box.id === anchor.anchorId);
        if (row !== undefined) {
          container.scrollTop = scrollTopForAnchor(
            anchor,
            row,
            metrics.scrollTop,
            metrics.scrollHeight - metrics.clientHeight,
          );
          following.current = isAtBottom({ ...metrics, scrollTop: container.scrollTop });
          return;
        }
        // The row this view was remembered at is not in the loaded transcript (the
        // tail moved on). Drop the anchor instead of restoring to a guess.
        store.removeScrollAnchor(viewKey);
      }
      container.scrollTop = container.scrollHeight;
      following.current = true;
      return;
    }

    if (following.current) container.scrollTop = container.scrollHeight;
  }, [containerRef, enabled, readRows, rowCount, store, viewKey]);

  // Listeners: learn whether the reader is at the bottom, and record where they are.
  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || container === null) return;

    const onScroll = () => {
      following.current = isAtBottom({
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
      });
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        record(container);
      }, 200);
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      // Leaving the surface is when the position is most likely to be needed and
      // least likely to have been written yet.
      record(container);
    };
  }, [containerRef, enabled, record]);
}
