-- ---------------------------------------------------------------------------
-- 003 — per-skill dependency provisioning status.
--
-- Intake told us a skill was *parseable* and *scanned*; it never told us the
-- skill could actually run. These columns record the outcome of provisioning a
-- skill's declared dependencies into its own isolated environment, so the
-- agentic layer can check "can this skill's scripts run?" before it tries, and
-- so the frontend can say "pandas failed to install: <error>" instead of
-- failing generically halfway through a task.
--
-- Why plain ADD COLUMN and not a table rebuild: `skills` carries no CHECK
-- constraint that needs widening and no child table references it, so the
-- rebuild dance in 002 is unnecessary here. Every column added below is either
-- nullable or has a default, which is what lets SQLite add them in place
-- without rewriting existing rows.
--
-- deps_status is deliberately limited to four values, matching the contract the
-- API exposes. Two states that look like they belong here are *derived* at read
-- time instead and are intentionally NOT stored:
--
--   * "installing" — lives in memory in deps.ts, because a status that outlives
--     the process that set it would be a lie after a crash or restart.
--   * "stale" — computed by re-hashing the manifests on disk and comparing with
--     deps_fingerprint. Storing it would mean writing to every skill row every
--     time a file changed underneath us, which nothing is watching for.
--
-- Existing rows default to 'none-declared' with a NULL fingerprint. That is not
-- a claim that they declare nothing: a NULL fingerprint never matches a real
-- one, so any pre-existing skill that *does* have a manifest is reported stale
-- on its next read and re-provisions on demand.
-- ---------------------------------------------------------------------------

-- 'none-declared' — no manifest, or a manifest declaring nothing. Runnable.
-- 'ready'         — everything declared installed successfully.
-- 'partial'       — some installed, some failed; deps_json lists which.
-- 'failed'        — provisioning errored; deps_error carries the real message.
ALTER TABLE skills ADD COLUMN deps_status TEXT NOT NULL DEFAULT 'none-declared'
  CHECK (deps_status IN ('none-declared', 'ready', 'partial', 'failed'));

-- The detail behind the status: ecosystems, the manifests we read, what was
-- declared, what installed, and per-package failure reasons. JSON rather than
-- columns because it is read whole and never queried by field.
ALTER TABLE skills ADD COLUMN deps_json TEXT;

-- The one-line reason a 'failed' status failed (missing interpreter, a timeout,
-- the tail of pip's output). Surfaced verbatim so the user can act on it —
-- many of these are fixable locally.
ALTER TABLE skills ADD COLUMN deps_error TEXT;

-- sha256 over the skill's manifest paths + contents at provisioning time.
-- Provisioning is cached against this so it runs once per skill rather than on
-- every use, and re-runs exactly when the skill's declared dependencies change.
ALTER TABLE skills ADD COLUMN deps_fingerprint TEXT;

-- When provisioning last completed (any outcome).
ALTER TABLE skills ADD COLUMN deps_provisioned_at INTEGER;

-- Path to the skill's own virtualenv interpreter, relative to the skills scope
-- root. Relative, like rel_path, so the row survives the app directory moving.
-- This is the interpreter a skill's Python scripts must be run with — the app's
-- own environment has none of the skill's packages in it, by design.
ALTER TABLE skills ADD COLUMN deps_python_path TEXT;

-- Path to the skill's own node_modules, relative to the skills scope root.
-- Scoped to the skill so one skill's dependency version cannot collide with
-- another's, or with the app's.
ALTER TABLE skills ADD COLUMN deps_node_modules_path TEXT;
