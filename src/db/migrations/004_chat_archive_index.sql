-- Chat archiving: exempt archived chats from the idle-cleanup sweep.
--
-- The `archived` column already exists (001_init), and archiving already hid a
-- chat from the sidebar. What changed is that the cleanup sweep now also skips
-- archived rows, so its WHERE clause went from
--
--     WHERE pinned = 0 AND last_opened_at < ?
-- to
--     WHERE pinned = 0 AND archived = 0 AND last_opened_at < ?
--
-- The old index led on (pinned, last_opened_at), which no longer covers the
-- middle equality. Rebuilding it as (pinned, archived, last_opened_at) keeps
-- both equality columns ahead of the range scan, which is the order SQLite can
-- actually use end to end.
--
-- No data migration is needed: `archived` is NOT NULL DEFAULT 0, so every
-- existing chat is already unarchived and keeps its current behaviour.

DROP INDEX IF EXISTS idx_chats_cleanup;
CREATE INDEX idx_chats_cleanup ON chats (pinned, archived, last_opened_at);
