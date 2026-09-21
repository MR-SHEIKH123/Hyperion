/**
 * Credential containment.
 *
 * SPEC line 68: "Never send provider API keys to the frontend, even
 * transiently." The realistic way that breaks is not a deliberate leak but an
 * upstream error body: an OpenAI-compatible gateway rejecting a request echoes
 * the key it was handed ("Incorrect API key provided: sk-proj-..."), and any
 * code path that forwards that body verbatim to the client publishes the secret.
 *
 * Two independent mechanisms are asserted here, because either one alone is a
 * single point of failure:
 *   1. Structural — upstream bodies go in `AppError.privateDetails`, which
 *      `toJSON()` does not serialize. This is the control.
 *   2. Textual — `redactSecrets` masks credential-shaped text. This is defence
 *      in depth for the server-side log, where the body does still land.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { cleanupHome, startMockProvider, type MockProvider } from './helpers.ts';

/**
 * Shaped like a real OpenAI key so the redactor's `sk-` rule applies, but random
 * so an accidental match against unrelated fixture text cannot pass this test.
 */
const SECRET = 'sk-proj-Zx91NotARealKeyJustForTesting42';

/** The distinctive tail. Asserting on this catches a partially-masked leak. */
const SECRET_TAIL = 'JustForTesting42';

let provider: MockProvider;

before(async () => {
  provider = await startMockProvider();
});

after(async () => {
  await provider.close();
  await cleanupHome();
});

/** A provider row pointing at the mock; no stored key, since the leak is inbound. */
function providerRecord(baseUrl: string) {
  return {
    id: 'p-secret',
    name: 'mock',
    type: 'remote' as const,
    baseUrl,
    apiKeyEnc: null,
    apiKeyHint: null,
    enabled: true,
    priority: 0,
    healthStatus: 'unknown' as const,
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
    models: null,
    modelsFetchedAt: null,
    modelsError: null,
    egressProxy: null,
    zdr: { support: 'unknown' as const, requestFlag: null, confirmedAt: null, confirmedNote: null },
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('provider error bodies never reach the client', () => {
  it('a 401 echoing the API key produces an envelope with no trace of it', async () => {
    const { openAiAdapter } = await import('../src/providers/adapters.ts');
    const { AppError } = await import('../src/util/errors.ts');

    provider.behave({
      modelsFailStatus: 401,
      failBody: JSON.stringify({
        error: {
          message: `Incorrect API key provided: ${SECRET}. You can find your API key at https://platform.openai.com/account/api-keys.`,
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      }),
    });

    const error = await openAiAdapter
      .listModels(providerRecord(provider.baseUrl))
      .then(() => null)
      .catch((e: unknown) => e);

    assert.ok(error instanceof AppError, 'expected an AppError');
    assert.equal(error.code, 'provider_auth_failed');
    assert.equal(error.retryable, false, 'a bad key is not fixed by retrying');

    // The wire format is the thing that matters: this is verbatim what the
    // frontend receives.
    const wire = JSON.stringify(error.toJSON());
    assert.ok(!wire.includes(SECRET), 'full key present in the error envelope');
    assert.ok(!wire.includes(SECRET_TAIL), 'part of the key present in the error envelope');

    // Status is still exposed, because the frontend needs something to branch on.
    assert.equal(error.toJSON().error.details?.status, 401);

    // `details` must not carry the body at all, redacted or otherwise — the
    // structural guarantee, independent of whether the redactor recognised it.
    assert.equal(
      (error.details as { body?: unknown } | undefined)?.body,
      undefined,
      'upstream body must not be in `details`',
    );
  });

  it('keeps a redacted body server-side so the failure is still diagnosable', async () => {
    const { openAiAdapter } = await import('../src/providers/adapters.ts');
    const { AppError } = await import('../src/util/errors.ts');

    provider.behave({
      modelsFailStatus: 401,
      failBody: `Incorrect API key provided: ${SECRET}`,
    });

    const error = await openAiAdapter
      .listModels(providerRecord(provider.baseUrl))
      .then(() => null)
      .catch((e: unknown) => e);

    assert.ok(error instanceof AppError);

    const body = (error.privateDetails as { body?: string } | undefined)?.body;
    assert.equal(typeof body, 'string', 'body should be retained for the log');
    assert.ok(!body!.includes(SECRET_TAIL), 'retained body should still be redacted');
    // Prefix survives, so the log says what kind of credential was rejected.
    assert.ok(body!.includes('Incorrect API key provided'), 'surrounding text should survive');
    assert.ok(body!.includes('[redacted]'), 'the secret should be replaced, not deleted');
  });

  it('applies to stream failures, not just model listing', async () => {
    const { openAiAdapter } = await import('../src/providers/adapters.ts');
    const { AppError } = await import('../src/util/errors.ts');

    provider.behave({
      modelsFailStatus: undefined,
      failStatus: 401,
      failBody: `{"error":{"message":"bad key ${SECRET}"}}`,
    });

    const stream = openAiAdapter.stream(providerRecord(provider.baseUrl), {
      modelId: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const error = await (async () => {
      try {
        for await (const _chunk of stream) {
          // drain; the failure is raised before the first chunk
        }
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();

    assert.ok(error instanceof AppError, 'expected an AppError');
    const wire = JSON.stringify(error.toJSON());
    assert.ok(!wire.includes(SECRET_TAIL), 'stream failures must not leak the key either');
  });

  it('a 500 body is withheld too, since any body can quote a request header', async () => {
    const { openAiAdapter } = await import('../src/providers/adapters.ts');
    const { AppError } = await import('../src/util/errors.ts');

    provider.behave({
      modelsFailStatus: 500,
      failBody: `upstream failed while sending Authorization: Bearer ${SECRET}`,
    });

    const error = await openAiAdapter
      .listModels(providerRecord(provider.baseUrl))
      .then(() => null)
      .catch((e: unknown) => e);

    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'provider_error');
    assert.equal(error.retryable, true, '5xx is genuine provider trouble, so retryable');

    const wire = JSON.stringify(error.toJSON());
    assert.ok(!wire.includes(SECRET_TAIL), '5xx body leaked a bearer token');
  });
});

describe('redactSecrets', () => {
  it('masks vendor-prefixed keys while keeping the prefix legible', async () => {
    const { redactSecrets } = await import('../src/util/redact.ts');

    const out = redactSecrets(`key=${SECRET} rejected`);
    assert.ok(!out.includes(SECRET_TAIL));
    // Retaining `sk` tells a reader which credential family failed.
    assert.ok(out.includes('sk-'), 'prefix should survive for diagnosis');
    assert.ok(out.includes('rejected'), 'surrounding text should survive');
  });

  it('masks bearer tokens', async () => {
    const { redactSecrets } = await import('../src/util/redact.ts');
    const out = redactSecrets('Authorization: Bearer abcdef1234567890abcdef');
    assert.ok(!out.includes('abcdef1234567890abcdef'));
    assert.ok(out.includes('Bearer'));
  });

  it('masks values whose field name declares them secret', async () => {
    const { redactSecrets } = await import('../src/util/redact.ts');

    const json = redactSecrets('{"api_key":"totally-not-a-prefixed-value","model":"gpt-4"}');
    assert.ok(!json.includes('totally-not-a-prefixed-value'));
    assert.ok(json.includes('"model":"gpt-4"'), 'non-secret fields should be untouched');

    const query = redactSecrets('https://x.test/v1?access_token=opaquevalue123&model=gpt-4');
    assert.ok(!query.includes('opaquevalue123'));
    assert.ok(query.includes('model=gpt-4'));
  });

  it('masks Google-style keys that run straight into the secret', async () => {
    const { redactSecrets } = await import('../src/util/redact.ts');
    const out = redactSecrets('AIzaSyA1B2C3D4E5F6G7H8I9J0abcdefghij failed');
    assert.ok(!out.includes('SyA1B2C3D4E5F6G7H8I9J0'));
    assert.ok(out.includes('failed'));
  });

  it('leaves ordinary text alone', async () => {
    const { redactSecrets, looksRedacted } = await import('../src/util/redact.ts');

    const clean = 'model gpt-4 is not available for this provider';
    assert.equal(redactSecrets(clean), clean);
    assert.equal(looksRedacted(clean), true);
    assert.equal(looksRedacted(`bad key ${SECRET}`), false);
  });

  it('handles the empty string', async () => {
    const { redactSecrets } = await import('../src/util/redact.ts');
    assert.equal(redactSecrets(''), '');
  });
});
