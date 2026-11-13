/**
 * The Files tab's tree — a lazy, keyboard-operated view of one task's
 * workspace (docs/API.md §27.1).
 *
 * **Lazy over the root listing, with one honest exception.** The root read
 * (`?path=.`) is breadth-first and bounded, so a complete walk already carries
 * every entry and expansion is pure derivation — no request, no flash of a
 * loading row over children the first response already held. The exception is
 * the reason the flag exists: when the walk was `truncated`, a directory's
 * children may be missing entirely, so the first expansion of each directory
 * re-reads that subtree (`?path=<dir>`, which restarts both bounds) and shows
 * its own loading and failure rows. A tree that silently rendered the
 * truncated half as the whole truth would be the defect `truncated` exists to
 * prevent.
 *
 * **The ARIA tree pattern, roving focus included.** One row is in the tab
 * order; `ArrowUp`/`ArrowDown` walk the visible rows, `Home`/`End` jump to
 * the ends, `ArrowRight` expands a directory (or descends into it), `ArrowLeft`
 * collapses (or climbs to the parent), `Enter` opens a file. Focus is a state
 * the render *derives*: if the tracked row disappears — collapsed away, or
 * deleted by the agent — the first visible row takes the `tabIndex=0`, so the
 * tree can never end up with no tab stop or a tab stop on a row that is gone.
 * That derivation is why there is no effect here.
 *
 * **What the tree refuses to pretend.** A symlink is labelled as one and
 * `Enter` does nothing on it: the backend lists links so the workspace is not
 * misdescribed, and the file route would refuse the read anyway (§27.5).
 * `.git` is filtered again on this side — the backend never lists it, and a
 * second check costs one line against a regression that would otherwise show
 * the reader an entry the next request 403s. Nothing is ever followed: the
 * entries arrive fully resolved as data, and this component never constructs
 * a path of its own.
 */
import { useMemo, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';

import { getTaskFiles } from '../../api/canvas';
import styles from './CanvasTabs.module.css';

import type { CanvasEntry } from '../../contracts/wire/canvas';

/** The parent of a workspace-relative path; `.` for a root-level entry. */
function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '.' : path.slice(0, slash);
}

/** Every ancestor directory of a path, outermost first (`a` for `a/b/c`). */
function ancestorsOf(path: string): string[] {
  const segments = path.split('/').slice(0, -1);
  const out: string[] = [];
  let current = '';
  for (const segment of segments) {
    current = current === '' ? segment : `${current}/${segment}`;
    out.push(current);
  }
  return out;
}

/**
 * The `.git` filter, again. The backend omits `.git` from listings entirely
 * (§27.1); this catches a regression there before the UI offers the reader a
 * row whose read is guaranteed to be refused.
 */
function isGitPath(entry: CanvasEntry): boolean {
  return entry.path.split('/').includes('.git');
}

interface Row {
  entry: CanvasEntry;
  depth: number;
}

export function FileTree({
  taskId,
  selectedPath,
  onSelect,
}: {
  taskId: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const root = useQuery({
    queryKey: ['canvas', 'files', taskId, '.'],
    queryFn: ({ signal }) => getTaskFiles(taskId, '.', signal),
    retry: false,
  });

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [trackedFocus, setTrackedFocus] = useState<string | null>(null);
  const [revealedFor, setRevealedFor] = useState(selectedPath);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  // Selecting a file from anywhere (the tree, the session panel's changed-file
  // list) reveals it: its ancestor directories open with the selection. Only
  // when the *selection* changes — a manual collapse stays collapsed until the
  // next selection, which is the behaviour an effect on `selectedPath` had,
  // without being an effect.
  if (revealedFor !== selectedPath) {
    setRevealedFor(selectedPath);
    if (selectedPath !== null && selectedPath !== '') {
      setExpanded(new Set([...expanded, ...ancestorsOf(selectedPath)]));
    }
  }

  const rootEntries = useMemo(
    () => (root.data?.entries ?? []).filter((entry) => !isGitPath(entry)),
    [root.data?.entries],
  );

  // A truncated walk may have left a directory's children unknown; a complete
  // one never needs a second request to expand.
  const subtreePaths = useMemo(
    () => (root.data?.truncated === true ? [...expanded] : []),
    [root.data?.truncated, expanded],
  );
  const subtreeQueries = useQueries({
    queries: subtreePaths.map((path) => ({
      queryKey: ['canvas', 'files', taskId, path] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => getTaskFiles(taskId, path, signal),
      retry: false,
    })),
  });
  const subtreeByPath = useMemo(() => {
    const map = new Map<string, (typeof subtreeQueries)[number]>();
    subtreePaths.forEach((path, index) => {
      const query = subtreeQueries[index];
      if (query !== undefined) map.set(path, query);
    });
    return map;
  }, [subtreePaths, subtreeQueries]);

  /** The direct children of a directory, from whichever read holds them. */
  const childrenOf = (path: string): CanvasEntry[] => {
    // The root's own children are always in the root response — the walk
    // breadth-first from `.`, so level one exists whenever anything does —
    // even when a later level was cut off.
    if (path === '.' || root.data?.truncated !== true) {
      return rootEntries.filter((entry) => parentPath(entry.path) === path);
    }
    const subtree = subtreeByPath.get(path);
    return (subtree?.data?.entries ?? []).filter(
      (entry) => parentPath(entry.path) === path && !isGitPath(entry),
    );
  };

  const sorted = (entries: CanvasEntry[]): CanvasEntry[] =>
    [...entries].sort((a, b) => a.name.localeCompare(b.name));

  /** Visible rows in render order — the order the arrow keys walk. */
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (path: string, depth: number): void => {
      for (const entry of sorted(childrenOf(path))) {
        out.push({ entry, depth });
        if (entry.type === 'directory' && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk('.', 0);
    return out;
    // `childrenOf` reads query result objects whose identity changes only on a
    // response; `expanded`/`rootEntries` are the inputs that matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootEntries, root.data?.truncated, expanded, subtreeByPath]);

  // Roving focus, derived: the tracked row if it is still visible, otherwise
  // the first row (or nothing, for an empty tree).
  const rovingPath =
    trackedFocus !== null && rows.some((row) => row.entry.path === trackedFocus)
      ? trackedFocus
      : (rows[0]?.entry.path ?? null);

  // The flat index of each row, for keys that navigate the flattened order
  // (`ArrowDown` from a directory's last child lands on its sibling, not on a
  // group-relative position). Built once per render instead of a `findIndex`
  // per row.
  const rowIndexByPath = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => map.set(row.entry.path, index));
    return map;
  }, [rows]);

  const focusRow = (path: string): void => {
    setTrackedFocus(path);
    rowRefs.current.get(path)?.focus();
  };

  const toggle = (path: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const onRowKeyDown = (event: React.KeyboardEvent<HTMLLIElement>, row: Row): void => {
    // Rows nest (`<li>` inside `<li>` inside the group), and React's synthetic
    // events bubble: without this, ArrowUp on a child would run the parent's
    // handler a second time and jump two rows. Each row handles its own key,
    // and only its own.
    event.stopPropagation();
    const { entry } = row;
    const index = rowIndexByPath.get(entry.path) ?? 0;
    const at = (next: number): string | null =>
      rows[Math.min(rows.length - 1, Math.max(0, next))]?.entry.path ?? null;
    let target: string | null = null;
    switch (event.key) {
      case 'ArrowDown':
        target = at(index + 1);
        break;
      case 'ArrowUp':
        target = at(index - 1);
        break;
      case 'Home':
        target = at(0);
        break;
      case 'End':
        target = at(rows.length - 1);
        break;
      case 'ArrowRight':
        if (entry.type === 'directory') {
          if (!expanded.has(entry.path)) toggle(entry.path);
          else target = at(index + 1);
        }
        break;
      case 'ArrowLeft':
        if (entry.type === 'directory' && expanded.has(entry.path)) toggle(entry.path);
        else if (parentPath(entry.path) !== '.') target = parentPath(entry.path);
        break;
      case 'Enter':
        if (entry.type === 'file') onSelect(entry.path);
        else if (entry.type === 'directory') toggle(entry.path);
        // A symlink does nothing: the label already says it is not followed,
        // and opening it would be a path the backend would refuse.
        break;
      default:
        break;
    }
    if (target !== null) {
      event.preventDefault();
      focusRow(target);
    }
  };

  const renderEntry = (entry: CanvasEntry, depth: number): React.ReactNode => {
    const isOpen = entry.type === 'directory' && expanded.has(entry.path);
    const subtree = subtreeByPath.get(entry.path);
    const children = isOpen ? sorted(childrenOf(entry.path)) : [];
    const showSubtreeState =
      isOpen && root.data?.truncated === true && (subtree?.isPending === true || subtree?.isError === true);

    return (
      <li
        key={entry.path}
        ref={(node) => {
          if (node === null) rowRefs.current.delete(entry.path);
          else rowRefs.current.set(entry.path, node);
        }}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={entry.type === 'file' ? entry.path === selectedPath : undefined}
        aria-expanded={entry.type === 'directory' ? isOpen : undefined}
        aria-label={
          entry.type === 'symlink' ? `${entry.name} — symlink (not followed)` : entry.name
        }
        tabIndex={entry.path === rovingPath ? 0 : -1}
        className={
          entry.type === 'file' && entry.path === selectedPath ? styles.treeRowSelected : styles.treeRow
        }
        style={{ paddingInlineStart: `calc(var(--space-2) + ${String(depth)} * 1.25rem)` }}
        onFocus={(event) => {
          // Also bubbling: focusing a child would otherwise re-track every
          // ancestor after it, leaving the roving stop on the wrong row.
          event.stopPropagation();
          setTrackedFocus(entry.path);
        }}
        onClick={(event) => {
          event.stopPropagation();
          focusRow(entry.path);
          if (entry.type === 'file') onSelect(entry.path);
          else if (entry.type === 'directory') toggle(entry.path);
        }}
        onKeyDown={(event) => onRowKeyDown(event, { entry, depth })}
      >
        <span className={styles.treeGlyph} aria-hidden="true">
          {entry.type === 'directory' ? (isOpen ? '▾ ' : '▸ ') : entry.type === 'symlink' ? '↗ ' : '· '}
        </span>
        <span className={styles.treeName}>{entry.name}</span>
        {entry.type === 'symlink' && <span className={styles.treeNote}> — symlink (not followed)</span>}
        {isOpen ? (
          <ul role="group">
            {showSubtreeState && subtree?.isPending === true ? (
              <li role="none">
                <span role="status" className={styles.treeNote}>
                  Loading directory…
                </span>
              </li>
            ) : null}
            {showSubtreeState && subtree?.isError === true ? (
              <li role="none">
                <span role="alert" className={styles.treeNote}>
                  This directory could not be read: {subtree.error.message}
                </span>
              </li>
            ) : null}
            {!showSubtreeState && children.length === 0 ? (
              <li role="none">
                <span className={styles.treeNote}>Empty directory</span>
              </li>
            ) : null}
            {children.map((child) => renderEntry(child, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  if (root.isPending) {
    return (
      <div className={styles.treePane}>
        <p role="status">Reading task files…</p>
      </div>
    );
  }
  if (root.isError) {
    return (
      <div className={styles.treePane}>
        <p role="alert">The task file tree could not be read: {root.error.message}</p>
      </div>
    );
  }

  const top = sorted(rootEntries.filter((entry) => parentPath(entry.path) === '.'));

  return (
    <div className={styles.treePane}>
      <p className={styles.note}>
        Select a file and press Enter to read it. Directories expand with the arrow keys; links are
        identified but never followed.
      </p>
      {top.length === 0 ? (
        <p className={styles.note}>This task workspace has no files to list.</p>
      ) : (
        <ul className={styles.tree} role="tree" aria-label="Task files">
          {top.map((entry) => renderEntry(entry, 0))}
        </ul>
      )}
      {root.data.truncated ? (
        <p className={styles.notice}>
          The file listing was truncated by the server limit — directories read their own listing
          when expanded.
        </p>
      ) : null}
      {root.data.skipped.length > 0 ? (
        <p className={styles.note}>Skipped directories: {root.data.skipped.join(', ')}</p>
      ) : null}
    </div>
  );
}
