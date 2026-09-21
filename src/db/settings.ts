/**
 * Typed access to the `settings` key/value table.
 *
 * Values are stored as text and coerced on read. Reads are deliberately
 * un-cached: this table is tiny, SQLite reads are microseconds, and a cache
 * would mean a setting changed through the API only takes effect on restart.
 */

import { getDb } from '../db/adapter.ts';
import { isZdrRequirement } from '../types/core.ts';

import type { ZdrRequirement } from '../types/core.ts';

export interface SettingRow {
  key: string;
  value: string | null;
  updated_at: number;
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare<{ value: string | null }>(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row?.value ?? null;
}

export function getBoolSetting(key: string, fallback: boolean): boolean {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  return raw === 'true' || raw === '1';
}

export function getNumberSetting(key: string, fallback: number): number {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Writes a setting, or clears it when `value` is null.
 *
 * Clearing has to delete the row: `value` is `NOT NULL` in the schema, so a
 * literal NULL cannot be stored, and the INSERT that tried raised
 * `NOT NULL constraint failed` — surfacing as a 500 from `DELETE
 * /api/settings/:key`, which meant that route had never once succeeded.
 * Absence and NULL are indistinguishable to every reader anyway, because
 * `getSetting()` maps a missing row to null, so removing the row is exactly
 * what "restore the built-in default" already meant.
 */
export function setSetting(key: string, value: string | number | boolean | null): void {
  if (value === null) {
    getDb().prepare(`DELETE FROM settings WHERE key = ?`).run(key);
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, String(value), Date.now());
}


export function allSettings(): Record<string, string | null> {
  const rows = getDb().prepare<SettingRow>(`SELECT key, value, updated_at FROM settings ORDER BY key`).all();
  const out: Record<string, string | null> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

/**
 * Settings that hold credential material and must never be serialized to a
 * client.
 *
 * `push_vapid_private` signs every push and is the half that
 * `services/notify/push.ts` promises never leaves the server;
 * `push_subscriptions` stores endpoint URLs, and an endpoint URL is itself a
 * capability to notify that device (which is why that module truncates them
 * even in logs).
 *
 * `allSettings()` deliberately still returns both, because a backup has to
 * round-trip them or every existing browser subscription breaks on restore.
 * The omission therefore belongs at the boundary, not in the table accessor.
 */
export const SECRET_SETTING_KEYS: readonly string[] = ['push_vapid_private', 'push_subscriptions'];

/**
 * `allSettings()` minus the credential keys — the only form that may be sent
 * over HTTP.
 *
 * Secret keys are *omitted* rather than replaced with a `"[redacted]"` marker
 * on purpose: the bulk update route writes back every key it is handed, so a
 * placeholder would overwrite the real private key the first time a client did
 * read-modify-write on this object.
 */
export function publicSettings(): Record<string, string | null> {
  const out = allSettings();
  for (const key of SECRET_SETTING_KEYS) delete out[key];
  return out;
}


// --- named settings used by backend logic ----------------------------------

/**
 * Whether a successful failover to a *different* provider should immediately
 * re-attempt the exchange. Retrying elsewhere is not "auto-retrying into the
 * same broken state" — the broken state was the old provider.
 */
export function autoResumeAfterFailover(): boolean {
  return getBoolSetting('auto_resume_after_failover', true);
}

/** 'reject' (409 immediately) or 'queue' (wait in line). */
export function concurrencyMode(): 'reject' | 'queue' {
  return getSetting('concurrency_mode') === 'queue' ? 'queue' : 'reject';
}

export function costTrackingEnabled(): boolean {
  return getBoolSetting('cost_tracking_enabled', true);
}

/**
 * Whether the backend may send browser push notifications.
 *
 * Defaults to **off**. A notification is an interruption the user did not ask
 * for at the moment it arrives, and the browser permission prompt is a poor
 * place to discover a feature exists — so this stays dark until it is turned
 * on deliberately. Once on, only two things push: a scheduled task finishing,
 * and something waiting on an explicit confirmation. Ordinary foreground
 * activity never does; the user is already looking at it.
 */
export function pushEnabled(): boolean {
  return getBoolSetting('push_enabled', false);
}

// --- response preferences (Part 1.20) --------------------------------------

export const RESPONSE_PREFERENCES_KEY = 'response_preferences';

/**
 * Free-text standing instructions, account-wide.
 *
 * Returns `''` rather than null when unset so callers can concatenate without
 * a guard. **This backend never injects it into a prompt** — that is the
 * agent's decision, made per turn, and doing it here would mean the agent
 * could not see or override what it was given. `GET /api/settings/preferences`
 * is how the agent reads it. See docs/CONTRACTS.md.
 */
export function responsePreferences(): string {
  return getSetting(RESPONSE_PREFERENCES_KEY) ?? '';
}

// --- capability toggles (Part 1.20 §2, Part 1.21 §5) -----------------------

/**
 * Capabilities the user can switch off independently of whether the underlying
 * provider or MCP server is configured. A toggle answers "am I allowed to",
 * which is a different question from "is it available".
 *
 * `network_egress` is a sub-toggle of `code_execution` rather than a peer:
 * reaching the network is a strictly larger permission than running a local
 * command, so it is meaningless when `code_execution` is off. `isCapabilityOn`
 * enforces that relationship in one place.
 *
 * `web_research` is a **peer**, not a second name for `network_egress`, and the
 * distinction is deliberate. `network_egress` governs a *shell command the agent
 * chose to run* — an `npm install` inside a worktree. `web_research` governs the
 * agent fetching pages through a supervised MCP server, which is a narrower and
 * differently-shaped permission: no arbitrary binary runs, and the traffic is
 * one the user can see in the transcript.
 *
 * Folding it under `code_execution` the way `network_egress` is folded would
 * mean a user who switched code execution off — a reasonable thing to want for
 * a research-only install — silently lost web research too, with the Settings
 * toggle still reading "on". That is exactly the silent-no-op failure the
 * capability gates exist to prevent.
 */
export const CAPABILITIES = [
  'cowork_research',
  'code_execution',
  'network_egress',
  'web_research',
  'artifacts',
  'chat_search',
  'memory_generation',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

function capabilityKey(capability: Capability): string {
  return `capability.${capability}`;
}

/**
 * The stored toggle, ignoring the code_execution/network_egress relationship.
 *
 * Every capability defaults to **on**. A fresh install must behave like the app
 * it says it is; shipping features switched off would present as breakage
 * rather than as a safety default. `network_egress` is on for the same reason —
 * the spec asks for the toggle and the security note, not for a default that
 * quietly breaks `npm install`.
 */
function rawCapability(capability: Capability): boolean {
  return getBoolSetting(capabilityKey(capability), true);
}

/**
 * Whether a capability may be used right now.
 *
 * Network egress additionally requires `code_execution`: with execution off
 * there is nothing to reach the network *with*, and reporting egress as
 * available would invite a caller to test the wrong gate.
 */
export function isCapabilityOn(capability: Capability): boolean {
  if (capability === 'network_egress') {
    return rawCapability('code_execution') && rawCapability('network_egress');
  }
  return rawCapability(capability);
}

/** All toggles, for `GET /api/settings/capabilities`. */
export function capabilityToggles(): Record<Capability, boolean> {
  const out = {} as Record<Capability, boolean>;
  for (const capability of CAPABILITIES) out[capability] = rawCapability(capability);
  return out;
}

export function setCapability(capability: Capability, on: boolean): void {
  setSetting(capabilityKey(capability), on);
}

// --- tool access mode (Part 1.21 §4) ---------------------------------------

export const TOOL_ACCESS_MODE_KEY = 'tool_access_mode';

/** The list is the source of truth; the type is derived so they cannot drift. */
export const TOOL_ACCESS_MODES = ['always_loaded', 'load_when_needed'] as const;

export type ToolAccessMode = (typeof TOOL_ACCESS_MODES)[number];


/**
 * Whether MCP tool definitions and skill summaries are front-loaded into every
 * request or pulled in on demand.
 *
 * Defaults to `always_loaded`: it is the behaviour that exists today, and the
 * token saving only becomes worth a relevance pre-check once several servers
 * and skills are configured. Like `response_preferences`, this is advisory —
 * the agent reads it and decides. Nothing in this backend changes behaviour
 * based on it.
 */
export function toolAccessMode(): ToolAccessMode {
  return getSetting(TOOL_ACCESS_MODE_KEY) === 'load_when_needed' ? 'load_when_needed' : 'always_loaded';
}

// --- spending and runaway limit keys ---------------------------------------

/**
 * Named so the settings routes write the same strings the readers below expect.
 * A typo'd key here is invisible: the write succeeds, the reader keeps
 * returning its default, and the limit silently never applies.
 */
export const DAILY_SPEND_CAP_KEY = 'daily_spend_cap_usd';
export const TASK_TOKEN_CEILING_KEY = 'task_token_ceiling';
export const TASK_ITERATION_CEILING_KEY = 'task_iteration_ceiling';
export const SUBAGENT_COUNT_LIMIT_KEY = 'subagent_count_limit';
export const REDACTION_CHECK_KEY = 'redaction_check_enabled';
export const PARKED_WORKTREE_TTL_KEY = 'parked_worktree_ttl_hours';
export const APPROVAL_WAIT_TTL_KEY = 'approval_wait_ttl_hours';


// --- spending and runaway limits (Part 1.19) -------------------------------

/**
 * Daily spend ceiling in USD, or null when unset.
 *
 * Off by default. A cap the user did not choose would start refusing work for
 * reasons they never asked for, and an arbitrary default figure is a guess
 * about their budget. Zero and negatives are treated as unset rather than as
 * "refuse everything": a cap of zero would silently disable every autonomous
 * task, which is not something anyone types on purpose.
 */
export function dailySpendCapUsd(): number | null {
  const raw = getNumberSetting(DAILY_SPEND_CAP_KEY, 0);
  return raw > 0 ? raw : null;
}


/**
 * Default token budget for a single task.
 *
 * Pre-filled rather than blank, per the spec. 2,000,000 tokens is roughly a few
 * dollars at mid-2020s frontier rates and far above any legitimate single task,
 * so it catches a genuine runaway loop without interrupting real work.
 */
export function taskTokenCeiling(): number {
  const raw = getNumberSetting(TASK_TOKEN_CEILING_KEY, 2_000_000);
  return raw > 0 ? raw : 2_000_000;
}

/** Maximum agentic loop iterations (tool calls, subagent spawns) per task. */
export function taskIterationCeiling(): number {
  const raw = getNumberSetting(TASK_ITERATION_CEILING_KEY, 100);
  return raw > 0 ? raw : 100;
}


/**
 * Maximum subagents a single parent task may spawn.
 *
 * Distinct from Prompt 3's one-level depth limit: depth stops recursion, count
 * stops a flat fan-out of one subagent after another. Default 5, conservative
 * on purpose.
 */
export function subagentCountLimit(): number {
  const raw = getNumberSetting(SUBAGENT_COUNT_LIMIT_KEY, 5);
  return raw > 0 ? raw : 5;
}


/**
 * How long a parked Code task keeps its git worktree before the reaper releases it.
 *
 * A week by default. Parking exists so a run can be *continued*, which means the
 * directory and its uncommitted edits have to survive until someone answers — and
 * "someone answers" is a human timescale, not a process one. An hour would silently
 * turn approval prompts back into dead ends over a lunch break.
 *
 * Zero and negatives read as the default rather than as "release immediately". A
 * TTL of zero would discard every parked task's work the moment the cleanup timer
 * fired, which is not something anyone types on purpose — the same reasoning
 * `dailySpendCapUsd` uses for treating zero as unset.
 */
export function parkedWorktreeTtlHours(): number {
  const raw = getNumberSetting(PARKED_WORKTREE_TTL_KEY, 168);
  return raw > 0 ? raw : 168;
}


/**
 * How long a prompt waits for an answer before it expires (1.31).
 *
 * Three days by default. This is the deadline on the *question*, not on the task:
 * a `pending_approvals` row older than this is closed as `expired` by the reaper,
 * and answering it afterwards no longer authorises anything. What it buys is the
 * thing an unbounded wait gets wrong twice — a prompt left `pending` forever is
 * still shown as answerable, and a click on a week-old prompt replays a call
 * against a checkout from a week ago, which is not what the user is picturing
 * when they approve it.
 *
 * Deliberately shorter than `parkedWorktreeTtlHours` above: the question goes
 * first and the work survives it, so an expired prompt still leaves the directory
 * and its edits on disk to be looked at. The reverse order would reap the work
 * while the question that could still consume it is answerable.
 *
 * A long weekend is the scale this has to clear — a task parked on Friday
 * evening must still be answerable on Monday morning — and it is measured in
 * hours rather than days because the useful values below a day (8, 12) are real
 * ones for an unattended box.
 *
 * Zero and negatives read as the default rather than as "expire immediately",
 * the same rule the worktree TTL uses: nobody types zero on purpose, and a
 * zero-TTL reaper would close every prompt the moment the timer fired.
 */
export function approvalWaitTtlHours(): number {
  const raw = getNumberSetting(APPROVAL_WAIT_TTL_KEY, 72);
  return raw > 0 ? raw : 72;
}


// --- outbound data safety (Part 1.23) --------------------------------------

/**
 * Whether outbound payloads bound for a **remote** provider are scanned for
 * credential-shaped text before being sent.
 *
 * Off by default, and deliberately not a `Capability`. The capability list is a
 * set of things the agent may *do*, all defaulting on; this is a check on what
 * leaves the machine, and it defaults off because it is a regex heuristic. A
 * false positive interrupts real work, and an interruption the user did not ask
 * for is how a safety feature gets switched off for good.
 *
 * When on, a flagged send is refused with `redaction_flagged` rather than
 * silently rewritten — see `services/safety/outbound.ts` for why masking a
 * user's prompt is never the right answer.
 */
export function redactionCheckEnabled(): boolean {
  return getBoolSetting(REDACTION_CHECK_KEY, false);
}

// --- zero data retention (Part 1.26) ---------------------------------------

/**
 * Named for the same reason as the limit keys above: a typo'd key write succeeds
 * while the reader keeps returning its default, so the policy silently never
 * applies — and a ZDR policy that silently does not apply is the worst possible
 * failure for this feature, because the user believes the opposite.
 */
export const ZDR_REQUIREMENT_KEY = 'zdr_requirement';

/**
 * The standing zero-data-retention policy.
 *
 * Defaults to `off`, and that is not timidity. Every provider starts at
 * `zdr_support = 'unknown'`, and `require` fails closed on unknown, so a default
 * of `require` would make a fresh install refuse every remote provider it has —
 * presenting a correct safety decision as a broken app. Turning it on is an
 * informed act, taken after recording what each provider actually does.
 *
 * An unrecognised stored value reads as `off` rather than throwing: this is
 * consulted on the request path, and a hand-edited settings row must not be able
 * to make every send fail.
 */
export function zdrRequirement(): ZdrRequirement {
  const raw = getSetting(ZDR_REQUIREMENT_KEY);
  return isZdrRequirement(raw) ? raw : 'off';
}


