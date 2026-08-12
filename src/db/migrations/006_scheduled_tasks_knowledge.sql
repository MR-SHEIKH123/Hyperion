-- Cowork's standing reference library, its scheduled work, and the history of
-- what that work did.
--
-- Knowledge sources follow the `attachments` convention exactly: the row is
-- metadata and a path, the bytes live on disk under the scoped knowledge root.
-- What they deliberately do NOT share with attachments is the cleanup timer.
-- There is no `last_accessed_at` and no `pinned` column here because neither
-- would ever be read: a reference library is not a transient upload, so these
-- rows expire only when the user deletes them. Omitting the columns makes that
-- exemption structural rather than a rule someone has to remember.
CREATE TABLE knowledge_sources (
  id          TEXT PRIMARY KEY,
  -- Optional short user label. The filename is what it is; this is what the
  -- user calls it.
  label       TEXT,
  filename    TEXT NOT NULL,
  -- Relative to the knowledge root, POSIX separators, same as attachments —
  -- an absolute path would not survive a restore on another machine.
  rel_path    TEXT NOT NULL,
  mime_type   TEXT,
  bytes       INTEGER NOT NULL DEFAULT 0,
  sha256      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_knowledge_sources_created ON knowledge_sources (created_at DESC);


-- A recurring Cowork job.
--
-- `schedule` is deliberately not a cron expression. Two forms are accepted:
--
--   daily:HH:MM        every day at that local time
--   weekly:D:HH:MM     every week on day D (0 = Sunday) at that local time
--
-- Full cron buys generality nobody asked for and costs a parser plus a class of
-- schedules that are impossible to describe in the UI. Local time, not UTC,
-- because "every morning at 9" means the user's morning.
--
-- `model_id` is NOT NULL on purpose. A scheduled run happens while the user is
-- away, so there is no one to correct a guess — the model is chosen when the
-- schedule is created or not at all.
CREATE TABLE scheduled_tasks (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  schedule      TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  -- Which conversation the run belongs to. Optional: a schedule that exists on
  -- its own gets a stable synthetic id derived from the task.
  chat_id       TEXT,
  -- Working directory inside the projects scope. NULL means the scope root.
  cwd           TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_run_at   INTEGER,
  last_status   TEXT CHECK (last_status IN ('success', 'failed', 'skipped')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- The scheduler's own query: enabled rows, ordered by how long they have gone
-- unrun. Indexed because it runs every minute for the life of the process.
CREATE INDEX idx_scheduled_tasks_due ON scheduled_tasks (enabled, last_run_at);


-- One row per attempt, including the attempts that never got to run.
--
-- `skipped` is a first-class status rather than an absence of a row: a task that
-- came due while the app was busy and gave up waiting is a thing the user needs
-- to be able to see. Silence would look identical to the scheduler never having
-- fired at all.
CREATE TABLE scheduled_task_runs (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  status           TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'skipped')),
  -- Link to whatever the run produced, when it produced anything.
  artifact_key     TEXT,
  artifact_version INTEGER,
  summary          TEXT,
  error_code       TEXT,
  error_message    TEXT
);

CREATE INDEX idx_scheduled_task_runs_task ON scheduled_task_runs (task_id, started_at DESC);
