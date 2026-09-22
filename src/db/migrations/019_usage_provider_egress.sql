-- ---------------------------------------------------------------------------
-- 019 — stamp the *egress class* each request actually had (S21).
--
-- `provider_type` records what the provider declared itself to be. That was
-- assumed to answer "did these bytes leave the machine", and for two of the four
-- types it does not: `local` and `colibri` *claim* locality, and `normalizeBaseUrl`
-- accepts any http(s) host. A Colibrì box — or an Ollama server — on another
-- machine could be registered and used while `GET /api/providers/active` said
-- `local`, the credential scan was skipped, `zdrStatusFor` answered
-- `local_no_egress` (which satisfies a `require` policy), and the summary counted
-- the traffic as never having left. All five statements were false for one URL.
--
-- The class is now derived from the type *and* the URL the request goes to, and
-- stamped here so the summary stays a record of what happened rather than a
-- re-derivation from whatever the providers table says today — the same reason
-- 013 stamped the type in the first place.
--
-- NULLABLE, and deliberately *not* backfilled.
--
--   * No backfill is possible: the URL was never stored, and re-deciding a row
--     from the type it was already classified by would just restate the mapping
--     in SQL — a second copy of a judgement that must live in one place.
--   * Rows written before this migration keep the class they were written under,
--     which is a permanent understatement for any local-typed provider that
--     pointed off this machine. That is recorded in the register rather than
--     hidden: it cannot be repaired, and a silent "fix" that guessed would be
--     worse than the honest gap.
--   * NULL is also what a row gets if a *newer* build stamps a class this one
--     does not know: the reader falls back to the type mapping instead of
--     inventing a bucket.
-- ---------------------------------------------------------------------------

ALTER TABLE usage_log ADD COLUMN provider_egress TEXT;

-- The exposure summary groups on this column alongside the same time range the
-- provider-type index serves, so it gets the same shape.
CREATE INDEX idx_usage_provider_egress ON usage_log (provider_egress, created_at DESC);
