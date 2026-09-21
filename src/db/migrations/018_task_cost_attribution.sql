-- ---------------------------------------------------------------------------
-- 018 — per-task cost accounting: the run a spend row belongs to (v4 §6.2).
--
-- 017 gave `usage_log` a `task_id`, which answers "what did this task cost" —
-- including work delegated to subagent children, since a child inherits its
-- parent's task id. What that cannot answer is "what did *this run* cost", and
-- that is the unit the activity feed and the task-state route report on: each
-- feed entry is one `task_runs` row, each state response carries one run. So the
-- log records the run as well, and the two keys mean different things on purpose:
--
--   task_id  the attribution key. Present for every agent-path row, including
--            delegated children (a child's rows carry the parent task id and no
--            run id, because `loop.ts` omits `runId` for depth-1 children).
--   run_id   the execution that made the request. ABSENT for a child's requests
--            — so a task total includes delegated work and a run total does not,
--            and `runs` (a COUNT DISTINCT) says how many runs contributed.
--
-- Plain nullable column, no FK, no default, following 016 and 017 verbatim and
-- for the reason they give: `recordUsage` swallows every error it raises, so a
-- NOT NULL column would convert a missing value into a silently discarded spend
-- row — the cap-bypass class `test/temporarychats.test.ts` exists to close.
--
-- No foreign key to `task_runs (run_id)` either, and that is the important one.
-- `task_runs` is written with `INSERT OR REPLACE` when an attempt restarts
-- (`014`'s header), and a cascading relation would delete the spend for exactly
-- the attempt that is being replaced — erasing cost precisely when a run was
-- retried. 017 refuses a cascade on `task_messages` for the same reason. A spend
-- row is a record of something a provider was actually asked, so it must outlive
-- the bookkeeping row it is attributed to; a dangling `run_id` is the survivable
-- error, and the honest one.
--
-- No backfill. Rows written before this migration recorded no run, and inventing
-- one — from the task's latest run, say — would put an attribution in the log
-- that no request made. They keep a task id where 017's rows had one, and are
-- reported as belonging to no particular run.
-- ---------------------------------------------------------------------------

ALTER TABLE usage_log ADD COLUMN run_id TEXT;

CREATE INDEX idx_usage_run ON usage_log (run_id);

-- ---------------------------------------------------------------------------
-- Fixing a price upsert that never fired (found by the §6.2 tests).
--
-- `model_prices` has `UNIQUE (model_id, provider_id)`, and `setPrice` upserts
-- with `ON CONFLICT(model_id, provider_id)`. That clause does **not** fire when
-- `provider_id IS NULL`: SQLite treats NULLs as distinct in a unique index, and a
-- conflict target containing a NULL matches nothing. So every save of a *global*
-- price (the "all providers" row, which is the common case) inserted a second
-- row, and `findPrice` — which orders by `provider_id IS NULL` and takes one —
-- then returned whichever row SQLite reached first, usually the oldest. The
-- user's edit vanished and the stale price stayed in force, including for the
-- daily spend cap, which is computed from `usage_log.cost_usd`.
--
-- `deletePrice` already handles the NULL case explicitly, which is how the
-- omission in `setPrice` went unnoticed: the semantics were known in one place
-- and missed in the other.
--
-- Existing duplicates are collapsed to the newest row — the one the user most
-- recently saved, which is what they believe is in force. `updated_at` first,
-- `id` as the tiebreak for rows written in the same millisecond.
-- ---------------------------------------------------------------------------

DELETE FROM model_prices
 WHERE provider_id IS NULL
   AND id NOT IN (
     SELECT id FROM (
       SELECT id, ROW_NUMBER() OVER (PARTITION BY model_id ORDER BY updated_at DESC, id DESC) AS rank
         FROM model_prices
        WHERE provider_id IS NULL
     )
     WHERE rank = 1
   );

-- A partial unique index, so the invariant is the schema's rather than the
-- caller's: at most one global row per model. This is also what makes a
-- `ON CONFLICT (model_id) WHERE provider_id IS NULL DO UPDATE` target valid.
CREATE UNIQUE INDEX idx_model_prices_global ON model_prices (model_id)
  WHERE provider_id IS NULL;
