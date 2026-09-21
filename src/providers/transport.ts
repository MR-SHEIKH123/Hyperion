/**
 * The transport seam for a proxied provider (Part 1.37).
 *
 * `adapters.ts` talks to providers through `fetch`, and Node's fetch accepts a
 * `dispatcher` — so honouring a per-provider egress proxy is one option on one
 * call, not a second HTTP client. This module owns the dispatcher cache, and it
 * is the only place in the process that knows which library performs a proxied
 * hop.
 *
 * Three decisions:
 *
 *   1. **One agent per proxy URL, cached by the exact string.** `ProxyAgent` holds
 *      a connection pool; building one per request would open a fresh tunnel for
 *      every token and lose the pooling the tunnel exists to provide. Keyed by
 *      the full URL (credentials included) so two providers on the same host with
 *      different accounts do not share a pool that authenticated as one of them.
 *   2. **`undici` is a declared dependency, not a guess about Node internals.**
 *      Node's global fetch *is* undici, but the copy inside the runtime is not
 *      importable, so `ProxyAgent` has to come from the package. That is the whole
 *      reason `undici` is in `package.json`; the unproxied path continues to use
 *      the global fetch and pays nothing for this.
 *   3. **A failure to construct a dispatcher is an error, never a silent direct
 *      request.** `dispatcherFor` lets the mistake out; `httpFetch` turns it into
 *      a `provider_error`. Quietly falling back to a direct connection would send
 *      the user's data from an address they configured a proxy precisely to avoid,
 *      which is the one outcome no disclosure could repair after the fact.
 */
import { ProxyAgent } from 'undici';

import { tryEgressProxy } from '../services/safety/outbound.ts';

import type { ProviderRecord } from '../types/core.ts';

const agents = new Map<string, ProxyAgent>();

/**
 * A dispatcher for this provider's egress proxy, or undefined when it has none.
 *
 * Returns undefined rather than null so callers can spread it into a
 * `RequestInit` without an exact-optional-properties error.
 */
export function dispatcherFor(provider: Pick<ProviderRecord, 'egressProxy'>): ProxyAgent | undefined {
  const proxy = tryEgressProxy(provider.egressProxy);
  if (proxy === null) return undefined;

  const existing = agents.get(proxy.url);
  if (existing !== undefined) return existing;

  const agent = new ProxyAgent(proxy.url);
  agents.set(proxy.url, agent);
  return agent;
}

/** Test hook: close and forget every pooled tunnel. */
export async function resetDispatchers(): Promise<void> {
  const open = [...agents.values()];
  agents.clear();
  await Promise.all(open.map(async (agent) => agent.close()));
}
