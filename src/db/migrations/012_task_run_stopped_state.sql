-- ---------------------------------------------------------------------------
-- 012 — add 'stopped' as a task run state (Part 1.19).
--
-- A run that hits its token or iteration ceiling has not failed and is not
-- resumable, and the existing vocabulary has no word for that:
--
--   'error'  would be wrong. Nothing broke. The run did exactly what it was
--            told to do and stopped at the limit the user set. Reporting it as
--            an error trains the user to ignore errors.
--
--   'paused' would be worse. `paused` promises a resume, and 010's own comment
--            makes the point that claiming a run is resumable when it is not
--            "is the same lie in a different shape". Resuming a ceiling-capped
--            run would re-hit the ceiling immediately, so the promise is empty
--            until the user raises the limit.
--
--   'stopped' says the true thing: it ended early, on purpose, at a boundary
--            the user configured. The reason rides in `pause_reason`
--            ('ceiling_reached'), and whatever partial work was produced has
--            already been saved by the agent before this is written.
--
-- 'stopped' is terminal, so finishTaskRun stamps completed_at for it. Note the
-- deliberate consequence: `reconcileOrphanedTaskRuns` still only demotes rows
-- left in 'running', so a stopped run survives a restart untouched.
--
-- Why a table rebuild: task_runs.state carries a CHECK constraint and SQLite
-- cannot alter a CHECK in place. Same procedure 010 documents — build
-- task_runs_new, copy rows, DROP the original, rename, then recreate the
-- indexes, whose names are global and belong to the table they were built on.
-- No other table references task_runs, so no child REFERENCES clause moves.
-- ---------------------------------------------------------------------------

CREATE TABLE task_runs_new (
  run_id         TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  tool           TEXT NOT NULL CHECK (tool IN ('code', 'cowork', 'design')),
  chat_id        TEXT REFERENCES chats (id) ON DELETE SET NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('running', 'paused', 'complete', 'error', 'blocked', 'ready_for_review', 'stopped')),
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

DROP INDEX idx_task_runs_state;
DROP INDEX idx_task_runs_task_id;
DROP INDEX idx_task_runs_tool;

DROP TABLE task_runs;

ALTER TABLE task_runs_new RENAME TO task_runs;

CREATE INDEX idx_task_runs_state ON task_runs (state, started_at DESC);
CREATE INDEX idx_task_runs_task_id ON task_runs (task_id);
CREATE INDEX idx_task_runs_tool ON task_runs (tool, started_at DESC);
