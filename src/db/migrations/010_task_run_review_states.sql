-- ---------------------------------------------------------------------------
-- 010 — add 'blocked' and 'ready_for_review' as task run states.
--
-- The agent loop (Prompt 3) can reach two states the original vocabulary had
-- no word for:
--
--   blocked          — the run is waiting on something it cannot resolve
--                      alone: a confirmation, a missing dependency, an
--                      ambiguous instruction, or a pre-send redaction flag on
--                      an unattended run. Distinct from 'paused' (the user
--                      asked to pause) and from 'error' (something broke —
--                      nothing here broke, the run is waiting well).
--
--   ready_for_review — the work is complete and specifically wants the user's
--                      eyes on it, as opposed to a background/scheduled task
--                      that finished with nothing further needed. Distinct
--                      from 'complete' so the multi-task view can surface
--                      "come look at this" separately from "done, move on".
--
-- Both are written mid-run by the agent via updateTaskRunState(), not only at
-- the end — the whole point is the multi-task view reflecting reality while
-- the task is live, not just once it is done.
--
-- Why a table rebuild: task_runs.state carries a CHECK constraint and SQLite
-- cannot alter a CHECK in place. Same procedure 005 documents: build
-- task_runs_new, copy rows across, DROP the original, rename. task_runs has
-- exactly one child-side concern — its own chat_id REFERENCES chats(id) —
-- and no other table references task_runs, so no child REFERENCES clause is
-- touched by the rename. The runner (src/db/migrate.ts) disables foreign-key
-- enforcement around the batch and runs PRAGMA foreign_key_check afterwards.
-- ---------------------------------------------------------------------------

CREATE TABLE task_runs_new (
  run_id         TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  tool           TEXT NOT NULL CHECK (tool IN ('code', 'cowork', 'design')),
  chat_id        TEXT REFERENCES chats (id) ON DELETE SET NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('running', 'paused', 'complete', 'error', 'blocked', 'ready_for_review')),
  pause_reason   TEXT,
  error_code     TEXT,
  error_message  TEXT,
  started_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  completed_at   INTEGER
);

-- Explicit column list on both sides: SELECT * would silently bind by position
-- if the column order ever drifted.
INSERT INTO task_runs_new (
  run_id, task_id, tool, chat_id, state,
  pause_reason, error_code, error_message,
  started_at, updated_at, completed_at
)
SELECT
  run_id, task_id, tool, chat_id, state,
  pause_reason, error_code, error_message,
  started_at, updated_at, completed_at
FROM task_runs;

-- Index names are global; these go with the table they were built on.
DROP INDEX idx_task_runs_state;
DROP INDEX idx_task_runs_task_id;
DROP INDEX idx_task_runs_tool;

DROP TABLE task_runs;

ALTER TABLE task_runs_new RENAME TO task_runs;

CREATE INDEX idx_task_runs_state ON task_runs (state, started_at DESC);
CREATE INDEX idx_task_runs_task_id ON task_runs (task_id);
CREATE INDEX idx_task_runs_tool ON task_runs (tool, started_at DESC);
