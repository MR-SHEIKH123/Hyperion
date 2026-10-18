import { describe, expect, it } from 'vitest';

import {
  colibriProviderFixture,
  localProviderFixture,
  puterProviderFixture,
  remoteProviderFixture,
} from '../../dev-harness/fixtures/providers';
import {
  activeProviderOf,
  buildCreateInput,
  buildUpdateInput,
  emptyProviderForm,
  isPaymentFailure,
  providerLocality,
  validateProviderForm,
  zdrSummary,
  type ProviderFormValues,
} from './providerModel';

const values = (overrides: Partial<ProviderFormValues> = {}): ProviderFormValues => ({
  ...emptyProviderForm('remote'),
  name: 'Hosted',
  baseUrl: 'https://api.example.test',
  ...overrides,
});

describe('providerLocality', () => {
  it('calls a loopback local provider local', () => {
    expect(providerLocality(localProviderFixture)).toBe('local');
  });

  it('treats a proxy that leaves the machine as remote even for a loopback URL', () => {
    expect(providerLocality({ ...localProviderFixture, egressProxy: 'http://user:***@proxy.example.test:8080' })).toBe(
      'remote',
    );
  });

  it('keeps a loopback proxy local', () => {
    expect(providerLocality({ ...localProviderFixture, egressProxy: 'http://127.0.0.1:8080' })).toBe('local');
  });

  it('marks remote, opencodex and puter remote whatever the URL says', () => {
    expect(providerLocality({ ...remoteProviderFixture, baseUrl: 'http://localhost:9999' })).toBe('remote');
    expect(providerLocality(puterProviderFixture)).toBe('remote');
  });

  it('says unknown instead of guessing at an unparseable URL', () => {
    expect(providerLocality({ ...colibriProviderFixture, baseUrl: 'not a url' })).toBe('unknown');
  });
});

describe('zdrSummary', () => {
  it('reports a confirmation with its note', () => {
    const summary = zdrSummary(puterProviderFixture);
    expect(summary.state).toBe('ZDR confirmed');
    expect(summary.detail).toContain('Enterprise agreement, ref. ENT-42');
  });

  it('reports a requested flag from the backend fields', () => {
    const summary = zdrSummary(remoteProviderFixture);
    expect(summary.state).toBe('ZDR requested');
    expect(summary.detail).toContain('X-Zero-Retention');
  });

  it('distinguishes not-requested from unknown', () => {
    expect(
      zdrSummary({ ...remoteProviderFixture, zdr: { support: 'supported_default', requestFlag: null, confirmedAt: null, confirmedNote: null } }).state,
    ).toBe('ZDR not requested');
    expect(zdrSummary(colibriProviderFixture).state).toBe('ZDR unknown');
  });

  it('reports not-supported and not-applicable in backend terms', () => {
    expect(
      zdrSummary({ ...remoteProviderFixture, zdr: { support: 'not_supported', requestFlag: null, confirmedAt: null, confirmedNote: null } }).state,
    ).toBe('ZDR not supported');
    expect(zdrSummary(localProviderFixture).state).toBe('ZDR not applicable');
  });
});

describe('validateProviderForm — mirrors the routes, never stricter', () => {
  it('accepts a bare-host OpenAI-compatible URL (the backend appends /v1)', () => {
    expect(validateProviderForm(values(), 'create')).toEqual({});
  });

  it('accepts a fractional priority, as asPriority does', () => {
    expect(validateProviderForm(values({ priority: '1.5' }), 'create')).toEqual({});
  });

  it('accepts a proxy URL carrying credentials, as parseEgressProxy does', () => {
    expect(validateProviderForm(values({ egressProxy: 'http://user:pass@proxy.local:8080' }), 'create')).toEqual({});
  });

  it('rejects what the routes reject', () => {
    expect(validateProviderForm(values({ name: '  ' }), 'create').name).toBeDefined();
    expect(validateProviderForm(values({ baseUrl: 'ftp://x.test' }), 'create').baseUrl).toBeDefined();
    expect(validateProviderForm(values({ baseUrl: 'example.test' }), 'create').baseUrl).toBeDefined();
    expect(validateProviderForm(values({ egressProxy: 'proxy.local:8080' }), 'create').egressProxy).toBeDefined();
    expect(validateProviderForm(values({ maxContextTokens: '0' }), 'create').maxContextTokens).toBeDefined();
    expect(validateProviderForm(values({ maxContextTokens: '1.5' }), 'create').maxContextTokens).toBeDefined();
    expect(validateProviderForm(values({ maxContextTokens: '32768' }), 'create')).toEqual({});
  });

  it('requires the Colibrì acknowledgement when creating an enabled Colibrì', () => {
    const colibri = values({ type: 'colibri', enabled: true });
    expect(validateProviderForm(colibri, 'create').acknowledgeSlow).toBeDefined();
    expect(validateProviderForm({ ...colibri, acknowledgeSlow: true }, 'create')).toEqual({});
  });

  it('does not ask for the acknowledgement on an edit (the enable route owns it there)', () => {
    expect(validateProviderForm(values({ type: 'colibri', enabled: true }), 'edit')).toEqual({});
  });
});

describe('body building', () => {
  it('omits secrets that were not typed and parses numbers', () => {
    const input = buildCreateInput(values({ priority: '5', maxContextTokens: '4096' }));
    expect(input).toEqual({
      name: 'Hosted',
      type: 'remote',
      baseUrl: 'https://api.example.test',
      enabled: false,
      priority: 5,
      maxContextTokens: 4096,
    });
  });

  it('creates Colibrì disabled so enabling goes through the acknowledging route', () => {
    const input = buildCreateInput(values({ type: 'colibri', enabled: true, acknowledgeSlow: true }));
    expect(input.enabled).toBe(false);
  });

  it('keeps the secret tri-state on update: empty keeps, typed replaces, remove sends null', () => {
    expect(buildUpdateInput(values()).apiKey).toBeUndefined();
    expect(buildUpdateInput(values({ apiKey: 'new-key' })).apiKey).toBe('new-key');
    expect(buildUpdateInput(values({ removeApiKey: true })).apiKey).toBeNull();
    expect(buildUpdateInput(values()).egressProxy).toBeUndefined();
    expect(buildUpdateInput(values({ egressProxy: 'http://127.0.0.1:9' })).egressProxy).toBe('http://127.0.0.1:9');
    expect(buildUpdateInput(values({ removeEgressProxy: true })).egressProxy).toBeNull();
  });

  it('clears the context override when the field is emptied', () => {
    expect(buildUpdateInput(values()).maxContextTokens).toBeNull();
    expect(buildUpdateInput(values({ maxContextTokens: '8192' })).maxContextTokens).toBe(8192);
  });
});

describe('isPaymentFailure and activeProviderOf', () => {
  it('recognises a 402 in the code or in the backend’s own message', () => {
    expect(isPaymentFailure('payment_required', 'nope')).toBe(true);
    expect(isPaymentFailure(undefined, 'Puter answered 402 (payment required).')).toBe(true);
    expect(isPaymentFailure('rate_limit', 'slow down')).toBe(false);
  });

  it('finds the enabled provider and no other', () => {
    expect(activeProviderOf([remoteProviderFixture, localProviderFixture])?.id).toBe(localProviderFixture.id);
    expect(activeProviderOf([remoteProviderFixture])).toBeNull();
    expect(activeProviderOf([])).toBeNull();
  });
});
