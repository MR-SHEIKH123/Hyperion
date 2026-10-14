import type { UpdateLimitsInput } from '../../api/settings';
import type { LimitsWire, ToolAccessModeWire } from '../../contracts/wire/settings';
import type { ZdrRequirementWire } from '../../contracts/wire/providers';

/**
 * The pure half of Safety and limits: option wording taken from the
 * backend's own semantics, and the limits form's validation and payload
 * building. Every rule here mirrors `src/http/settings.ts`; nothing accepts
 * less than the route or refuses what the route would take.
 */

export const ZDR_REQUIREMENT_OPTIONS: Array<{
  value: ZdrRequirementWire;
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Off',
    description: 'No standing policy. Providers are chosen without regard to data retention.',
  },
  {
    value: 'prefer',
    label: 'Prefer ZDR',
    description:
      'Providers that satisfy ZDR — local, confirmed, or a usable opt-in flag — are ordered first. Others stay eligible: a preference, not a prohibition.',
  },
  {
    value: 'require',
    label: 'Require ZDR',
    description:
      'Only local providers and remote providers that satisfy ZDR are eligible at all. A provider whose support is unknown fails closed and is not used.',
  },
];

export const TOOL_ACCESS_OPTIONS: Array<{ value: ToolAccessModeWire; label: string; description: string }> = [
  {
    value: 'always_loaded',
    label: 'Always loaded',
    description: 'Every tool definition and skill summary goes into the context up front.',
  },
  {
    value: 'load_when_needed',
    label: 'Load when needed',
    description: 'Tool definitions are pulled in on demand, trading a relevance pre-check for a smaller context.',
  },
];

// --- limits form -------------------------------------------------------------

export interface LimitsFormValues {
  dailySpendCapUsd: string;
  tokenCeiling: string;
  iterationCeiling: string;
  subagentLimit: string;
}

export const limitsFormFrom = (limits: LimitsWire): LimitsFormValues => ({
  dailySpendCapUsd: limits.spend.capUsd === null ? '' : String(limits.spend.capUsd),
  tokenCeiling: String(limits.ceilings.tokenCeiling),
  iterationCeiling: String(limits.ceilings.iterationCeiling),
  subagentLimit: String(limits.ceilings.subagentLimit),
});

export type LimitsFormErrors = Partial<Record<keyof LimitsFormValues, string>>;

const POSITIVE_WHOLE = 'Enter a whole number greater than zero. A ceiling has no “unset” — the backend restores its default only when the setting is cleared elsewhere.';

export function validateLimitsForm(values: LimitsFormValues): LimitsFormErrors {
  const errors: LimitsFormErrors = {};
  const cap = values.dailySpendCapUsd.trim();
  if (cap !== '' && (!Number.isFinite(Number(cap)) || Number(cap) < 0))
    errors.dailySpendCapUsd = 'A dollar amount of zero or more, or empty for no cap. Zero clears the cap rather than refusing everything.';
  for (const field of ['tokenCeiling', 'iterationCeiling', 'subagentLimit'] as const) {
    const raw = values[field].trim();
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) errors[field] = POSITIVE_WHOLE;
  }
  return errors;
}

/**
 * Only what changed is sent — the route writes only the keys present, so an
 * unchanged field is omitted rather than rewritten. Emptying the cap sends
 * `0`, which is the route's spelling of "clear the cap".
 */
export function buildLimitsUpdate(values: LimitsFormValues, current: LimitsWire): UpdateLimitsInput {
  const update: UpdateLimitsInput = {};
  const capRaw = values.dailySpendCapUsd.trim();
  if (capRaw === '') {
    if (current.spend.capUsd !== null) update.dailySpendCapUsd = 0;
  } else if (Number(capRaw) !== current.spend.capUsd) {
    update.dailySpendCapUsd = Number(capRaw);
  }
  if (Number(values.tokenCeiling) !== current.ceilings.tokenCeiling) update.tokenCeiling = Number(values.tokenCeiling);
  if (Number(values.iterationCeiling) !== current.ceilings.iterationCeiling)
    update.iterationCeiling = Number(values.iterationCeiling);
  if (Number(values.subagentLimit) !== current.ceilings.subagentLimit) update.subagentLimit = Number(values.subagentLimit);
  return update;
}

export const hasLimitsChanges = (values: LimitsFormValues, current: LimitsWire): boolean =>
  Object.keys(buildLimitsUpdate(values, current)).length > 0;

/** Dollars as the backend reports them — never rounded into a false total. */
export const formatUsd = (value: number): string =>
  `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
