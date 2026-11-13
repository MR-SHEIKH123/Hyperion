/**
 * The current time as state, for every "how long ago / until" display.
 *
 * `react-hooks/purity` (v7) forbids calling `Date.now()` during render, which
 * is exactly what these displays used to do: `relativeTime(at, Date.now())`
 * inside JSX. The rule is right about the hazard — a value that changes on
 * every call cannot be memoised, and a compiled component would cache a stale
 * or flickering clock — so the fix is not to hide the call but to make "now" a
 * fact the component holds: a lazy initializer (correct at first paint) that an
 * interval updates.
 *
 * The tick is 30 seconds because the displays are minute-scale ("expires in
 * 4 min", "opened 12 min ago"): finer granularity would re-render the panel
 * for a difference no reader can see, and coarser would let a deadline's
 * wording drift past the event it describes. Components that already poll
 * re-render on their own schedule; this only guarantees the clock itself is
 * not frozen for the life of the mount.
 *
 * A hook rather than a local `useState` per call site so the interval policy
 * lives in one documented place instead of six copies.
 */
import { useEffect, useState } from 'react';

/** Default tick for {@link useNow}; exported so a test can name the policy. */
export const NOW_TICK_MS = 30_000;

export function useNow(tickMs: number = NOW_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(id);
  }, [tickMs]);

  return now;
}
