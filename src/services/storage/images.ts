/**
 * Image downscaling for attachments.
 *
 * Every image that arrives as an upload is capped at a longest edge of
 * ~1568px before it is written to disk. That number is not arbitrary: it is
 * roughly where vision models stop gaining anything from extra resolution, so
 * bytes above it cost disk and upload time and buy nothing.
 *
 * Three rules keep this from turning into an image pipeline:
 *
 *   1. **One pass.** Resize and re-encode, once. No thumbnails, no variants, no
 *      format negotiation, no EXIF rewriting beyond what the re-encode does.
 *   2. **Never upscale, never touch what is already small.** An image already
 *      within the cap is stored byte-for-byte as it arrived. Re-encoding it
 *      would lose quality to save nothing.
 *   3. **Never fail an upload.** If sharp is missing, or the bytes are not a
 *      format it can read, or the encode errors, the original buffer is stored
 *      unchanged. A slightly larger file is a far better outcome than a lost
 *      attachment.
 *
 * sharp is an **optional** dependency, loaded lazily through `createRequire` —
 * the same pattern `db/adapter.ts` uses for better-sqlite3. It is a native
 * module: on a machine where its prebuilt binary does not install, the app must
 * still run, and everything here degrades to a pass-through.
 */
import { createRequire } from 'node:module';

import { env } from '../../config/env.ts';
import { createLogger } from '../../util/logger.ts';

const log = createLogger('storage:images');
const require = createRequire(import.meta.url);

/** Minimal surface of the sharp API this module uses. */
interface SharpImage {
  metadata(): Promise<{ width?: number; height?: number; format?: string; pages?: number }>;
  resize(options: { width: number; height: number; fit: 'inside'; withoutEnlargement: true }): SharpImage;
  rotate(): SharpImage;
  jpeg(options: { quality: number; mozjpeg: boolean }): SharpImage;
  png(options: { compressionLevel: number }): SharpImage;
  webp(options: { quality: number }): SharpImage;
  toBuffer(): Promise<Buffer>;
}
type SharpFactory = (input: Buffer, options?: { animated?: boolean }) => SharpImage;

let cached: SharpFactory | null | undefined;

/**
 * Resolves sharp once and remembers the answer, including the failure.
 *
 * `undefined` means "not tried yet", `null` means "tried, unavailable" — so a
 * missing module costs one failed require for the life of the process rather
 * than one per upload.
 */
function loadSharp(): SharpFactory | null {
  if (cached !== undefined) return cached;
  try {
    const mod = require('sharp') as SharpFactory | { default: SharpFactory };
    cached = typeof mod === 'function' ? mod : mod.default;
    return cached;
  } catch (error) {
    cached = null;
    log.warn('sharp is not available; images will be stored at their original size', error);
    return null;
  }
}

/** True when sharp resolved. Exposed for tests and diagnostics. */
export function imageProcessingAvailable(): boolean {
  return loadSharp() !== null;
}

/**
 * Formats worth touching.
 *
 * Deliberately narrow. SVG is excluded because it is markup, not pixels —
 * rasterizing it would silently destroy the thing that makes it useful. GIF is
 * excluded because the interesting ones are animated and a single-pass resize
 * would flatten them to one frame.
 */
const RESIZABLE = new Set(['jpeg', 'jpg', 'png', 'webp', 'tiff', 'avif', 'heif']);

export interface ProcessedImage {
  buffer: Buffer;
  /** False when the original was returned untouched, for any reason. */
  processed: boolean;
  /** Why it was skipped, when it was. Logged, not surfaced to the user. */
  reason?: string;
  width?: number;
  height?: number;
  format?: string;
}

/**
 * Downscales an image buffer if it is worth downscaling.
 *
 * Always resolves; never throws. The returned buffer is safe to write whatever
 * happened.
 */
export async function processImage(
  buffer: Buffer,
  mimeType?: string | null,
): Promise<ProcessedImage> {
  const maxEdge = env.imageMaxEdge;

  // A cap of 0 or less disables the whole feature, which is the escape hatch for
  // anyone who wants originals preserved exactly.
  if (maxEdge <= 0) return { buffer, processed: false, reason: 'disabled' };

  // Cheap rejection first: if the caller already knows this is not an image,
  // don't pay for a sharp load or a metadata probe.
  if (mimeType && !mimeType.startsWith('image/')) {
    return { buffer, processed: false, reason: 'not-an-image' };
  }

  const sharp = loadSharp();
  if (!sharp) return { buffer, processed: false, reason: 'sharp-unavailable' };

  try {
    const image = sharp(buffer);
    const meta = await image.metadata();
    const format = meta.format;

    if (!format || !RESIZABLE.has(format)) {
      return { buffer, processed: false, reason: `unsupported-format:${format ?? 'unknown'}` };
    }

    // An animated WebP reports more than one page. Same reasoning as GIF: a
    // single-pass resize would throw away every frame but the first.
    if ((meta.pages ?? 1) > 1) {
      return { buffer, processed: false, reason: 'animated' };
    }

    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width === 0 || height === 0) {
      return { buffer, processed: false, reason: 'unknown-dimensions' };
    }

    // Rule 2: already small enough, so store the original bytes. Re-encoding
    // here would be a pure quality loss.
    if (Math.max(width, height) <= maxEdge) {
      return { buffer, processed: false, reason: 'already-small', width, height, format };
    }

    // `rotate()` with no argument applies the EXIF orientation and drops the
    // tag, so the stored pixels are the right way up — otherwise a resized
    // phone photo can come out sideways in viewers that ignore EXIF.
    const pipeline = image
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });

    // Re-encode in the format it arrived in. Converting everything to one
    // format would be the "whole image pipeline" this is meant not to be, and
    // would surprise anyone who uploaded a PNG for its transparency.
    const encoded =
      format === 'png'
        ? pipeline.png({ compressionLevel: 9 })
        : format === 'webp'
          ? pipeline.webp({ quality: 82 })
          : pipeline.jpeg({ quality: 82, mozjpeg: true });

    const out = await encoded.toBuffer();

    // A resize that somehow grew the file is a loss. Keep the original.
    if (out.byteLength >= buffer.byteLength) {
      return { buffer, processed: false, reason: 'no-saving', width, height, format };
    }

    return { buffer: out, processed: true, width, height, format };
  } catch (error) {
    // Rule 3. A corrupt or exotic file must not cost the user their upload.
    log.warn('image processing failed; storing the original', error);
    return { buffer, processed: false, reason: 'error' };
  }
}
