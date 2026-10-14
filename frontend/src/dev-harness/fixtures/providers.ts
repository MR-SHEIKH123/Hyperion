import type {
  ColibriAdvisoryWire,
  ProviderModelsResponseWire,
  ProviderWire,
  PuterAdvisoryWire,
} from '../../contracts/wire/providers';

/**
 * Provider fixtures for the dev harness (Settings 2.5, slice 1).
 *
 * Typed against the wire schemas, so a backend shape change breaks this file
 * at compile time rather than letting the harness keep showing a row the API
 * no longer produces. Times are epoch milliseconds, as `ProviderPublic`
 * serves them. No key material appears here beyond what the backend itself
 * exposes (`hasKey` / `apiKeyHint` / the redacted proxy form) — that absence
 * is the fixture's point as much as the values are.
 */
const base = {
  hasKey: false,
  apiKeyHint: null as string | null,
  priority: 0,
  healthStatus: 'unknown' as const,
  lastError: null as string | null,
  lastErrorAt: null as number | null,
  lastSuccessAt: null as number | null,
  modelCount: null as number | null,
  modelsFetchedAt: null as number | null,
  modelsError: null as string | null,
  egressProxy: null as string | null,
  cooldown: null as ProviderWire['cooldown'],
  maxContextTokens: null as number | null,
  zdr: { support: 'unknown' as const, requestFlag: null, confirmedAt: null, confirmedNote: null },
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_000_000,
};

export const localProviderFixture: ProviderWire = {
  ...base,
  id: 'provider-local',
  name: 'Ollama on this machine',
  type: 'local',
  baseUrl: 'http://localhost:11434',
  enabled: true,
  healthStatus: 'healthy',
  lastSuccessAt: 1_760_000_100_000,
  modelCount: 3,
  modelsFetchedAt: 1_760_000_100_000,
  zdr: { support: 'not_applicable', requestFlag: null, confirmedAt: null, confirmedNote: null },
};

export const remoteProviderFixture: ProviderWire = {
  ...base,
  id: 'provider-remote',
  name: 'Hosted endpoint',
  type: 'remote',
  baseUrl: 'https://api.example.test/v1',
  hasKey: true,
  apiKeyHint: 'sk-…cdef',
  enabled: false,
  priority: 10,
  healthStatus: 'degraded',
  lastError: 'Upstream answered 429 (rate limited).',
  lastErrorAt: 1_760_000_200_000,
  lastSuccessAt: 1_760_000_150_000,
  modelCount: 12,
  modelsFetchedAt: 1_760_000_150_000,
  egressProxy: 'http://user:***@proxy.example.test:8080',
  cooldown: {
    until: 1_760_000_600_000,
    failureClass: 'rate_limit',
    source: 'retry_after',
    reason: 'provider asked for a pause',
  },
  maxContextTokens: 32768,
  zdr: {
    support: 'supported_opt_in',
    requestFlag: { location: 'header', key: 'X-Zero-Retention', value: 'true' },
    confirmedAt: null,
    confirmedNote: null,
  },
};

export const colibriProviderFixture: ProviderWire = {
  ...base,
  id: 'provider-colibri',
  name: 'Colibrì (sovereign node)',
  type: 'colibri',
  baseUrl: 'http://127.0.0.1:8471/v1',
  enabled: false,
  modelCount: 1,
  modelsFetchedAt: 1_760_000_120_000,
};

export const puterProviderFixture: ProviderWire = {
  ...base,
  id: 'provider-puter',
  name: 'Puter account',
  type: 'puter',
  baseUrl: 'https://api.puter.com/puterai/openai/v1/',
  hasKey: true,
  apiKeyHint: '…wxyz',
  enabled: false,
  healthStatus: 'unhealthy',
  lastError: 'Puter answered 402 (payment required).',
  lastErrorAt: 1_760_000_300_000,
  zdr: {
    support: 'unknown',
    requestFlag: null,
    confirmedAt: 1_759_000_000_000,
    confirmedNote: 'Enterprise agreement, ref. ENT-42',
  },
};

export const providersFixture: ProviderWire[] = [
  localProviderFixture,
  remoteProviderFixture,
  colibriProviderFixture,
  puterProviderFixture,
];

export const providerModelsFixture: ProviderModelsResponseWire = {
  providerId: localProviderFixture.id,
  models: [
    { id: 'llama3.1:8b', contextLength: 131072 },
    { id: 'qwen2.5-coder:7b' },
  ],
};

export const puterAdvisoryFixture: PuterAdvisoryWire = {
  type: 'puter',
  defaultBaseUrl: 'https://api.puter.com/puterai/openai/v1/',
  credential: 'auth_token',
  egress: 'remote',
  catalogueUrl: 'https://puter.com/drivers/ai/models',
  requiresPaidPlan: true,
  note: 'Mint an auth token in your Puter account and paste it as the API key. Tokens expire — pick the expiry that matches how you use this machine.',
};

export const colibriAdvisoryFixture: ColibriAdvisoryWire = {
  type: 'colibri',
  defaultBaseUrl: 'http://127.0.0.1:8471/v1',
  caveat: 'Colibrì is a sovereign local provider: inference can be extremely slow compared with hosted providers.',
  acknowledgementRequired: true,
  acknowledgementField: 'acknowledgeSlow',
};
