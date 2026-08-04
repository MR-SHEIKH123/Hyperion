-- ---------------------------------------------------------------------------
-- 005 — add 'colibri' as a fourth provider type.
--
-- Colibrì (`coli serve --port 8000 --model-id ...`) runs a large quantised
-- model on ordinary consumer hardware by streaming expert tensors from disk
-- instead of requiring them all in VRAM. It serves an OpenAI-compatible API:
-- GET /v1/models plus POST /v1/chat/completions, so unlike 'opencodex' it
-- needs no new adapter — it reuses the openai adapter verbatim.
--
-- To this app it is ONE ordinary provider: same single-active-provider rule,
-- same 2-failures-in-20s health rule, same failover order as any other.
--
-- Registered manually only. Nothing auto-detects or auto-enables it —
-- detectAndRegisterLocal() remains exclusive to type 'local' (Ollama).
--
-- No `port` column deliberately. base_url already carries the port, and a
-- second field holding the same fact is a second source of truth that can
-- disagree with the first. The probe endpoint suggests the documented default
-- (http://localhost:8000/v1) so the port rarely has to be typed at all.
--
-- Why a table rebuild: providers.type carries a CHECK constraint and SQLite
-- cannot alter a CHECK in place.
--
-- Why the build order below matters — the same trap 002 documents. Five child
-- tables carry `REFERENCES providers`: chats, messages, chat_runs, usage_log
-- (ON DELETE SET NULL) and model_prices (ON DELETE CASCADE). SQLite rewrites a
-- child's REFERENCES clause whenever the parent it names is renamed, and that
-- rewriting is NOT suppressed by `PRAGMA foreign_keys = OFF`. So renaming
-- `providers` out of the way first would silently repoint all five children at
-- `providers_old` and leave them dangling once it was dropped.
--
-- Instead this follows SQLite's documented schema-change procedure verbatim:
-- build providers_new, copy the rows across, DROP the original providers, then
-- rename providers_new INTO the original name. No child ever names
-- `providers_new`, so no REFERENCES clause is touched.
--
-- The DROP is only safe with foreign-key enforcement off, otherwise it would
-- fire all five referential actions. `PRAGMA foreign_keys` is a no-op inside a
-- transaction, which is where the runner executes this file, so the runner
-- (src/db/migrate.ts) disables enforcement around the whole batch and runs
-- `PRAGMA foreign_key_check` afterwards to prove nothing was left dangling.
-- ---------------------------------------------------------------------------

CREATE TABLE providers_new (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  -- 'remote'    = OpenAI-compatible gateway (key + base URL)
  -- 'local'     = auto-detected local runner (e.g. Ollama)
  -- 'opencodex' = local opencodex proxy; speaks the OpenAI *Responses* API
  --               (POST /v1/responses), NOT chat completions
  -- 'colibri'   = local Colibrì server; OpenAI chat-completions compatible
  --               (GET /v1/models + POST /v1/chat/completions)
  type          TEXT NOT NULL CHECK (type IN ('remote', 'local', 'opencodex', 'colibri')),
  base_url      TEXT NOT NULL,

  -- Encrypted at rest. NULL for local runners, which need no credential.
  -- opencodex only needs one when OPENCODEX_API_AUTH_TOKEN is set, which it
  -- is not for a loopback bind. Colibrì likewise needs none unless COLI_API_KEY
  -- is set, and accepts any dummy value when a client insists on sending one.
  api_key_enc   TEXT,
  -- Last 4 characters of the key, kept in cleartext purely so the UI can show
  -- "sk-...abcd" for identification without ever decrypting or transmitting
  -- the real key.
  api_key_hint  TEXT,

  -- Exactly one provider may be enabled at a time; enforced by the partial
  -- unique index below, not merely by application logic. A disabled provider
  -- is on standby (config retained), never deleted.
  enabled       INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),

  -- Failover order when the active provider is taken out of rotation.
  -- Lower runs first.
  priority      INTEGER NOT NULL DEFAULT 100,

  -- Runtime health, maintained by the health tracker.
  --   unknown   — no live request attempted yet
  --   healthy   — last request succeeded
  --   degraded  — has recent failures but below the threshold
  --   unhealthy — tripped the threshold; taken out of rotation
  health_status TEXT NOT NULL DEFAULT 'unknown'
                  CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'unhealthy')),
  last_error         TEXT,
  last_error_at      INTEGER,
  last_success_at    INTEGER,

  -- Cached live model list. Consulted for the *capability* check before a
  -- request is sent, so a model the provider does not offer costs zero
  -- upstream calls to discover.
  models_json        TEXT,
  models_fetched_at  INTEGER,
  models_error       TEXT,

  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Explicit column list on both sides: SELECT * would silently bind by position
-- if the column order ever drifted.
INSERT INTO providers_new (
  id, name, type, base_url,
  api_key_enc, api_key_hint,
  enabled, priority,
  health_status, last_error, last_error_at, last_success_at,
  models_json, models_fetched_at, models_error,
  created_at, updated_at
)
SELECT
  id, name, type, base_url,
  api_key_enc, api_key_hint,
  enabled, priority,
  health_status, last_error, last_error_at, last_success_at,
  models_json, models_fetched_at, models_error,
  created_at, updated_at
FROM providers;

-- Index names are global; these go with the table they were built on.
DROP INDEX idx_providers_single_enabled;
DROP INDEX idx_providers_priority;

DROP TABLE providers;

ALTER TABLE providers_new RENAME TO providers;

-- The single-active-provider invariant, enforced by the database.
CREATE UNIQUE INDEX idx_providers_single_enabled
  ON providers (enabled) WHERE enabled = 1;

CREATE INDEX idx_providers_priority ON providers (priority, id);
