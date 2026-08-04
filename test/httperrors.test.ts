/**
 * Malformed requests must be reported as client errors.
 *
 * These live at the HTTP boundary because that is the only place they can
 * happen: Express rejects a bad percent-escape in the path, and body-parser
 * rejects an unparseable JSON body, both *before* any route handler runs. No
 * module-level test can reach that code, which is exactly why these two cases
 * shipped returning `internal_error` 500 — telling the client the server had
 * broken when in fact the request had.
 *
 * The suite boots the real app on an ephemeral port and drives it with fetch,
 * because a hand-built fake error object would prove only that the classifier
 * handles the shape I imagined, not the shape Express actually throws.
 */

import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import './helpers.ts';

import type { Server } from 'node:http';

let server: Server;
let base: string;

before(async () => {
  const { createApp } = await import('../src/http/app.ts');
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo from listen(0)');
  }
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('malformed requests are client errors, not server faults', () => {
  test('a bad percent-escape in the path is a 400, not a 500', async () => {
    // '%ZZ' is not a valid escape, so Express throws URIError while decoding
    // the route parameter — before providers.ts is ever consulted.
    const res = await fetch(`${base}/api/providers/%ZZ`);
    const body = (await res.json()) as { error: { code: string; message: string } };

    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'bad_request');
    assert.match(body.error.message, /URL-encoded/);
  });

  test('an unparseable JSON body is a 400, not a 500', async () => {
    const res = await fetch(`${base}/api/resources/detect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const body = (await res.json()) as { error: { code: string; message: string } };

    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'bad_request');
    assert.match(body.error.message, /valid JSON/);
  });

  test('the parser message never reaches the client', async () => {
    // body-parser quotes the offending input in its message. That is useful in
    // the log and wrong on the wire, so it goes in privateDetails instead.
    const secret = 'notjson-PASTED-SECRET';
    const res = await fetch(`${base}/api/resources/detect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{${secret}`,
    });
    const raw = await res.text();

    assert.equal(res.status, 400);
    assert.equal(raw.includes(secret), false, 'the rejected body was echoed back');
    assert.equal(raw.includes('position'), false, 'the parser message leaked');
  });

  test('an unmatched route is still a 404 with the usual envelope', async () => {
    const res = await fetch(`${base}/api/definitely-not-a-route`);
    const body = (await res.json()) as { error: { code: string; retryable: boolean } };

    assert.equal(res.status, 404);
    assert.equal(body.error.code, 'not_found');
    assert.equal(body.error.retryable, false);
  });

  test('a well-formed body still reaches validation, which owns its own 400', async () => {
    // Proves the parser fix did not swallow the handler's own validation: this
    // body parses cleanly, so the 400 must come from asString(url).
    const res = await fetch(`${base}/api/resources/detect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = (await res.json()) as {
      error: { code: string; details?: { field?: string } };
    };

    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'bad_request');
    assert.equal(body.error.details?.field, 'url');
  });

  test('an oversized JSON body is 413, not a flat 400', async () => {
    // The JSON limit is 25mb; body-parser tags this entity.too.large. It is
    // normalized to bad_request for the code, but the status must survive.
    const res = await fetch(`${base}/api/resources/detect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `http://x/${'a'.repeat(26 * 1024 * 1024)}` }),
    });
    const body = (await res.json()) as { error: { code: string } };

    assert.equal(res.status, 413);
    assert.equal(body.error.code, 'bad_request');
  });
});
