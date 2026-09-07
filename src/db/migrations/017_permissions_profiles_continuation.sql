-- ---------------------------------------------------------------------------
-- 017 — the permission engine, agent profiles, and task-run continuation
--       (Prompts 1.27 + 1.28).
--
-- Three separate capabilities land in one migration because they are one
-- change: a permission verdict of `ask` is only useful if the run it stops can
-- be continued, and a run can only be continued if something durable holds the
-- conversation it was in the middle of.
--
-- ## task_steps is rebuilt, not altered
--
-- `kind` carries a CHECK and SQLite cannot alter one in place. Two new kinds
-- arrive here (`approval`, `turn`) and more will follow, so the CHECK goes
-- rather than being widened: 016's header already set the precedent for a
-- descriptive column — a CHECK "would mean a table rebuild every time it does"
-- widen. The TypeScript union in `services/agent/loop.ts` is the definition.
-- With the CHECK gone this is the last time this table needs rebuilding.
--
-- The `mode` CHECK stays. `mode` is not descriptive: the UI maps its three
-- values onto a control, and a profile name is a different fact, so it gets its
-- own `profile` column rather than being smuggled into `mode` as free text.
--
-- The procedure is mandated by `db/migrate.ts:115-120`, not merely conventional:
-- never `ALTER TABLE task_steps RENAME TO task_steps_old`, because that rewrites
-- every child's `REFERENCES task_steps` clause and only `legacy_alter_table`
-- suppresses it. Build `task_steps_new`, copy with explicit column lists on both
-- sides, drop the original, rename into place. task_steps has no secondary
-- indexes — 014 explains why the primary key's own index is the only one — so
-- none are dropped or recreated here.
--
-- `ON DELETE CASCADE` on `run_id` is reproduced verbatim and is load-bearing in
-- a way `PRAGMA foreign_key_check` cannot verify: a rebuilt table without it is
-- perfectly valid schema. Per 014's header, that clause is what makes
-- `startTaskRun`'s `INSERT OR REPLACE` clear a superseded attempt's steps —
-- "a property of two separate pieces of code agreeing", with nothing in
-- `startTaskRun` saying so. The migration test is the only guard against
-- silently losing it.
--
-- New step columns:
--
--   profile            which agent profile was in force. Null for a step taken
--                      before profiles existed, or by an agent that runs none.
--   provenance         which permission layer and pattern allowed or refused
--                      the call, so the trust decision is auditable after the
--                      fact rather than only observable live.
--   reasoning_tokens   accounting some providers report separately from
--   cache_read_tokens  completion tokens. Nullable for the same reason
--   cache_write_tokens `tokens_in`/`tokens_out` are: a missing count must stay
--                      distinguishable from a genuine zero, or a sum over them
--                      reads as complete when it is not.
--
-- ## usage_log gains plain nullable columns
--
-- No NOT NULL, no CHECK, no default — 016's header gives the reason and it has
-- not changed: `recordUsage` swallows its own errors so a failure to log spend
-- cannot fail the request that produced it. A NOT NULL column would convert a
-- missing value into a silently discarded spend row, which is the cap bypass
-- `test/temporarychats.test.ts` exists to close.
--
-- `task_id` is what makes a subagent's spend attributable to the task that
-- delegated it. Without it, descendant cost is only ever visible against a
-- chat, and a task that spawned five children looks as cheap as one that
-- spawned none.
--
-- ## The three new tables
--
-- `pending_approvals` is the durable half of an `ask` verdict. The state column
-- carries a CHECK because it is a lifecycle, not a description: five values,
-- each with behaviour attached, and a sixth would be a design change rather
-- than a widening.
--
-- `task_messages` holds the verbatim conversation at a stopping point so a
-- parked run has something to continue from. It has **no foreign key**, which
-- follows 015 verbatim: scheduled/headless work may have no run row, and
-- `task_runs` uses `INSERT OR REPLACE` when an attempt restarts, so a cascading
-- relation would erase the snapshot during exactly the replacement it needs to
-- survive. The primary key is `(task_id, seq)` for the same reason 014's is
-- `(run_id, step)`: the ordinal is the identity, nothing will ever reference one
-- message, and the key's index already serves the only read there is.
--
-- These rows are stored unredacted, because redacting them would corrupt the
-- replay they exist for — a continuation must resume believing exactly what it
-- read. That makes the retention window the control instead: a snapshot exists
-- only between a park and its continuation or terminal state, deletion on the
-- terminal transition is a tested property rather than housekeeping, and
-- `exportBackup` strips the table from the temp copy it archives.
--
-- `context_handoffs` records a handoff that happened. It is an audit row and an
-- idempotency key, written by the endpoint that performs the handoff rather
-- than by the loop — the loop only emits the warning, and most warnings are
-- dismissed, so pre-computing a summary for each one would pay for an LLM call
-- nobody asked for.
-- ---------------------------------------------------------------------------

CREATE TABLE task_steps_new (
  run_id              TEXT NOT NULL REFERENCES task_runs (run_id) ON DELETE CASCADE,
  step                INTEGER NOT NULL,
  mode                TEXT CHECK (mode IS NULL OR mode IN ('ask', 'plan', 'act')),
  -- No CHECK: see the header. The TypeScript union is the definition.
  kind                TEXT NOT NULL,
  profile             TEXT,
  provenance          TEXT,
  tool_name           TEXT,
  ok                  INTEGER CHECK (ok IS NULL OR ok IN (0, 1)),
  detail              TEXT,
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  reasoning_tokens    INTEGER,
  cache_read_tokens   INTEGER,
  cache_write_tokens  INTEGER,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

  PRIMARY KEY (run_id, step)
);

-- Explicit column lists on both sides: SELECT * would silently bind by
-- position if the column order ever drifted.
INSERT INTO task_steps_new (
  run_id, step, mode, kind, tool_name, ok, detail, tokens_in, tokens_out, created_at
)
SELECT
  run_id, step, mode, kind, tool_name, ok, detail, tokens_in, tokens_out, created_at
FROM task_steps;

DROP TABLE task_steps;

ALTER TABLE task_steps_new RENAME TO task_steps;

ALTER TABLE usage_log ADD COLUMN task_id TEXT;
ALTER TABLE usage_log ADD COLUMN reasoning_tokens INTEGER;
ALTER TABLE usage_log ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE usage_log ADD COLUMN cache_write_tokens INTEGER;

-- Cost roll-up for one task reads every row it and its descendants produced,
-- which is a plain equality lookup rather than a time range.
CREATE INDEX idx_usage_task ON usage_log (task_id);

-- A fork is a new chat that remembers where it came from. ON DELETE SET NULL
-- rather than CASCADE: deleting the original conversation must not delete the
-- branch someone kept working in.
ALTER TABLE chats ADD COLUMN forked_from TEXT REFERENCES chats (id) ON DELETE SET NULL;
ALTER TABLE chats ADD COLUMN forked_at_message_id TEXT;

-- The user's own knowledge of a model's window, which outranks whatever the
-- provider reports. Nullable: absent means "nothing recorded", which is a
-- different fact from a recorded small window.
ALTER TABLE providers ADD COLUMN max_context_tokens INTEGER;

CREATE TABLE pending_approvals (
  id               TEXT PRIMARY KEY,
  -- Correlation only, and nullable for the same reason 015's parent_run_id is:
  -- an unattended run may park without an interactive run row. No foreign key,
  -- because task_runs is INSERT OR REPLACE on retry.
  run_id           TEXT,
  task_id          TEXT NOT NULL,
  tool             TEXT NOT NULL,
  -- The wire name the model actually asked for, e.g. `wigolo.search`.
  tool_name        TEXT NOT NULL,
  -- Verbatim JSON arguments, so continuing replays the identical call rather
  -- than a re-serialized approximation of it.
  arguments        TEXT NOT NULL,
  -- The derived permission key the verdict was reached under, e.g.
  -- `wigolo_search`. Stored alongside `tool_name` because the mapping is
  -- derived and a future change to the derivation must not silently rewrite
  -- history.
  permission_key   TEXT NOT NULL,
  matched_pattern  TEXT,
  matched_layer    TEXT,
  reason           TEXT,
  state            TEXT NOT NULL CHECK (state IN
                     ('pending', 'allow_once', 'allow_session', 'denied', 'expired')),
  created_at       INTEGER NOT NULL,
  resolved_at      INTEGER
);

-- Both reads are "this task's approvals in this state": the pending list for
-- the UI, and the session allow-list the permission engine consults per call.
CREATE INDEX idx_pending_approvals_task ON pending_approvals (task_id, state);

CREATE TABLE task_messages (
  task_id       TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL,
  -- JSON array, set only on an assistant turn that requested tools.
  tool_calls    TEXT,
  -- Required on a `tool` message; identifies the call being answered. Without
  -- this pairing a provider rejects the replayed conversation outright.
  tool_call_id  TEXT,
  name          TEXT,
  created_at    INTEGER NOT NULL,

  PRIMARY KEY (task_id, seq)
);

CREATE TABLE context_handoffs (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  from_chat_id      TEXT,
  to_chat_id        TEXT,
  run_id            TEXT,
  tool              TEXT NOT NULL,
  summary           TEXT NOT NULL,
  -- JSON: the deterministic half — goal, pending steps, changed files,
  -- artifact versions, diff stat. Kept separately from `summary` so a handoff
  -- whose LLM section failed is still machine-readable.
  structured        TEXT,
  tokens_at_handoff INTEGER,
  window_tokens     INTEGER,
  -- Whether the prose section was written by a model or omitted. An LLM failure
  -- must degrade the summary, never fail the handoff, so this records which
  -- happened instead of leaving the two indistinguishable.
  summary_source    TEXT NOT NULL CHECK (summary_source IN ('structured', 'structured_plus_llm')),
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_context_handoffs_task ON context_handoffs (task_id, created_at DESC);
