/**
 * Provider protocol adapters.
 *
 * Two protocols cover the intended providers:
 *   - `openai`: any OpenAI-compatible gateway (AgentRouter et al) — /v1/models
 *     and /v1/chat/completions with SSE streaming.
 *   - `ollama`: the local runner — /api/tags and /api/chat with JSONL streaming.
 *
 * Adapters are pure protocol translation: they do not decide failover, health or
 * routing. Failures are thrown as AppError with an accurate code so the router
 * above can distinguish "unreachable" (health-relevant) from "bad key" (not).
 */
import { AppError } from '../util/errors.ts';
import { tryDecrypt } from '../security/keystore.ts';
import { env } from '../config/env.ts';
import type {
  CompletionRequest,
  ModelInfo,
  ProviderAdapter,
  ProviderRecord,
  StreamChunk,
} from '../types/core.ts';

/** Join a base URL and path without doubling or dropping slashes. */
function url(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

/**
 * fetch with a timeout, translating transport failures into typed errors.
 *
 * Distinguishing timeout from connection-refused matters: both are health
 * failures, but the messages the user sees are very different diagnoses.
 */
async function httpFetch(
  target: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const timer = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal ? AbortSignal.any([timer, externalSignal]) : timer;

  try {
    return await fetch(target, { ...init, signal });
  } catch (error) {
    if (externalSignal?.aborted) {
      throw new AppError('aborted', 'Request cancelled', { retryable: false });
    }
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new AppError('provider_timeout', `Provider did not respond within ${timeoutMs}ms`, {
        cause: error,
      });
    }
    throw new AppError('provider_unreachable', `Could not reach provider at ${target}`, {
      cause: error,
    });
  }
}

/** Map an HTTP status into a typed error, since not all failures are equal. */
async function failFromResponse(response: Response, context: string): Promise<never> {
  const body = await response.text().catch(() => '');
  const detail = body.slice(0, 500);

  // 401/403 are configuration problems: retrying cannot help, and they must NOT
  // count toward the health threshold or a wrong key would evict a live provider.
  if (response.status === 401 || response.status === 403) {
    throw new AppError('provider_auth_failed', `${context}: provider rejected the API key`, {
      details: { status: response.status, body: detail },
      retryable: false,
    });
  }
  // 4xx is our bad request; also not the provider being unhealthy.
  if (response.status < 500 && response.status !== 429) {
    throw new AppError('provider_error', `${context}: provider returned ${response.status}`, {
      details: { status: response.status, body: detail },
      retryable: false,
    });
  }
  // 5xx and 429 are genuine provider-side trouble.
  throw new AppError('provider_error', `${context}: provider returned ${response.status}`, {
    details: { status: response.status, body: detail },
    retryable: true,
  });
}

/** Decrypt a provider key at the last possible moment, server-side only. */
function authHeaders(provider: ProviderRecord): Record<string, string> {
  const key = tryDecrypt(provider.apiKeyEnc);
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * Iterate `data:` frames from an SSE body.
 * Buffers across chunk boundaries — a JSON payload is routinely split mid-object.
 */
async function* sseFrames(response: Response, signal?: AbortSignal): AsyncGenerator<string> {
  const body = response.body;
  if (!body) throw new AppError('provider_error', 'Provider returned an empty stream body');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      if (signal?.aborted) throw new AppError('aborted', 'Request cancelled', { retryable: false });

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line; \r\n tolerated.
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2));

        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('data:')) yield line.slice(5).trim();
        }
      }
    }
    // Some gateways omit the final blank line.
    for (const line of buffer.split(/\r?\n/)) {
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// --- OpenAI-compatible ----------------------------------------------------

export const openAiAdapter: ProviderAdapter = {
  kind: 'openai',

  async listModels(provider, signal) {
    const response = await httpFetch(
      url(provider.baseUrl, '/models'),
      { headers: { ...authHeaders(provider), Accept: 'application/json' } },
      15_000,
      signal,
    );
    if (!response.ok) await failFromResponse(response, 'Listing models');

    const payload = (await response.json().catch(() => null)) as
      | { data?: unknown[]; models?: unknown[] }
      | null;
    // Accept `{data:[...]}` (OpenAI) and a bare array, which some gateways return.
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
          ? payload.models
          : null;

    if (!list) {
      throw new AppError('provider_error', 'Model list response was not in a recognized format');
    }

    return list
      .map((entry): ModelInfo | null => {
        if (typeof entry === 'string') return { id: entry };
        if (entry && typeof entry === 'object') {
          const row = entry as Record<string, unknown>;
          const id = row.id ?? row.name ?? row.model;
          if (typeof id !== 'string' || id === '') return null;
          return {
            id,
            ...(typeof row.name === 'string' && row.name !== id ? { label: row.name } : {}),
            ...(typeof row.owned_by === 'string' ? { ownedBy: row.owned_by } : {}),
            ...(typeof row.context_length === 'number' ? { contextLength: row.context_length } : {}),
          };
        }
        return null;
      })
      .filter((m): m is ModelInfo => m !== null);
  },

  async *stream(provider, request) {
    const response = await httpFetch(
      url(provider.baseUrl, '/chat/completions'),
      {
        method: 'POST',
        headers: {
          ...authHeaders(provider),
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: request.modelId,
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
          // Ask for token counts in the stream; harmless where unsupported.
          stream_options: { include_usage: true },
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        }),
      },
      env.requestTimeoutMs,
      request.signal,
    );

    if (!response.ok) await failFromResponse(response, 'Streaming completion');

    let finishReason: string | undefined;
    let sawUsage = false;
    let approxOut = 0;

    for await (const data of sseFrames(response, request.signal)) {
      if (data === '' || data === '[DONE]') continue;

      let frame: OpenAiStreamFrame;
      try {
        frame = JSON.parse(data) as OpenAiStreamFrame;
      } catch {
        continue; // ignore keep-alives and non-JSON noise
      }

      // Some gateways deliver errors inside a 200 stream.
      if (frame.error) {
        throw new AppError('provider_error', frame.error.message ?? 'Provider stream error', {
          details: { providerError: frame.error },
          retryable: true,
        });
      }

      const choice = frame.choices?.[0];
      const text = choice?.delta?.content;
      if (typeof text === 'string' && text !== '') {
        approxOut += 1;
        yield { type: 'token', text };
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;

      if (frame.usage) {
        sawUsage = true;
        yield {
          type: 'usage',
          usage: {
            tokensIn: frame.usage.prompt_tokens ?? 0,
            tokensOut: frame.usage.completion_tokens ?? 0,
          },
        };
      }
    }

    // Without provider-reported usage the cost dashboard would have nothing, so
    // fall back to a rough estimate. Marked approximate by being derived from
    // chunk counts rather than a tokenizer.
    if (!sawUsage) {
      yield { type: 'usage', usage: { tokensIn: estimateTokens(request.messages), tokensOut: approxOut } };
    }

    yield { type: 'done', ...(finishReason ? { finishReason } : {}) };
  },
};

interface OpenAiStreamFrame {
  choices?: { delta?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** ~4 characters per token. Only used when the provider reports no usage. */
function estimateTokens(messages: { content: string }[]): number {
  return Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
}

// --- Ollama ----------------------------------------------------------------

export const ollamaAdapter: ProviderAdapter = {
  kind: 'ollama',

  async listModels(provider, signal) {
    const response = await httpFetch(
      url(provider.baseUrl, '/api/tags'),
      { headers: { Accept: 'application/json' } },
      10_000,
      signal,
    );
    if (!response.ok) await failFromResponse(response, 'Listing local models');

    const payload = (await response.json().catch(() => null)) as
      | { models?: { name?: string; model?: string; details?: { parameter_size?: string } }[] }
      | null;

    if (!payload?.models) {
      throw new AppError('provider_error', 'Ollama returned an unrecognized model list');
    }

    return payload.models
      .map((m): ModelInfo | null => {
        const id = m.model ?? m.name;
        return typeof id === 'string' && id !== '' ? { id } : null;
      })
      .filter((m): m is ModelInfo => m !== null);
  },

  async *stream(provider, request) {
    const response = await httpFetch(
      url(provider.baseUrl, '/api/chat'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.modelId,
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
          ...(request.temperature !== undefined || request.maxTokens !== undefined
            ? {
                options: {
                  ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                  ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
                },
              }
            : {}),
        }),
      },
      env.requestTimeoutMs,
      request.signal,
    );

    if (!response.ok) await failFromResponse(response, 'Streaming local completion');

    const body = response.body;
    if (!body) throw new AppError('provider_error', 'Ollama returned an empty stream body');

    // Ollama streams newline-delimited JSON, not SSE.
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason: string | undefined;

    try {
      for (;;) {
        if (request.signal?.aborted) {
          throw new AppError('aborted', 'Request cancelled', { retryable: false });
        }
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line === '') continue;

          let frame: OllamaStreamFrame;
          try {
            frame = JSON.parse(line) as OllamaStreamFrame;
          } catch {
            continue;
          }

          if (frame.error) {
            throw new AppError('provider_error', frame.error, { retryable: true });
          }

          const text = frame.message?.content;
          if (typeof text === 'string' && text !== '') yield { type: 'token', text };

          if (frame.done) {
            finishReason = frame.done_reason ?? 'stop';
            yield {
              type: 'usage',
              usage: {
                tokensIn: frame.prompt_eval_count ?? 0,
                tokensOut: frame.eval_count ?? 0,
              },
            };
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    yield { type: 'done', ...(finishReason ? { finishReason } : {}) };
  },
};

interface OllamaStreamFrame {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

// --- selection & local detection ------------------------------------------

export function adapterFor(provider: ProviderRecord): ProviderAdapter {
  return provider.type === 'local' ? ollamaAdapter : openAiAdapter;
}

export interface DetectResult {
  detected: boolean;
  baseUrl: string;
  models: ModelInfo[];
  attempts: number;
  reason?: string;
}

/**
 * One-shot local runner detection. Deliberately NOT the runtime health check.
 *
 * A clean refusal means Ollama is not installed/running — reported immediately
 * with no retries and no background rescanning, per spec. Flaky symptoms
 * (timeout, connection reset, garbled response) get up to 3 attempts, since
 * those can be a cold start rather than absence.
 */
export async function detectLocalProvider(baseUrl = env.ollamaUrl): Promise<DetectResult> {
  const stub: ProviderRecord = {
    id: 'probe',
    name: 'probe',
    type: 'local',
    baseUrl,
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
    createdAt: 0,
    updatedAt: 0,
  };

  let lastReason = 'not detected';

  for (let attempt = 1; attempt <= env.localDetectAttempts; attempt++) {
    try {
      const models = await ollamaAdapter.listModels(stub, AbortSignal.timeout(env.localDetectTimeoutMs));
      return { detected: true, baseUrl, models, attempts: attempt };
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      lastReason = appError?.message ?? String(error);

      // A hard refusal is conclusive: nothing is listening. Stop immediately
      // rather than burning the retry budget on a definite answer.
      if (isConnectionRefused(error)) {
        return {
          detected: false,
          baseUrl,
          models: [],
          attempts: attempt,
          reason: `Nothing is listening on ${baseUrl}`,
        };
      }
      // Otherwise it looked flaky — retry.
    }
  }

  return {
    detected: false,
    baseUrl,
    models: [],
    attempts: env.localDetectAttempts,
    reason: lastReason,
  };
}

function isConnectionRefused(error: unknown): boolean {
  const chain: unknown[] = [error];
  while (chain.length) {
    const current = chain.pop();
    if (current instanceof Error) {
      const code = (current as { code?: string }).code;
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') return true;
      if (current.cause !== undefined) chain.push(current.cause);
    }
  }
  return false;
}
