import type {
  ProviderTypeWire,
  ProviderWire,
} from '../../contracts/wire/providers';
import type { CreateProviderInput, UpdateProviderInput } from '../../api/providers';

/**
 * The pure half of the Providers surface: every label on a row, the locality
 * badge, the ZDR wording, and the form's validation and body-building live
 * here so they can be tested without rendering anything. Nothing in this file
 * fetches, and nothing invents a value the backend did not send: where the API
 * does not expose a distinction, the label says so instead of guessing.
 */

export const PROVIDER_TYPE_LABELS: Record<ProviderTypeWire, string> = {
  local: 'Local (Ollama)',
  remote: 'Remote (OpenAI-compatible)',
  opencodex: 'opencodex (local proxy)',
  puter: 'Puter',
  colibri: 'Colibrì (runs locally, can be very slow)',
};

export const PROVIDER_TYPES = Object.keys(PROVIDER_TYPE_LABELS) as ProviderTypeWire[];

/** Which provider is active, straight from the list the backend returned. */
export const activeProviderOf = (providers: ProviderWire[]): ProviderWire | null =>
  providers.find((provider) => provider.enabled) ?? null;

/**
 * Enabled / standby are the only two states the backend stores — `enabled` is
 * a single flag and the disable route clears the same flag standby rows have,
 * so there is no third "disabled" state to show. The word on the row follows
 * the routes the user can call: the active one, and the rest on standby.
 */
export const providerStateLabel = (provider: ProviderWire): string =>
  provider.enabled ? 'Active' : 'Standby';

/** Loopback in the same sense the backend's egress classification uses it. */
export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Local or remote, by the backend's documented rules (the per-provider egress
 * verdict is only served for the active provider, so a row shows the badge
 * these rules give and prints the base URL beside it — never a stronger claim):
 * remote/opencodex/puter always leave the machine; local/colibrì stay local
 * only while their URL is loopback and no proxy carries traffic elsewhere.
 * The stored proxy string is the redacted form, whose host survives redaction.
 */
export function providerLocality(provider: ProviderWire): 'local' | 'remote' | 'unknown' {
  if (provider.type === 'remote' || provider.type === 'opencodex' || provider.type === 'puter') return 'remote';
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    return 'unknown';
  }
  if (!isLoopbackUrl(provider.baseUrl)) return 'remote';
  if (provider.egressProxy !== null) {
    try {
      if (!isLoopbackUrl(new URL(provider.egressProxy).href)) return 'remote';
    } catch {
      return 'unknown';
    }
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? 'local' : 'unknown';
}

export const HEALTH_LABELS: Record<ProviderWire['healthStatus'], string> = {
  unknown: 'Health unknown',
  healthy: 'Healthy',
  degraded: 'Degraded',
  unhealthy: 'Unhealthy',
};

export const HEALTH_TONES: Record<ProviderWire['healthStatus'], 'success' | 'warning' | 'error' | 'neutral'> = {
  unknown: 'neutral',
  healthy: 'success',
  degraded: 'warning',
  unhealthy: 'error',
};

export function formatTime(value: string | number | null): string {
  if (value === null) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

/**
 * ZDR wording from the backend's own fields and nothing else. The state the
 * brief names map onto what `ProviderPublic.zdr` can actually say:
 * confirmed (an attestation with a time), requested (a flag is sent with each
 * request), not requested (the backend knows the support story and no flag is
 * set), or unknown (support itself is unknown and nothing is claimed).
 */
export function zdrSummary(provider: ProviderWire): { state: string; detail: string } {
  const { zdr } = provider;
  if (zdr.confirmedAt !== null) {
    return {
      state: 'ZDR confirmed',
      detail: `Confirmed ${formatTime(zdr.confirmedAt)}${zdr.confirmedNote === null ? '' : ` — ${zdr.confirmedNote}`}`,
    };
  }
  const supportDetail: Record<ProviderWire['zdr']['support'], string> = {
    unknown: 'Whether this provider supports zero data retention is unknown.',
    supported_default: 'The provider says ZDR applies by default.',
    supported_opt_in: 'The provider says ZDR is available on request.',
    not_supported: 'The provider does not support zero data retention.',
    not_applicable: 'Zero data retention does not apply here (the provider runs locally).',
  };
  if (zdr.requestFlag !== null) {
    return {
      state: 'ZDR requested',
      detail: `A flag is sent with each request (${zdr.requestFlag.location}: ${zdr.requestFlag.key}). ${supportDetail[zdr.support]}`,
    };
  }
  if (zdr.support === 'unknown') return { state: 'ZDR unknown', detail: supportDetail.unknown };
  if (zdr.support === 'not_supported') return { state: 'ZDR not supported', detail: supportDetail.not_supported };
  if (zdr.support === 'not_applicable') return { state: 'ZDR not applicable', detail: supportDetail.not_applicable };
  return { state: 'ZDR not requested', detail: supportDetail[zdr.support] };
}

/** The cooldown line, when the backend says the provider is cooling down. */
export function cooldownSummary(provider: ProviderWire): string | null {
  if (provider.cooldown === null) return null;
  const { until, failureClass, source, reason } = provider.cooldown;
  return `Cooling down until ${formatTime(until)} after ${failureClass.replace('_', ' ')} failures (${reason}; source: ${source}).`;
}

/** Whether a connection-test failure is the provider asking for payment (HTTP 402). */
export const isPaymentFailure = (code: string | undefined, message: string): boolean =>
  (code !== undefined && code.includes('payment')) || /\b402\b/.test(message);

// --- form model --------------------------------------------------------------

export interface ProviderFormValues {
  name: string;
  type: ProviderTypeWire;
  baseUrl: string;
  /** New key as typed. Empty means "no new key" — never a persisted value. */
  apiKey: string;
  /** Edit only: explicitly remove the stored key (sends null). */
  removeApiKey: boolean;
  /** New proxy as typed. Empty means "no new proxy typed". */
  egressProxy: string;
  /** Edit only: explicitly remove the stored proxy (sends null). */
  removeEgressProxy: boolean;
  priority: string;
  maxContextTokens: string;
  enabled: boolean;
  /** Colibrì only: the slow-inference acknowledgement. Never pre-ticked. */
  acknowledgeSlow: boolean;
}

export const emptyProviderForm = (type: ProviderTypeWire = 'local'): ProviderFormValues => ({
  name: '',
  type,
  baseUrl: '',
  apiKey: '',
  removeApiKey: false,
  egressProxy: '',
  removeEgressProxy: false,
  priority: '',
  maxContextTokens: '',
  enabled: false,
  acknowledgeSlow: false,
});

export const providerFormFrom = (provider: ProviderWire): ProviderFormValues => ({
  ...emptyProviderForm(provider.type),
  name: provider.name,
  baseUrl: provider.baseUrl,
  priority: provider.priority === 0 ? '' : String(provider.priority),
  maxContextTokens: provider.maxContextTokens === null ? '' : String(provider.maxContextTokens),
  enabled: provider.enabled,
});

export type ProviderFormErrors = Partial<
  Record<'name' | 'baseUrl' | 'egressProxy' | 'priority' | 'maxContextTokens' | 'acknowledgeSlow', string>
>;

const httpUrlOrNull = (value: string): URL | null => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
};

/**
 * Client validation that mirrors the provider routes and is never stricter:
 * every rule here is one the route enforces (name present, a valid http(s)
 * base URL, a proxy with a host, whole-token context override), checked in the
 * same units. Anything the route would accept must pass here.
 */
export function validateProviderForm(values: ProviderFormValues, mode: 'create' | 'edit'): ProviderFormErrors {
  const errors: ProviderFormErrors = {};
  if (values.name.trim() === '') errors.name = 'Give the provider a name.';
  const baseUrl = values.baseUrl.trim();
  if (baseUrl === '') errors.baseUrl = 'The base URL is required.';
  else if (httpUrlOrNull(baseUrl) === null)
    errors.baseUrl =
      'Enter a valid http:// or https:// URL. For an OpenAI-compatible host the backend adds /v1 itself when the path is empty.';
  const proxy = values.egressProxy.trim();
  if (proxy !== '' && !values.removeEgressProxy) {
    const parsed = httpUrlOrNull(proxy);
    if (parsed === null || parsed.hostname === '')
      errors.egressProxy = 'Enter a valid proxy URL such as http://127.0.0.1:8080 (http or https, with a host).';
  }
  if (values.priority.trim() !== '' && !Number.isFinite(Number(values.priority)))
    errors.priority = 'Priority must be a number (higher runs first when enabling by priority).';
  const maxContext = values.maxContextTokens.trim();
  if (maxContext !== '' && (!/^\d+$/.test(maxContext) || Number(maxContext) <= 0))
    errors.maxContextTokens = 'Use a whole number of tokens greater than zero, or leave this empty.';
  if (values.type === 'colibri' && values.enabled && mode === 'create' && !values.acknowledgeSlow)
    errors.acknowledgeSlow = 'Tick the acknowledgement: Colibrì inference can be extremely slow.';
  return errors;
}

export function buildCreateInput(values: ProviderFormValues): CreateProviderInput {
  const input: CreateProviderInput = {
    name: values.name.trim(),
    type: values.type,
    baseUrl: values.baseUrl.trim(),
    // Colibrì created "enabled" is a two-step on purpose: the create route has
    // no slow-acknowledgement field, so the caller creates it disabled and
    // enables it through the enable route with the acknowledgement attached.
    enabled: values.type === 'colibri' ? false : values.enabled,
  };
  if (values.apiKey !== '') input.apiKey = values.apiKey;
  const proxy = values.egressProxy.trim();
  if (proxy !== '') input.egressProxy = proxy;
  if (values.priority.trim() !== '') input.priority = Number(values.priority);
  if (values.maxContextTokens.trim() !== '') input.maxContextTokens = Number(values.maxContextTokens);
  return input;
}

export function buildUpdateInput(values: ProviderFormValues): UpdateProviderInput {
  const input: UpdateProviderInput = {
    name: values.name.trim(),
    baseUrl: values.baseUrl.trim(),
  };
  if (values.removeApiKey) input.apiKey = null;
  else if (values.apiKey !== '') input.apiKey = values.apiKey;
  if (values.removeEgressProxy) input.egressProxy = null;
  else if (values.egressProxy.trim() !== '') input.egressProxy = values.egressProxy.trim();
  if (values.priority.trim() !== '') input.priority = Number(values.priority);
  // Emptying the field clears the override — the route treats null as "back to
  // the provider's own reported/default window", which is what the label says.
  input.maxContextTokens = values.maxContextTokens.trim() === '' ? null : Number(values.maxContextTokens);
  return input;
}
