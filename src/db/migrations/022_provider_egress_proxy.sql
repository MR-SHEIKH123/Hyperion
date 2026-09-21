-- ---------------------------------------------------------------------------
-- 022 — a per-provider egress proxy, and the audit stamp for it (1.37).
--
-- 019 made the *egress class* a fact about the URL a request goes to rather than
-- about the type a provider declared. A proxy is the one remaining way for that
-- fact to be wrong in the direction that matters: a request can leave this
-- machine even though both the provider type and the provider URL are local,
-- because the bytes go to `egress_proxy` first and that hop may be anywhere.
-- So 1.37 needs the field, and it needs the class derivation to see it — which
-- only works if the field is stored on the provider rather than kept in memory.
--
-- `providers.egress_proxy` is the configured proxy URL, verbatim, because that is
-- what the transport dials. Credentials in that URL are permitted (a proxy that
-- wants them is common) and are why nothing reads this column directly: every
-- read path goes through the redacting helpers in `services/safety/outbound.ts`,
-- and no route returns the raw value.
--
-- `usage_log.egress_proxy` is the audit field, and it is deliberately NOT the
-- same string. It holds the canonical `scheme://host:port` only — never
-- credentials — because the audit question is *where the bytes went*, not which
-- credential carried them, and a usage row is readable by the exposure summary
-- and by export. Two providers sharing a proxy host are indistinguishable in
-- this column, which is the intended trade: the alternative is a credential at
-- rest in a table that is read far more widely than the providers table is.
--
-- NULLABLE, and deliberately not backfilled. Every row written before this
-- migration was written directly, so NULL is exactly true of it — unlike 019,
-- where NULL was an understatement for one class of row.
--
-- Stamped at write time, like `provider_egress` beside it: removing or changing
-- the proxy afterwards must not rewrite where an earlier request went.
-- ---------------------------------------------------------------------------

ALTER TABLE providers ADD COLUMN egress_proxy TEXT;

ALTER TABLE usage_log ADD COLUMN egress_proxy TEXT;

-- The exposure summary groups by route, usually within a time range, so this
-- index matches `idx_usage_provider_egress`' shape.
CREATE INDEX idx_usage_egress_proxy ON usage_log (egress_proxy, created_at DESC);
