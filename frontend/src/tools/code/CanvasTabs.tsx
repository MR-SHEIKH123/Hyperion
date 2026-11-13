/**
 * The Code main surface's tab strip (Addendum 2.4): Overview keeps today's
 * content untouched; the other tabs are the Canvas views.
 *
 * **The frame is not extended.** The strip lives inside the frame's existing
 * `mainSurface` region — a tool *is* its surface, so the tabs are how one
 * surface shows several views, not a new region the frame would have to
 * register, fold or lay out (docs/CONTRACTS.md, Prompt 1.39 A3).
 *
 * **ARIA tabs, with automatic activation.** Roving `tabIndex` (one tab in the
 * tab order, the rest `-1`), `ArrowLeft`/`ArrowRight` wrapping, `Home`/`End`
 * to the ends — the pattern the brief names. Activation follows the focus
 * because each panel is a query over already-loaded routes: there is no
 * expensive switch for a manual Enter step to protect, and a panel that
 * appears on arrow-key focus is a panel the arrow key can also dismiss.
 *
 * **Panels mount on first visit and then stay mounted, hidden rather than
 * unmounted.** The preview's iframe must keep running while the Console tab is
 * being read — unmounting the Preview panel on tab switch would tear down the
 * very frame whose messages the Console exists to show. `hidden` removes the
 * panel from the accessibility tree and the tab order (a folded region's own
 * rule, same reasoning), while the DOM — and the live iframe — survives. The
 * first-visit half matters just as much: a hidden panel that had never been
 * opened must not have already spent its queries, or merely *rendering* the
 * strip would read the tree and poll the preview on behalf of a tab nobody
 * asked for.
 *
 * **No motion.** Tabs switch instantly. Nothing here declares a transition or
 * an animation, which is the strongest form of the reduced-motion promise:
 * `CanvasTabs.test.tsx` fails if one is ever added without the
 * `prefers-reduced-motion` guard the design system's `motion.css` would then
 * have to carry.
 */
import { useCallback, useRef, useState } from 'react';

import { DiffTab } from './DiffTab';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';
import { PreviewTab } from './PreviewTab';
import { ConsoleTab } from './ConsoleTab';
import { CANVAS_TABS, TAB_LABELS, type CanvasTab } from './useCanvasTab';
import styles from './CanvasTabs.module.css';

export interface CanvasTabsProps {
  taskId: string;
  /** The shared `?file=` selection — the same parameter the versions timeline reads. */
  file: string | null;
  activeTab: CanvasTab;
  onTabChange: (tab: CanvasTab) => void;
  /** Sets `?file=` in the surface (tree selection and the session panel share it). */
  onSelectFile: (path: string) => void;
  /**
   * The run stream's `artifact`-frame counter for this task — the Preview
   * tab reloads (debounced) when it moves, because a save is what an
   * artifact frame is.
   */
  writeRevision?: number;
  /**
   * The Console tab's Send-to-composer: fills the composer with the error
   * report and focuses it. Never submits — sending is the user's click.
   */
  onSendErrors: (text: string) => void;
  /** Overview's content — today's recovery/parked/spend region, unchanged. */
  children: React.ReactNode;
}

export function CanvasTabs({
  taskId,
  file,
  activeTab,
  onTabChange,
  onSelectFile,
  writeRevision = 0,
  onSendErrors,
  children,
}: CanvasTabsProps) {
  const tabRefs = useRef(new Map<CanvasTab, HTMLButtonElement>());
  const [visited, setVisited] = useState<ReadonlySet<CanvasTab>>(() => new Set(['overview' as const]));

  // The Preview tab's live frame, handed up so the Console gate can check
  // `event.source` against the window this surface actually loaded. A handle
  // only: cross-origin, it proves which frame spoke and reads nothing.
  const [frameWindow, setFrameWindow] = useState<Window | null>(null);
  const onFrameLoad = useCallback((win: Window | null) => {
    setFrameWindow(win);
  }, []);

  // The active tab is visited even when it was not clicked into from here:
  // the stored per-task tab restores straight to Files (or the surface's own
  // handlers, like the changed-file list, switch tabs directly), and a panel
  // that is on screen must not be an empty shell. Adjusting state when a prop
  // changes is the render-time pattern; an effect here would paint the empty
  // panel for a frame first.
  if (!visited.has(activeTab)) {
    setVisited(new Set([...visited, activeTab]));
  }

  const activate = (tab: CanvasTab): void => {
    setVisited((previous) => (previous.has(tab) ? previous : new Set(previous).add(tab)));
    onTabChange(tab);
  };

  const focusTab = (tab: CanvasTab): void => {
    activate(tab);
    tabRefs.current.get(tab)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: CanvasTab): void => {
    const index = CANVAS_TABS.indexOf(current);
    let next: CanvasTab | null = null;
    switch (event.key) {
      case 'ArrowRight':
        next = CANVAS_TABS[(index + 1) % CANVAS_TABS.length] ?? null;
        break;
      case 'ArrowLeft':
        next = CANVAS_TABS[(index + CANVAS_TABS.length - 1) % CANVAS_TABS.length] ?? null;
        break;
      case 'Home':
        next = CANVAS_TABS[0] ?? null;
        break;
      case 'End':
        next = CANVAS_TABS.at(-1) ?? null;
        break;
      default:
        break;
    }
    if (next !== null) {
      event.preventDefault();
      focusTab(next);
    }
  };

  return (
    <section className={styles.surface} aria-label={`Workspace for task ${taskId}`}>
      <div className={styles.strip} role="tablist" aria-label="Task workspace views">
        {CANVAS_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`canvas-tab-${id}`}
            className={id === activeTab ? styles.tabActive : styles.tab}
            aria-selected={id === activeTab}
            aria-controls={`canvas-panel-${id}`}
            tabIndex={id === activeTab ? 0 : -1}
            ref={(node) => {
              if (node === null) tabRefs.current.delete(id);
              else tabRefs.current.set(id, node);
            }}
            onClick={() => activate(id)}
            onKeyDown={(event) => onKeyDown(event, id)}
          >
            {TAB_LABELS[id]}
          </button>
        ))}
      </div>
      {CANVAS_TABS.map((id) => (
        <div
          key={id}
          role="tabpanel"
          id={`canvas-panel-${id}`}
          aria-labelledby={`canvas-tab-${id}`}
          className={styles.panel}
          tabIndex={id === activeTab ? 0 : -1}
          hidden={id !== activeTab}
        >
          {visited.has(id) ? (
            id === 'overview' ? (
              children
            ) : id === 'files' ? (
              <FilesTab taskId={taskId} file={file} onSelectFile={onSelectFile} />
            ) : id === 'diff' ? (
              <DiffTab taskId={taskId} file={file} onSelectFile={onSelectFile} />
            ) : id === 'console' ? (
              <ConsoleTab frameWindow={frameWindow} onSendErrors={onSendErrors} />
            ) : (
              <PreviewTab
                taskId={taskId}
                writeRevision={writeRevision}
                onOpenFiles={() => activate('files')}
                onFrameLoad={onFrameLoad}
              />
            )
          ) : null}
        </div>
      ))}
    </section>
  );
}

/**
 * The Files tab: the tree beside the viewer, both driven by the shared
 * `?file=` selection so this tab and the versions timeline can never
 * disagree about which file is meant.
 */
function FilesTab({
  taskId,
  file,
  onSelectFile,
}: {
  taskId: string;
  file: string | null;
  onSelectFile: (path: string) => void;
}) {
  return (
    <div className={styles.filesLayout}>
      <FileTree taskId={taskId} selectedPath={file} onSelect={onSelectFile} />
      <FileViewer taskId={taskId} path={file} />
    </div>
  );
}
