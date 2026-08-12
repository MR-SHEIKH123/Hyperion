-- ---------------------------------------------------------------------------
-- 009 — add 'needs-user-approval' as a fifth skill dependency status.
--
-- Some skills need a *system* binary rather than a package: ffmpeg, pandoc,
-- imagemagick. Unlike a pip or npm dependency we cannot install one into an
-- isolated per-skill environment — it goes into the machine, via winget, choco,
-- brew or apt, and that is a decision only the user can make. So detection
-- parks the skill here and waits for a person.
--
-- Why this is not 'failed': nothing failed. 'failed' means provisioning ran and
-- errored, and it carries a message in deps_error the user is expected to act
-- on. A skill waiting for approval has a perfectly healthy environment and one
-- outstanding question. Collapsing the two would either nag the user about a
-- broken install that isn't broken, or hide a real failure behind a prompt.
-- Both statuses are non-runnable, and that shared consequence is exactly why
-- they need to stay distinguishable — the *reason* is what the UI shows.
--
-- The status is only reachable when a required binary is absent from PATH. A
-- skill whose binaries are already installed never enters it, so the common
-- case costs the user nothing.
--
-- Why a table rebuild: deps_status carries a CHECK constraint (added by 003)
-- and SQLite cannot alter a CHECK in place.
--
-- Why the build order below matters — the trap 002 and 005 both document.
-- `ALTER TABLE skills RENAME TO skills_old` would rewrite the REFERENCES clause
-- of any child table naming `skills`, and that rewriting is NOT suppressed by
-- `PRAGMA foreign_keys = OFF`. No table references `skills` today, so nothing
-- would actually break — but the safe order costs nothing and stops this file
-- becoming the template someone copies for a table that does have children.
-- So: build skills_new, copy across, DROP the original, rename into place.
--
-- Unlike 005 there is no index step. `skills` carries no explicit CREATE INDEX
-- in any migration; `name TEXT NOT NULL UNIQUE` is served by an implicit
-- autoindex, which belongs to the table definition and is rebuilt by the
-- CREATE TABLE below. Adding DROP INDEX statements here would fail on names
-- that were never created.
--
-- The DROP is only safe with foreign-key enforcement off. `PRAGMA foreign_keys`
-- is a no-op inside a transaction, which is where the runner executes this
-- file, so src/db/migrate.ts disables enforcement around the whole batch and
-- runs `PRAGMA foreign_key_check` afterwards to prove nothing dangles.
-- ---------------------------------------------------------------------------

CREATE TABLE skills_new (
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
  updated_at     INTEGER NOT NULL,

  -- --- dependency provisioning (added by 003) -------------------------------
  -- 'none-declared'       — no manifest, or a manifest declaring nothing. Runnable.
  -- 'ready'               — everything declared installed successfully.
  -- 'partial'             — some installed, some failed; deps_json lists which.
  -- 'failed'              — provisioning errored; deps_error carries the real message.
  -- 'needs-user-approval' — a required system binary is missing from PATH and
  --                         installing it needs the user's explicit go-ahead.
  deps_status TEXT NOT NULL DEFAULT 'none-declared'
    CHECK (deps_status IN ('none-declared', 'ready', 'partial', 'failed', 'needs-user-approval')),
  deps_json              TEXT,
  deps_error             TEXT,
  deps_fingerprint       TEXT,
  deps_provisioned_at    INTEGER,
  deps_python_path       TEXT,
  deps_node_modules_path TEXT
);

-- Explicit column list on both sides: SELECT * would silently bind by position
-- if the column order ever drifted. All 19 columns are named — 12 from 001 plus
-- the 7 that 003 added — because a rebuild that omits one drops that column's
-- data on every existing install, irreversibly.
INSERT INTO skills_new (
  id, name, description,
  source_type, source_ref, rel_path,
  token_enc, needs_credential,
  risk_flags_json, enabled,
  created_at, updated_at,
  deps_status, deps_json, deps_error, deps_fingerprint,
  deps_provisioned_at, deps_python_path, deps_node_modules_path
)
SELECT
  id, name, description,
  source_type, source_ref, rel_path,
  token_enc, needs_credential,
  risk_flags_json, enabled,
  created_at, updated_at,
  deps_status, deps_json, deps_error, deps_fingerprint,
  deps_provisioned_at, deps_python_path, deps_node_modules_path
FROM skills;

DROP TABLE skills;

ALTER TABLE skills_new RENAME TO skills;
