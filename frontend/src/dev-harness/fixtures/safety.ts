import type {
  LimitsWire,
  NetworkEgressWire,
  RedactionCheckWire,
  ReloadConfigWire,
  ToolAccessModeWire,
  ZdrPolicyWire,
} from '../../contracts/wire/settings';

/**
 * Safety-and-limits fixtures for the dev harness (Settings 2.5, slice 2).
 *
 * Typed against the wire schemas. The values are chosen to show the states
 * a reader most needs to see rather than the defaults: egress stored on but
 * not effective, the redaction check at its off default, a ZDR preference,
 * and a spend figure with unpriced requests it cannot include.
 */
export const networkEgressFixture: NetworkEgressWire = {
  enabled: true,
  effective: false,
  requiresCodeExecution: true,
  enforced: 'command_prefix_match',
};

export const redactionCheckFixture: RedactionCheckWire = {
  enabled: false,
  appliesTo: 'remote',
  enforced: 'pattern_match',
};

export const zdrPolicyFixture: ZdrPolicyWire = {
  requirement: 'prefer',
  allowed: ['off', 'prefer', 'require'],
  appliesTo: 'remote',
  enforced: 'provider_selection',
};

export const toolAccessModeFixture: ToolAccessModeWire = 'load_when_needed';

export const limitsFixture: LimitsWire = {
  ceilings: { tokenCeiling: 2_000_000, iterationCeiling: 100, subagentLimit: 5 },
  spend: {
    capUsd: 25,
    spentUsd: 3.4172,
    remainingUsd: 21.5828,
    capReached: false,
    unpricedRequestsToday: 2,
    windowResetsAt: 1_760_100_000_000,
  },
};

export const reloadConfigFixture: ReloadConfigWire = {
  project: '.',
  settings: {},
  defaultAgentProfile: 'act',
  permissions: { bash: 'ask', write: 'allow' },
  profiles: [
    { name: 'ask', description: 'Answers without acting.', path: null, builtin: true, hidden: false },
    { name: 'act', description: null, path: null, builtin: true, hidden: false },
  ],
  validated: true,
};
