/**
 * A notification must fit in a push message.
 *
 * The payload was assembled from whatever the run produced, and a scheduled run's
 * summary is model output bounded only at 4,000 characters by the code agent
 * (`MAX_SUMMARY`). Web Push messages are capped at 4,096 octets by the protocol —
 * that is the size a push service is required to accept — and web-push adds its
 * encryption envelope on top, so a run that produced a long report built a
 * message the service refused.
 *
 * The failure was invisible in the worst way: a rejection that is not 404/410 is
 * treated as transient and the subscription is deliberately kept, so the user got
 * no notification for exactly the runs with the most to say, and nothing anywhere
 * said why. The tray truncates the text anyway — a notification is a pointer to
 * the app, not the report.
 *
 * The clamp lives in `buildPushBody`, which is what `sendPush` serializes, so a
 * caller cannot opt out of it by passing a long string.
 */

import './helpers.ts';

import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

const { buildPushBody, PUSH_MESSAGE_BUDGET_BYTES } = await import(
  '../src/services/notify/push.ts'
);

type Message = { reason: string; title: string; body: string; url?: string; tag?: string; sentAt: number };

before(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

function parse(json: string): Message {
  return JSON.parse(json) as Message;
}

describe('the body a push carries', () => {
  test('a long run summary is clamped instead of building an unsendable message', () => {
    const summary = 'The report is long. '.repeat(1_000);
    assert.ok(summary.length >= 20_000, 'the fixture must be far past the transport limit');

    const json = buildPushBody({ reason: 'scheduled-task', title: 'Morning digest finished', body: summary });

    assert.ok(
      Buffer.byteLength(json) <= PUSH_MESSAGE_BUDGET_BYTES,
      `payload is ${String(Buffer.byteLength(json))} bytes, budget is ${String(PUSH_MESSAGE_BUDGET_BYTES)}`,
    );

    const message = parse(json);
    assert.ok(message.body.length < summary.length);
    assert.match(message.body, /…$/, 'a clipped body should say it was clipped');
    assert.equal(message.body.startsWith('The report is long.'), true, 'the start is the point of a summary');
  });

  test('a short body is passed through untouched', () => {
    const json = buildPushBody({ reason: 'attention-needed', title: 'Hyperion', body: 'Push notifications are working.' });
    const message = parse(json);

    assert.equal(message.body, 'Push notifications are working.');
    assert.equal(message.title, 'Hyperion');
    assert.equal(message.reason, 'attention-needed');
    assert.equal(message.body.includes('…'), false);
  });

  test('the optional fields survive, and are clamped too', () => {
    const json = buildPushBody({
      reason: 'scheduled-task',
      title: 'T'.repeat(500),
      body: 'short',
      url: `/cowork/${'u'.repeat(2_000)}`,
      tag: `scheduled-task:${'g'.repeat(2_000)}`,
    });
    const message = parse(json);

    assert.ok(Buffer.byteLength(json) <= PUSH_MESSAGE_BUDGET_BYTES);
    assert.equal(message.body, 'short', 'a short body must not be collateral damage');
    assert.equal(message.title.length < 500, true);
    assert.equal(message.url?.startsWith('/cowork/'), true, 'the link still points somewhere useful');
    assert.equal(message.tag?.startsWith('scheduled-task:'), true, 'the tag still collapses repeats');
  });

  test('multi-byte text is cut on a character boundary, not through a code point', () => {
    // Each of these is four UTF-8 bytes, so a byte-wise cut would leave a lone
    // surrogate or a replacement character in the notification.
    const json = buildPushBody({ reason: 'scheduled-task', title: 'Emoji', body: '🚀'.repeat(2_000) });
    const message = parse(json);

    assert.ok(Buffer.byteLength(json) <= PUSH_MESSAGE_BUDGET_BYTES);
    assert.equal(message.body.includes('\uFFFD'), false, 'the clamp split a code point');
    assert.equal(/[\uD800-\uDFFF]/.test(message.body.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), false);
    assert.equal(message.body.endsWith('…'), true);
  });

  test('the worst case still fits the protocol, whatever the caller sends', () => {
    const worst = buildPushBody({
      reason: 'scheduled-task',
      title: '😀'.repeat(4_000),
      body: '😀'.repeat(4_000),
      url: `https://example.com/${'😀'.repeat(4_000)}`,
      tag: '😀'.repeat(4_000),
    });

    // 4096 is the size a push service is required to accept; the budget leaves
    // room for the encryption envelope web-push adds (about 100 bytes).
    assert.ok(Buffer.byteLength(worst) <= PUSH_MESSAGE_BUDGET_BYTES);
    assert.ok(PUSH_MESSAGE_BUDGET_BYTES + 103 <= 4_096);
  });
});
