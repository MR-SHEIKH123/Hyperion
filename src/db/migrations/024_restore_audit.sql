-- ---------------------------------------------------------------------------
-- 024 — an audit trail for restores (Prompt 1.29).
--
-- Restoring is the one operation in this app that destroys data on purpose, and
-- until now it left no trace of its own: `logs/` has whatever the process printed
-- and nothing survives a restart, so "when did this database last get replaced,
-- and with which file?" had no answer after the container was cleaned.
--
-- **Why a table and not a log line.** Three reasons, and the third is the one
-- that decided it:
--
--   * The interesting restore is the one that happened months ago on a machine
--     nobody is watching any more; a log file rotates, a table does not.
--   * The row is queried by the same surfaces that show backups, and a table is
--     what those read.
--   * **The row must live in the restored database.** It is written after the
--     swap, against the reopened handle, so the archive that became this install
--     carries the record of the restore that produced it — the audit travels with
--     the data rather than with the process.
--
-- **What is deliberately absent: the passphrase, and any credential.** There is
-- no column for one, so no future caller can log one by accident. `sha256` is
-- what identifies the file that was restored — the digest of the *container* for
-- a protected archive, never of a decrypted payload, so the value is stable for
-- the bytes the user holds.
--
-- `detail` carries a refusal reason and is written on the refusal path, before
-- anything is touched. It must stay a short human-readable line: it is returned
-- by `GET /api/backup/restores` and read by whoever asks what went wrong.
--
-- `dry_run` and `restored` are separate columns rather than one status because a
-- dry run is a question, not an attempt: recording it is how "did anyone check
-- before doing this?" becomes answerable.
--
-- `pre_restore_backup` is the filename of the safety snapshot taken immediately
-- before the swap. It is the undo path, and the audit row is where a user looks
-- for it a week later.
-- ---------------------------------------------------------------------------

CREATE TABLE restore_audit (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at         INTEGER NOT NULL,

  -- What the caller called it: an upload's filename, or the name in the backups
  -- directory. Nullable because a restored-from-buffer request may not name it.
  filename           TEXT,
  bytes              INTEGER NOT NULL,
  sha256             TEXT NOT NULL,

  encrypted          INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0, 1)),
  dry_run            INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1)),
  restored           INTEGER NOT NULL DEFAULT 0 CHECK (restored IN (0, 1)),

  -- 'dry_run'   — inspected only, nothing written
  -- 'restored'  — the database was replaced
  -- 'refused'   — rejected before anything was touched, with `detail` saying why
  outcome            TEXT NOT NULL CHECK (outcome IN ('dry_run', 'restored', 'refused')),
  detail             TEXT,
  pre_restore_backup TEXT
);

-- Every read is "the most recent N", so the index is on the sort key alone.
CREATE INDEX idx_restore_audit_created ON restore_audit (created_at DESC, id DESC);
