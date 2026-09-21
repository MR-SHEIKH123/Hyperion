-- ---------------------------------------------------------------------------
-- 021 — which knowledge sources a Cowork run actually used (Prompt 1.39 A6).
--
-- Cowork is knowledge-first: it reads the standing library, marks each source
-- usable or not, and puts only the usable text in the prompt. Until now nothing
-- recorded *which* ones those were. The run's answer cites sources in prose, the
-- system prompt goes away with the process, and `task_steps` holds tool calls and
-- plans rather than the evidence — so "what was this built on?" had no answer
-- after the fact, which is exactly the question provenance exists to answer.
--
-- A dedicated table rather than a `task_steps` kind, for three reasons:
--
--   * `detail` there is documented as "a short human-readable line, not a
--     transcript" and is read back verbatim by the debug console. A JSON blob of
--     sources would be a second format inside a column that promises one.
--   * Steps are ordered ordinals with a PRIMARY KEY of (run_id, step); sources
--     have no order and their identity is (run_id, source_id). Storing them as
--     steps would invent an ordinal that means nothing.
--   * A step is a *thing the loop did*. Reading the library happens before the
--     loop starts, and `run_knowledge_sources` is written once, at that moment.
--
-- **No foreign key to `knowledge_sources` on purpose.** This row is a historical
-- record: the label, filename, byte count and digest are copied in, so deleting a
-- source later cannot erase the fact that a run used it — which is the whole
-- point of provenance, and the opposite of what a cascading reference would do.
-- (`run_id` does cascade, because a deleted run has no provenance to preserve.)
--
-- `sha256`/`bytes` are nullable because a source can be registered without a
-- pinned digest, and "unknown" must stay distinguishable from "zero bytes".
-- ---------------------------------------------------------------------------

CREATE TABLE run_knowledge_sources (
  run_id     TEXT NOT NULL REFERENCES task_runs (run_id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL,
  label      TEXT,
  filename   TEXT NOT NULL,
  bytes      INTEGER,
  sha256     TEXT,
  used_at    INTEGER NOT NULL,

  PRIMARY KEY (run_id, source_id)
);

-- The reverse question — "which runs used this source?" — is the one that matters
-- when a source is found to be wrong, and it is the only read pattern that does
-- not already start from the primary key's prefix.
CREATE INDEX idx_run_knowledge_sources_source ON run_knowledge_sources (source_id);
