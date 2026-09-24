-- ---------------------------------------------------------------------------
-- 028 — an audit trail for Cowork Pulse fetches (Prompt 1.30).
--
-- Pulse is the one path on which model-chosen text leaves for public search
-- APIs, so "what did the agent fetch, from where, and what came back" needs an
-- answer after the run is over. The run's step rows record that a tool ran;
-- they do not record the query or the results, and the tool's output text is
-- conversational rather than structured. This table is the structured half:
-- one row per fetch, with the query, the tier that served it, the per-source
-- outcomes (including failures) and the items returned.
--
-- **Why the query is stored.** A fetch history without the query answers
-- nothing. The query is scanned for credential-shaped text before it is sent
-- (when `redaction_check_enabled` is on) and refused when flagged, so a stored
-- query passed the scan or the scan was off — the same standing as a chat
-- prompt in `messages`, and read only by the local history route.
--
-- **Why outcomes and items are JSON, not rows.** A fetch fans out to at most a
-- handful of sources and returns at most tens of items; normalising them would
-- buy joins nobody needs. Both columns are bounded by the fetch caps (query at
-- most 300 characters, 10 items per source, 4 free sources), so a row stays
-- small without a truncation rule.
--
-- **What is deliberately absent: any credential.** The free tier needs none,
-- and the keyed tier's framework registers code, not keys — a future keyed
-- source reads its own secrets at fetch time and never writes them here.
-- `sources_json` carries per-source error strings, which name HTTP statuses,
-- never request headers.
-- ---------------------------------------------------------------------------

CREATE TABLE pulse_fetches (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at         INTEGER NOT NULL,

  -- The query as sent, trimmed. At most 300 characters by the fetch caps.
  query              TEXT NOT NULL,

  -- 'free' or 'keyed': the tier that served this fetch. Never 'off' — a fetch
  -- refused for a disabled Pulse throws before a row is written.
  tier               TEXT NOT NULL,

  -- [{ source, ok, count, error, ms }]: one entry per source attempted.
  sources_json       TEXT NOT NULL,

  -- [{ source, title, url, snippet, publishedAt, score }]: what came back.
  items_json         TEXT NOT NULL
);

-- The history read is newest-first with a limit; nothing else queries this table.
CREATE INDEX idx_pulse_fetches_created ON pulse_fetches (created_at DESC);
