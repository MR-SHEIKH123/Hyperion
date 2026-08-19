import { Router } from 'express';

import { wrap } from './errors.ts';
import { asBool, asClearableString, asEnum, asNumber, body, pathParam } from './params.ts';
// `publicSettings` rather than `allSettings`: the table holds the VAPID private
// key and the push subscription list, neither of which may cross this boundary.
import {
  autoResumeAfterFailover,
  CAPABILITIES,
  capabilityToggles,
  concurrencyMode,
  costTrackingEnabled,
  DAILY_SPEND_CAP_KEY,
  isCapabilityOn,
  publicSettings,
  pushEnabled,
  REDACTION_CHECK_KEY,
  redactionCheckEnabled,
  responsePreferences,
  RESPONSE_PREFERENCES_KEY,
  setCapability,
  setSetting,
  SUBAGENT_COUNT_LIMIT_KEY,
  TASK_ITERATION_CEILING_KEY,
  TASK_TOKEN_CEILING_KEY,
  TOOL_ACCESS_MODE_KEY,
  TOOL_ACCESS_MODES,
  toolAccessMode,
  type Capability,
} from '../db/settings.ts';
import { ceilingLimits, spendStatus } from '../services/limits/budget.ts';
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
      settings: publicSettings(),
      resolved: {
        concurrencyMode: concurrencyMode(),
        autoResumeAfterFailover: autoResumeAfterFailover(),
        costTrackingEnabled: costTrackingEnabled(),
        pushEnabled: pushEnabled(),
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
    res.json({ updated: keys, settings: publicSettings() });
  });
}

settingsRouter.put('/', updateHandler());
settingsRouter.patch('/', updateHandler());

// Every literal route below must stay above `/:key`, or Express matches
// `/preferences` as a setting named "preferences" and writes the wrong row.

/**
 * Standing response instructions.
 *
 * Exposed as its own route, rather than left to the generic `/:key` handler,
 * because the agent reads this on its own initiative — the same reason
 * `GET /api/skills/summary` exists. Nothing here injects it into a prompt.
 */
settingsRouter.get(
  '/preferences',
  wrap(async (_req, res) => {
    res.json({ preferences: responsePreferences() });
  }),
);

settingsRouter.put(
  '/preferences',
  wrap(async (req, res) => {
    // Blank clears the row instead of storing an empty string, so "unset" has
    // one representation rather than two that read the same. `asClearableString`
    // rather than `asString` because the latter rejects a blank value outright,
    // which made clearing unreachable: the user emptied the textarea, saved, and
    // got a 400 naming a field they had deliberately left blank.
    setSetting(RESPONSE_PREFERENCES_KEY, asClearableString(body(req).preferences, 'preferences'));
    res.json({ preferences: responsePreferences() });
  }),
);

/**
 * Capability toggles.
 *
 * `capabilities` is what the user chose; `effective` is what the backend will
 * actually permit. They differ for `network_egress`, which also requires
 * `code_execution` — reporting only the stored value would let the UI show
 * egress as available while every command is refused.
 */
settingsRouter.get(
  '/capabilities',
  wrap(async (_req, res) => {
    const capabilities = capabilityToggles();
    const effective = {} as Record<Capability, boolean>;
    for (const capability of CAPABILITIES) effective[capability] = isCapabilityOn(capability);
    res.json({ capabilities, effective });
  }),
);

settingsRouter.put(
  '/capabilities',
  wrap(async (req, res) => {
    const payload = body(req);
    const raw = payload.capabilities;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new AppError('bad_request', 'capabilities must be an object of capability names to booleans.', {
        details: { field: 'capabilities' },
      });
    }

    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length === 0) {
      throw new AppError('bad_request', 'No capabilities provided.', { details: { field: 'capabilities' } });
    }

    // Validate every entry before writing any of them: a half-applied toggle
    // set is worse than a rejected one, because the user cannot see which half.
    //
    // An unknown capability name is rejected rather than skipped. Silently
    // ignoring it would return 200 for a request that changed nothing, and the
    // caller would have no way to tell a typo from a toggle that did not stick.
    const updates: Array<[Capability, boolean]> = [];
    for (const [name, value] of entries) {
      // `name` is always present, so this either returns a Capability or throws.
      const capability = asEnum(name, `capabilities.${name}`, CAPABILITIES) as Capability;
      const enabled = asBool(value, `capabilities.${name}`);

      if (enabled === undefined) {
        throw new AppError('bad_request', `capabilities.${name} must be a boolean.`, {
          details: { field: `capabilities.${name}` },
        });
      }
      updates.push([capability, enabled]);
    }

    for (const [capability, enabled] of updates) setCapability(capability, enabled);

    const capabilities = capabilityToggles();
    const effective = {} as Record<Capability, boolean>;
    for (const capability of CAPABILITIES) effective[capability] = isCapabilityOn(capability);
    res.json({ capabilities, effective, updated: updates.map(([capability]) => capability) });
  }),
);

/** Advisory only — the agent reads this and decides. See db/settings.ts. */
settingsRouter.get(
  '/tool-access-mode',
  wrap(async (_req, res) => {
    res.json({ mode: toolAccessMode() });
  }),
);

settingsRouter.put(
  '/tool-access-mode',
  wrap(async (req, res) => {
    const mode = asEnum(body(req).mode, 'mode', TOOL_ACCESS_MODES);
    if (mode === undefined) {
      throw new AppError('bad_request', 'mode is required.', { details: { field: 'mode' } });
    }
    setSetting(TOOL_ACCESS_MODE_KEY, mode);
    res.json({ mode: toolAccessMode() });
  }),
);

/**
 * Network egress, which is `capability.network_egress` under a name that
 * matches how the setting is discussed. `enforced` names where the check lives
 * so a reader does not go looking for a sandbox: it is a command-string guard
 * in `services/limits/capabilities.ts`, nothing deeper.
 */
settingsRouter.get(
  '/network-egress',
  wrap(async (_req, res) => {
    res.json({
      enabled: capabilityToggles().network_egress,
      effective: isCapabilityOn('network_egress'),
      requiresCodeExecution: true,
      enforced: 'command_prefix_match',
    });
  }),
);

settingsRouter.put(
  '/network-egress',
  wrap(async (req, res) => {
    const enabled = asBool(body(req).enabled, 'enabled');
    if (enabled === undefined) {
      throw new AppError('bad_request', 'enabled is required.', { details: { field: 'enabled' } });
    }
    setCapability('network_egress', enabled);
    res.json({
      enabled: capabilityToggles().network_egress,
      effective: isCapabilityOn('network_egress'),
    });
  }),
);

/**
 * The outbound data safety check (Part 1.23).
 *
 * Kept out of `capabilityToggles()` on purpose. A capability is something the
 * agent may *do*, and every one of them defaults on; this is a check applied to
 * what the agent *sends*, and it defaults **off** because it is a regex
 * heuristic whose false positives interrupt real work. Filing it as a capability
 * would flip that default the first time the toggles map was iterated.
 */
settingsRouter.get(
  '/redaction-check',
  wrap(async (_req, res) => {
    res.json({
      enabled: redactionCheckEnabled(),
      appliesTo: 'remote',
      enforced: 'pattern_match',
    });
  }),
);

settingsRouter.put(
  '/redaction-check',
  wrap(async (req, res) => {
    const enabled = asBool(body(req).enabled, 'enabled');
    if (enabled === undefined) {
      throw new AppError('bad_request', 'enabled is required.', { details: { field: 'enabled' } });
    }
    setSetting(REDACTION_CHECK_KEY, enabled);
    res.json({ enabled: redactionCheckEnabled(), appliesTo: 'remote' });
  }),
);

/** A ceiling of 0 is rejected rather than stored — see the note on the route. */
function positiveLimit(value: unknown, field: string): number | undefined {
  const parsed = asNumber(value, field);
  if (parsed === undefined) return undefined;
  if (parsed <= 0 || !Number.isInteger(parsed)) {
    throw new AppError('bad_request', `${field} must be a positive whole number.`, {
      details: { field },
    });
  }
  return parsed;
}

/**
 * Spending cap and runaway ceilings, plus where today's spend currently stands.
 *
 * `spend` is included in the GET so the UI can render the cap and the progress
 * toward it from one request; they are read from the same snapshot, so they
 * cannot disagree.
 */
settingsRouter.get(
  '/limits',
  wrap(async (_req, res) => {
    res.json({ ceilings: ceilingLimits(), spend: spendStatus() });
  }),
);

/**
 * Only the keys present in the body are written, so a UI that owns one control
 * does not have to send the others back.
 *
 * `dailySpendCapUsd: 0` **removes** the cap rather than storing zero. Zero
 * would otherwise mean "refuse all autonomous work", which nobody types on
 * purpose, and the reader already treats it as unset — writing the row anyway
 * would leave a value that displays as a cap but behaves as none.
 */
settingsRouter.put(
  '/limits',
  wrap(async (req, res) => {
    const payload = body(req);
    const updated: string[] = [];

    const cap = asNumber(payload.dailySpendCapUsd, 'dailySpendCapUsd');
    if (cap !== undefined) {
      if (cap < 0) {
        throw new AppError('bad_request', 'dailySpendCapUsd cannot be negative.', {
          details: { field: 'dailySpendCapUsd' },
        });
      }
      setSetting(DAILY_SPEND_CAP_KEY, cap === 0 ? null : cap);
      updated.push('dailySpendCapUsd');
    }

    const tokenCeiling = positiveLimit(payload.tokenCeiling, 'tokenCeiling');
    if (tokenCeiling !== undefined) {
      setSetting(TASK_TOKEN_CEILING_KEY, tokenCeiling);
      updated.push('tokenCeiling');
    }

    const iterationCeiling = positiveLimit(payload.iterationCeiling, 'iterationCeiling');
    if (iterationCeiling !== undefined) {
      setSetting(TASK_ITERATION_CEILING_KEY, iterationCeiling);
      updated.push('iterationCeiling');
    }

    const subagentLimit = positiveLimit(payload.subagentLimit, 'subagentLimit');
    if (subagentLimit !== undefined) {
      setSetting(SUBAGENT_COUNT_LIMIT_KEY, subagentLimit);
      updated.push('subagentLimit');
    }

    if (updated.length === 0) {
      throw new AppError('bad_request', 'No limits provided.');
    }

    res.json({ updated, ceilings: ceilingLimits(), spend: spendStatus() });
  }),
);

settingsRouter.put(
  '/:key',
  wrap(async (req, res) => {
    const key = pathParam(req, 'key');
    const payload = body(req);
    setSetting(key, asSettingValue(payload.value, key));
    res.json({ updated: [key], settings: publicSettings() });
  }),
);

/** Clearing a key writes NULL, which restores the built-in default. */
settingsRouter.delete(
  '/:key',
  wrap(async (req, res) => {
    const key = pathParam(req, 'key');
    setSetting(key, null);
    res.json({ cleared: key, settings: publicSettings() });
  }),
);
