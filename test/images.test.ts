/**
 * Image downscaling on the way to disk.
 *
 * sharp is an *optional* dependency, so every test that needs it is guarded by
 * `{ skip: !available }` rather than assumed. A machine where the native binary
 * did not install must still run a green suite — that is the whole point of
 * making it optional, and a test file that fails there would quietly undo it.
 *
 * The pass-through cases below are asserted unconditionally, because those are
 * exactly the paths that run when sharp is missing.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { cleanupHome } from './helpers.ts';

const { imageProcessingAvailable, processImage } = await import(
  '../src/services/storage/images.ts'
);
const { env } = await import('../src/config/env.ts');

const available = imageProcessingAvailable();
const require = createRequire(import.meta.url);

/* eslint-disable @typescript-eslint/no-explicit-any */
const sharp: any = available ? require('sharp') : null;

after(async () => {
  await cleanupHome();
});

/**
 * Raw RGB holding a smooth gradient — deliberately photo-like.
 *
 * A repeating pattern (`x % 256`) would be the obvious fixture and is the wrong
 * one: PNG's row filters encode a perfectly periodic image almost for free, and
 * the interpolation a downscale performs destroys that periodicity, so the
 * smaller image compresses *worse* and `processImage` correctly refuses it as
 * `no-saving`. Real photographs have locally smooth values, which is what makes
 * downscaling a saving at all, so the fixture has to be smooth too.
 */
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

async function makeImage(
  width: number,
  height: number,
  format: 'jpeg' | 'png' | 'webp',
): Promise<Buffer> {
  const img = sharp(gradient(width, height), { raw: { width, height, channels: 3 } });
  if (format === 'png') return img.png().toBuffer();
  if (format === 'webp') return img.webp().toBuffer();
  return img.jpeg({ quality: 95 }).toBuffer();
}

// --- pass-through paths (no sharp required) --------------------------------

test('a non-image mime type is returned untouched, without loading sharp', async () => {
  const buffer = Buffer.from('id,name\n1,ada\n');
  const result = await processImage(buffer, 'text/csv');

  assert.equal(result.processed, false);
  assert.equal(result.reason, 'not-an-image');
  // Same buffer, not a copy: nothing was read, decoded or re-encoded.
  assert.equal(result.buffer, buffer);
});

test('bytes that are not a decodable image never cost the caller their upload', async () => {
  const buffer = Buffer.from('this claims to be a PNG but is not');
  const result = await processImage(buffer, 'image/png');

  assert.equal(result.processed, false);
  assert.deepEqual(result.buffer, buffer);
});

test('a missing mime type is still inspected rather than skipped', async () => {
  // No mime means "unknown", not "not an image" — the cheap rejection must not
  // fire, or an attachment with no declared type would never be processed.
  const result = await processImage(Buffer.from('nope'), null);
  assert.notEqual(result.reason, 'not-an-image');
});

// --- real processing (sharp required) --------------------------------------

test('an oversized image is capped at the configured longest edge', { skip: !available }, async () => {
  const input = await makeImage(2400, 1600, 'jpeg');
  const result = await processImage(input, 'image/jpeg');

  assert.equal(result.processed, true);
  assert.equal(result.width, 2400, 'reports the source dimensions');
  assert.equal(result.height, 1600);
  assert.equal(result.format, 'jpeg');

  const out = await sharp(result.buffer).metadata();
  assert.equal(Math.max(out.width, out.height), env.imageMaxEdge);
  // 2400x1600 is 3:2, so the short edge lands proportionally, not letterboxed.
  assert.equal(out.height, Math.round((env.imageMaxEdge * 1600) / 2400));
  assert.ok(
    result.buffer.byteLength < input.byteLength,
    'a downscale that grew the file would have been rejected',
  );
});

test('an image already within the cap is stored byte-for-byte', { skip: !available }, async () => {
  const input = await makeImage(800, 600, 'jpeg');
  const result = await processImage(input, 'image/jpeg');

  assert.equal(result.processed, false);
  assert.equal(result.reason, 'already-small');
  // Identity, not equality: re-encoding a small image would lose quality to
  // save nothing, so the original bytes must be handed straight through.
  assert.equal(result.buffer, input);
});

test('the cap is on the longest edge, so a tall image counts too', { skip: !available }, async () => {
  const input = await makeImage(900, 2200, 'jpeg');
  const result = await processImage(input, 'image/jpeg');

  assert.equal(result.processed, true);
  const out = await sharp(result.buffer).metadata();
  assert.equal(out.height, env.imageMaxEdge);
  assert.ok(out.width < env.imageMaxEdge);
});

test('a PNG comes back a PNG', { skip: !available }, async () => {
  const input = await makeImage(2400, 1600, 'png');
  const result = await processImage(input, 'image/png');

  assert.equal(result.processed, true);
  // Converting to JPEG would silently destroy transparency for anyone who
  // uploaded a PNG precisely to keep it.
  const out = await sharp(result.buffer).metadata();
  assert.equal(out.format, 'png');
});

test('a WebP comes back a WebP', { skip: !available }, async () => {
  const input = await makeImage(2400, 1600, 'webp');
  const result = await processImage(input, 'image/webp');

  assert.equal(result.processed, true);
  const out = await sharp(result.buffer).metadata();
  assert.equal(out.format, 'webp');
});

test('an SVG is left alone rather than rasterized', { skip: !available }, async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="4000">' +
      '<rect width="4000" height="4000" fill="#0af"/></svg>',
  );
  const result = await processImage(svg, 'image/svg+xml');

  assert.equal(result.processed, false);
  assert.match(result.reason ?? '', /^unsupported-format:/);
  assert.equal(result.buffer, svg);
});

test('processing an already-processed image is a no-op', { skip: !available }, async () => {
  const first = await processImage(await makeImage(2400, 1600, 'jpeg'), 'image/jpeg');
  assert.equal(first.processed, true);

  // Whatever writes to disk may be re-run (an import, a re-save). The second
  // pass must not re-encode and shed quality every time.
  const second = await processImage(first.buffer, 'image/jpeg');
  assert.equal(second.processed, false);
  assert.equal(second.reason, 'already-small');
  assert.equal(second.buffer, first.buffer);
});
