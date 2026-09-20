import { useQuery } from '@tanstack/react-query';
import { getHealthSummary } from '../api/health';
import { StatusBadge } from '../design-system/components/StatusBadge/StatusBadge';

/**
 * One status light over the whole backend (docs/API.md §2, health/summary):
 * `ok | degraded | error`, where the top-level value is the worst of the three
 * components. Polls — it is a status light, not a page, so no refetch-on-focus.
 */
const TONES = { ok: 'success', degraded: 'warning', error: 'error' } as const;
const LABELS = { ok: 'Healthy', degraded: 'Degraded', error: 'Failing' } as const;

export function HealthIndicator() {
  const query = useQuery({
    queryKey: ['health', 'summary'],
    queryFn: ({ signal }) => getHealthSummary(signal),
    refetchInterval: 30_000,
    retry: false,
  });

  if (query.isPending) {
    return <StatusBadge tone="neutral">Checking…</StatusBadge>;
  }
  if (query.isError || query.data === undefined) {
    return (
      <span title={query.error instanceof Error ? query.error.message : 'Health check failed'}>
        <StatusBadge tone="error">Unreachable</StatusBadge>
      </span>
    );
  }

  const summary = query.data;
  const providerDetail = summary.components.providers?.detail;
  const tooltip = [summary.status, providerDetail, `checked ${new Date(summary.checkedAt).toLocaleTimeString()}`]
    .filter(Boolean)
    .join(' — ');

  return (
    <span title={tooltip}>
      <StatusBadge tone={TONES[summary.status]}>{LABELS[summary.status]}</StatusBadge>
    </span>
  );
}
