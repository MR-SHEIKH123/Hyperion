-- ---------------------------------------------------------------------------
-- 013 — record which *kind* of provider each usage row was sent to (Part 1.23).
--
-- `usage_log` already names the provider by id and by name, but neither answers
-- the question the outbound data safety layer exists to answer: how much of
-- what this machine produced actually left it. A provider id is opaque, and a
-- provider row can be edited or deleted afterwards, at which point the history
-- can no longer be classified at all. Stamping the type at write time makes the
-- exposure summary a record of what happened rather than a re-derivation from
-- whatever the providers table happens to say today.
--
-- The column is deliberately NULLABLE, and that is not laziness:
--
--   * `recordUsage` swallows every error it raises — a failure to log spend must
--     not fail the request that produced it. A NOT NULL constraint would turn a
--     missing type into a silently discarded row, which is exactly the cap
--     bypass `test/temporarychats.test.ts` was written to close. Losing the
--     spend is far worse than losing the classification.
--   * A row whose provider has since been deleted has `provider_id` NULL by
--     `ON DELETE SET NULL`, so there is genuinely nothing to record. NULL is the
--     honest answer, and it is reported as its own `unknown` bucket rather than
--     being folded into `local` or `remote`. Guessing would understate or
--     overstate egress, and both directions mislead.
--
-- No CHECK constraint, on purpose. Provider types are a widening set (002 added
-- `opencodex`, 005 added `colibri`), and a CHECK here would mean a third
-- migration and a table rebuild every time a new one appears — for a column
-- that is descriptive, not load-bearing.
--
-- The backfill classifies the rows it still can: any row whose provider row
-- survives gets that provider's current type. Rows with no provider stay NULL.
-- ---------------------------------------------------------------------------

ALTER TABLE usage_log ADD COLUMN provider_type TEXT;

UPDATE usage_log
   SET provider_type = (SELECT type FROM providers WHERE providers.id = usage_log.provider_id)
 WHERE provider_id IS NOT NULL;

-- The exposure summary always filters or groups on this column alongside a time
-- range, which is the same shape as the existing usage indexes.
CREATE INDEX idx_usage_provider_type ON usage_log (provider_type, created_at DESC);
