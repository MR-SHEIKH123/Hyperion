import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import { getPreviewStatus, getTaskDiff, getTaskFile, getTaskFiles, mintPreview, revokePreview } from '../../api/canvas';
import { splitPatch, type PatchSummary } from './patch';
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
  writeRevision = 0,
  onOpenFiles,
  children,
}: {
  taskId: string;
  file: string | null;
  onSelectFile: (path: string) => void;
  activeTab: CanvasTab;
  onTabChange: (tab: CanvasTab) => void;
  writeRevision?: number;
  onOpenFiles: () => void;
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
          <DiffView taskId={taskId} selectedPath={file} onSelectFile={onSelectFile} />
        ) : tab === 'preview' ? (
          <PreviewView taskId={taskId} writeRevision={writeRevision} onOpenFiles={onOpenFiles} />
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

function DiffView({ taskId, selectedPath, onSelectFile }: { taskId: string; selectedPath: string | null; onSelectFile: (path: string) => void }) {
  const query = useQuery({ queryKey: ['canvas', 'diff', taskId], queryFn: ({ signal }) => getTaskDiff(taskId, signal), retry: false });
  const summary: PatchSummary | null = useMemo(() => query.data ? splitPatch(query.data.patch) : null, [query.data]);
  if (query.isPending) return <p role="status">Reading the task diff…</p>;
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.details?.mode === 'direct') return <p className={styles.notice}>No base to compare against. Diff is unavailable in direct mode; Files and Preview remain available.</p>;
    return <p role="alert">The task diff could not be read: {query.error.message}</p>;
  }
  if (summary === null) return <p role="status">Preparing the patch…</p>;
  return <div className={styles.diff}>
    <p>{summary.files.length === 0 ? 'No changes against the base commit.' : `${summary.files.length} file(s) · +${summary.additions} −${summary.deletions}`}</p>
    {query.data.truncated ? <p className={styles.notice}>The patch was truncated by the server size limit; the displayed hunks may be incomplete.</p> : null}
    {summary.files.map((file) => (
      <article className={styles.diffFile} key={`${file.path}-${file.isDeleted ? 'deleted' : 'live'}`}>
        <header><button type="button" className={styles.fileButton} aria-pressed={selectedPath === file.path} onClick={() => onSelectFile(file.path)}>{file.path}</button>
          <span className={styles.badge}>{file.isNew ? 'added' : file.isDeleted ? 'deleted' : file.isRenamed ? 'renamed' : file.isBinary ? 'binary' : 'modified'}</span></header>
        {file.isBinary ? <p>Binary file; no text patch is available.</p> : <pre className={styles.patch}>{file.hunks.map((hunk, index) => <span className={styles.patchHunk} key={index}>{hunk.map((line, lineIndex) => {
          const sign = line.startsWith('+') ? '+' : line.startsWith('-') ? '−' : ' ';
          return <span className={styles.patchLine} key={lineIndex}><b aria-label={sign === ' ' ? 'context' : sign}>{sign} </b>{line.startsWith('+') || line.startsWith('-') ? line.slice(1) : line}{'\n'}</span>;
        })}</span>)}</pre>}
      </article>
    ))}
  </div>;
}

function PreviewView({ taskId, writeRevision, onOpenFiles }: { taskId: string; writeRevision: number; onOpenFiles: () => void }) {
  const client = useQueryClient();
  const status = useQuery({ queryKey: ['canvas', 'preview', taskId], queryFn: ({ signal }) => getPreviewStatus(taskId, signal), retry: false, refetchInterval: 10_000 });
  const root = useQuery({ queryKey: ['canvas', 'files', taskId, '.'], queryFn: ({ signal }) => getTaskFiles(taskId, '.', signal), retry: false });
  const [entry, setEntry] = useState('');
  const [reload, setReload] = useState(0);
  const [lastExpiry, setLastExpiry] = useState<number | null>(null);
  const [renewed, setRenewed] = useState(false);
  const [expired, setExpired] = useState(false);
  const previousRevision = useRef(writeRevision);
  const reloadTimer = useRef<number | null>(null);
  const htmlFiles = (root.data?.entries ?? []).filter((item) => item.type === 'file' && !item.path.includes('/') && /\.html?$/i.test(item.name));
  const preview = status.data?.preview ?? null;

  useEffect(() => {
    if (preview !== null) {
      setLastExpiry(preview.expiresAt);
      if (Date.now() < preview.expiresAt) setExpired(false);
    } else if (lastExpiry !== null && Date.now() >= lastExpiry) setExpired(true);
  }, [preview, lastExpiry]);

  useEffect(() => {
    if (previousRevision.current === writeRevision) return;
    previousRevision.current = writeRevision;
    if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => { reloadTimer.current = null; setReload((value) => value + 1); }, 350);
    return () => { if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current); };
  }, [writeRevision]);

  const refreshStatus = () => void client.invalidateQueries({ queryKey: ['canvas', 'preview', taskId] });
  const start = useMutation({ mutationFn: () => mintPreview(taskId), onSuccess: () => { setRenewed(true); refreshStatus(); } });
  const stop = useMutation({ mutationFn: () => revokePreview(taskId), onSuccess: refreshStatus });
  const activeEntry = entry || htmlFiles[0]?.path || '';
  const source = preview === null ? null : activeEntry === '' ? preview.url : entryUrl(preview.url, activeEntry);

  if (root.isError && root.error instanceof ApiError && root.error.status === 404) return <p className={styles.notice}>This task’s worktree is gone, so it no longer has a preview.</p>;
  if (status.isError && status.error instanceof ApiError && status.error.status === 404) return <p className={styles.notice}>This task’s worktree is gone, so it no longer has a preview.</p>;
  if (status.isPending || root.isPending) return <p role="status">Checking the task’s preview…</p>;
  if (root.isError) return <p role="alert">The task’s files could not be read: {root.error.message}</p>;
  if (htmlFiles.length === 0) return <div className={styles.stateBlock}><p>No HTML entry file at the task root, so there is nothing to preview.</p><button type="button" onClick={onOpenFiles}>Open Files</button></div>;

  const refusal = status.error ?? start.error;
  if (refusal instanceof ApiError && refusal.code === 'capability_disabled') {
    const setting = refusal.details?.setting;
    return <p className={styles.notice}>Previews are disabled on this host{typeof setting === 'string' ? <> by <code>{setting}</code>.</> : '.'}</p>;
  }
  if (status.isError && status.error instanceof ApiError && status.error.code === 'network_error') return <p role="alert">The preview listener is unreachable. Check that the preview service is running.</p>;
  if (refusal instanceof ApiError && refusal.status === 404) return <p className={styles.notice}>This task’s worktree is gone, so it no longer has a preview.</p>;
  if (status.isError) return <p role="alert">Preview status could not be read: {status.error.message}</p>;

  if (preview === null) return <div className={styles.stateBlock}>
    <p>{expired ? 'The preview session expired.' : 'No preview session exists for this task.'}</p>
    {start.error ? <p role="alert">Preview could not start: {start.error.message}</p> : null}
    <button type="button" disabled={start.isPending || (expired && renewed)} onClick={() => start.mutate()}>{start.isPending ? 'Starting preview…' : expired ? (renewed ? 'Preview already renewed' : 'Renew preview') : 'Start preview'}</button>
  </div>;

  if (expired || Date.now() >= preview.expiresAt) return <div className={styles.stateBlock}><p>The preview session expired.</p><button type="button" disabled={renewed || start.isPending} onClick={() => start.mutate()}>{renewed ? 'Preview already renewed' : 'Renew preview'}</button></div>;

  const origin = safeOrigin(preview.url);
  return <div className={styles.preview}>
    <div className={styles.toolbar}>
      <button type="button" onClick={() => setReload((value) => value + 1)}>Reload</button>
      <a href={source ?? preview.url} target="_blank" rel="noreferrer">Open in new tab</a>
      <label>Entry file <select aria-label="Preview entry file" value={activeEntry} onChange={(event) => { setEntry(event.target.value); setReload((value) => value + 1); }}>
        {htmlFiles.map((item) => <option key={item.path} value={item.path}>{item.name}</option>)}
      </select></label>
      <button type="button" disabled={stop.isPending} onClick={() => stop.mutate()}>{stop.isPending ? 'Stopping…' : 'Stop preview'}</button>
      {origin ? <span className={styles.origin}>{origin}</span> : null}
    </div>
    {start.error || stop.error ? <p role="alert">{(start.error ?? stop.error)?.message}</p> : null}
    <iframe key={reload} className={styles.iframe} src={source ?? preview.url} sandbox="allow-scripts allow-forms allow-pointer-lock" referrerPolicy="no-referrer" title={`Preview of task ${taskId}`} />
    <p className={styles.note}>A frame that stays blank may mean this app’s origin is missing from <code>HYPERION_APP_ORIGINS</code>, which controls <code>frame-ancestors</code>. A browser cannot reliably report that refusal to Hyperion.</p>
    <p className={styles.note}>Browser storage is unavailable inside this preview.</p>
  </div>;
}

function entryUrl(base: string, path: string): string {
  const url = new URL(base);
  const suffix = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${suffix}`;
  return url.toString();
}

function safeOrigin(value: string): string | null {
  try { return new URL(value).origin; } catch { return null; }
}
function ConsoleView() { return <p className={styles.note}>The preview console becomes available when a preview is running.</p>; }
