-- ---------------------------------------------------------------------------
-- 016 — zero data retention: per-provider facts, per-request record (Part 1.26).
--
-- 013 recorded *where* a request went. This records what the provider promised
-- about keeping it, and what the user's standing policy demanded at the time.
-- Both halves are needed: a status alone cannot be audited later ("was that
-- acceptable?" depends on what was required), and a requirement alone cannot
-- say what actually applied.
--
-- Two different nullability rules apply here, deliberately, and the difference
-- is about which writer swallows its errors.
--
-- `providers` gets NOT NULL DEFAULT columns. Provider writes throw properly —
-- `setProviderZdr` surfaces a failure to the caller as a 4xx/5xx — so a
-- constraint violation is visible rather than silent, and a default of
-- 'unknown' is the honest starting value for every existing row: nothing has
-- been attested about any of them yet.
--
-- `usage_log` gets plain nullable columns with no CHECK, for exactly the reason
-- 013 gives. `recordUsage` swallows every error it raises, because a failure to
-- log spend must not fail the request that produced it. A NOT NULL column would
-- convert a missing value into a silently discarded spend row — the cap bypass
-- `test/temporarychats.test.ts` exists to close. Pre-1.26 rows therefore stay
-- NULL and are reported as their own bucket rather than being backfilled with a
-- guess: no ZDR policy was in force when they were written, and inventing one
-- retroactively would put a claim in the log that nobody ever made.
--
-- No CHECK on the status columns either. The status enum is a product decision
-- that will widen (as provider types did in 002 and 005), and a CHECK here would
-- mean a table rebuild every time it does — for a column that is descriptive,
-- not load-bearing. The TypeScript union in `types/core.ts` is the definition;
-- see `services/safety/zdr.ts` for why that mapping never moves into SQL.
--
-- `zdr_confirmed_at` is epoch milliseconds, matching `created_at` and
-- `last_error_at`, and is only ever written from an explicit user confirmation.
-- Nothing Hyperion observes about a request may set it: a successful send
-- proves the flag was accepted, never that the data was discarded.
-- ---------------------------------------------------------------------------

ALTER TABLE providers ADD COLUMN zdr_support TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE providers ADD COLUMN zdr_flag_location TEXT;
ALTER TABLE providers ADD COLUMN zdr_flag_key TEXT;
ALTER TABLE providers ADD COLUMN zdr_flag_value TEXT;
ALTER TABLE providers ADD COLUMN zdr_confirmed_at INTEGER;
ALTER TABLE providers ADD COLUMN zdr_confirmed_note TEXT;

ALTER TABLE usage_log ADD COLUMN zdr_status TEXT;
ALTER TABLE usage_log ADD COLUMN zdr_requirement TEXT;

-- The exposure summary filters and groups on this column alongside a time
-- range, which is the same shape as idx_usage_provider_type.
CREATE INDEX idx_usage_zdr_status ON usage_log (zdr_status, created_at DESC);
