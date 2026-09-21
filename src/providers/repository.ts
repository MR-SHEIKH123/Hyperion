/**
 * Provider persistence.
 *
 * Owns the row <-> ProviderRecord mapping and the single-active-provider
 * transaction. Two rules are enforced here and nowhere else:
 *
 *   1. `toPublic()` is the ONLY way a provider reaches the frontend. It has no
 *      key field at all, so a future careless `res.json(provider)` cannot leak
 *      ciphertext either — the type system rejects it.
 *   2. Enabling a provider disables the previous one inside one transaction.
 *      The database also has a partial unique index on `enabled = 1`, so even a
 *      bug elsewhere cannot produce two active providers; it errors instead.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/adapter.ts';
import { encrypt, keyHint } from '../security/keystore.ts';
import { AppError } from '../util/errors.ts';
import { parseEgressProxy, tryEgressProxy } from '../services/safety/outbound.ts';
import { findSensitive } from '../util/redact.ts';
import { isZdrFlagLocation, isZdrSupport } from '../types/core.ts';
import type {
  HealthStatus,
  ModelInfo,
  ProviderPublic,
  ProviderRecord,
  ProviderType,
  ProviderZdr,
  ZdrFlagLocation,
  ZdrRequestFlag,
  ZdrSupport,
} from '../types/core.ts';

interface ProviderRow {
  id: string;
  name: string;
  type: string;
  base_url: string;
  api_key_enc: string | null;
  api_key_hint: string | null;
  enabled: number;
  priority: number;
  health_status: string;
  last_error: string | null;
  last_error_at: number | null;
  last_success_at: number | null;
  models_json: string | null;
  models_fetched_at: number | null;
  models_error: string | null;
  egress_proxy: string | null;
  zdr_support: string | null;
  zdr_flag_location: string | null;
  zdr_flag_key: string | null;
  zdr_flag_value: string | null;
  zdr_confirmed_at: number | null;
  zdr_confirmed_note: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Assemble the ZDR block from its columns.
 *
 * An unrecognised stored `zdr_support` reads as `unknown` rather than throwing.
 * The column is free text by design (see migration 016), so a downgrade or a
 * hand-edited row must not make a provider unreadable — and `unknown` is the
 * value that fails closed, which is the right direction to fail in.
 *
 * A flag is assembled only when it is complete. A half-written flag row is
 * indistinguishable from none as far as the wire is concerned, and reporting a
 * partial one would let `zdrStatusFor` claim ZDR was requested when nothing
 * would be sent.
 */
function mapZdr(row: ProviderRow): ProviderZdr {
  const location: ZdrFlagLocation | null = isZdrFlagLocation(row.zdr_flag_location)
    ? row.zdr_flag_location
    : null;
  const key = row.zdr_flag_key;
  const value = row.zdr_flag_value;

  const requestFlag: ZdrRequestFlag | null =
    location !== null && key !== null && key.trim() !== '' && value !== null && value.trim() !== ''
      ? { location, key, value }
      : null;

  return {
    support: isZdrSupport(row.zdr_support) ? row.zdr_support : 'unknown',
    requestFlag,
    confirmedAt: row.zdr_confirmed_at,
    confirmedNote: row.zdr_confirmed_note,
  };
}

function mapRow(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type as ProviderType,
    baseUrl: row.base_url,
    apiKeyEnc: row.api_key_enc,
    apiKeyHint: row.api_key_hint,
    enabled: row.enabled === 1,
    priority: row.priority,
    healthStatus: row.health_status as HealthStatus,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    lastSuccessAt: row.last_success_at,
    models: parseModels(row.models_json),
    modelsFetchedAt: row.models_fetched_at,
    modelsError: row.models_error,
    egressProxy: row.egress_proxy,
    zdr: mapZdr(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A corrupt cache must not make the provider unreadable — treat it as absent. */
function parseModels(json: string | null): ModelInfo[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as ModelInfo[]) : null;
  } catch {
    return null;
  }
}

/**
 * Wire format. Note what is missing: no `apiKeyEnc`, no `apiKey`, nothing
 * decryptable. `apiKeyHint` is the last 4 characters only, for identification.
 */
/**
 * The proxy as a read path may see it: redacted, or null.
 *
 * `tryEgressProxy` rather than the throwing parse: a row written by a newer build
 * (or edited by hand in SQLite) must not make `GET /api/providers` fail. An
 * unreadable value reads as "no proxy disclosed" — which is a disclosure gap, and
 * the class derivation treats it as one by not vouching for locality.
 */
function proxyForRead(raw: string | null): string | null {
  const proxy = tryEgressProxy(raw);
  return proxy === null ? null : proxy.redacted;
}

export function toPublic(provider: ProviderRecord): ProviderPublic {
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    hasKey: provider.apiKeyEnc !== null,
    apiKeyHint: provider.apiKeyHint,
    enabled: provider.enabled,
    priority: provider.priority,
    healthStatus: provider.healthStatus,
    lastError: provider.lastError,
    lastErrorAt: provider.lastErrorAt,
    lastSuccessAt: provider.lastSuccessAt,
    modelCount: provider.models === null ? null : provider.models.length,
    modelsFetchedAt: provider.modelsFetchedAt,
    modelsError: provider.modelsError,
    // Redacted at the boundary rather than by the caller. The row holds the dial
    // URL with its credentials; this interface has never carried a credential,
    // and the way to keep that true is to convert here, where the raw value is
    // still in hand and cannot be forgotten by a new route.
    egressProxy: proxyForRead(provider.egressProxy),
    // Carried across in full, `requestFlag.value` included. That value is a
    // policy declaration and never a credential — `setProviderZdr` rejects one
    // that looks like a credential — and a field maintained by hand is
    // unverifiable if the user cannot read back what was saved.
    zdr: provider.zdr,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

const COLUMNS = `id, name, type, base_url, api_key_enc, api_key_hint, enabled, priority,
  health_status, last_error, last_error_at, last_success_at, models_json,
  models_fetched_at, models_error, egress_proxy, zdr_support, zdr_flag_location,
  zdr_flag_key, zdr_flag_value, zdr_confirmed_at, zdr_confirmed_note, created_at, updated_at`;

// --- reads -----------------------------------------------------------------

export function listProviders(): ProviderRecord[] {
  return getDb()
    .prepare<ProviderRow>(`SELECT ${COLUMNS} FROM providers ORDER BY priority ASC, name ASC`)
    .all()
    .map(mapRow);
}

export function findProvider(id: string): ProviderRecord | null {
  const row = getDb()
    .prepare<ProviderRow>(`SELECT ${COLUMNS} FROM providers WHERE id = ?`)
    .get(id);
  return row ? mapRow(row) : null;
}

/** Throws instead of returning null, for the many call sites that require one. */
export function requireProvider(id: string): ProviderRecord {
  const provider = findProvider(id);
  if (!provider) {
    throw new AppError('not_found', `No provider with id "${id}"`);
  }
  return provider;
}

export function findProviderByName(name: string): ProviderRecord | null {
  const row = getDb()
    .prepare<ProviderRow>(`SELECT ${COLUMNS} FROM providers WHERE name = ?`)
    .get(name);
  return row ? mapRow(row) : null;
}

/** The single active provider, or null if the user has none enabled. */
export function getActiveProvider(): ProviderRecord | null {
  const row = getDb()
    .prepare<ProviderRow>(`SELECT ${COLUMNS} FROM providers WHERE enabled = 1 LIMIT 1`)
    .get();
  return row ? mapRow(row) : null;
}

export function requireActiveProvider(): ProviderRecord {
  const provider = getActiveProvider();
  if (!provider) {
    throw new AppError(
      'no_active_provider',
      'No provider is enabled. Add a provider and enable it before sending requests.',
    );
  }
  return provider;
}

/**
 * Failover candidates: everything except `excludeId`, in priority order, with
 * providers already known to be unhealthy last rather than excluded — a provider
 * marked unhealthy an hour ago may well be fine now, and it beats having no
 * option at all.
 */
export function listFailoverCandidates(excludeId?: string): ProviderRecord[] {
  const rows = getDb()
    .prepare<ProviderRow>(
      `SELECT ${COLUMNS} FROM providers
       WHERE (? IS NULL OR id <> ?)
       ORDER BY (health_status = 'unhealthy') ASC, priority ASC, name ASC`,
    )
    .all(excludeId ?? null, excludeId ?? null);
  return rows.map(mapRow);
}

// --- writes ----------------------------------------------------------------

export interface CreateProviderInput {
  name: string;
  type: ProviderType;
  baseUrl: string;
  /** Plaintext, encrypted here and never stored or logged as-is. */
  apiKey?: string | null;
  priority?: number;
  enabled?: boolean;
  /** Proxy URL the requests are tunnelled through (Part 1.37). Validated here. */
  egressProxy?: string | null;
}

export function createProvider(input: CreateProviderInput): ProviderRecord {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();

  const name = input.name.trim();
  if (name === '') throw new AppError('bad_request', 'Provider name is required');
  const baseUrl = normalizeBaseUrl(input.baseUrl, input.type);
  // Parsed before anything is written, so an unusable proxy is a rejected create
  // rather than a stored value the transport cannot dial (Part 1.37).
  const egressProxy = parseEgressProxy(input.egressProxy)?.url ?? null;

  if (findProviderByName(name)) {
    throw new AppError('conflict', `A provider named "${name}" already exists`);
  }

  const key = input.apiKey?.trim() ?? '';
  const hasKey = key !== '';

  return db.transaction(() => {
    // Enabling on create must go through the same mutual-exclusion path.
    if (input.enabled) clearActive();

    db.prepare(
      `INSERT INTO providers
         (id, name, type, base_url, api_key_enc, api_key_hint, enabled, priority,
          egress_proxy, health_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`,
    ).run(
      id,
      name,
      input.type,
      baseUrl,
      hasKey ? encrypt(key) : null,
      hasKey ? keyHint(key) : null,
      input.enabled ?? false,
      input.priority ?? 100,
      egressProxy,
      now,
      now,
    );

    return requireProvider(id);
  })();
}

export interface UpdateProviderInput {
  name?: string;
  baseUrl?: string;
  priority?: number;
  /**
   * Tri-state on purpose:
   *   undefined — leave the stored key untouched (the usual case, since the
   *               frontend never receives it and so cannot echo it back)
   *   ''/null   — remove the key
   *   string    — replace it
   */
  apiKey?: string | null;
  /** Same tri-state as `apiKey`: undefined leaves it, null/'' removes it. */
  egressProxy?: string | null;
}

export function updateProvider(id: string, input: UpdateProviderInput): ProviderRecord {
  const db = getDb();
  const existing = requireProvider(id);

  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name === '') throw new AppError('bad_request', 'Provider name cannot be empty');
    const clash = findProviderByName(name);
    if (clash && clash.id !== id) {
      throw new AppError('conflict', `A provider named "${name}" already exists`);
    }
    sets.push('name = ?');
    values.push(name);
  }

  if (input.baseUrl !== undefined) {
    sets.push('base_url = ?');
    // A provider's type is immutable after creation, so the stored one is the
    // right lens to normalize an edited URL through.
    values.push(normalizeBaseUrl(input.baseUrl, existing.type));
  }

  if (input.priority !== undefined) {
    sets.push('priority = ?');
    values.push(input.priority);
  }

  if (input.apiKey !== undefined) {
    const key = input.apiKey?.trim() ?? '';
    if (key === '') {
      sets.push('api_key_enc = NULL', 'api_key_hint = NULL');
    } else {
      sets.push('api_key_enc = ?', 'api_key_hint = ?');
      values.push(encrypt(key), keyHint(key));
    }
  }

  if (input.egressProxy !== undefined) {
    const proxy = parseEgressProxy(input.egressProxy);
    sets.push('egress_proxy = ?');
    values.push(proxy?.url ?? null);
  }

  if (sets.length === 0) return existing;

  // A changed base URL or key invalidates both the model cache and the recorded
  // health verdict — the old evidence describes a different endpoint.
  const endpointChanged =
    input.baseUrl !== undefined || input.apiKey !== undefined || input.egressProxy !== undefined;
  if (endpointChanged) {
    sets.push('models_json = NULL', 'models_fetched_at = NULL', 'models_error = NULL');
    sets.push("health_status = 'unknown'", 'last_error = NULL', 'last_error_at = NULL');
  }

  sets.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  db.prepare(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return requireProvider(id);
}

// --- zero data retention (Part 1.26) ---------------------------------------

export interface SetProviderZdrInput {
  support: ZdrSupport;
  /**
   * Tri-state, like `apiKey` above:
   *   undefined — leave the stored flag alone
   *   null      — remove it
   *   object    — replace it
   */
  requestFlag?: ZdrRequestFlag | null;
  /**
   * The user attesting, in person, that they have verified this. `false` retracts
   * a previous attestation. Omitted leaves an existing one in place, so recording
   * a new support value does not silently drop the confirmation.
   */
  confirmed?: boolean;
  /** Free text kept with the attestation. Meaningless without `confirmed`. */
  note?: string | null;
}

/**
 * Record what is known about a provider's retention behaviour.
 *
 * Three rules are enforced here and nowhere else.
 *
 * **A flag value that looks like a credential is refused, and the error does not
 * echo it.** The field is a policy declaration (`"true"`, `"strict"`), it is
 * returned in plaintext by `toPublic()`, and a user who pasted a key into it
 * would be publishing that key to every client and every log that records a
 * provider response. The refusal names the rule that matched, never the text —
 * the same discipline that keeps matched spans out of `redaction_flagged.details`.
 *
 * **`confirmed: false` clears the date and the note together.** A note without a
 * date is an assertion with nothing standing behind it, and it would still be
 * displayed; retracting has to retract the whole thing.
 *
 * **`zdr_confirmed_at` is only ever set from an explicit `confirmed: true`.**
 * Nothing about a successful request may write it. See `services/safety/zdr.ts`:
 * a request that was accepted proves the flag was accepted, not that anything was
 * discarded.
 *
 * Unlike `updateProvider`, this deliberately does **not** invalidate the model
 * cache or the health verdict. Retention policy describes what the provider does
 * with the request, not where the request goes — the cached evidence still
 * describes the same endpoint.
 */
export function setProviderZdr(id: string, input: SetProviderZdrInput): ProviderRecord {
  const existing = requireProvider(id);

  if (!isZdrSupport(input.support)) {
    throw new AppError('bad_request', `"${String(input.support)}" is not a known ZDR support value.`, {
      details: { field: 'support' },
    });
  }

  const sets: string[] = ['zdr_support = ?'];
  const values: (string | number | null)[] = [input.support];

  if (input.requestFlag !== undefined) {
    if (input.requestFlag === null) {
      sets.push('zdr_flag_location = NULL', 'zdr_flag_key = NULL', 'zdr_flag_value = NULL');
    } else {
      const { location, key, value } = input.requestFlag;
      if (!isZdrFlagLocation(location)) {
        throw new AppError('bad_request', 'requestFlag.location must be "header" or "body".', {
          details: { field: 'requestFlag.location' },
        });
      }
      if (key.trim() === '') {
        throw new AppError('bad_request', 'requestFlag.key must not be empty.', {
          details: { field: 'requestFlag.key' },
        });
      }
      if (value.trim() === '') {
        throw new AppError('bad_request', 'requestFlag.value must not be empty.', {
          details: { field: 'requestFlag.value' },
        });
      }

      const findings = findSensitive(value);
      if (findings.length > 0) {
        throw new AppError(
          'bad_request',
          'requestFlag.value looks like a credential. This field is a retention policy ' +
            'declaration — it is stored and returned in plaintext — so it must never hold a key, ' +
            'token or password. Put the credential in the provider\'s API key field instead.',
          {
            // The kinds that matched, never the value: an error body that quoted
            // it would publish the thing being protected.
            details: { field: 'requestFlag.value', kinds: [...new Set(findings.map((f) => f.kind))] },
          },
        );
      }

      sets.push('zdr_flag_location = ?', 'zdr_flag_key = ?', 'zdr_flag_value = ?');
      values.push(location, key.trim(), value.trim());
    }
  }

  if (input.confirmed === true) {
    sets.push('zdr_confirmed_at = ?', 'zdr_confirmed_note = ?');
    values.push(Date.now(), input.note?.trim() === '' ? null : input.note ?? null);
  } else if (input.confirmed === false) {
    sets.push('zdr_confirmed_at = NULL', 'zdr_confirmed_note = NULL');
  } else if (input.note !== undefined && existing.zdr.confirmedAt !== null) {
    // A note may be edited on its own, but only while an attestation exists to
    // attach it to. Writing one without a date would display an unbacked claim.
    sets.push('zdr_confirmed_note = ?');
    values.push(input.note?.trim() === '' ? null : input.note ?? null);
  }

  sets.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  getDb().prepare(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return requireProvider(id);
}

export function deleteProvider(id: string): void {
  const result = getDb().prepare('DELETE FROM providers WHERE id = ?').run(id);
  if (result.changes === 0) {
    throw new AppError('not_found', `No provider with id "${id}"`);
  }
}

function clearActive(): void {
  getDb()
    .prepare('UPDATE providers SET enabled = 0, updated_at = ? WHERE enabled = 1')
    .run(Date.now());
}

/**
 * Enable one provider, putting the previously active one on standby.
 *
 * Order matters: the disable must land before the enable or the partial unique
 * index on `enabled = 1` rejects the write. Both happen in one transaction, so
 * there is no instant where zero or two providers are active.
 */
export function enableProvider(id: string): ProviderRecord {
  const db = getDb();
  return db.transaction(() => {
    const provider = requireProvider(id);
    if (provider.enabled) return provider;

    clearActive();
    db.prepare('UPDATE providers SET enabled = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
    return requireProvider(id);
  })();
}

/** Disable without electing a replacement; leaves the app with no active provider. */
export function disableProvider(id: string): ProviderRecord {
  getDb()
    .prepare('UPDATE providers SET enabled = 0, updated_at = ? WHERE id = ?')
    .run(Date.now(), id);
  return requireProvider(id);
}

// --- health & model cache persistence -------------------------------------

export function recordHealth(
  id: string,
  status: HealthStatus,
  error?: { message: string } | null,
): void {
  const now = Date.now();
  if (status === 'healthy') {
    getDb()
      .prepare(
        `UPDATE providers
         SET health_status = 'healthy', last_success_at = ?, last_error = NULL,
             last_error_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, id);
    return;
  }

  getDb()
    .prepare(
      `UPDATE providers
       SET health_status = ?, last_error = ?, last_error_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(status, error?.message ?? null, now, now, id);
}

export function saveModelCache(id: string, models: ModelInfo[]): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE providers
       SET models_json = ?, models_fetched_at = ?, models_error = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .run(JSON.stringify(models), now, now, id);
}

export function saveModelCacheError(id: string, message: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE providers SET models_error = ?, models_fetched_at = ?, updated_at = ? WHERE id = ?`,
    )
    .run(message, now, now, id);
}

// --- helpers ---------------------------------------------------------------

/**
 * Provider types that speak the OpenAI-compatible wire protocol, where the base
 * URL conventionally already ends in `/v1` because the client appends
 * `/chat/completions` to it.
 *
 * An explicit allowlist rather than an exclusion check: an Anthropic-native
 * endpoint takes a plain host and appends `/v1/messages` itself, and Ollama's
 * local API lives under `/api/...` with no `/v1` anywhere. Both would break if
 * `/v1` were bolted on. Anything not named here is stored exactly as the user
 * typed it, so adding a provider type is inert until someone lists it.
 */
const OPENAI_COMPATIBLE_TYPES: readonly ProviderType[] = ['remote'];

/**
 * Normalize and sanity-check a base URL.
 *
 * Trailing slashes are stripped so the adapters' path joining is predictable,
 * and a non-HTTP scheme is rejected early rather than surfacing later as an
 * unhelpful fetch failure.
 *
 * For OpenAI-compatible providers a missing `/v1` is filled in. This is the
 * single choke point every stored base URL passes through, at write time, so
 * what is in the database is already normalized and the settings view shows the
 * URL that will actually be called. `type` is optional so that callers who only
 * want the validation (and no rewriting) can omit it.
 */
export function normalizeBaseUrl(raw: string, type?: ProviderType): string {
  const trimmed = raw.trim();
  if (trimmed === '') throw new AppError('bad_request', 'Base URL is required');

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError('bad_request', `"${raw}" is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('bad_request', 'Base URL must use http or https');
  }

  const stripped = trimmed.replace(/\/+$/, '');
  if (type === undefined || !OPENAI_COMPATIBLE_TYPES.includes(type)) return stripped;

  // Only a bare host gets `/v1` appended. Pasting "https://ollama.com" is the
  // mistake this fixes, and such a URL is unusable without it. A URL that
  // already carries a path is left alone: the user may legitimately be on
  // "https://host/openai" or "https://openrouter.ai/api/v1", and guessing at
  // those would break working configurations in order to fix a typo.
  if (parsed.pathname !== '' && parsed.pathname !== '/') return stripped;

  // Built from the origin rather than concatenated onto the input, so a
  // trailing slash can never produce "https://host//v1".
  return `${parsed.origin}/v1`;
}
