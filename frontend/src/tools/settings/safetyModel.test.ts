import { describe, expect, it } from 'vitest';

import { limitsFixture } from '../../dev-harness/fixtures/safety';
import { buildLimitsUpdate, limitsFormFrom, validateLimitsForm, type LimitsFormValues } from './safetyModel';

const values = (overrides: Partial<LimitsFormValues> = {}): LimitsFormValues => ({
  ...limitsFormFrom(limitsFixture),
  ...overrides,
});

describe('limitsFormFrom', () => {
  it('renders an unset cap as empty, not zero', () => {
    const noCap = { ...limitsFixture, spend: { ...limitsFixture.spend, capUsd: null } };
    expect(limitsFormFrom(noCap).dailySpendCapUsd).toBe('');
    expect(limitsFormFrom(limitsFixture).dailySpendCapUsd).toBe('25');
  });
});

describe('validateLimitsForm — mirrors the limits route', () => {
  it('accepts the values the route accepts', () => {
    expect(validateLimitsForm(values())).toEqual({});
    expect(validateLimitsForm(values({ dailySpendCapUsd: '' }))).toEqual({});
    expect(validateLimitsForm(values({ dailySpendCapUsd: '0' }))).toEqual({});
    expect(validateLimitsForm(values({ dailySpendCapUsd: '10.50' }))).toEqual({});
  });

  it('refuses what the route refuses', () => {
    expect(validateLimitsForm(values({ dailySpendCapUsd: '-1' })).dailySpendCapUsd).toBeDefined();
    expect(validateLimitsForm(values({ dailySpendCapUsd: 'ten' })).dailySpendCapUsd).toBeDefined();
    expect(validateLimitsForm(values({ tokenCeiling: '0' })).tokenCeiling).toBeDefined();
    expect(validateLimitsForm(values({ tokenCeiling: '1.5' })).tokenCeiling).toBeDefined();
    expect(validateLimitsForm(values({ iterationCeiling: '' })).iterationCeiling).toBeDefined();
    expect(validateLimitsForm(values({ subagentLimit: '-2' })).subagentLimit).toBeDefined();
  });
});

describe('buildLimitsUpdate', () => {
  it('sends nothing when nothing changed', () => {
    expect(buildLimitsUpdate(values(), limitsFixture)).toEqual({});
  });

  it('sends only the field that changed', () => {
    expect(buildLimitsUpdate(values({ tokenCeiling: '500000' }), limitsFixture)).toEqual({ tokenCeiling: 500000 });
  });

  it('clears the cap by sending zero, as the route spells it', () => {
    expect(buildLimitsUpdate(values({ dailySpendCapUsd: '' }), limitsFixture)).toEqual({ dailySpendCapUsd: 0 });
  });

  it('does not send a clear for a cap that was never set', () => {
    const noCap = { ...limitsFixture, spend: { ...limitsFixture.spend, capUsd: null } };
    expect(buildLimitsUpdate(limitsFormFrom(noCap), noCap)).toEqual({});
  });

  it('sets a new cap without touching the ceilings', () => {
    expect(buildLimitsUpdate(values({ dailySpendCapUsd: '40' }), limitsFixture)).toEqual({ dailySpendCapUsd: 40 });
  });
});
