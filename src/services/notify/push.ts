/**
 * Browser push notifications.
 *
 * The whole point of running under PM2 is that the backend outlives any
 * browser tab: a scheduled task fires at 07:00 whether or not anything is
 * open. Push is how the result reaches the user, and the standard browser Push
 * API is enough — no native app, and no custom encryption layer, because the
 * Web Push protocol already encrypts payloads end-to-end with keys the browser
 * generated. (`happy`'s bespoke crypto was reviewed for this and deliberately
 * not adopted; re-implementing it here would be strictly worse.)
 *
 * ## Deliberate choices
 *
 * **Off by default.** `pushEnabled()` gates every send. Nothing is pushed until
 * the user turns it on, and even then only two kinds of event qualify — see
 * `PushReason`. Ordinary foreground activity never pushes; the user is already
 * watching it happen.
 *
 * **web-push is optional and lazily loaded**, the same way sharp is in
 * `storage/images.ts`. A machine without it must still run the app; push simply
 * reports itself unavailable. A notification failing is never allowed to fail
 * the work it was reporting on, so `sendPush` resolves with an outcome instead
 * of throwing.
 *
 * **The VAPID private key is credential material.** It is encrypted at rest
 * with the same keystore that protects provider API keys, and it never leaves
 * the server — `publicKey()` is the only half the frontend ever sees. Nothing
 * here logs a subscription endpoint in full either: an endpoint URL is a
 * capability to notify that device, so it is truncated in logs.
 *
 * **A subscription that the push service rejects with 404/410 is deleted.**
 * That pair specifically means the browser threw the subscription away (cleared
 * site data, uninstalled the PWA). Keeping it would mean retrying a dead
 * endpoint forever. Any other failure is transient and the subscription stays.
 */

import { createRequire } from 'node:module';

import { getSetting, pushEnabled, setSetting } from '../../db/settings.ts';
// `tryDecrypt` rather than `decrypt`: an unreadable private key must degrade to
// "push unavailable", not throw from inside a notification send.
import { encrypt, tryDecrypt } from '../../security/keystore.ts';
import { AppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';

const log = createLogger('push');
const require = createRequire(import.meta.url);

const SUBSCRIPTIONS_KEY = 'push_subscriptions';
const VAPID_PUBLIC_KEY = 'push_vapid_public';
const VAPID_PRIVATE_KEY = 'push_vapid_private';
const VAPID_SUBJECT = 'mailto:hyperion@localhost';

/**
 * Only these two events justify interrupting the user, per the spec: a
 * scheduled task finished while they were away, or something is blocked
 * waiting for them to confirm it.
 */
export type PushReason = 'scheduled-task' | 'attention-needed';

/** The payload shape Sol's service worker receives. Keep this stable. */
export interface PushPayload {
  reason: PushReason;
  title: string;
  body: string;
  /** Where clicking the notification should take the user, if anywhere. */
  url?: string;
  /** Collapses repeat notifications about the same thing in the OS tray. */
  tag?: string;
  sentAt: number;
}

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * How much room a notification has.
 *
 * Web Push caps a message at 4,096 octets — the size a push service is required
 * to accept — and `web-push` wraps the JSON in an encryption envelope on top
 * (about 103 bytes for `aes128gcm`). This budget sits below both, and the
 * per-field ceilings below leave the worst case at roughly half of it.
 */
export const PUSH_MESSAGE_BUDGET_BYTES = 3_000;

/** Per-field ceilings, in UTF-8 bytes. */
const FIELD_LIMITS = { title: 240, body: 600, url: 512, tag: 128 } as const;

/**
 * Clamp text to `maxBytes` without splitting a code point.
 *
 * Byte-wise slicing is what turns an emoji into a replacement character, and a
 * notification is exactly where a status glyph lives. The ellipsis says the text
 * was cut; the whole text is in the app, which is where the notification points.
 */
function clampField(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;

  const ellipsis = '…';
  const room = maxBytes - Buffer.byteLength(ellipsis);
  let kept = '';
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (used + size > room) break;
    kept += character;
    used += size;
  }
  return `${kept}${ellipsis}`;
}

/**
 * The message `sendPush` serializes: the payload with every text field clamped.
 *
 * Built here rather than at the call sites because a caller cannot be expected to
 * know the transport's limit, and the failure was invisible in the worst way — a
 * run whose summary ran long built a message the push service refused, the
 * rejection was not 404/410 so the subscription was deliberately kept, and the
 * user got no notification for exactly the runs with the most to say.
 */
export function buildPushBody(payload: Omit<PushPayload, 'sentAt'>, sentAt = Date.now()): string {
  const message: PushPayload = {
    ...payload,
    title: clampField(payload.title, FIELD_LIMITS.title),
    body: clampField(payload.body, FIELD_LIMITS.body),
    ...(payload.url === undefined ? {} : { url: clampField(payload.url, FIELD_LIMITS.url) }),
    ...(payload.tag === undefined ? {} : { tag: clampField(payload.tag, FIELD_LIMITS.tag) }),
    sentAt,
  };
  return JSON.stringify(message);
}

// --- web-push loading ------------------------------------------------------

interface WebPushError {
  statusCode?: number;
}

interface WebPushModule {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(subscription: PushSubscription, payload: string): Promise<unknown>;
  generateVAPIDKeys(): { publicKey: string; privateKey: string };
}

let cached: WebPushModule | null | undefined;

/**
 * Resolve web-push once and remember the answer, including the failure —
 * `undefined` is "not tried", `null` is "tried, unavailable". A missing module
 * then costs one failed require for the life of the process, not one per send.
 */
function loadWebPush(): WebPushModule | null {
  if (cached !== undefined) return cached;
  try {
    const mod = require('web-push') as WebPushModule | { default: WebPushModule };
    cached = 'sendNotification' in mod ? mod : mod.default;
  } catch (error) {
    log.warn('web-push unavailable; push notifications are disabled', { error: String(error) });
    cached = null;
  }
  return cached;
}

/** Tests only — forget the cached module so availability can be re-evaluated. */
export function resetPushCache(): void {
  cached = undefined;
}

// --- VAPID keys ------------------------------------------------------------

/**
 * The public half, generating a keypair on first use.
 *
 * Keys are generated lazily rather than at boot because most installs will
 * never enable push, and a keypair nobody uses is a secret nobody needed.
 * Returns null when web-push is unavailable — the frontend reads that as "do
 * not offer to subscribe" rather than as an error.
 */
export function publicKey(): string | null {
  const existing = getSetting(VAPID_PUBLIC_KEY);
  if (existing) return existing;

  const webpush = loadWebPush();
  if (!webpush) return null;

  const keys = webpush.generateVAPIDKeys();
  setSetting(VAPID_PUBLIC_KEY, keys.publicKey);
  // Encrypted at rest: this is credential material, not configuration.
  setSetting(VAPID_PRIVATE_KEY, encrypt(keys.privateKey));
  log.info('generated VAPID keypair for web push');
  return keys.publicKey;
}

function configureVapid(webpush: WebPushModule): boolean {
  const pub = publicKey();
  const encrypted = getSetting(VAPID_PRIVATE_KEY);
  const priv = tryDecrypt(encrypted);
  if (!pub || !priv) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, pub, priv);
  return true;
}

// --- subscriptions ---------------------------------------------------------

function isSubscription(value: unknown): value is PushSubscription {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  return (
    typeof candidate.endpoint === 'string' &&
    candidate.endpoint.length > 0 &&
    typeof candidate.keys?.p256dh === 'string' &&
    typeof candidate.keys?.auth === 'string'
  );
}

/**
 * Narrow an untrusted body into a subscription. Called at the HTTP boundary,
 * so a malformed body is the caller's fault and names the offending field.
 */
export function parseSubscription(value: unknown): PushSubscription {
  if (!isSubscription(value)) {
    throw new AppError(
      'bad_request',
      'A push subscription needs an "endpoint" string and "keys" containing "p256dh" and "auth".',
      { details: { field: 'subscription' } },
    );
  }
  return { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

export function listSubscriptions(): PushSubscription[] {
  const raw = getSetting(SUBSCRIPTIONS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSubscription) : [];
  } catch {
    // A corrupt blob is not worth crashing over, and not worth keeping either.
    log.warn('stored push subscriptions were unreadable; starting over');
    return [];
  }
}

function saveSubscriptions(subscriptions: PushSubscription[]): void {
  setSetting(SUBSCRIPTIONS_KEY, JSON.stringify(subscriptions));
}

/** Endpoints are capabilities — never log one in full. */
function short(endpoint: string): string {
  return `${endpoint.slice(0, 32)}...`;
}

/**
 * Register a browser. Re-subscribing with the same endpoint replaces the entry
 * rather than duplicating it, so a page that re-registers on every load does
 * not accumulate copies and send the user four identical notifications.
 */
export function addSubscription(subscription: PushSubscription): void {
  const others = listSubscriptions().filter((s) => s.endpoint !== subscription.endpoint);
  saveSubscriptions([...others, subscription]);
  log.info('push subscription registered', { endpoint: short(subscription.endpoint) });
}

/** Returns true when something was actually removed. */
export function removeSubscription(endpoint: string): boolean {
  const before = listSubscriptions();
  const after = before.filter((s) => s.endpoint !== endpoint);
  if (after.length === before.length) return false;
  saveSubscriptions(after);
  log.info('push subscription removed', { endpoint: short(endpoint) });
  return true;
}

// --- sending ---------------------------------------------------------------

export interface PushResult {
  /** How many endpoints accepted the notification. */
  sent: number;
  /** How many were dropped as permanently gone. */
  removed: number;
  /**
   * Why nothing was sent, when nothing was: 'disabled' (setting off),
   * 'unavailable' (web-push not installed / no keys), 'no-subscriptions'.
   * Absent when at least one send was attempted.
   */
  skipped?: 'disabled' | 'unavailable' | 'no-subscriptions';
}

/**
 * Deliver a notification to every registered browser.
 *
 * Never throws and never rejects. This is called from the tail of a scheduled
 * run, and a failed notification must not turn a successful task into a failed
 * one — the outcome is reported in the return value and the log instead.
 */
export async function sendPush(payload: Omit<PushPayload, 'sentAt'>): Promise<PushResult> {
  if (!pushEnabled()) return { sent: 0, removed: 0, skipped: 'disabled' };

  const webpush = loadWebPush();
  if (!webpush || !configureVapid(webpush)) {
    return { sent: 0, removed: 0, skipped: 'unavailable' };
  }

  const subscriptions = listSubscriptions();
  if (subscriptions.length === 0) return { sent: 0, removed: 0, skipped: 'no-subscriptions' };

  const body = buildPushBody(payload);
  const dead: string[] = [];
  let sent = 0;

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(subscription, body);
      sent += 1;
    } catch (error) {
      const status = (error as WebPushError).statusCode;
      // 404/410 is the push service saying this endpoint no longer exists.
      // Anything else (a 500, a network blip) is transient — keep the entry.
      if (status === 404 || status === 410) {
        dead.push(subscription.endpoint);
      } else {
        log.warn('push delivery failed', {
          endpoint: short(subscription.endpoint),
          status,
          error: String(error),
        });
      }
    }
  }

  for (const endpoint of dead) removeSubscription(endpoint);

  log.debug('push dispatched', { reason: payload.reason, sent, removed: dead.length });
  return { sent, removed: dead.length };
}

/** Whether push could work right now, for the settings UI to reflect. */
export function pushStatus(): {
  enabled: boolean;
  available: boolean;
  publicKey: string | null;
  subscriptions: number;
} {
  const available = loadWebPush() !== null;
  return {
    enabled: pushEnabled(),
    available,
    // Only surfaced when enabled, so merely opening settings does not mint a
    // keypair the user never asked for.
    publicKey: available && pushEnabled() ? publicKey() : null,
    subscriptions: listSubscriptions().length,
  };
}
