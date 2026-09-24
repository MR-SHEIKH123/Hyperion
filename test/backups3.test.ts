/**
 * S3-compatible backup destinations (1.29): config validation, SigV4 uploads
 * against a fake S3 server, the round-trip probe, and the automatic run's
 * never-throw S3 leg.
 *
 * What this suite pins, and how honestly:
 *
 *   - The canonical request is pinned against the AWS documentation's worked
 *     example — an external oracle for the canonicalization half of SigV4.
 *     The fake S3 server then asserts the *shape* of what we send
 *     (Authorization structure, credential scope, payload hash matching the
 *     actual bytes) without reimplementing signature verification, which would
 *     be self-verification theater. Live-provider verification is what
 *     `POST /api/backup/destinations/s3/test` exists for.
 *   - The secret is asserted absent from every response and present in the
 *     settings table only in encrypted form.
 *   - Failure semantics are asserted on both paths: the explicit upload fails
 *     the request *after* the local archive exists; the automatic leg degrades
 *     to `s3Key: null` plus an `error_log` row; a failed probe writes no such
 *     row.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

const { cleanupHome, freshDb, testHome } = await import('./helpers.ts');
const { createApp } = await import('../src/http/app.ts');
const { getSetting, setSetting } = await import('../src/db/settings.ts');
const { queryErrorLog } = await import('../src/db/errorLog.ts');
const { tryDecrypt } = await import('../src/security/keystore.ts');
const {
  S3_SETTINGS_KEYS,
  buildCanonicalRequest,
  uploadFileToS3,
} = await import('../src/services/backup/destinations.ts');
const { runAutoBackup } = await import('../src/services/backup/schedule.ts');

const SECRET = 's3-test-secret-abc-123';
const ACCESS_KEY_ID = 'TESTKEYID';
const BUCKET = 'test-bucket';
const PREFIX = 'backups';
const REGION = 'us-east-1';

// ---------------------------------------------------------------------------
// Fake S3: records requests, answers like S3.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  path: string;
  auth: string;
  payloadHash: string;
  amzDate: string;
  body: Buffer;
}

type FakeMode = 'ok' | 'forbidden' | 'put500' | 'noEtag';

let fakeMode: FakeMode = 'ok';
let recorded: RecordedRequest[] = [];
let lastPutLength = 0;
let fakeServer: http.Server;
let fakeBase = '';

function s3ErrorXml(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

async function startFakeS3(): Promise<string> {
  fakeServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      recorded.push({
        method: req.method ?? '',
        path: new URL(req.url ?? '/', 'http://fake').pathname,
        auth: String(req.headers.authorization ?? ''),
        payloadHash: String(req.headers['x-amz-content-sha256'] ?? ''),
        amzDate: String(req.headers['x-amz-date'] ?? ''),
        body,
      });
      if (req.method === 'PUT') {
        lastPutLength = body.length;
        if (fakeMode === 'forbidden') {
          res.writeHead(403, { 'content-type': 'application/xml' });
          res.end(s3ErrorXml('AccessDenied', 'Access Denied'));
          return;
        }
        if (fakeMode === 'put500') {
          res.writeHead(500, { 'content-type': 'application/xml' });
          res.end(s3ErrorXml('InternalError', 'We encountered an internal error.'));
          return;
        }
        // A 200 without an ETag: the client must treat the upload as unverified.
        const headers = fakeMode === 'noEtag' ? {} : { etag: '"5d41402abc4b2a76b9719d911017c592"' };
        res.writeHead(200, headers);
        res.end();
        return;
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': String(lastPutLength), etag: '"probe"' });
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(400);
      res.end();
    });
  });
  await new Promise<void>((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
  const address = fakeServer.address();
  if (address === null || typeof address === 'string') throw new Error('expected AddressInfo from fake S3 listen');
  return `http://127.0.0.1:${address.port}`;
}

// ---------------------------------------------------------------------------
// App server + helpers.
// ---------------------------------------------------------------------------

let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let base = '';

interface WireError {
  error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
}

async function putS3Config(patch: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/backup/destinations/s3`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function configureS3(overrides: Record<string, unknown> = {}): Promise<void> {
  const { status, body } = await putS3Config({
    endpoint: fakeBase,
    region: REGION,
    bucket: BUCKET,
    prefix: PREFIX,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET,
    enabled: true,
    ...overrides,
  });
  assert.equal(status, 200, JSON.stringify(body));
}

function clearS3Config(): void {
  for (const key of Object.values(S3_SETTINGS_KEYS)) setSetting(key, null);
}

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

before(async () => {
  await freshDb();
  fakeBase = await startFakeS3();
  server = createApp().listen(0, '127.0.0.1');
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

beforeEach(() => {
  clearS3Config();
  recorded = [];
  fakeMode = 'ok';
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
  await cleanupHome();
});

describe('SigV4 canonical request', () => {
  it('matches the AWS documentation worked example', () => {
    // From "Task 1: Create a Canonical Request" (Signature Version 4 signing
    // process): GET https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08.
    const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
      method: 'GET',
      canonicalUri: '/',
      canonicalQuery: 'Action=ListUsers&Version=2010-05-08',
      headers: [
        ['host', 'iam.amazonaws.com'],
        ['x-amz-date', '20150830T123600Z'],
      ],
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    assert.equal(
      canonicalRequest,
      'GET\n' +
        '/\n' +
        'Action=ListUsers&Version=2010-05-08\n' +
        'host:iam.amazonaws.com\n' +
        'x-amz-date:20150830T123600Z\n' +
        '\n' +
        'host;x-amz-date\n' +
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    assert.equal(signedHeaders, 'host;x-amz-date');
  });

  it('lowercases, trims, sorts and whitespace-folds headers', () => {
    const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
      method: 'PUT',
      canonicalUri: '/b/k',
      headers: [
        ['X-Amz-Date', '  20150830T123600Z  '],
        ['Host', 'iam.amazonaws.com'],
        ['x-custom', 'a   b'],
      ],
      payloadHash: 'abc',
    });
    assert.equal(
      canonicalRequest,
      'PUT\n/b/k\n\nhost:iam.amazonaws.com\nx-amz-date:20150830T123600Z\nx-custom:a b\n\nhost;x-amz-date;x-custom\nabc',
    );
    assert.equal(signedHeaders, 'host;x-amz-date;x-custom');
  });
});

describe('PUT /api/backup/destinations/s3 validation', () => {
  it('rejects endpoints that are not loopback-http(s) origins', async () => {
    for (const endpoint of [
      'ftp://127.0.0.1:9000',
      'http://example.com',
      'http://127.0.0.1:9000/with/path',
      'https://minio.local:9000/?x=1',
      'https://user:pass@minio.local:9000',
      'not-a-url',
    ]) {
      const { status, body } = await putS3Config({ endpoint });
      assert.equal(status, 400, endpoint);
      assert.equal(((body as unknown as WireError).error.details?.field as string) ?? '', 'endpoint', endpoint);
    }
  });

  it('accepts loopback http and remote https origins', async () => {
    for (const endpoint of [fakeBase, 'https://s3.example.com', 'http://localhost:9000']) {
      const { status } = await putS3Config({ endpoint });
      assert.equal(status, 200, endpoint);
    }
  });

  it('rejects malformed buckets', async () => {
    for (const bucket of ['UPPERCASE', 'ab', '1.2.3.4', 'bad..dots', '-leading', 'x'.repeat(64)]) {
      const { status, body } = await putS3Config({ bucket });
      assert.equal(status, 400, bucket);
      assert.equal(((body as unknown as WireError).error.details?.field as string) ?? '', 'bucket', bucket);
    }
  });

  it('rejects unknown keys rather than silently ignoring them', async () => {
    const { status, body } = await putS3Config({ endpooint: fakeBase } as Record<string, unknown>);
    assert.equal(status, 400);
    assert.match((body as unknown as WireError).error.message, /Unknown S3 setting/);
  });

  it('stores the secret encrypted and never returns it', async () => {
    const put = await putS3Config({
      endpoint: fakeBase,
      region: REGION,
      bucket: BUCKET,
      prefix: PREFIX,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET,
      enabled: true,
    });
    assert.equal(put.status, 200);
    assert.ok(!JSON.stringify(put.body).includes(SECRET), 'PUT response leaks the secret');

    const res = await fetch(`${base}/api/backup/destinations`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      local: { directory: string; mirror: null };
      s3: Record<string, unknown>;
    };
    assert.ok(!JSON.stringify(body).includes(SECRET), 'GET response leaks the secret');
    assert.equal(body.s3['configured'], true);
    assert.equal(body.s3['hasSecret'], true);
    assert.equal(body.s3['accessKeyId'], ACCESS_KEY_ID);
    assert.ok(String(body.local.directory).endsWith('backups'));
    assert.equal(body.local.mirror, null);

    const stored = getSetting(S3_SETTINGS_KEYS.secretAccessKey);
    assert.ok(stored !== null && stored !== SECRET, 'secret stored in plaintext');
    assert.equal(tryDecrypt(stored), SECRET);
  });

  it('clears fields on null or empty string', async () => {
    await configureS3();
    const cleared = await putS3Config({ endpoint: '', secretAccessKey: null });
    assert.equal(cleared.status, 200);
    const res = await fetch(`${base}/api/backup/destinations`);
    const body = (await res.json()) as { s3: { configured: boolean; missing: string[]; hasSecret: boolean } };
    assert.equal(body.s3.configured, false);
    assert.deepEqual(body.s3.missing.sort(), ['endpoint', 'secretAccessKey']);
    assert.equal(body.s3.hasSecret, false);
  });

  it('reads an undecryptable secret as missing-but-present', async () => {
    await configureS3();
    setSetting(S3_SETTINGS_KEYS.secretAccessKey, 'not-a-valid-envelope');
    const res = await fetch(`${base}/api/backup/destinations`);
    const body = (await res.json()) as { s3: { configured: boolean; missing: string[]; hasSecret: boolean } };
    assert.equal(body.s3.configured, false);
    assert.equal(body.s3.hasSecret, true);
    assert.ok(body.s3.missing.includes('secretAccessKey'));
  });
});

describe('explicit upload via POST /api/backup/export', () => {
  it('uploads the archive with a well-formed SigV4 request and reports the key', async () => {
    await configureS3();
    const res = await fetch(`${base}/api/backup/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadToS3: true }),
    });
    assert.equal(res.status, 200);
    const key = res.headers.get('x-hyperion-s3-key');
    assert.ok(key?.startsWith(`${PREFIX}/`), `unexpected key header: ${key}`);
    const download = Buffer.from(await res.arrayBuffer());
    assert.ok(download.length > 0);

    assert.equal(recorded.length, 1);
    const put = recorded[0] as RecordedRequest;
    assert.equal(put.method, 'PUT');
    assert.equal(put.path, `/${BUCKET}/${key}`);
    const auth = /^AWS4-HMAC-SHA256 Credential=TESTKEYID\/(\d{8})\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.exec(
      put.auth,
    );
    assert.ok(auth, `malformed Authorization: ${put.auth}`);
    assert.match(put.amzDate, /^\d{8}T\d{6}Z$/);
    assert.equal(auth?.[1], put.amzDate.slice(0, 8));
    assert.equal(put.payloadHash, sha256Hex(download));
    assert.ok(put.body.equals(download), 'uploaded bytes differ from the download');
  });

  it('fails the request on an S3 refusal, after the local archive exists', async () => {
    await configureS3();
    fakeMode = 'forbidden';
    const res = await fetch(`${base}/api/backup/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadToS3: true }),
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as WireError;
    assert.equal(body.error.code, 'storage_error');
    assert.match(body.error.message, /AccessDenied/);
    const file = body.error.details?.['file'] as string;
    assert.ok(file?.endsWith('.zip'), `error does not name the local file: ${JSON.stringify(body)}`);

    const list = (await (await fetch(`${base}/api/backup`)).json()) as { backups: { filename: string }[] };
    assert.ok(list.backups.some((b) => b.filename === file), 'local archive missing after failed upload');
  });

  it('treats a 200 without an ETag as a failed upload', async () => {
    await configureS3();
    fakeMode = 'noEtag';
    const res = await fetch(`${base}/api/backup/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadToS3: true }),
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as WireError;
    assert.equal(body.error.details?.['reason'], 's3_missing_etag');
  });

  it('answers 409 when S3 is not configured, and still writes the archive', async () => {
    // Manual exports share one filename per minute, so clear the directory:
    // the assertion is that *this* request wrote an archive, not a count delta.
    const dests = (await (await fetch(`${base}/api/backup/destinations`)).json()) as {
      local: { directory: string };
    };
    for (const entry of fs.readdirSync(dests.local.directory)) {
      fs.rmSync(path.join(dests.local.directory, entry), { force: true });
    }
    const before = (await (await fetch(`${base}/api/backup`)).json()) as { backups: { filename: string }[] };
    assert.equal(before.backups.length, 0);
    const res = await fetch(`${base}/api/backup/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadToS3: true }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as WireError;
    assert.equal(body.error.details?.['reason'], 's3_not_configured');
    const afterList = (await (await fetch(`${base}/api/backup`)).json()) as { backups: { filename: string }[] };
    assert.equal(afterList.backups.length, before.backups.length + 1);
  });

  it('lets an explicit upload override a disabled toggle', async () => {
    await configureS3({ enabled: false });
    const res = await fetch(`${base}/api/backup/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadToS3: true }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('x-hyperion-s3-key')?.startsWith(`${PREFIX}/`));
    assert.equal(recorded.length, 1);
  });
});

describe('POST /api/backup/destinations/s3/test', () => {
  it('round-trips a probe object and cleans it up', async () => {
    await configureS3();
    const res = await fetch(`${base}/api/backup/destinations/s3/test`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      key: string;
      steps: { step: string; ok: boolean }[];
    };
    assert.equal(body.ok, true);
    assert.deepEqual(
      body.steps.map((s) => s.step),
      ['put', 'head', 'delete'],
    );
    assert.ok(body.steps.every((s) => s.ok));
    assert.ok(body.key.startsWith(`${PREFIX}/.hyperion-probe-`));
    assert.deepEqual(
      recorded.map((r) => r.method),
      ['PUT', 'HEAD', 'DELETE'],
    );
    assert.ok(recorded.every((r) => r.path === `/${BUCKET}/${body.key}`));
  });

  it('reports S3 failures as a diagnosis, not an error_log row', async () => {
    await configureS3();
    fakeMode = 'put500';
    const since = Date.now();
    const res = await fetch(`${base}/api/backup/destinations/s3/test`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; steps: { step: string; ok: boolean; error?: string }[] };
    assert.equal(body.ok, false);
    assert.equal(body.steps.length, 1);
    assert.match(body.steps[0]?.error ?? '', /InternalError/);
    const rows = queryErrorLog({ since });
    assert.ok(
      rows.every((row) => row.endpoint !== '/api/backup/destinations/s3'),
      'failed probe polluted error_log',
    );
  });

  it('reports misconfiguration without touching the network', async () => {
    const res = await fetch(`${base}/api/backup/destinations/s3/test`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; error: string; missing: string[]; steps: unknown[] };
    assert.equal(body.ok, false);
    assert.deepEqual(body.steps, []);
    assert.ok(body.missing.length > 0);
    assert.equal(recorded.length, 0);
  });
});

describe('automatic run S3 leg', () => {
  it('uploads when enabled and configured', async () => {
    await configureS3();
    const result = await runAutoBackup();
    assert.ok(result.s3Key?.startsWith(`${PREFIX}/hyperion-auto-`), `unexpected s3Key: ${result.s3Key}`);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.path, `/${BUCKET}/${result.s3Key}`);
  });

  it('degrades an unreachable endpoint to s3Key null plus an error_log row', async () => {
    await configureS3({ endpoint: 'http://127.0.0.1:9', enabled: true });
    const since = Date.now();
    const result = await runAutoBackup();
    assert.ok(result.filename.endsWith('.zip'));
    assert.equal(result.s3Key, null);
    const rows = queryErrorLog({ since });
    const row = rows.find((entry) => entry.endpoint === '/api/backup/destinations/s3');
    assert.ok(row, 'no error_log row for the failed S3 leg');
    assert.equal(row?.error_code, 'storage_error');
    assert.match(row?.error_message ?? '', new RegExp(result.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('skips silently when disabled', async () => {
    await configureS3({ enabled: false });
    const since = Date.now();
    const result = await runAutoBackup();
    assert.equal(result.s3Key, null);
    assert.equal(recorded.length, 0);
    const rows = queryErrorLog({ since });
    assert.ok(rows.every((row) => row.endpoint !== '/api/backup/destinations/s3'));
  });
});

describe('single-PUT ceiling', () => {
  it('refuses a file past 4 GiB without reading it', async () => {
    // A sparse file: 5 GiB on paper, ~0 bytes on disk.
    const sparse = path.join(testHome, 'sparse-five-gib.bin');
    const fd = fs.openSync(sparse, 'w');
    try {
      fs.ftruncateSync(fd, 5 * 1024 * 1024 * 1024);
    } finally {
      fs.closeSync(fd);
    }
    try {
      // A dead endpoint: if the guard failed, this would burn 5 GiB of RAM
      // and then fail with a network error instead of the size refusal.
      await configureS3({ endpoint: 'http://127.0.0.1:9' });
      await assert.rejects(uploadFileToS3(sparse, 'big.zip'), (error: unknown) => {
        assert.ok(error instanceof Error);
        const app = error as Error & { code?: string; details?: Record<string, unknown> };
        assert.equal(app.code, 'storage_error');
        assert.equal(app.details?.['reason'], 's3_object_too_large');
        return true;
      });
    } finally {
      fs.rmSync(sparse, { force: true });
    }
  });
});
