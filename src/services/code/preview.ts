/** Sandboxed browser-preview session registry. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { AppError } from '../../util/errors.ts';

export const DEFAULT_TTL_MS = 30 * 60 * 1_000;

export interface MintedPreview {
  taskId: string;
  token: string;
  url: string;
  expiresAt: number;
}

interface PreviewSession extends MintedPreview {}

/** One current preview per task. Tokens are deliberately not map keys. */
const previews = new Map<string, PreviewSession>();

/** Set only while the isolated listener is actually available. */
let previewOrigin: string | null = null;

/** Called by the listener when it starts, stops, or degrades after EADDRINUSE. */
export function setPreviewOrigin(origin: string | null): void {
  previewOrigin = origin?.replace(/\/+$/, '') ?? null;
}

export function mintPreview(
  taskId: string,
  options: { now?: number; ttlMs?: number; origin?: string } = {},
): MintedPreview {
  const origin = options.origin?.replace(/\/+$/, '') ?? previewOrigin;
  if (origin === null) {
    throw new AppError('capability_disabled', 'Browser preview is disabled.', {
      details: { setting: 'HYPERION_PREVIEW_PORT' },
    });
  }

  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const token = randomBytes(32).toString('base64url');
  const session: PreviewSession = {
    taskId,
    token,
    url: `${origin}/p/${token}/`,
    expiresAt: now + ttlMs,
  };
  // Replacing the row revokes the prior token immediately.
  previews.set(taskId, session);
  return { ...session };
}

/**
 * Resolve a token without making the token itself a hash-map lookup.
 *
 * The two-argument form also binds it to an expected task and is useful at
 * service boundaries that already know the task identity. The listener uses
 * the one-argument form because the opaque URL contains only the token.
 */
export function resolvePreview(token: string, now?: number): MintedPreview | undefined;
export function resolvePreview(taskId: string, token: string, now?: number): MintedPreview | undefined;
export function resolvePreview(
  first: string,
  second?: string | number,
  third?: number,
): MintedPreview | undefined {
  const expectedTask = typeof second === 'string' ? first : undefined;
  const candidate = typeof second === 'string' ? second : first;
  const now = typeof second === 'number' ? second : (third ?? Date.now());

  let found: PreviewSession | undefined;
  for (const [taskId, session] of previews) {
    if (session.expiresAt <= now) {
      previews.delete(taskId);
      continue;
    }

    // Keep comparing every live session. Returning on the first match would
    // leak its position in the map even though the byte comparison is constant.
    const matches = equalToken(candidate, session.token);
    if (matches && (expectedTask === undefined || expectedTask === taskId)) found = session;
  }
  return found === undefined ? undefined : { ...found };
}

export function revokePreview(taskId: string): boolean {
  return previews.delete(taskId);
}

/** Test hook: a fresh process has no minted sessions. */
export function resetPreviews(): void {
  previews.clear();
}

function equalToken(candidate: string, expected: string): boolean {
  // Hashing first makes both buffers fixed-length even for a malformed token;
  // `timingSafeEqual` otherwise throws or exposes the length before comparing.
  const left = createHash('sha256').update(candidate, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}
