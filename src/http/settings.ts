import { Router } from 'express';

import { wrap } from './errors.ts';
import { body, pathParam } from './params.ts';
import {
  allSettings,
  autoResumeAfterFailover,
  concurrencyMode,
  costTrackingEnabled,
  setSetting,
} from '../db/settings.ts';
import { AppError } from '../util/errors.ts';

type SettingValue = string | number | boolean | null;

/**
 * Settings are stored as text, so only scalars round-trip. Rejecting objects
 * and arrays here keeps a malformed write from landing as "[object Object]".
 */
function asSettingValue(value: unknown, key: string): SettingValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value === undefined) {
    throw new AppError('bad_request', `Setting "${key}" is missing a value`, { details: { key } });
  }
  throw new AppError(
    'bad_request',
    `Setting "${key}" must be a string, number, boolean, or null`,
    { details: { key, received: typeof value } },
  );
}

export const settingsRouter = Router();

/**
 * Returns the raw key/value map plus the resolved values the backend actually
 * acts on, so the UI does not have to duplicate the default-value logic.
 */
settingsRouter.get(
  '/',
  wrap(async (_req, res) => {
    res.json({
      settings: allSettings(),
      resolved: {
        concurrencyMode: concurrencyMode(),
        autoResumeAfterFailover: autoResumeAfterFailover(),
        costTrackingEnabled: costTrackingEnabled(),
      },
    });
  }),
);

/** Bulk write: every key in the body is applied. */
function updateHandler(): ReturnType<typeof wrap> {
  return wrap(async (req, res) => {
    const payload = body(req);
    const keys = Object.keys(payload);
    if (keys.length === 0) {
      throw new AppError('bad_request', 'No settings provided');
    }
    for (const key of keys) {
      setSetting(key, asSettingValue(payload[key], key));
    }
    res.json({ updated: keys, settings: allSettings() });
  });
}

settingsRouter.put('/', updateHandler());
settingsRouter.patch('/', updateHandler());

settingsRouter.put(
  '/:key',
  wrap(async (req, res) => {
    const key = pathParam(req, 'key');
    const payload = body(req);
    setSetting(key, asSettingValue(payload.value, key));
    res.json({ updated: [key], settings: allSettings() });
  }),
);

/** Clearing a key writes NULL, which restores the built-in default. */
settingsRouter.delete(
  '/:key',
  wrap(async (req, res) => {
    const key = pathParam(req, 'key');
    setSetting(key, null);
    res.json({ cleared: key, settings: allSettings() });
  }),
);
