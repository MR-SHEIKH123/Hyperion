-- Error log table for the debug console to query
CREATE TABLE error_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp         INTEGER NOT NULL,
  severity          TEXT NOT NULL CHECK (severity IN ('warning', 'error')),
  endpoint          TEXT,
  method            TEXT,
  status            INTEGER,
  error_code        TEXT,
  error_message     TEXT NOT NULL,
  stack_trace       TEXT,
  request_context   TEXT,  -- JSON blob: sanitized headers, query params, body keys
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX idx_error_log_timestamp ON error_log (timestamp DESC);
CREATE INDEX idx_error_log_severity ON error_log (severity);


-- Task state tracking for Code/Cowork/Design — enabling reconnection after dropped SSE
CREATE TABLE task_runs (
  run_id         TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  tool           TEXT NOT NULL CHECK (tool IN ('code', 'cowork', 'design')),
  chat_id        TEXT REFERENCES chats (id) ON DELETE SET NULL,
  state          TEXT NOT NULL CHECK (state IN ('running', 'paused', 'complete', 'error')),
  pause_reason   TEXT,
  error_code     TEXT,
  error_message  TEXT,
  started_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  completed_at   INTEGER
);

CREATE INDEX idx_task_runs_state ON task_runs (state, started_at DESC);
CREATE INDEX idx_task_runs_task_id ON task_runs (task_id);
CREATE INDEX idx_task_runs_tool ON task_runs (tool, started_at DESC);
