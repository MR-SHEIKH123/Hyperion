-- ---------------------------------------------------------------------------
-- AIStudio initial schema
--
-- Conventions:
--   * Timestamps are INTEGER unix epoch **milliseconds** (Date.now()), not
--     SQLite date strings — comparison and arithmetic stay trivial in JS.
--   * Booleans are INTEGER 0/1 (SQLite has no boolean type). The DB adapter
--     coerces JS true/false on the way in.
--   * Anything named *_enc holds AES-256-GCM ciphertext (security/keystore.ts).
--     Plaintext credentials are never stored in this database.
--   * Anything named *_json holds a JSON-encoded string.
-- ---------------------------------------------------------------------------

-- --- providers -------------------------------------------------------------

CREATE TABLE providers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  -- 'remote' = OpenAI-compatible gateway (key + base URL)
  -- 'local'  = auto-detected local runner (e.g. Ollama)
  type          TEXT NOT NULL CHECK (type IN ('remote', 'local')),
  base_url      TEXT NOT NULL,

  -- Encrypted at rest. NULL for local runners, which need no credential.
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

-- The single-active-provider invariant, enforced by the database.
CREATE UNIQUE INDEX idx_providers_single_enabled
  ON providers (enabled) WHERE enabled = 1;

CREATE INDEX idx_providers_priority ON providers (priority, id);

-- --- chats & messages ------------------------------------------------------

CREATE TABLE chats (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL DEFAULT 'New chat',
  -- Which sidebar tool owns this conversation: chat | code | cowork | design |
  -- playground. Each tool selects its model independently.
  tool           TEXT NOT NULL,

  -- Last model/provider used, so reopening a chat restores its selection.
  model_id       TEXT,
  provider_id    TEXT REFERENCES providers (id) ON DELETE SET NULL,

  -- Pinned chats are exempt from the auto-cleanup timer entirely.
  pinned         INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived       INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),

  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  -- Drives "delete chats not opened for 1 month". Distinct from updated_at:
  -- opening a chat without sending anything still counts as activity.
  last_opened_at INTEGER NOT NULL
);

CREATE INDEX idx_chats_tool_updated ON chats (tool, updated_at DESC);
CREATE INDEX idx_chats_cleanup ON chats (pinned, last_opened_at);

CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content      TEXT NOT NULL DEFAULT '',

  -- Recorded per message (not just per chat) because the model can change
  -- mid-conversation, and the cost dashboard attributes spend per message.
  tool         TEXT,
  model_id     TEXT,
  provider_id  TEXT REFERENCES providers (id) ON DELETE SET NULL,
  provider_name TEXT,

  -- A partial assistant reply interrupted by a provider failure is persisted
  -- with status 'paused' and kept verbatim — history is never rolled back or
  -- truncated on failure. That is the core pause-never-crash contract.
  status       TEXT NOT NULL DEFAULT 'complete'
                 CHECK (status IN ('streaming', 'paused', 'complete', 'error')),
  error_code   TEXT,
  error_message TEXT,

  tokens_in    INTEGER,
  tokens_out   INTEGER,

  -- Ordering within the chat. Explicit so reordering/branching stays possible
  -- without depending on timestamp collisions.
  seq          INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_messages_chat_seq ON messages (chat_id, seq);

-- --- chat run state machine ------------------------------------------------

-- The authority for pause/resume, deliberately persisted rather than held in
-- the SSE connection: a browser reload must be able to re-read "this chat is
-- paused, and why", and PM2 can restart the process mid-conversation.
CREATE TABLE chat_runs (
  id             TEXT PRIMARY KEY,
  chat_id        TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  tool           TEXT NOT NULL,

  state          TEXT NOT NULL
                   CHECK (state IN ('idle', 'running', 'paused', 'complete', 'error')),
  -- Why it paused, for the frontend banner:
  --   provider_failure | provider_switch | model_switch |
  --   no_healthy_provider | capability_mismatch | user_request
  pause_reason   TEXT,
  error_code     TEXT,
  error_message  TEXT,

  model_id       TEXT,
  provider_id    TEXT REFERENCES providers (id) ON DELETE SET NULL,

  -- The assistant message being written, so a resume appends to the same row
  -- instead of orphaning the partial text.
  message_id     TEXT REFERENCES messages (id) ON DELETE SET NULL,

  attempt        INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX idx_chat_runs_chat ON chat_runs (chat_id, created_at DESC);
CREATE INDEX idx_chat_runs_state ON chat_runs (state);

-- --- attachments / assets --------------------------------------------------

-- Metadata only. The bytes live on disk under ~/AIStudio/attachments/ — a
-- SQLite file bloated with blobs would make every backup slow and risk the
-- whole DB on corruption.
CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  chat_id       TEXT REFERENCES chats (id) ON DELETE SET NULL,
  message_id    TEXT REFERENCES messages (id) ON DELETE SET NULL,

  filename      TEXT NOT NULL,
  -- Relative to the attachments root, never absolute: keeps the DB portable
  -- across machines and restores, and keeps path traversal out of the data.
  rel_path      TEXT NOT NULL,
  mime_type     TEXT,
  bytes         INTEGER NOT NULL DEFAULT 0,
  sha256        TEXT,

  -- 'uploaded' by the user, or 'generated' by a tool (Design output, etc.)
  origin        TEXT NOT NULL DEFAULT 'uploaded'
                  CHECK (origin IN ('uploaded', 'generated')),
  tool          TEXT,

  -- Pinned assets are exempt from the 3-month cleanup timer entirely.
  pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),

  created_at    INTEGER NOT NULL,
  -- Drives "delete assets untouched for 3 months"; bumped on view/download.
  last_accessed_at INTEGER NOT NULL
);

CREATE INDEX idx_attachments_cleanup ON attachments (pinned, last_accessed_at);
CREATE INDEX idx_attachments_created ON attachments (created_at DESC);
CREATE INDEX idx_attachments_chat ON attachments (chat_id);

-- --- MCP servers -----------------------------------------------------------

-- Mirrors mcp_config.json (Cline's format). The file is the source of truth for
-- external tooling; this table is the queryable mirror plus test results.
-- Editing is update-by-name, never delete-and-recreate.
CREATE TABLE mcp_servers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL CHECK (type IN ('local', 'remote')),

  -- local/stdio transport
  command      TEXT,
  args_json    TEXT,
  env_json     TEXT,

  -- remote/URL transport
  url          TEXT,
  headers_json TEXT,
  token_enc    TEXT,

  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  -- Informational only. A failing test never blocks saving a config.
  last_test_status  TEXT CHECK (last_test_status IN ('ok', 'failed', 'unknown')),
  last_test_message TEXT,
  last_test_at      INTEGER,

  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,

  -- Each transport requires its own field; a local server without a command or
  -- a remote one without a URL is meaningless.
  CHECK ((type = 'local'  AND command IS NOT NULL)
      OR (type = 'remote' AND url     IS NOT NULL))
);

-- --- skills ----------------------------------------------------------------

CREATE TABLE skills (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  -- Both parsed from the skill's own SKILL.md rather than typed by the user.
  description    TEXT NOT NULL DEFAULT '',

  source_type    TEXT NOT NULL CHECK (source_type IN ('upload', 'url', 'builtin')),
  -- Original URL or uploaded filename, for provenance.
  source_ref     TEXT,
  -- Relative to the skills root.
  rel_path       TEXT NOT NULL,

  -- Optional per-skill credential, encrypted exactly like provider keys.
  token_enc      TEXT,
  -- Set when SKILL.md indicates the skill expects a credential, so the UI can
  -- prompt for it before finalizing.
  needs_credential INTEGER NOT NULL DEFAULT 0 CHECK (needs_credential IN (0, 1)),

  -- Heuristic risk-scan findings from intake, retained so the warning can be
  -- shown again later rather than only at registration time.
  risk_flags_json TEXT,

  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- --- artifact version history ---------------------------------------------

-- Snapshot stack powering undo in Code/Design/Cowork. This table is owned here;
-- the agentic loops that populate it live in the other layers.
CREATE TABLE artifact_versions (
  id           TEXT PRIMARY KEY,
  -- Stable identity of the thing being versioned (file path, design doc id...).
  artifact_key TEXT NOT NULL,
  tool         TEXT NOT NULL,

  -- Monotonic per artifact_key; version 1 is the state before the first edit,
  -- so the very first change is undoable.
  version      INTEGER NOT NULL,

  -- Small artifacts inline; large ones by file reference. Exactly one is set.
  content      TEXT,
  rel_path     TEXT,

  label        TEXT,
  bytes        INTEGER,
  sha256       TEXT,
  created_at   INTEGER NOT NULL,

  UNIQUE (artifact_key, version),
  CHECK (content IS NOT NULL OR rel_path IS NOT NULL)
);

CREATE INDEX idx_artifact_versions_key ON artifact_versions (artifact_key, version DESC);

-- --- usage / cost ----------------------------------------------------------

CREATE TABLE usage_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       TEXT REFERENCES chats (id) ON DELETE SET NULL,
  message_id    TEXT,

  tool          TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  -- provider_id may be nulled if the provider is later deleted, so the name is
  -- denormalized to keep historical cost reports readable.
  provider_id   TEXT REFERENCES providers (id) ON DELETE SET NULL,
  provider_name TEXT,

  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,

  -- NULL when no price is configured for the model. Deliberately not zero:
  -- "unpriced" and "free" are different facts and must not be summed together.
  cost_usd      REAL,

  status        TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error', 'partial')),
  duration_ms   INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_usage_created ON usage_log (created_at DESC);
CREATE INDEX idx_usage_tool ON usage_log (tool, created_at DESC);
CREATE INDEX idx_usage_provider ON usage_log (provider_id, created_at DESC);
CREATE INDEX idx_usage_model ON usage_log (model_id, created_at DESC);

-- Optional per-model pricing. Empty by default: model IDs are pulled live from
-- whichever provider is active, so there is no curated list to price up front,
-- and inventing numbers would make the dashboard confidently wrong.
CREATE TABLE model_prices (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id            TEXT NOT NULL,
  provider_id         TEXT REFERENCES providers (id) ON DELETE CASCADE,
  input_per_1m_usd    REAL NOT NULL DEFAULT 0,
  output_per_1m_usd   REAL NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL,
  UNIQUE (model_id, provider_id)
);

-- --- settings & housekeeping ----------------------------------------------

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Audit trail for the background cleanup job, so automatic deletions are
-- explainable after the fact instead of silent.
CREATE TABLE cleanup_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at        INTEGER NOT NULL,
  chats_deleted INTEGER NOT NULL DEFAULT 0,
  assets_deleted INTEGER NOT NULL DEFAULT 0,
  bytes_freed   INTEGER NOT NULL DEFAULT 0,
  dry_run       INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1)),
  detail_json   TEXT
);

-- --- seed ------------------------------------------------------------------

-- Theme is fixed to dark by design (no toggle); stored so the frontend has a
-- single source of truth to read rather than hardcoding it too.
INSERT INTO settings (key, value, updated_at) VALUES
  ('theme',                     'dark',  0),
  ('cost_tracking_enabled',     'true',  0),
  ('auto_resume_after_failover','true',  0),
  ('concurrency_mode',          'reject',0);
