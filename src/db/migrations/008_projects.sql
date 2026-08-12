-- The project registry.
--
-- Everything the Code, Design and Cowork tools do is scoped to a directory:
-- `fsScope` contains their writes, git worktrees branch from it, and the
-- `.hyperion/rules|agents|commands/` conventions are read out of it. Until now
-- that directory was one fixed path, which meant the app could only ever be
-- pointed at a single piece of work. This table is what makes "which project"
-- a question with more than one answer.
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  -- What the user calls it. Free text, and deliberately not derived from the
  -- directory name: two checkouts of the same repository need distinguishable
  -- labels, and the folder on disk is often not what the work is called.
  name            TEXT NOT NULL,
  -- Absolute path, which breaks the convention every other table follows.
  -- Attachments, skills and knowledge all store paths relative to a scope root
  -- so a backup restores onto a different machine or a changed HYPERION_HOME.
  -- A project cannot: it may point at an existing checkout anywhere on disk
  -- (`D:\work\api`), which has no scope root to be relative to. A restore on
  -- another machine therefore has to have its external projects re-pointed,
  -- and that is the honest outcome — the alternative is a relative path that
  -- silently resolves somewhere wrong.
  path            TEXT NOT NULL UNIQUE,
  -- 1 when Hyperion created the directory under its own projects root, 0 when
  -- the row points at a directory that already existed. Delete reads this: a
  -- managed directory is the app's own, an external one is emphatically the
  -- user's, and neither is removed from disk by deregistering the project.
  managed         INTEGER NOT NULL DEFAULT 1 CHECK (managed IN (0, 1)),
  created_at      INTEGER NOT NULL,
  -- NULL until the project has been opened once. Absence and "opened at epoch
  -- zero" are different facts, so this is nullable rather than defaulted.
  last_opened_at  INTEGER
);

-- `UNIQUE` on `path` rather than an index for lookup speed: two rows pointing
-- at one directory would give the same files two names, two worktree
-- namespaces and two sets of rules, with nothing to say which was authoritative.
CREATE INDEX idx_projects_last_opened ON projects (last_opened_at DESC);
