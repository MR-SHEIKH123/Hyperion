-- ---------------------------------------------------------------------------
-- 015 — durable parent/child identity and outcome for delegated Code work.
--
-- A task step can say that delegation happened, but it cannot answer which
-- child ran, whether it finished after the stream disconnected, or what bounded
-- result the parent received. This table keeps that lifecycle without storing a
-- recursive transcript.
--
-- There is deliberately no foreign key to task_runs. Scheduled/headless work
-- may have no run row, and task_runs uses INSERT OR REPLACE when an attempt is
-- restarted. A cascading relation would erase the child history during that
-- replacement. Parent and child task identities are durable on their own;
-- parent_run_id is correlation metadata when an interactive run has one.
--
-- Depth is fixed to one because Phase 3 permits one delegation layer only. The
-- sequence is unique per parent task so persisted count and ordering cannot
-- disagree even after a reconnect.
-- ---------------------------------------------------------------------------

CREATE TABLE subagent_runs (
  id              TEXT PRIMARY KEY,
  parent_run_id   TEXT,
  parent_task_id  TEXT NOT NULL,
  child_task_id   TEXT NOT NULL UNIQUE,
  sequence        INTEGER NOT NULL CHECK (sequence > 0),
  depth           INTEGER NOT NULL CHECK (depth = 1),
  state           TEXT NOT NULL CHECK (state IN ('running', 'complete', 'error', 'stopped')),
  prompt          TEXT NOT NULL,
  summary         TEXT,
  error_code      TEXT,
  error_message   TEXT,
  started_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER,

  UNIQUE (parent_task_id, sequence)
);

CREATE INDEX idx_subagent_runs_parent
  ON subagent_runs (parent_task_id, sequence);
