/**
 * The one question the dashboard asks: is this thing working right now?
 *
 * The pieces were already readable individually — `GET /api/providers`,
 * `GET /api/mcp/status`, `GET /api/errors` — but answering "is anything wrong"
 * meant three requests and knowing which fields mattered in each. This collapses
 * them into a single verdict plus the per-component detail that justifies it, so
 * the UI can render a light without teaching the frontend our health rules.
 *
 * Two deliberate asymmetries in how the verdict is reached:
 *
 *   - Only providers can raise `error`. `error` means "a request sent right now
 *     cannot succeed", which is a statement about capability, not about history.
 *     MCP servers are auxiliary and past 500s are already over, so neither can
 *     take the whole app red on its own.
 *   - `unknown` providers are not counted as failing. Every provider on a fresh
 *     install is `unknown` until something is actually sent to it, and a
 *     dashboard that shows red before the user has done anything trains them to
 *     ignore it.
 *
 * The provider verdict is shaped by how providers actually work here, which is
 * not what the plural in `listProviders()` suggests: `enabled` is a single
 * *active* flag guarded by a partial unique index, so at most one provider is
 * ever enabled. Asking "how many enabled providers are unhealthy" is therefore
 * meaningless — the real question is whether the active provider works, and if
 * it does not, whether `listFailoverCandidates()` has anywhere else to go. That
 * function deliberately ignores `enabled` and merely sorts known-unhealthy
 * providers last, so a disabled provider is still a route out.
 */

import { countErrors } from '../../db/errorLog.ts';
import { mcpStatus } from '../../orchestrator/agents.ts';
import {
  getActiveProvider,
  listFailoverCandidates,
  listProviders,
} from '../../providers/repository.ts';

import type { HealthStatus } from '../../types/core.ts';

export type ComponentStatus = 'ok' | 'degraded' | 'error';

/** How far back the error count looks. */
const ERROR_WINDOW_MS = 60 * 60 * 1000;

const RANK: Record<ComponentStatus, number> = { ok: 0, degraded: 1, error: 2 };

/** The worst of the parts — a summary that rounded up would hide the fault. */
function worst(statuses: readonly ComponentStatus[]): ComponentStatus {
  return statuses.reduce<ComponentStatus>(
    (acc, next) => (RANK[next] > RANK[acc] ? next : acc),
    'ok',
  );
}

export interface ProviderComponent {
  status: ComponentStatus;
  detail: string;
  total: number;
  /** The one enabled provider, or null when the user has not chosen one. */
  active: { id: string; name: string; health: HealthStatus } | null;
  /** Other providers not already known to be unhealthy — the routes failover can take. */
  failoverCandidates: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
  unknown: number;
}

export interface McpComponent {
  status: ComponentStatus;
  detail: string;
  managed: boolean;
  total: number;
  running: number;
  errored: number;
}

export interface ErrorComponent {
  status: ComponentStatus;
  detail: string;
  windowMs: number;
  count: number;
}

export interface HealthSummary {
  status: ComponentStatus;
  checkedAt: number;
  uptimeSec: number;
  components: {
    providers: ProviderComponent;
    mcp: McpComponent;
    errors: ErrorComponent;
  };
}

function providerComponent(): ProviderComponent {
  const all = listProviders();
  const activeRecord = getActiveProvider();

  // Counted across every provider, not just the active one: the fleet-wide
  // breakdown is what tells the user whether the standbys are worth switching to.
  const counts: Record<HealthStatus, number> = {
    unknown: 0,
    healthy: 0,
    degraded: 0,
    unhealthy: 0,
  };
  for (const provider of all) counts[provider.healthStatus]++;

  // A candidate already known to be unhealthy is still *tried* by the router, but
  // it is not something we can promise here, so it does not count as a route out.
  const candidates = activeRecord
    ? listFailoverCandidates(activeRecord.id).filter(
        (provider) => provider.healthStatus !== 'unhealthy',
      ).length
    : 0;

  const shape = {
    total: all.length,
    active: activeRecord
      ? { id: activeRecord.id, name: activeRecord.name, health: activeRecord.healthStatus }
      : null,
    failoverCandidates: candidates,
    healthy: counts.healthy,
    degraded: counts.degraded,
    unhealthy: counts.unhealthy,
    unknown: counts.unknown,
  };

  if (all.length === 0) {
    return {
      status: 'degraded',
      detail: 'No provider is configured yet, so nothing can answer a request.',
      ...shape,
    };
  }

  // Not an outage: the providers are there, the user simply has not picked one.
  // `requireActiveProvider()` refuses with `no_active_provider`, which is a
  // configuration prompt rather than a fault.
  if (!activeRecord) {
    return {
      status: 'degraded',
      detail: `${all.length} provider(s) configured but none is active; enable one before sending requests.`,
      ...shape,
    };
  }

  if (activeRecord.healthStatus === 'unhealthy') {
    // The one condition that is genuinely an outage: the active provider is
    // known bad and there is nothing healthy to fail over to.
    if (candidates === 0) {
      return {
        status: 'error',
        detail: `The active provider "${activeRecord.name}" is unhealthy and there is no other provider to fail over to.`,
        ...shape,
      };
    }

    return {
      status: 'degraded',
      detail: `The active provider "${activeRecord.name}" is unhealthy; ${candidates} other provider(s) can take over.`,
      ...shape,
    };
  }

  if (activeRecord.healthStatus === 'degraded') {
    return {
      status: 'degraded',
      detail: `The active provider "${activeRecord.name}" is degraded but still answering.`,
      ...shape,
    };
  }

  return {
    status: 'ok',
    detail:
      activeRecord.healthStatus === 'healthy'
        ? `The active provider "${activeRecord.name}" answered successfully.`
        : `The active provider "${activeRecord.name}" has not been tried yet.`,
    ...shape,
  };
}

function mcpComponent(): McpComponent {
  const { managed, servers } = mcpStatus();
  const running = servers.filter((server) => server.state === 'running').length;
  const errored = servers.filter((server) => server.state === 'error').length;
  const shape = { managed, total: servers.length, running, errored };

  // Boot registers the supervisor on every start, so an unmanaged answer now
  // means `HYPERION_MCP_DISABLED=1` was set (the test suite does exactly this)
  // or the request beat boot to it. Either way it is a supported configuration
  // rather than a fault, so this stays `ok` — reporting `degraded` would make
  // every test run and every deliberately MCP-less install look broken.
  if (!managed) {
    return {
      status: 'ok',
      detail: 'No MCP supervisor is registered, so no servers are being managed.',
      ...shape,
    };
  }

  if (errored > 0) {
    return {
      status: 'degraded',
      detail: `${errored} of ${servers.length} MCP server(s) are in an error state.`,
      ...shape,
    };
  }

  return {
    status: 'ok',
    detail: `${running} of ${servers.length} MCP server(s) running.`,
    ...shape,
  };
}

function errorComponent(now: number): ErrorComponent {
  const count = countErrors({ since: now - ERROR_WINDOW_MS });

  return {
    status: count === 0 ? 'ok' : 'degraded',
    detail:
      count === 0
        ? 'No server errors in the last hour.'
        : `${count} server error(s) logged in the last hour.`,
    windowMs: ERROR_WINDOW_MS,
    count,
  };
}

export function healthSummary(now = Date.now()): HealthSummary {
  const components = {
    providers: providerComponent(),
    mcp: mcpComponent(),
    errors: errorComponent(now),
  };

  return {
    status: worst([components.providers.status, components.mcp.status, components.errors.status]),
    checkedAt: now,
    uptimeSec: Math.round(process.uptime()),
    components,
  };
}
