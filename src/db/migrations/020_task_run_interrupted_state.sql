-- ---------------------------------------------------------------------------
-- 020 — add 'interrupted' as a task run state (Prompt 1, item 1.31).
--
-- Boot reconciliation demoted a run the server had left mid-flight to `error`
-- with `error_code = 'internal_error'` (see `reconcileOrphanedTaskRuns`). That
-- was the closest word the vocabulary had, and it is the wrong one:
--
--   'error'      prints a failure the work did not suffer. Nothing about the
--                task was broken — the process running it went away. 012 made
--                exactly this argument for 'stopped' ("reporting it as an error
--                trains the user to ignore errors") and it applies twice over
--                here, because this state arrives on every unclean shutdown.
--
--   'paused'     promises a resume, and a task run has none: the agent loop
--                that could continue it is gone, and a chat-style resume path
--                does not exist for Code/Cowork/Design. 012 rejected 'paused'
--                for the same reason.
--
--   'interrupted' says the third true thing: the run ended because something
--                outside it stopped the process. It is terminal — the work is
--                not coming back — and the cause still rides in `error_code`
--                ('internal_error') so a reader that only knows the old shape
--                loses nothing.
--
-- The distinguishing pair is deliberate: `error_code = 'internal_error'` with
-- `state = 'error'` is what a pre-020 row looks like, so history is not
-- rewritten, and readers that must keep showing those rows as interrupted (the
-- attention queue does) can still recognise them.
--
-- Why a table rebuild: `task_runs.state` carries a CHECK constraint and SQLite
-- cannot alter a CHECK in place. Same procedure 010 and 012 document — build
-- task_runs_new, copy rows with explicit column lists, DROP the original,
-- rename, then recreate the indexes, whose names are global and belong to the
-- table they were built on. `task_runs` has exactly one child-side concern —
-- its own `chat_id REFERENCES chats(id)` — and no other table references it, so
-- no child REFERENCES clause moves. The runner disables foreign-key enforcement
-- around the batch and runs `PRAGMA foreign_key_check` afterwards.
-- ---------------------------------------------------------------------------

CREATE TABLE task_runs_new (
  run_id         TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  tool           TEXT NOT NULL CHECK (tool IN ('code', 'cowork', 'design')),
  chat_id        TEXT REFERENCES chats (id) ON DELETE SET NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('running', 'paused', 'complete', 'error', 'blocked', 'ready_for_review', 'stopped', 'interrupted')),
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
