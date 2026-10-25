import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';

import { getTaskFile, getTaskFiles } from '../../api/canvas';
import { ApiError } from '../../api/errors';
import styles from './CanvasTabs.module.css';

export const CANVAS_TABS = ['overview', 'files', 'diff', 'preview', 'console'] as const;
export type CanvasTab = (typeof CANVAS_TABS)[number];
const TAB_LABELS: Record<CanvasTab, string> = {
  overview: 'Overview', files: 'Files', diff: 'Diff', preview: 'Preview', console: 'Console',
};

function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '.' : path.slice(0, slash);
}

/** Tabs keep focus on the active tab; arrows both move and activate. */
export function CanvasTabs({
  taskId,
  file,
  onSelectFile,
  activeTab,
  onTabChange,
  children,
}: {
  taskId: string;
  file: string | null;
  onSelectFile: (path: string) => void;
  activeTab: CanvasTab;
  onTabChange: (tab: CanvasTab) => void;
  children: React.ReactNode;
}) {
  const tab = activeTab;
  const tabRefs = useRef(new Map<CanvasTab, HTMLButtonElement>());
  const activate = useCallback((next: CanvasTab) => onTabChange(next), [onTabChange]);
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: CanvasTab) => {
    const index = CANVAS_TABS.indexOf(current);
    let next: CanvasTab | null = null;
    if (event.key === 'ArrowRight') next = CANVAS_TABS[(index + 1) % CANVAS_TABS.length] ?? null;
    if (event.key === 'ArrowLeft') next = CANVAS_TABS[(index + CANVAS_TABS.length - 1) % CANVAS_TABS.length] ?? null;
    if (event.key === 'Home') next = CANVAS_TABS[0];
    if (event.key === 'End') next = CANVAS_TABS.at(-1) ?? null;
    if (next !== null) {
      event.preventDefault();
      activate(next);
      tabRefs.current.get(next)?.focus();
    }
  };



  return (
    <section className={styles.surface} aria-label={`Canvas for task ${taskId}`}>
      <div className={styles.tabs} role="tablist" aria-label="Task workspace views" aria-orientation="horizontal">
        {CANVAS_TABS.map((id) => (
          <button
            key={id}
            ref={(node) => { if (node) tabRefs.current.set(id, node); else tabRefs.current.delete(id); }}
            id={`canvas-tab-${id}`}
            className={styles.tab}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={`canvas-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => activate(id)}
            onKeyDown={(event) => onTabKeyDown(event, id)}
          >{TAB_LABELS[id]}</button>
        ))}
      </div>
      <div id={`canvas-panel-${tab}`} className={styles.panel} role="tabpanel" aria-labelledby={`canvas-tab-${tab}`} tabIndex={0}>
        {tab === 'overview' ? children : tab === 'files' ? (
          <FilesView taskId={taskId} selectedPath={file} onSelect={onSelectFile} />
        ) : tab === 'diff' ? (
          <DiffView />
        ) : tab === 'preview' ? (
          <PreviewView />
        ) : (
          <ConsoleView />
        )}
      </div>
    </section>
  );
}

interface TreeNode { path: string; name: string; type: 'file' | 'directory' | 'symlink'; bytes: number | null }

function FilesView({ taskId, selectedPath, onSelect }: { taskId: string; selectedPath: string | null; onSelect: (path: string) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focusPath, setFocusPath] = useState('');
  const refs = useRef(new Map<string, HTMLLIElement>());
  const root = useQuery({ queryKey: ['canvas', 'files', taskId, '.'], queryFn: ({ signal }) => getTaskFiles(taskId, '.', signal), retry: false });
  const directories = useMemo(() => [...expanded], [expanded]);
  const queries = useQueries({ queries: directories.map((path) => ({
    queryKey: ['canvas', 'files', taskId, path], queryFn: ({ signal }: { signal: AbortSignal }) => getTaskFiles(taskId, path, signal), retry: false,
  })) });
  const byPath = new Map(directories.map((path, index) => [path, queries[index]?.data]));
  const directNodes = (path: string): TreeNode[] => {
    const data = path === '.' ? root.data : byPath.get(path);
    return (data?.entries ?? []).filter((entry) => parentPath(entry.path) === path).map((entry) => ({
      ...entry,
      type: entry.type,
    })).sort((a, b) => a.name.localeCompare(b.name));
  };
  const visible = useMemo(() => {
    const rows: { node: TreeNode; depth: number }[] = [];
    const visit = (path: string, depth: number) => {
      for (const node of directNodes(path)) {
        rows.push({ node, depth });
        if (node.type === 'directory' && expanded.has(node.path)) visit(node.path, depth + 1);
      }
    };
    visit('.', 0);
    return rows;
  // directNodes reads query result objects, and their data identity changes only on a response.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root.data, byPath, expanded]);

  useEffect(() => {
    if (focusPath === '' && visible[0]) setFocusPath(visible[0].node.path);
  }, [focusPath, visible]);

  const focus = (path: string) => {
    setFocusPath(path);
    requestAnimationFrame(() => refs.current.get(path)?.focus());
  };
  const toggle = (path: string) => setExpanded((old) => {
    const next = new Set(old);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const handleKey = (event: React.KeyboardEvent<HTMLLIElement>, node: TreeNode, index: number) => {
    let target: string | null = null;
    if (event.key === 'ArrowDown') target = visible[Math.min(index + 1, visible.length - 1)]?.node.path ?? null;
    if (event.key === 'ArrowUp') target = visible[Math.max(index - 1, 0)]?.node.path ?? null;
    if (event.key === 'Home') target = visible[0]?.node.path ?? null;
    if (event.key === 'End') target = visible.at(-1)?.node.path ?? null;
    if (event.key === 'ArrowRight' && node.type === 'directory') {
      if (!expanded.has(node.path)) toggle(node.path);
      else target = visible[index + 1]?.node.path ?? null;
    }
    if (event.key === 'ArrowLeft') {
      if (node.type === 'directory' && expanded.has(node.path)) toggle(node.path);
      else if (node.path.includes('/')) target = parentPath(node.path);
    }
    if (event.key === 'Enter') {
      if (node.type === 'directory') toggle(node.path);
      else if (node.type === 'file') onSelect(node.path);
    }
    if (target !== null) { event.preventDefault(); focus(target); }
  };

  if (root.isPending) return <p role="status">Reading task files…</p>;
  if (root.isError) return <p role="alert">The task file tree could not be read: {root.error.message}</p>;
  return (
    <div className={styles.filesLayout}>
      <div>
        <p className={styles.note}>Select a file and press Enter to read it. Directories load when expanded; links are identified but never followed.</p>
        {visible.length === 0 ? <p className={styles.note}>This task workspace has no files to list.</p> : null}
        <ul className={styles.tree} role="tree" aria-label="Task files">
          {visible.map(({ node, depth }, index) => (
            <li key={node.path} role="treeitem" aria-level={depth + 1}
              aria-expanded={node.type === 'directory' ? expanded.has(node.path) : undefined}
              aria-selected={node.type === 'file' ? selectedPath === node.path : undefined}
              tabIndex={node.path === focusPath ? 0 : -1}
              ref={(element) => { if (element) refs.current.set(node.path, element); else refs.current.delete(node.path); }}
              style={{ paddingInlineStart: `calc(var(--space-2) + ${depth} * 1.25rem)` }}
              onFocus={() => setFocusPath(node.path)} onClick={() => { focus(node.path); if (node.type === 'file') onSelect(node.path); }}
              onKeyDown={(event) => handleKey(event, node, index)}>
              <span aria-hidden="true">{node.type === 'directory' ? (expanded.has(node.path) ? '▾ ' : '▸ ') : node.type === 'symlink' ? '↗ ' : '· '}</span>
              {node.name}{node.type === 'symlink' ? ' — symlink (not followed)' : ''}
            </li>
          ))}
        </ul>
        {root.data.truncated && <p className={styles.notice}>The file listing was truncated by the server limit.</p>}
        {root.data.skipped.length > 0 && <p className={styles.note}>Skipped directories: {root.data.skipped.join(', ')}</p>}
      </div>
      <FileViewer taskId={taskId} path={selectedPath} bytes={root.data.entries.find((entry) => entry.path === selectedPath)?.bytes ?? null} />
    </div>
  );
}

function FileViewer({ taskId, path, bytes }: { taskId: string; path: string | null; bytes: number | null }) {
  const query = useQuery({ queryKey: ['canvas', 'file', taskId, path], queryFn: ({ signal }) => getTaskFile(taskId, path ?? '', signal), enabled: path !== null, retry: false });
  if (path === null) return <p className={styles.note}>Choose a file from the tree to read it.</p>;
  if (query.isPending) return <p role="status">Reading {path}…</p>;
  if (query.isError) {
    if (query.error instanceof ApiError && /not valid UTF-8 text/i.test(query.error.message)) return <p className={styles.notice}>binary, {bytes === null ? 'size unknown' : `${bytes} bytes`}</p>;
    if (query.error instanceof ApiError && query.error.code === 'not_found') return <p className={styles.notice}>This file is no longer present in the task workspace.</p>;
    return <p role="alert">Could not read {path}: {query.error.message}</p>;
  }
  const lines = query.data.content.split('\n');
  return <div className={styles.viewer} aria-label={`Contents of ${path}`}>
    <p className={styles.filePath}>{path} · {query.data.bytes} bytes</p>
    <pre className={styles.code}><code>{lines.map((line, index) => <span className={styles.line} key={index}><span className={styles.lineNumber} aria-hidden="true">{index + 1}</span>{line || ' '}{'\n'}</span>)}</code></pre>
  </div>;
}

function DiffView() { return <p className={styles.note}>Diff rendering is loading in the next Canvas slice.</p>; }

function PreviewView() { return <p className={styles.note}>Preview controls load in the Preview tab.</p>; }
function ConsoleView() { return <p className={styles.note}>The preview console becomes available when a preview is running.</p>; }
