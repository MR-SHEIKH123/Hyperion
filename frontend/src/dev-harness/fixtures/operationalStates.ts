/**
 * Operational fixtures for the dev-only state harness (Prompt 1.39 A4).
 *
 * Each entry is either a state the backend contract really can produce — named
 * with the surface that produces it — or an explicit record that the state has
 * no backend shape yet. The second kind is the point of the list: a harness that
 * only ever shows implemented states would let "we never built it" read as
 * "nothing to render".
 *
 * `tone` is the status tone the surface would carry, not a claim that the state
 * exists.
 */
export const operationalFixtures = [
  {
    id: 'worktree-lane-full',
    title: 'Worktree lane full',
    detail:
      'Refused with worktree_lane_full: two Code tasks already hold the lane, so this one queues behind them.',
    tone: 'warning' as const,
    source: 'POST /api/code/tasks (docs/API.md)',
  },
  {
    id: 'spending-cap-reached',
    title: 'Spending cap reached',
    detail:
      "Today's daily cap is reached, so autonomous work is refused with spending_cap_reached (429) until the window resets. Work the user starts is unaffected.",
    tone: 'warning' as const,
    source: 'services/limits/budget.ts, usage_log',
  },
  {
    id: 'mcp-disconnected',
    title: 'MCP disconnected',
    detail: 'A configured MCP server is not connected, so its tools are unavailable to a run.',
    tone: 'error' as const,
    source: 'GET /api/mcp/status',
  },
  {
    id: 'backup-diff',
    title: 'Backup diff ready',
    detail: 'A restore preview is waiting: review the diff before it replaces live data.',
    tone: 'info' as const,
    source: 'POST /api/storage/backup/inspect (docs/API.md §16)',
  },
  {
    id: 'provider-cooldown',
    title: 'Provider cooldown',
    detail:
      'No separate cooldown state exists: a provider outage arrives as a run paused with the reason, and failover moves the next request to another provider.',
    tone: 'warning' as const,
    source: 'run state paused (src/providers/failover.ts)',
  },
  {
    id: 'provider-disabled',
    title: 'No provider active',
    detail:
      'Every provider is disabled, so the composer is disabled and says so; a request cannot be sent at all.',
    tone: 'neutral' as const,
    source: 'GET /api/providers/active → provider: null',
  },
  {
    id: 'interrupted-gap',
    title: 'Interrupted task',
    detail:
      'Not exposed: the TaskRun contract has no interrupted state. An interrupted run is recorded stopped or error, and the frontend derives "interrupted" from the transport state (docs/CONTRACTS.md, task machine).',
    tone: 'neutral' as const,
    source: 'none yet — recorded, not rendered as real',
  },
  {
    id: 'design-preview-failure',
    title: 'Design preview failure',
    detail:
      'Not exposed: the Design tool has no frontend surface yet, so there is no preview to fail. Recorded here so the state is not mistaken for covered.',
    tone: 'neutral' as const,
    source: 'none yet — the Design tool is backend-only',
  },
];
