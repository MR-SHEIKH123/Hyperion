-- ---------------------------------------------------------------------------
-- 026 — the ticket that binds an approved call to the call that actually runs (S1).
--
-- A permission decision and the execution that carries it out happen at
-- different times: the run parks mid-conversation, the stream drops, the answer
-- arrives minutes later from another connection, and a *second* run id is created
-- to drive the replay. Nothing in that gap proved the call about to execute was
-- the call the user approved. This table is that proof, and it is deliberately a
-- separate table rather than columns on `pending_approvals`: an approval is a
-- question, a ticket is a bound authorisation, and the two have different
-- lifecycles (a question is answered once; a ticket is armed, spent, and can be
-- voided by an answer to a *different* question).
--
-- Three decisions:
--
--   1. **The ticket is minted where the call is recorded, and armed where the
--      decision lands.** Everything it binds — the verbatim arguments, the
--      canonical workspace, the run that asked, the permission-config revision —
--      is only simultaneously known at the park, so that is where the binding is
--      captured. `resolveApproval` then moves it from `pending` to `armed` (an
--      `allow_once`) or `standing` (an `allow_session`) in the same guarded UPDATE
--      that resolves the question, so the two cannot disagree about what was
--      answered.
--   2. **`digest` is stored as well as its inputs.** The row keeps every field so
--      a refusal can name which one changed, and the digest so a comparison is one
--      constant-time string equality rather than eight field comparisons that
--      could silently stop covering a field somebody added later.
--   3. **No foreign key, same reasoning as `017`.** A ticket must outlive an
--      `INSERT OR REPLACE` on either side of it: `startTaskRun` rewrites run rows
--      and `recordApproval` never rewrites its own, and a cascading relation would
--      delete the authorisation during exactly the retry it exists for. Ids are
--      correlation, validated by the module that owns the table.
--
-- `task_runs.continued_from` is the second half of the same subject, and it is a
-- column rather than a parse of `supersede()`'s `pause_reason`
-- (`continued_as:<runId>`): that string is a sentence for a user, and a
-- verification path that read it would be one prose edit away from refusing every
-- continuation. Nullable with no default, because every row already written
-- genuinely has no recorded predecessor and a default would invent one.
-- ---------------------------------------------------------------------------

ALTER TABLE task_runs ADD COLUMN continued_from TEXT;

CREATE TABLE approval_tickets (
  id              TEXT PRIMARY KEY,
  approval_id     TEXT NOT NULL,
  tool            TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  -- The run that asked. Nullable for a headless run with no `task_runs` row, which
  -- is the same case `pending_approvals.run_id` is nullable for.
  run_id          TEXT,
  -- Set when the asking run was a delegated child, which is what makes the parent
  -- part of the identity rather than just context.
  parent_task_id  TEXT,
  tool_name       TEXT NOT NULL,
  permission_key  TEXT NOT NULL,
  -- Verbatim, exactly as the model emitted it: re-serialising would bind a
  -- different call from the one the user read.
  arguments       TEXT NOT NULL,
  -- The canonical cwd/worktree identity the call will execute in.
  workspace       TEXT NOT NULL,
  -- The effective permission-config revision at mint time (S1). A rule change
  -- between the ask and the execution invalidates the ticket.
  revision        TEXT NOT NULL,
  digest          TEXT NOT NULL,
  -- No CHECK: this vocabulary belongs to the module and will widen (a ticket that
  -- has to be re-armed after a config reload, for instance), and a CHECK here would
  -- mean a table rebuild for a value this code owns outright.
  state           TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  armed_at        INTEGER,
  consumed_at     INTEGER,
  consumed_run_id TEXT
);

-- The only lookup the runtime does: one task's tickets for one call, newest first.
CREATE INDEX idx_approval_tickets_lookup
  ON approval_tickets (task_id, tool_name, created_at DESC);
CREATE INDEX idx_approval_tickets_approval ON approval_tickets (approval_id);
