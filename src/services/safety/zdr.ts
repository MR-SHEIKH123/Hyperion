/**
 * Zero data retention (Part 1.26).
 *
 * The whole policy lives here: what ZDR status a provider carries, whether that
 * status satisfies the user's standing requirement, how a candidate list is
 * ordered or filtered because of it, and what has to be added to an outbound
 * request to ask for it.
 *
 * Four decisions shape this module, and each has a specific failure it avoids.
 *
 * **Eligibility is a predicate on selection, not a check before dispatch.** A
 * gate that runs once, on the provider chosen up front, is silent about the
 * failover that happens afterwards: the router can move a request to a second
 * provider mid-flight, and a mid-flight provider has already been sent the
 * payload by the time any gate could object. Making eligibility part of *which
 * providers are candidates at all* — the same shape as `cachedSupportsModel`
 * excluding a provider that lacks the model — closes that structurally, because
 * an ineligible provider is never in the list to fail over to.
 *
 * **`require` filters, `prefer` sorts.** This mirrors the rule already written
 * at `providers/repository.ts:160`, where an unhealthy provider is ordered last
 * rather than dropped, because "it beats having no option at all". A preference
 * that silently became a prohibition the moment nothing eligible was configured
 * would be a different feature from the one the user switched on.
 *
 * **`unknown` fails closed under `require`.** Both kinds of unknown: a provider
 * with nothing recorded about it, and a provider type this build cannot classify
 * at all. `CONTRACTS.md` states that understating exposure is the one error this
 * layer must never make, and "we do not know" is not evidence of safety.
 *
 * **Nothing here infers `zdr_confirmed`.** A successful request proves the flag
 * was accepted, not that the data was discarded — that is unobservable from this
 * side of the wire. `zdr_confirmed` therefore requires `confirmedAt`, which only
 * an explicit user attestation writes. `zdr_requested` is the ceiling for
 * anything Hyperion determines itself.
 *
 * The provider-type → egress mapping is **not** duplicated here: every local/
 * remote decision defers to `classifyProviderType` in `outbound.ts`, so there
 * stays exactly one definition of what leaves the machine.
 */

import { classifyProviderType } from './outbound.ts';

import type { ProviderRecord, ZdrRequirement, ZdrStatus } from '../../types/core.ts';

/** Statuses that satisfy a ZDR policy. Everything else is ineligible. */
const SATISFYING: readonly ZdrStatus[] = ['local_no_egress', 'zdr_confirmed', 'zdr_requested'];

/**
 * Only the ZDR-relevant shape of a provider, so callers that hold a partial
 * record — a test fixture, a row mid-construction — can still be classified.
 */
export type ZdrSubject = Pick<ProviderRecord, 'type' | 'zdr'>;

/**
 * True when the provider's opt-in flag is complete enough to send.
 *
 * A `supported_opt_in` provider with no usable flag is *not* ZDR-satisfied: the
 * retention is off only when the request asks, and a half-filled flag asks
 * nothing. Treating the recorded intent as sufficient would report
 * `zdr_requested` for a request that made no such request.
 */
function hasUsableFlag(provider: ZdrSubject): boolean {
  const flag = provider.zdr.requestFlag;
  if (!flag) return false;
  return flag.key.trim() !== '' && flag.value.trim() !== '';
}

/** True when this provider's recorded facts amount to ZDR being in force. */
function zdrSatisfied(provider: ZdrSubject): boolean {
  switch (provider.zdr.support) {
    case 'supported_default':
      return true;
    case 'supported_opt_in':
      return hasUsableFlag(provider);
    case 'not_supported':
    case 'not_applicable':
    case 'unknown':
      return false;
  }
}

/**
 * The status that applies to a request served by this provider, right now.
 *
 * Derived on demand rather than stored on the provider row: it depends on the
 * flag being usable and on whether a confirmation exists, and a cached copy
 * would go stale the moment either changed. It *is* stamped onto each usage row
 * at write time, which is a different thing — that is a record of what applied,
 * not a cache of what applies.
 */
export function zdrStatusFor(provider: ZdrSubject): ZdrStatus {
  const egress = classifyProviderType(provider.type);

  // Nothing left the machine, so retention by a third party is not a question
  // that arises — regardless of what has been recorded about the provider.
  if (egress === 'local') return 'local_no_egress';

  // The provider type does not classify, so we cannot even say whether the
  // bytes left. Fails closed under `require`; see the module comment.
  if (egress === 'unknown') return 'egress_unknown';

  if (zdrSatisfied(provider)) {
    return provider.zdr.confirmedAt !== null ? 'zdr_confirmed' : 'zdr_requested';
  }

  switch (provider.zdr.support) {
    case 'not_supported':
      return 'standard_retention';
    // Either an opt-in provider with no usable flag, or an endpoint for which the
    // question does not arise. Both mean ZDR is available in principle and is not
    // being applied to this request.
    case 'supported_opt_in':
    case 'not_applicable':
      return 'zdr_not_applied';
    case 'unknown':
    case 'supported_default':
      // `supported_default` cannot reach here — it always satisfies above — but
      // the switch stays exhaustive so widening `ZdrSupport` is a compile error.
      return 'zdr_unknown';
  }
}

/**
 * Whether this provider may serve a request under `requirement`.
 *
 * `off` admits everything, including `egress_unknown`: with no policy in force
 * there is nothing to be ineligible against, and refusing anyway would change
 * behaviour on a default install.
 *
 * `prefer` returns true for the same set as `require`. The difference is not in
 * this predicate but in what the caller does with a false — `orderByZdr` sorts
 * rather than filters.
 */
export function isZdrEligible(provider: ZdrSubject, requirement: ZdrRequirement): boolean {
  if (requirement === 'off') return true;
  return SATISFYING.includes(zdrStatusFor(provider));
}

/**
 * Apply the policy to a candidate list.
 *
 *   off     — returned unchanged. Not a copy-and-sort that happens to preserve
 *             order: identity, so nothing about a default install's routing can
 *             shift because this function exists.
 *   require — ineligible candidates are removed. An empty result is a legitimate
 *             outcome and the caller must report it as `zdr_requirement_unmet`,
 *             not as an outage.
 *   prefer  — ineligible candidates move to the back, keeping the incoming order
 *             within each group. That order already encodes health and priority
 *             (`listFailoverCandidates`), so a stable partition is what preserves
 *             it; a comparator-based sort would not.
 */
export function orderByZdr<T extends ZdrSubject>(
  candidates: readonly T[],
  requirement: ZdrRequirement,
): T[] {
  if (requirement === 'off') return [...candidates];
  if (requirement === 'require') {
    return candidates.filter((candidate) => isZdrEligible(candidate, requirement));
  }

  const eligible: T[] = [];
  const rest: T[] = [];
  for (const candidate of candidates) {
    (isZdrEligible(candidate, requirement) ? eligible : rest).push(candidate);
  }
  return [...eligible, ...rest];
}

/**
 * True when a chosen provider falls short of a `prefer` policy — the compensating
 * control for the residual failover gap that `prefer` keeps by design.
 *
 * Computed from a stored `(status, requirement)` pair rather than stored itself,
 * so the conclusion can be re-derived if the wording of the policy changes and
 * so the log holds facts rather than verdicts.
 *
 * `status` is typed as a plain string, not `ZdrStatus`, because it comes off a
 * column with no `CHECK` and a downgrade can leave a value this build does not
 * recognise. Such a value is reported as **unmet**, never as satisfied: only the
 * three statuses in `SATISFYING` satisfy a policy, and this build cannot know that
 * something it cannot name met the user's requirement. A guard that nulled the
 * unrecognised value first would fail open and quietly claim the policy held.
 */
export function zdrPreferenceUnmet(
  status: ZdrStatus | string | null,
  requirement: ZdrRequirement | null,
): boolean {
  if (requirement !== 'prefer' || status === null) return false;
  return !(SATISFYING as readonly string[]).includes(status);
}

/** Headers and body fields an outbound request must carry to ask for ZDR. */
export interface ZdrFlagApplication {
  headers?: Record<string, string>;
  bodyFields?: Record<string, string>;
}

/**
 * What to add to a request to this provider, or null when there is nothing to
 * add.
 *
 * Gated on **egress class**, not on the adapter and not on `zdr_support` alone.
 * `openAiAdapter` serves both the remote `remote` type and the local `colibri`
 * type, so keying off the adapter would send a retention header to a local
 * runtime that never had a retention policy — noise at best, and a request a
 * strict local server may reject at worst.
 *
 * Returns a value only for a provider that is remote, declares `supported_opt_in`
 * and has a usable flag. `supported_default` needs nothing sent, by definition;
 * anything else has nothing to send.
 */
export function zdrFlagFor(provider: ZdrSubject): ZdrFlagApplication | null {
  if (classifyProviderType(provider.type) !== 'remote') return null;
  if (provider.zdr.support !== 'supported_opt_in') return null;

  const flag = provider.zdr.requestFlag;
  if (!flag || !hasUsableFlag(provider)) return null;

  const key = flag.key.trim();
  const value = flag.value.trim();

  return flag.location === 'header' ? { headers: { [key]: value } } : { bodyFields: { [key]: value } };
}
