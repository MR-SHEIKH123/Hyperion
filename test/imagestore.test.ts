/**
 * The gallery's image path, end to end: `saveAsset` → `processImage` → disk.
 *
 * `images.test.ts` covers `processImage` on its own, and the brand/design
 * suites drive `saveAsset` with SVG or plain text — but nothing pinned what
 * actually lands on disk when a **real raster** goes through the store. That
 * chain is the only production path sharp sits on (`saveAsset` is its sole
 * caller; knowledge uploads deliberately bypass it), and its contract has
 * three parts the row and the file must both honour:
 *
 *   1. An oversized image is stored *downscaled*, and `bytes`/`sha256`
 *      describe what was stored — not what arrived.
 *   2. An image already within the cap is stored byte-for-byte: the store
 *      must not quietly re-encode what did not need touching.
 *   3. A crafted or corrupt image never costs the upload: the original bytes
 *      are written and the row still matches them, whether or not sharp can
 *      be loaded at all.
 *
 * The sharp-dependent cases skip when the optional dependency is absent —
 * the same rule `images.test.ts` follows; a machine without the native
 * binary must still run this file green.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

const { assetPath, saveAsset } = await import('../src/services/storage/gallery.ts');
const { imageProcessingAvailable } = await import('../src/services/storage/images.ts');
const { env } = await import('../src/config/env.ts');

const available = imageProcessingAvailable();
const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const sharp: any = available ? require('sharp') : null;

before(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

/** Smooth photo-like gradient — same construction as images.test.ts. */
function gradient(width: number, height: number): Buffer {
  const data = Buffer.allocUnsafe(width * height * 3);
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[i++] = Math.round((255 * x) / width);
      data[i++] = Math.round((255 * y) / height);
      data[i++] = Math.round((255 * (x / width + y / height)) / 2);
    }
  }
  return data;
}

async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp(gradient(width, height), { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

test(
  'an oversized raster is stored downscaled, and the row describes what was stored',
  { skip: !available },
  async () => {
    const input = await makeJpeg(2400, 1600);
    const asset = await saveAsset({
      filename: 'photo.jpg',
      buffer: input,
      mimeType: 'image/jpeg',
      origin: 'generated',
      tool: 'test',
    });

    const stored = fs.readFileSync(assetPath(asset));
    assert.ok(stored.byteLength < input.byteLength, 'stored bytes must be the smaller ones');

    const meta = await sharp(stored).metadata();
    assert.equal(
      Math.max(meta.width, meta.height),
      env.imageMaxEdge,
      'the stored file must carry the cap, not the original edge',
    );

    assert.equal(asset.bytes, stored.byteLength, 'bytes describes what was stored');
    assert.equal(
      asset.sha256,
      createHash('sha256').update(stored).digest('hex'),
      'sha256 describes what was stored',
    );
  },
);

test(
  'an image already within the cap is stored byte-for-byte',
  { skip: !available },
  async () => {
    const input = await makeJpeg(800, 600);
    const asset = await saveAsset({
      filename: 'small.jpg',
      buffer: input,
      mimeType: 'image/jpeg',
      origin: 'generated',
      tool: 'test',
    });

    const stored = fs.readFileSync(assetPath(asset));
    assert.deepEqual(stored, input, 'the store must not re-encode an image that fit');
    assert.equal(asset.bytes, input.byteLength);
    assert.equal(
      asset.sha256,
      createHash('sha256').update(input).digest('hex'),
    );
  },
);

test('a crafted image never costs the upload: the original bytes are stored', async () => {
  // PNG magic followed by garbage — a header that promises pixels the bytes
  // do not contain. The store must write the original, loaded sharp or not,
  // and the row must still match the file.
  const crafted = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not really a png')]);
  const asset = await saveAsset({
    filename: 'crafted.png',
    buffer: crafted,
    mimeType: 'image/png',
    origin: 'uploaded',
    tool: 'test',
  });

  const stored = fs.readFileSync(assetPath(asset));
  assert.deepEqual(stored, crafted, 'a file sharp cannot read must be stored as it arrived');
  assert.equal(asset.bytes, crafted.byteLength);
  assert.equal(asset.sha256, createHash('sha256').update(crafted).digest('hex'));
});
