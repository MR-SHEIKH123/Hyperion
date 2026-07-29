/**
 * Typed access to the `settings` key/value table.
 *
 * Values are stored as text and coerced on read. Reads are deliberately
 * un-cached: this table is tiny, SQLite reads are microseconds, and a cache
 * would mean a setting changed through the API only takes effect on restart.
 */

import { getDb } from '../db/adapter.ts';

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

export function setSetting(key: string, value: string | number | boolean | null): void {
  const serialised = value === null ? null : typeof value === 'boolean' ? String(value) : String(value);
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, serialised, Date.now());
}

export function allSettings(): Record<string, string | null> {
  const rows = getDb().prepare<SettingRow>(`SELECT key, value, updated_at FROM settings ORDER BY key`).all();
  const out: Record<string, string | null> = {};
  for (const row of rows) out[row.key] = row.value;
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
