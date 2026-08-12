/**
 * Browser push subscription management.
 *
 * These endpoints exist because a push subscription is an *object*, and the
 * generic settings routes deliberately reject objects so a malformed write
 * cannot land as "[object Object]". The subscription also has to be validated
 * field by field before it is stored — a half-formed one fails much later, at
 * send time, in a background job nobody is watching.
 *
 * Deliberately standard Web Push: the browser mints the subscription, we hold
 * a VAPID keypair and post to the endpoint the browser gave us. No native app,
 * no bespoke transport, no custom crypto.
 *
 * The on/off switch itself stays where every other preference lives — the
 * `push_enabled` key on `/api/settings` — so the settings screen has one write
 * path. This router only owns the subscription list and the status view.
 */

import { Router } from 'express';

import {
  addSubscription,
  parseSubscription,
  publicKey,
  pushStatus,
  removeSubscription,
  sendPush,
} from '../services/notify/push.ts';
import { wrap } from './errors.ts';
import { asString, body } from './params.ts';

export const pushRouter: Router = Router();

/**
 * Everything the frontend needs before it can call `registration.pushManager
 * .subscribe()`: whether the user has turned push on, whether the server can
 * actually send (the `web-push` optional dependency may be absent), the VAPID
 * application key, and how many devices are already registered.
 *
 * `enabled` and `available` are separate answers on purpose. "You switched this
 * off" and "this build cannot send" need different messages in the UI.
 */
pushRouter.get(
  '/status',
  wrap(async (_req, res) => {
    res.json(pushStatus());
  }),
);

/**
 * The VAPID public key on its own, for a service worker that wants just this.
 * Minting is lazy, so the first caller creates the keypair.
 */
pushRouter.get(
  '/key',
  wrap(async (_req, res) => {
    res.json({ publicKey: publicKey() });
  }),
);

/**
 * Registers a device. Re-subscribing with the same endpoint replaces the old
 * entry rather than adding a duplicate, so a browser that rotates its
 * subscription does not produce two notifications per event.
 */
pushRouter.post(
  '/subscribe',
  wrap(async (req, res) => {
    const subscription = parseSubscription(body(req).subscription ?? body(req));
    addSubscription(subscription);
    res.status(201).json({ subscribed: true, ...pushStatus() });
  }),
);

/**
 * Unregisters a device by endpoint. `removed: false` means it was not on the
 * list — which is the desired end state either way, so this is a 200 rather
 * than a 404.
 */
pushRouter.post(
  '/unsubscribe',
  wrap(async (req, res) => {
    const endpoint = asString(body(req).endpoint, 'endpoint');
    const removed = removeSubscription(endpoint);
    res.json({ removed, ...pushStatus() });
  }),
);

/**
 * Sends a test notification, so the user can confirm the permission prompt and
 * the service worker are actually wired up before trusting the feature with a
 * 3am job result.
 *
 * `sendPush` never throws and reports `skipped` when push is off, unavailable
 * or unsubscribed; that reason is the answer, not an error.
 */
pushRouter.post(
  '/test',
  wrap(async (_req, res) => {
    const result = await sendPush({
      reason: 'attention-needed',
      title: 'Hyperion',
      body: 'Push notifications are working.',
      tag: 'push-test',
    });
    res.json(result);
  }),
);
