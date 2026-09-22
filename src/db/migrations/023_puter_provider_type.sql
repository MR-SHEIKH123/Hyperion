-- ---------------------------------------------------------------------------
-- 023 — add 'puter' as a fifth provider type (1.38).
--
-- Puter (puter.com) serves an OpenAI-compatible chat-completions API, so this
-- needs no new adapter: `adapterFor` maps the type onto the `openai` adapter
-- exactly as `colibri` does. What makes it its own type is the *credential*.
-- Every other type here is configured with a vendor API key issued by the same
-- company that runs the endpoint; Puter is configured with an **auth token** —
-- the short-lived token a browser session on puter.com already holds — which
-- means two things this row has to say to every layer that reads it:
--
--   * It is a credential like any other: stored encrypted, hinted, never
--     returned, and it is not an API key, so nothing may assume the `sk-`
--     shape (the hint is taken from whatever the user pasted).
--   * It can be short-lived. A token that has expired is an *authentication*
--     failure (401), which 1.36's cooldown table already treats as "do not keep
--     retrying the same dead credential" — 60 minutes for a `auth` class — and
--     which the settings surface reports as a configuration problem rather than
--     as a provider outage. That is the right behaviour for a token that has to
--     be re-pasted, and it is why this type is documented rather than special
--     cased: nothing here bypasses the health or cooldown rules.
--
-- Puter is **remote**, always: a hosted service, classified by type, so the
-- credential scan runs on everything sent to it and the exposure summary counts
-- its traffic as having left the machine (see `classifyProviderType`).
--
-- Registered manually only, and never auto-enabled: `detectAndRegisterLocal`
-- stays exclusive to type 'local' (Ollama).
--
-- Why a table rebuild: `providers.type` carries a CHECK constraint and SQLite
-- cannot alter a CHECK in place.
--
-- Why the column list is written out in full rather than `SELECT *`: this table
-- has been extended by four migrations since 005 (016's ZDR facts, 017's context
-- window, 022's egress proxy), and a rebuild that copied the columns of an
-- older shape would silently drop the newer ones. The explicit list is what
-- makes that a visible omission instead of data loss.
--
-- Why the build order below matters — the same trap 002 and 005 document. Five
-- child tables carry `REFERENCES providers`: chats, messages, chat_runs,
-- usage_log (ON DELETE SET NULL) and model_prices (ON DELETE CASCADE). SQLite
-- rewrites a child's REFERENCES clause whenever the parent it names is renamed,
-- and that rewriting is NOT suppressed by `PRAGMA foreign_keys = OFF`. So
-- renaming `providers` out of the way first would silently repoint all five
-- children at `providers_old` and leave them dangling once it was dropped.
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
  -- 'puter'     = Puter's OpenAI-compatible endpoint (see 1.38 below)
  type          TEXT NOT NULL CHECK (type IN ('remote', 'local', 'opencodex', 'colibri', 'puter')),
  base_url      TEXT NOT NULL,

  -- Encrypted at rest. NULL for local runners, which need no credential.
  -- opencodex only needs one when OPENCODEX_API_AUTH_TOKEN is set, which it
  -- is not for a loopback bind. Colibrì likewise needs none unless COLI_API_KEY
  -- is set, and accepts any dummy value when a client insists on sending one.
  -- Puter's credential is an *auth token* rather than a vendor key, and it is
  -- stored here like any other secret: encrypted, hinted, never returned.
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
  updated_at    INTEGER NOT NULL,

  -- Zero-data-retention facts (016), recorded by the user and never inferred.
  zdr_support TEXT NOT NULL DEFAULT 'unknown',
  zdr_flag_location TEXT,
  zdr_flag_key TEXT,
  zdr_flag_value TEXT,
  zdr_confirmed_at INTEGER,
  zdr_confirmed_note TEXT,

  -- Window the provider's own docs claim, used by the context budget (017).
  max_context_tokens INTEGER,

  -- The per-provider egress proxy (022). Dial URL, credentials included; every
  -- read path redacts it in `toPublic`.
  egress_proxy TEXT
);

INSERT INTO providers_new (
  id,
  name,
  type,
  base_url,
  api_key_enc,
  api_key_hint,
  enabled,
  priority,
  health_status,
  last_error,
  last_error_at,
  last_success_at,
  models_json,
  models_fetched_at,
  models_error,
  created_at,
  updated_at,
  zdr_support,
  zdr_flag_location,
  zdr_flag_key,
  zdr_flag_value,
  zdr_confirmed_at,
  zdr_confirmed_note,
  max_context_tokens,
  egress_proxy
)
SELECT
  id,
  name,
  type,
  base_url,
  api_key_enc,
  api_key_hint,
  enabled,
  priority,
  health_status,
  last_error,
  last_error_at,
  last_success_at,
  models_json,
  models_fetched_at,
  models_error,
  created_at,
  updated_at,
  zdr_support,
  zdr_flag_location,
  zdr_flag_key,
  zdr_flag_value,
  zdr_confirmed_at,
  zdr_confirmed_note,
  max_context_tokens,
  egress_proxy
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
