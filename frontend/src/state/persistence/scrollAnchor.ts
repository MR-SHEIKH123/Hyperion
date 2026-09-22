import type { ScrollAnchor } from './schemas';

/**
 * Where the reader was, expressed so it survives a reflow.
 *
 * A raw `scrollTop` is the obvious thing to remember and the wrong one: the same
 * number means a different place after a window resize, a font change or a streamed
 * message that grew above it. So the memory is an **anchor** — the id of the row at
 * the top of the viewport, plus how far that row's top sits above the viewport top —
 * and restoring it puts *that row* back where it was found.
 *
 * The arithmetic lives here, apart from the DOM, so it can be tested as arithmetic:
 * reading rectangles needs a layout engine, and jsdom does not have one.
 */

export interface RowBox {
  id: string;
  /** Row top, in the scroll container's own frame (0 = the viewport's top edge). */
  top: number;
  /** Row bottom, same frame. */
  bottom: number;
}

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** How close to the bottom still counts as "following along". */
export const AT_BOTTOM_SLACK_PX = 24;

/**
 * True when the viewport is at (or within a line of) the end of the content.
 *
 * This is what decides whether new tokens may move the view. Someone reading
 * halfway up a transcript is not asking to be pulled to the bottom by the next
 * chunk, so following is only ever resumed from here.
 */
export function isAtBottom(metrics: ScrollMetrics, slack = AT_BOTTOM_SLACK_PX): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= slack;
}

/**
 * The row to remember: the first one still visible at the top of the viewport.
 *
 * Rows scrolled entirely past are skipped, so a long jump lands on the row the
 * reader is actually looking at rather than the first one above it. An empty list
 * (or one entirely above the fold) has nothing to anchor to and returns `null`.
 */
export function anchorForRows(rows: readonly RowBox[]): ScrollAnchor | null {
  for (const row of rows) {
    if (row.bottom > 0) return { anchorId: row.id, offset: row.top };
  }
  return null;
}

/**
 * The scroll position that puts `row` back at the offset it was remembered at.
 *
 * Both rectangles are read in the container's frame, so `row.top` is the row's
 * current distance below the viewport's top edge: moving by `row.top - offset`
 * puts it back where it was. Clamped, because a restore must never scroll past
 * the content it has.
 */
export function scrollTopForAnchor(
  anchor: ScrollAnchor,
  row: RowBox,
  currentScrollTop: number,
  maxScrollTop: number,
): number {
  const next = currentScrollTop + row.top - anchor.offset;
  return Math.min(Math.max(next, 0), Math.max(maxScrollTop, 0));
}
