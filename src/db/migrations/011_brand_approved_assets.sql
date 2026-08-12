-- ---------------------------------------------------------------------------
-- 011 — brand-approved flag on assets (Part 1.22).
--
-- Marking an asset as representing the established brand is a different claim
-- from pinning it. `pinned` means "do not auto-delete this"; approval means
-- "this IS the brand" — the thing a Design agent should look at before
-- inventing a new palette. Overloading `pinned` for both would make the two
-- inseparable: every approved asset would have to be pinned (fine) but every
-- pinned screenshot would also read as brand guidance (wrong).
--
-- A plain ADD COLUMN rather than a table rebuild: `attachments` carries no
-- CHECK constraint that needs widening, and SQLite adds a NOT NULL column with
-- a constant DEFAULT in place. Existing rows get 0, which is the correct
-- answer — nothing was approved before this column existed.
--
-- Cleanup exemption is deliberately NOT enforced here with a trigger. It lives
-- in the WHERE clauses of `services/storage/cleanup.ts`, next to the pin check
-- it sits beside, so both exemptions are visible in one place.
-- ---------------------------------------------------------------------------

ALTER TABLE attachments ADD COLUMN is_brand_approved INTEGER NOT NULL DEFAULT 0;

-- When the flag was set, so the approved-assets list can show "approved on".
-- Nullable: an unapproved asset has no approval date, and 0 would read as
-- 1 January 1970 in every UI that formats it.
ALTER TABLE attachments ADD COLUMN brand_approved_at INTEGER;

-- Partial index: the interesting query is "the approved ones", which is a
-- small minority of a gallery. Indexing only those rows keeps the index tiny
-- and leaves inserts of ordinary assets untouched.
CREATE INDEX idx_attachments_brand_approved
  ON attachments (brand_approved_at DESC)
  WHERE is_brand_approved = 1;
