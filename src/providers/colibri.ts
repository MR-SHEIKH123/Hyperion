/**
 * Colibrì support — the fourth provider type.
 *
 * Colibrì (`coli serve --host 127.0.0.1 --port 8000 --model-id ...`) runs a
 * large quantised model on ordinary consumer hardware by streaming expert
 * tensors from disk rather than requiring them all resident in VRAM. It serves
 * an OpenAI-compatible surface — `GET /v1/models` and
 * `POST /v1/chat/completions` — so it needs no adapter of its own; `adapterFor`
 * routes type 'colibri' to the stock `openAiAdapter`.
 *
 * What lives here is the part that is NOT protocol: the honest performance
 * caveat, the documented default base URL, and a probe that answers "is
 * something Colibrì-shaped actually listening there?".
 */
import { AppError } from '../util/errors.ts';
import { createLogger } from '../util/logger.ts';
import { env } from '../config/env.ts';
import { openAiAdapter } from './adapters.ts';
import { DEFAULT_PROVIDER_ZDR } from '../types/core.ts';
import type { ModelInfo, ProviderRecord } from '../types/core.ts';

const log = createLogger('colibri');

/**
 * Colibrì's documented default. Its port is a CLI flag (`--port`) rather than a
 * fixed constant, so this is a suggestion for the UI to pre-fill, never an
 * assumption: every stored provider carries its own explicit `baseUrl`.
 */
export const COLIBRI_DEFAULT_BASE_URL = 'http://localhost:8000/v1';

/**
 * Shown before a Colibrì provider is enabled, and enforced by the ack gate on
 * the enable route.
 *
 * Deliberately blunt. The interesting cost is prefill, not decode: a large
 * agent preamble has to be processed before the first output token appears at
 * all, which reads as a hung application rather than a slow one. Softening this
 * into "may be slower than cloud models" would mean the first long silence gets
 * reported as a bug, and the user would be right to think so.
 */
export const COLIBRI_CAVEAT = [
  'Colibrì trades speed for the ability to run a very large model on hardware',
  'that could not otherwise hold it. Expect performance unlike any hosted API:',
  '',
  '  - Prefill dominates. A long prompt — an agent preamble, a pasted file — is',
  '    processed before the first output token appears. With a large context this',
  '    can mean a long stretch of apparent silence with no visible progress.',
  '  - Generation is roughly a token per second for a large model, so a full',
  '    answer is minutes, not seconds.',
  '  - One generation at a time. Further requests queue, and are rejected once',
  '    the queue is full.',
  '  - Sustained disk reads throughout, because expert tensors are streamed from',
  '    storage rather than held in VRAM.',
  '',
  'This is well suited to a single long unattended task and poorly suited to',
  'interactive chat. Keep a faster provider configured for everyday use —',
  'failover will pick it up if Colibrì stops responding.',
].join('\n');

/** Machine-readable form, so a UI can render it without parsing prose. */
export interface ColibriAdvisory {
  type: 'colibri';
  defaultBaseUrl: string;
  caveat: string;
  /** Must be echoed as `acknowledgeSlow: true` to enable a Colibrì provider. */
  acknowledgementRequired: true;
  acknowledgementField: 'acknowledgeSlow';
}

export function colibriAdvisory(): ColibriAdvisory {
  return {
    type: 'colibri',
    defaultBaseUrl: COLIBRI_DEFAULT_BASE_URL,
    caveat: COLIBRI_CAVEAT,
    acknowledgementRequired: true,
    acknowledgementField: 'acknowledgeSlow',
  };
}

/**
 * Refuse to enable a Colibrì provider without an explicit acknowledgement.
 *
 * Enforced in the backend rather than left to the UI on purpose: this repo has
 * no frontend, so a caveat that exists only as advisory metadata is a caveat
 * that any future client can forget to show. Returning the text in the 400 means
 * the warning travels with the refusal and cannot be skipped by accident.
 *
 * Deliberately NOT applied inside `enableProvider()`. Automatic failover calls
 * that function to promote a standby provider, and a gate there would make a
 * Colibrì provider unusable as a fallback — the exact moment it is most wanted.
 * The gate belongs on the user-initiated HTTP path only.
 */
export function requireSlowAcknowledgement(provider: ProviderRecord, acknowledged: boolean): void {
  if (provider.type !== 'colibri' || acknowledged) return;

  throw new AppError(
    'bad_request',
    'Enabling a Colibrì provider requires acknowledging its performance profile. ' +
      'Show the caveat, then retry with { "acknowledgeSlow": true }.',
    {
      details: {
        field: 'acknowledgeSlow',
        providerType: 'colibri',
        caveat: COLIBRI_CAVEAT,
      },
      retryable: false,
    },
  );
}

export interface ColibriProbeResult {
  detected: boolean;
  baseUrl: string;
  models: ModelInfo[];
  reason?: string;
}

/**
 * One-shot reachability probe against a candidate Colibrì base URL.
 *
 * A miss is a normal final answer, not an error: it returns `detected: false`
 * with a reason, the same contract `/detect-local` uses, so a UI never has to
 * special-case a failed probe.
 *
 * Single attempt, unlike Ollama detection. Colibrì is registered by hand at a
 * URL the user just typed, so a failure is far more likely to be a wrong port
 * than a cold start, and retrying a wrong port three times only delays saying
 * so. Nothing here registers or enables anything.
 */
export async function probeColibri(
  baseUrl: string = COLIBRI_DEFAULT_BASE_URL,
): Promise<ColibriProbeResult> {
  const target = baseUrl.trim().replace(/\/+$/, '');
  if (target === '') {
    throw new AppError('bad_request', 'baseUrl must not be empty', {
      details: { field: 'baseUrl' },
    });
  }

  // A throwaway record: the probe answers a question about a URL, and must work
  // before any provider row exists.
  const stub: ProviderRecord = {
    id: 'colibri-probe',
    name: 'colibri-probe',
    type: 'colibri',
    baseUrl: target,
    apiKeyEnc: null,
    apiKeyHint: null,
    enabled: false,
    priority: 0,
    healthStatus: 'unknown',
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
    models: null,
    modelsFetchedAt: null,
    modelsError: null,
    egressProxy: null,
    maxContextTokens: null,
    zdr: DEFAULT_PROVIDER_ZDR,
    createdAt: 0,
    updatedAt: 0,
  };

  try {
    // Bounded by its own timeout so a hung server cannot hold the request open:
    // the model list is a cheap metadata read even on a loaded Colibrì, so it
    // does not need the long generation budget.
    const models = await openAiAdapter.listModels(
      stub,
      AbortSignal.timeout(env.localDetectTimeoutMs * 4),
    );
    log.info('colibri probe succeeded', { baseUrl: target, models: models.length });
    return { detected: true, baseUrl: target, models };
  } catch (error) {
    const reason =
      error instanceof AppError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    log.info('colibri not detected', { baseUrl: target, reason });
    return { detected: false, baseUrl: target, models: [], reason };
  }
}
