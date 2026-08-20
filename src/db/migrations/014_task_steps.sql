-- ---------------------------------------------------------------------------
-- 014 — per-step history for a task run.
--
-- `task_runs` (007) is deliberately coarse: state, the reason it stopped, and
-- timestamps. Its own comment explains why nothing finer lives there — "a
-- reconnecting client learns whether to wait, retry, or show a result, which is
-- the question it actually has".
--
-- That answer is still right for reconnection and wrong for everything else. A
-- run that ended `stopped` at a ceiling, or `error` three tool calls in, gives
-- the user no way to see *what it did* before it got there. The stream carried
-- that detail and the stream is gone. This table is the durable summary of the
-- steps, sitting between "one row per run" and "persist every token" — which
-- 007 rejected, and which this does not attempt either.
--
-- What a step is: one decision the loop made and the outcome of it. A tool call
-- and its result, a plan it produced, a compression it performed, or a note it
-- recorded about its own behaviour. Not individual deltas, not prompt text.
--
-- Why the primary key is (run_id, step) rather than an AUTOINCREMENT id:
--
--   * The ordinal is the identity. A step only means anything relative to its
--     run, and there is no use for a global step id — nothing will ever
--     reference one.
--   * It makes duplicate ordinals impossible. A loop that records step 4 twice
--     is a bug in the loop, and the constraint reports it at the write instead
--     of leaving two rows that no ORDER BY can separate.
--   * The key's own index already serves the only read pattern there is —
--     "every step of this run, in order" — so no second index is needed. A
--     surrogate id plus UNIQUE (run_id, step) would build two B-trees to do
--     one job.
--
-- `ON DELETE CASCADE` is load-bearing twice over. The obvious half is that
-- deleting a run should not leave its steps orphaned. The subtle half is
-- `startTaskRun`, which is `INSERT OR REPLACE` on `run_id` because "a retried
-- run id is the same run being restarted". With foreign keys enabled, SQLite
-- runs foreign key actions for the delete that REPLACE performs — so retrying a
-- run clears the previous attempt's steps as a side effect of re-inserting the
-- row. That is exactly the wanted behaviour: the steps of a superseded attempt
-- must not be read back as though the current attempt had taken them. It is
-- also fragile enough to be worth a test, because it is a property of two
-- separate pieces of code agreeing, and nothing in `startTaskRun` says so.
--
-- Nullable columns say "not applicable", never "unknown":
--
--   mode        the ask/plan/act gate the step ran under. Null for a step
--               recorded before a mode was in force.
--   tool_name   only a tool_call has one.
--   ok          only an attempt that can fail has an outcome; a plan or a note
--               has none. Stored 0/1 because SQLite has no boolean.
--   tokens_in   accounting the provider may not report. A missing count must
--   tokens_out  stay distinguishable from a genuine zero, so these are null
--               rather than defaulted — a sum over them would otherwise
--               silently read as complete when it is not.
--
-- `detail` is a short human-readable line, not a transcript, and never a place
-- to put raw provider output: it is written to a row the debug console reads
-- back verbatim, and provider error bodies can quote a rejected credential.
-- Redact before recording.
-- ---------------------------------------------------------------------------

CREATE TABLE task_steps (
  run_id      TEXT NOT NULL REFERENCES task_runs (run_id) ON DELETE CASCADE,
  step        INTEGER NOT NULL,
  mode        TEXT CHECK (mode IS NULL OR mode IN ('ask', 'plan', 'act')),
  kind        TEXT NOT NULL CHECK (kind IN ('tool_call', 'plan', 'compression', 'note')),
  tool_name   TEXT,
  ok          INTEGER CHECK (ok IS NULL OR ok IN (0, 1)),
  detail      TEXT,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

  PRIMARY KEY (run_id, step)
);
