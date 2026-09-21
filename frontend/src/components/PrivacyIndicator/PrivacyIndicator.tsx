import type {
  EgressClassWire,
  EgressProxyWire,
  ProviderCooldownWire,
  ZdrRequirementWire,
  ZdrStatusWire,
} from '../../contracts/wire/providers';
import styles from './PrivacyIndicator.module.css';

/**
 * What the next send will do with the user's text, as the backend reports it.
 *
 * Every field comes from `GET /api/providers/active` unchanged. The indicator
 * derives nothing: whether a status satisfies a requirement is decided by the
 * backend (`zdr.ts` reasons about its own statuses, and its comment says why the
 * one definition lives there), so this renders the two facts side by side and
 * lets the pair speak. A UI that re-implemented the satisfying rule would keep
 * saying "meets your requirement" after the rule changed server-side.
 *
 * A `null` status means no provider is active — a real state, not an unknown one.
 */
export interface ProviderPrivacy {
  providerName: string | null;
  egress: EgressClassWire;
  /**
   * The proxy this provider's requests are tunnelled through, or null.
   *
   * Carried as its own fact rather than folded into the egress sentence: the
   * class says whether the bytes leave the machine, and this says *how*. A
   * provider reached through a proxy elsewhere is `remote` precisely because the
   * backend looked at this field (Part 1.37), so a UI that dropped it would show
   * "Remote" with no way for the user to learn why.
   */
  egressProxy: EgressProxyWire | null;
  zdrStatus: ZdrStatusWire | null;
  zdrRequirement: ZdrRequirementWire;
  redactionCheckEnabled: boolean;
  /**
   * The cooldown this provider is serving, or null (1.36).
   *
   * Live state rather than a stored fact, and it is disclosure rather than
   * decoration: a provider that is being skipped is exactly the case where a user
   * asks "why is it not using the one I configured", and the answer — which class
   * of failure, and for how much longer — was previously only in the server log.
   */
  cooldown: ProviderCooldownWire | null;
}

interface EgressCopy {
  short: string;
  sentence: string;
  tone: string;
}

const EGRESS: Record<EgressClassWire, EgressCopy> = {
  local: {
    short: 'Local',
    sentence: 'Requests go to a provider on this machine and do not leave it.',
    tone: 'local',
  },
  remote: { short: 'Remote', sentence: 'Requests leave this machine.', tone: 'remote' },
  unknown: {
    short: 'Egress unknown',
    sentence: 'This provider type cannot be classified, so treat requests as leaving this machine.',
    tone: 'unknown',
  },
};

const ZDR_SHORT: Record<ZdrStatusWire, string> = {
  local_no_egress: 'no egress',
  zdr_confirmed: 'zero-data-retention confirmed',
  zdr_requested: 'zero-data-retention requested',
  zdr_not_applied: 'zero-data-retention not applied',
  standard_retention: 'standard retention',
  zdr_unknown: 'zero-data-retention unknown',
  egress_unknown: 'zero-data-retention unknown (egress unknown)',
};

const ZDR_SENTENCE: Record<ZdrStatusWire, string> = {
  local_no_egress: 'Nothing leaves this machine, so there is no retention to disclose.',
  zdr_confirmed: 'The provider has been confirmed to apply zero-data-retention.',
  zdr_requested: 'Zero-data-retention has been requested but not confirmed.',
  zdr_not_applied: 'Zero-data-retention is not applied.',
  standard_retention: 'The provider retains data under its standard policy.',
  zdr_unknown: "Nothing has been recorded about this provider's retention.",
  egress_unknown:
    "Nothing has been recorded about this provider's retention, and its egress is unknown.",
};

const REQUIREMENT_SHORT: Record<ZdrRequirementWire, string | null> = {
  off: null,
  prefer: 'zero-data-retention preferred',
  require: 'zero-data-retention required',
};

const REQUIREMENT_SENTENCE: Record<ZdrRequirementWire, string | null> = {
  off: null,
  prefer: 'Zero-data-retention is preferred.',
  require: 'Zero-data-retention is required.',
};

/**
 * Point-of-action privacy line (Prompt 1.39 B).
 *
 * The same facts the settings screen shows, placed where the decision is made
 * rather than only where it is configured. There is no control here: a privacy
 * fact rendered as a toggle invites the reading that the toggle is what makes
 * the claim true.
 */
export function PrivacyIndicator({ privacy }: { privacy: ProviderPrivacy }) {
  const egress = EGRESS[privacy.egress];
  const zdrShort = privacy.zdrStatus === null ? 'no provider active' : ZDR_SHORT[privacy.zdrStatus];
  const zdrSentence =
    privacy.zdrStatus === null ? 'No provider is active.' : ZDR_SENTENCE[privacy.zdrStatus];
  const requirementShort = REQUIREMENT_SHORT[privacy.zdrRequirement];
  const requirementSentence = REQUIREMENT_SENTENCE[privacy.zdrRequirement];
  const redactionShort = privacy.redactionCheckEnabled ? 'redaction check on' : 'redaction check off';
  const redactionSentence = `The pre-send redaction check is ${
    privacy.redactionCheckEnabled ? 'on.' : 'off.'
  }`;
  const provider = privacy.providerName === null ? '' : `Provider: ${privacy.providerName}.`;
  // The reason sentence is the backend's own (`cooldowns.ts` writes the same words
  // into switch events), so the panel and the routing decision cannot describe the
  // same cooldown differently. The routing half is stated because it is the part a
  // user cannot infer from the reason: being skipped is not being disabled.
  const cooldown = privacy.cooldown;
  const cooldownShort = cooldown === null ? null : 'cooling down';
  const cooldownSentence =
    cooldown === null
      ? ''
      : `It is being left alone for now: ${cooldown.reason}. Another provider is preferred until then, and this one is used again only if nothing else can serve the model.`;
  // A proxied route is stated in both registers, because it is the fact a user
  // is most likely to have forgotten they configured — and because it is the one
  // fact that can make a provider they think of as local not be local at all.
  const proxy = privacy.egressProxy;
  const proxyShort =
    proxy === null ? null : `via proxy ${proxy.authority}${proxy.offMachine ? ' (off this machine)' : ''}`;
  const proxySentence =
    proxy === null
      ? ''
      : `Requests are tunnelled through the proxy ${proxy.redacted}${
          proxy.offMachine ? ', which is not on this machine' : ', which is on this machine'
        }.`;
  const short = [
    egress.short,
    ...(proxyShort === null ? [] : [proxyShort]),
    ...(cooldownShort === null ? [] : [cooldownShort]),
    zdrShort,
    ...(requirementShort === null ? [] : [requirementShort]),
    redactionShort,
  ];
  const sentence = [
    egress.sentence,
    proxySentence,
    provider,
    cooldownSentence,
    zdrSentence,
    requirementSentence ?? '',
    redactionSentence,
  ]
    .filter((part) => part !== '')
    .join(' ');

  return (
    <p
      className={`${styles.indicator} ${styles[egress.tone]}`}
      data-egress={privacy.egress}
      data-zdr={privacy.zdrStatus ?? 'none'}
      data-proxy={privacy.egressProxy?.authority ?? 'none'}
      data-cooldown={cooldown?.failureClass ?? 'none'}
      aria-label={sentence}
      title={sentence}
    >
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.parts}>{short.join(' · ')}</span>
    </p>
  );
}
