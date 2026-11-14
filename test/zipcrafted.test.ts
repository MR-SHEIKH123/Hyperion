/**
 * Crafted archives through `POST /api/backup/inspect` — the adm-zip fix,
 * proven from the outside.
 *
 * The class (CVE-2026-39244, fixed in adm-zip 0.6.0, hardened further in
 * 0.6.1): an archive whose *header declares* a huge uncompressed size used to
 * drive an unbounded `Buffer.alloc` — a few hundred bytes on the wire could
 * push a gigabyte of allocation into the process. 0.6.x bounds every read by
 * the data actually present, and 0.6.1 additionally rejects entries whose
 * declared extent runs past the end of the file at parse time.
 *
 * Two shapes, both pushed through the real route over HTTP:
 *
 *   1. **Huge declaration, honest extent** — the fix does *not* refuse this
 *      archive; it lists it and reads `manifest.json` from the bytes that
 *      exist (29 of them), with no allocation anywhere near the 1 GiB the
 *      header claims. The response carries the parsed manifest, which is only
 *      possible if the read was bounded — a 1 GiB zero-padded buffer would
 *      not parse as JSON. The RSS delta asserts the same thing from the
 *      other side.
 *
 *   2. **Huge declaration *and* an extent past the file** — refused at parse
 *      with a clean 400 ("Not a readable zip archive: …"), again with a flat
 *      RSS. This is the refusal half: no extraction, no allocation, a status
 *      code the route already knew how to produce.
 *
 * Mutation check (run before merge): installing adm-zip 0.5.18 over
 * node_modules makes test 1 fail — the old code allocates what the header
 * says, so the manifest comes back unparsable and the RSS delta explodes.
 * There is no product-level guard to remove: the library fix is the fix, and
 * these tests are what pins it.
 *
 * The other inbound archives (skills intake, resource archives) are parsed by
 * the same library version and read through the same `getData()` API — the
 * fix covers them at the same layer; this file proves it where the brief
 * asked, on the upload route anyone can reach.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { after, before, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

const { createApp } = await import('../src/http/app.ts');

let server: http.Server;
let base: string;

before(async () => {
  await freshDb();
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

/** 1 GiB — the declaration, not the data. */
const DECLARED = 0x40000000;

/**
 * A minimal one-entry, stored-method zip with independent control of what the
 * header *claims* versus what the file *contains*.
 *
 * `declared`  — the uncompressed size the central/local headers announce.
 * `csizePad`  — added to the compressed size so the declared data extent
 *               reaches past the end of the buffer (0.6.1 rejects this at
 *               parse time; older versions do not notice).
 */
function craftArchive(options: {
  declared?: number;
  csizePad?: number;
  name?: string;
  data?: Buffer;
}): Buffer {
  const name = options.name ?? 'manifest.json';
  const data = options.data ?? Buffer.from('{"app":"hyperion","format":1}');
  const declared = options.declared ?? data.length;
  const csize = data.length + (options.csizePad ?? 0);
  const crc = zlib.crc32(data) >>> 0;
  const nameBytes = Buffer.from(name, 'utf8');

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0); // local file header
  lfh.writeUInt16LE(20, 4); // version needed
  lfh.writeUInt16LE(0, 6); // flags
  lfh.writeUInt16LE(0, 8); // method: stored
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(csize, 18);
  lfh.writeUInt32LE(declared, 22);
  lfh.writeUInt16LE(nameBytes.length, 26);
  const local = Buffer.concat([lfh, nameBytes, data]);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); // central directory header
  cd.writeUInt16LE(20, 4); // version made by
  cd.writeUInt16LE(20, 6); // version needed
  cd.writeUInt16LE(0, 8); // flags
  cd.writeUInt16LE(0, 10); // method: stored
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(csize, 20);
  cd.writeUInt32LE(declared, 24);
  cd.writeUInt16LE(nameBytes.length, 28);
  cd.writeUInt32LE(0, 42); // local header offset
  const central = Buffer.concat([cd, nameBytes]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);

  return Buffer.concat([local, central, eocd]);
}

interface InspectBody {
  error?: { code?: string; message?: string };
  inspection?: { manifest?: { app?: string; format?: number } | null };
}

async function postInspect(
  bytes: Buffer,
): Promise<{ status: number; body: InspectBody }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)]), 'crafted.zip');
  const res = await fetch(`${base}/api/backup/inspect`, { method: 'POST', body: form });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as InspectBody) : {} };
}

/** Current RSS in bytes (VmHWM would be monotonic and could not delta). */
function rss(): number {
  return process.memoryUsage().rss;
}

/**
 * The allocation class: the header says 1 GiB, the file carries 29 bytes of
 * manifest. The route must answer 200 with the *parsed* manifest — proof the
 * read was bounded by the bytes present — and the process must not grow
 * anywhere near the declared size.
 */
test('a manifest declaring 1 GiB is read from the bytes present, without allocating', async () => {
  const bytes = craftArchive({ declared: DECLARED });
  assert.ok(bytes.length < 1024, 'the whole point: a sub-kilobyte file');

  const before = rss();
  const res = await postInspect(bytes);
  const delta = rss() - before;

  assert.equal(res.status, 200, `expected a clean inspection, got ${res.status}`);
  assert.equal(res.body.inspection?.manifest?.app, 'hyperion');
  assert.equal(res.body.inspection?.manifest?.format, 1);
  assert.ok(
    delta < 512 * 1024 * 1024,
    `inspection grew RSS by ${Math.round(delta / 1024 / 1024)} MB for a 1 GiB declaration — ` +
      'the declared size must not drive allocation',
  );
});

/**
 * The refusal half: the same 1 GiB declaration, plus a compressed extent
 * that reaches past the end of the file. adm-zip 0.6.1 rejects that at parse
 * time, the route turns it into its existing 400, and nothing is read.
 */
test('a huge declaration whose extent runs past the file is refused cleanly', async () => {
  const bytes = craftArchive({ declared: DECLARED, csizePad: 0x10000 });
  assert.ok(bytes.length < 1024, 'still a sub-kilobyte file');

  const before = rss();
  const res = await postInspect(bytes);
  const delta = rss() - before;

  assert.equal(res.status, 400, `expected a clean refusal, got ${res.status}`);
  assert.match(res.body.error?.message ?? '', /Not a readable zip archive/);
  assert.ok(
    delta < 512 * 1024 * 1024,
    `the refusal grew RSS by ${Math.round(delta / 1024 / 1024)} MB — refusing must happen before any allocation`,
  );
});
