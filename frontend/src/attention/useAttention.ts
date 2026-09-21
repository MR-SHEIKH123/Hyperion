import { useQuery } from '@tanstack/react-query';
import { getAttention } from '../api/attention';

/**
 * The queue, polled.
 *
 * Two decisions worth stating, because both are about *not* losing or inventing
 * items — the gate A1 is held to:
 *
 *  - **The response replaces the previous one wholesale.** There is no client-side
 *    merge, so a reconnect cannot duplicate an item (nothing is ever appended) and
 *    cannot lose one either (the next poll carries the full set). The only cost is
 *    that an item answered in another tab disappears on the next tick rather than
 *    immediately, which is honest: it is no longer waiting.
 *  - **Focus refetches, and so does a 30s tick.** The queue is read in the moment
 *    ("what is waiting *now*"), so a stale list is worse than a slightly chatty
 *    endpoint — it is one indexed read of a handful of small tables.
 */
export function useAttention() {
  return useQuery({
    queryKey: ['attention'],
    queryFn: ({ signal }) => getAttention(signal),
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}
