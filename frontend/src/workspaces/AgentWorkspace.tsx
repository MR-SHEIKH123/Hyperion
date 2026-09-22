/**
 * The frame every agent tool is mounted in — the case, not a page template.
 *
 * Its shape comes from one observation: Code, Cowork and Design are the same
 * *kind* of thing. Each watches a task rail, shows one surface, streams progress,
 * inspects what was produced, and takes its next instruction in a composer. Three
 * separate layouts would drift on exactly the parts a user learns once — where the
 * rail is, what the status line means, which key resizes a panel — so the eight
 * regions are defined here and an occupant fills them.
 *
 * Four things this file owns, because a frame that left them to its occupants
 * would not be one:
 *
 *   - **The regions.** `taskRail`, `contextExplorer`, `mainSurface`,
 *     `progressStream`, `inspector`, `versionTimeline`, `composer`,
 *     `statusBanner`. Optional ones may be omitted; the layout is valid either
 *     way, so a tool with no version history does not render an empty box.
 *   - **The geometry.** Widths are clamped, resizable by pointer drag (with
 *     pointer capture, so a fast drag does not outrun the handle) and by keyboard,
 *     and reset by double-click. A drag reports **once, on release**: a resize is
 *     one decision, and the persistence layer should not see eighty of them.
 *   - **Folding.** Panels can be collapsed and expanded, and the collapsed set is
 *     part of the reported layout. A collapsed panel is *not rendered* — not
 *     hidden — so nothing focusable lives inside a folded region.
 *   - **Focus targets.** `focusPanel` expands a folded panel before focusing it,
 *     which is what makes a deep link into a panel the user has folded away still
 *     arrive where it promised.
 *
 * Not owned here: which tool is open, what it shows, and what is remembered. The
 * occupant supplies the content; `useWorkspaceLayout` supplies persistence.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { WORKSPACE_PANEL_IDS } from './AgentWorkspace.types';
import styles from './AgentWorkspace.module.css';

import type {
  AgentWorkspaceDefinition,
  AgentWorkspaceHandle,
  WorkspaceLayoutState,
  WorkspacePanelId,
} from './AgentWorkspace.types';

export interface AgentWorkspaceProps {
  definition: AgentWorkspaceDefinition;
  initialLayout?: Partial<WorkspaceLayoutState>;
  onLayoutChange?: (layout: WorkspaceLayoutState) => void;
}

type WorkspaceStyle = CSSProperties & {
  '--left-width': string;
  '--right-width': string;
};

/** Pointer clamp for a side column; the keyboard path uses the same range. */
const MIN_WIDTH = 240;
const MAX_WIDTH = 520;
const DEFAULT_LEFT = 280;
const DEFAULT_RIGHT = 340;
/** Width of a side column whose panels are all folded away. */
const FOLDED_WIDTH = 44;
/** One keyboard step, and half of one pointer step's worth of predictability. */
const KEY_STEP = 16;

/** Where a double-click on a separator returns that column to. */
const DEFAULTS: Record<'left' | 'right', number> = { left: DEFAULT_LEFT, right: DEFAULT_RIGHT };

const clamp = (value: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));

/** The pointer-capture API, as something that may not be there. */
type CaptureTarget = HTMLElement & {
  setPointerCapture?: (pointerId: number) => void;
  hasPointerCapture?: (pointerId: number) => boolean;
  releasePointerCapture?: (pointerId: number) => void;
};

/**
 * Take pointer capture if the environment offers it, and carry on if it does not.
 *
 * Capture is what keeps a drag alive when the pointer outruns the 9px handle, but
 * it is not what makes the drag *work*, and the call can fail for a reason that has
 * nothing to do with the user: the spec throws `InvalidPointerId` for a pointer
 * that is not active, and jsdom — where this frame is tested — has no
 * implementation at all. A resize that throws on pointer-down is a worse failure
 * than one that stops at the edge of the handle, so a missing or refusing API is
 * tolerated and the drag continues uncaptured.
 */
const capturePointer = (node: HTMLElement, pointerId: number): void => {
  try {
    (node as CaptureTarget).setPointerCapture?.(pointerId);
  } catch {
    // Deliberately ignored: see above.
  }
};

const releasePointer = (node: HTMLElement, pointerId: number): void => {
  const target = node as CaptureTarget;
  try {
    if (target.hasPointerCapture?.(pointerId) === true) target.releasePointerCapture?.(pointerId);
  } catch {
    // Already released, or never captured. Either way there is nothing to do.
  }
};

/**
 * Which regions may be folded.
 *
 * `mainSurface`, `composer` and `statusBanner` are deliberately not in this list.
 * A tool is *for* its main surface, so folding it leaves a frame with nothing to
 * look at; the composer is where the next instruction is given and hiding it is
 * how a user concludes the surface is read-only; and the status line carries the
 * task's state, which is the one thing that must not be hideable while a run is
 * parked or stopped.
 */
const FOLDABLE: readonly WorkspacePanelId[] = [
  'taskRail',
  'contextExplorer',
  'progressStream',
  'inspector',
  'versionTimeline',
];

export const AgentWorkspace = forwardRef<AgentWorkspaceHandle, AgentWorkspaceProps>(
  function AgentWorkspace({ definition, initialLayout, onLayoutChange }, ref) {
    const [layout, setLayout] = useState<WorkspaceLayoutState>(() => ({
      leftWidth: clamp(initialLayout?.leftWidth ?? DEFAULT_LEFT),
      rightWidth: clamp(initialLayout?.rightWidth ?? DEFAULT_RIGHT),
      collapsed: (initialLayout?.collapsed ?? []).filter((panel) => FOLDABLE.includes(panel)),
    }));

    const regions = useRef(new Map<WorkspacePanelId, HTMLElement>());
    const dragging = useRef<{ side: 'left' | 'right'; startX: number; startWidth: number } | null>(null);
    const [pendingFocus, setPendingFocus] = useState<WorkspacePanelId | null>(null);

    const present = useMemo(
      () =>
        new Set<WorkspacePanelId>([
          'taskRail',
          'mainSurface',
          'progressStream',
          'composer',
          ...(definition.contextExplorer === undefined ? [] : (['contextExplorer'] as WorkspacePanelId[])),
          ...(definition.inspector === undefined ? [] : (['inspector'] as WorkspacePanelId[])),
          ...(definition.versionTimeline === undefined ? [] : (['versionTimeline'] as WorkspacePanelId[])),
          ...(definition.statusBanner === undefined ? [] : (['statusBanner'] as WorkspacePanelId[])),
        ]),
      [definition],
    );

    /**
     * Which panels may fold *here*: a foldable region that the occupant supplied
     * and that the definition did not opt out of. `collapsible` narrows the
     * default rather than replacing it, so an occupant cannot accidentally make
     * the task rail unfoldable by forgetting the field.
     */
    const foldableHere = useMemo(() => {
      const requested = definition.collapsible ?? FOLDABLE;
      return new Set(FOLDABLE.filter((panel) => present.has(panel) && requested.includes(panel)));
    }, [definition.collapsible, present]);

    const folded = useMemo(
      () => layout.collapsed.filter((panel) => foldableHere.has(panel)),
      [layout.collapsed, foldableHere],
    );

    const report = useCallback(
      (next: WorkspaceLayoutState) => {
        onLayoutChange?.(next);
        return next;
      },
      [onLayoutChange],
    );

    const setWidth = useCallback(
      (side: 'left' | 'right', width: number) => {
        const clamped = clamp(width);
        setLayout((current) => {
          const next = { ...current, [side === 'left' ? 'leftWidth' : 'rightWidth']: clamped };
          return current[side === 'left' ? 'leftWidth' : 'rightWidth'] === clamped ? current : next;
        });
      },
      [],
    );

    const commitWidth = useCallback(
      (side: 'left' | 'right', width: number) => {
        const clamped = clamp(width);
        setLayout((current) => report({ ...current, [side === 'left' ? 'leftWidth' : 'rightWidth']: clamped }));
      },
      [report],
    );

    const togglePanel = useCallback(
      (panel: WorkspacePanelId) => {
        setLayout((current) => {
          const collapsed = current.collapsed.includes(panel)
            ? current.collapsed.filter((entry) => entry !== panel)
            : [...current.collapsed, panel];
          return report({ ...current, collapsed });
        });
      },
      [report],
    );

    const expandPanel = useCallback(
      (panel: WorkspacePanelId) => {
        setLayout((current) =>
          current.collapsed.includes(panel)
            ? { ...current, collapsed: current.collapsed.filter((entry) => entry !== panel) }
            : current,
        );
      },
      [],
    );

    const register = (id: WorkspacePanelId) => (node: HTMLElement | null) => {
      if (node === null) regions.current.delete(id);
      else regions.current.set(id, node);
    };

    useImperativeHandle(
      ref,
      () => ({
        focusPanel(panel) {
          if (!present.has(panel)) return false;
          if (folded.includes(panel)) {
            // A folded panel has no DOM to focus, so the fold is opened first and
            // the focus lands once it exists. Returning `true` is the honest
            // answer: the request will be honoured, not ignored.
            expandPanel(panel);
            setPendingFocus(panel);
            return true;
          }
          regions.current.get(panel)?.focus();
          return regions.current.has(panel);
        },
      }),
      [present, folded, expandPanel],
    );

    useEffect(() => {
      if (pendingFocus === null) return;
      const node = regions.current.get(pendingFocus);
      if (node === undefined) return;
      node.focus();
      setPendingFocus(null);
    }, [pendingFocus, layout.collapsed]);

    // --- pointer resizing ----------------------------------------------------

    const startDrag = (side: 'left' | 'right') => (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      // Capture so a fast drag that leaves the 9px handle keeps resizing rather
      // than stopping the moment the pointer outruns the separator.
      capturePointer(event.currentTarget, event.pointerId);
      dragging.current = {
        side,
        startX: event.clientX,
        startWidth: side === 'left' ? layout.leftWidth : layout.rightWidth,
      };
    };

    const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragging.current;
      if (drag === null) return;
      // The right column grows as the pointer moves left, because its separator
      // sits on the column's outer edge.
      const delta = event.clientX - drag.startX;
      setWidth(drag.side, drag.startWidth + (drag.side === 'left' ? delta : -delta));
    };

    const endDrag = (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragging.current;
      if (drag === null) return;
      dragging.current = null;
      releasePointer(event.currentTarget, event.pointerId);
      const delta = event.clientX - drag.startX;
      // One report per drag: a resize is one decision, and the persistence layer
      // should not see every intermediate pixel.
      commitWidth(drag.side, drag.startWidth + (drag.side === 'left' ? delta : -delta));
    };

    const resetWidth = (side: 'left' | 'right') => () => {
      commitWidth(side, DEFAULTS[side]);
    };

    const resizeKey = (side: 'left' | 'right') => (event: KeyboardEvent<HTMLDivElement>) => {
      const current = side === 'left' ? layout.leftWidth : layout.rightWidth;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        commitWidth(side, current + (side === 'left' ? -KEY_STEP : KEY_STEP));
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        commitWidth(side, current + (side === 'left' ? KEY_STEP : -KEY_STEP));
      }
    };

    // --- regions ------------------------------------------------------------

    const panel = (id: WorkspacePanelId, label: string, content: ReactNode) => {
      const isFolded = folded.includes(id);
      const canFold = foldableHere.has(id);
      return (
        <section
          ref={register(id)}
          id={`region-${id}`}
          tabIndex={-1}
          data-panel={id}
          data-folded={isFolded ? 'true' : undefined}
          aria-label={label}
          className={`${styles.panel} ${styles.region} ${isFolded ? styles.panelFolded : ''}`}
        >
          {canFold && (
            <button
              type="button"
              className={styles.fold}
              aria-expanded={!isFolded}
              aria-controls={`region-${id}`}
              aria-label={isFolded ? `Show ${label} panel` : `Hide ${label} panel`}
              title={isFolded ? `Show ${label}` : `Hide ${label}`}
              onClick={() => togglePanel(id)}
            >
              {isFolded ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            </button>
          )}
          {/* Folded means absent, not hidden: a collapsed region must not keep
              focusable content in the tab order or in the accessibility tree. */}
          {!isFolded && <div className={styles.panelBody}>{content}</div>}
          {isFolded && <span className={styles.foldedLabel}>{label}</span>}
        </section>
      );
    };

    const leftFolded = folded.includes('taskRail') && (definition.contextExplorer === undefined || folded.includes('contextExplorer'));
    const rightFolded =
      (definition.inspector === undefined || folded.includes('inspector')) &&
      (definition.versionTimeline === undefined || folded.includes('versionTimeline'));
    const hasRightColumn = definition.inspector !== undefined || definition.versionTimeline !== undefined;
    const style: WorkspaceStyle = {
      '--left-width': `${leftFolded ? FOLDED_WIDTH : layout.leftWidth}px`,
      '--right-width': `${hasRightColumn && rightFolded ? FOLDED_WIDTH : layout.rightWidth}px`,
    };

    return (
      <div className={styles.frame} data-tool={definition.tool}>
        <div
          className={styles.workspace}
          style={style}
          data-progress={folded.includes('progressStream') ? 'folded' : 'open'}
          data-left={leftFolded ? 'folded' : 'open'}
          data-right={hasRightColumn ? (rightFolded ? 'folded' : 'open') : 'absent'}
        >
          {definition.statusBanner !== undefined && (
            <div className={styles.status}>{panel('statusBanner', 'Task status', definition.statusBanner)}</div>
          )}

          <aside className={styles.left} aria-label={`${definition.tool} navigation`}>
            {panel('taskRail', 'Tasks', definition.taskRail)}
            {definition.contextExplorer !== undefined && panel('contextExplorer', 'Context explorer', definition.contextExplorer)}
          </aside>

          <main className={styles.main}>
            {panel('mainSurface', 'Main workspace', definition.mainSurface)}
            {panel('progressStream', 'Task progress', definition.progressStream)}
          </main>

          {hasRightColumn && (
            <aside className={styles.right} aria-label={`${definition.tool} inspector`}>
              {definition.inspector !== undefined && panel('inspector', 'Inspector', definition.inspector)}
              {definition.versionTimeline !== undefined && panel('versionTimeline', 'Version timeline', definition.versionTimeline)}
            </aside>
          )}

          <div className={styles.composer}>{panel('composer', 'Task composer', definition.composer)}</div>
        </div>

        {/* ARIA's separator pattern is focusable when it controls a resizable split
            pane — WAI-ARIA's own window-splitter example does exactly this — which
            is why two a11y rules have to be switched off on the two attributes
            below: they read `separator` as the *static* separator and so see a
            non-interactive element with handlers and a tab stop. The pointer path
            and the keyboard path share one clamp and one reporting rule, so they
            cannot disagree about where a panel ends up. */}{' '}
        {!leftFolded && (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a *focusable* separator is interactive by ARIA design
          <div
            className={styles.resizeLeft}
            role="separator"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable by ARIA design: a split pane's separator
            tabIndex={0}
            aria-label="Resize navigation panels"
            aria-orientation="vertical"
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={MAX_WIDTH}
            aria-valuenow={layout.leftWidth}
            onKeyDown={resizeKey('left')}
            onPointerDown={startDrag('left')}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={resetWidth('left')}
          />
        )}
        {hasRightColumn && !rightFolded && (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a *focusable* separator is interactive by ARIA design
          <div
            className={styles.resizeRight}
            role="separator"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable by ARIA design: a split pane's separator
            tabIndex={0}
            aria-label="Resize inspector panels"
            aria-orientation="vertical"
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={MAX_WIDTH}
            aria-valuenow={layout.rightWidth}
            onKeyDown={resizeKey('right')}
            onPointerDown={startDrag('right')}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={resetWidth('right')}
          />
        )}
      </div>
    );
  },
);

/** Re-exported so a caller can check a stored panel id without reaching into the types. */
export { WORKSPACE_PANEL_IDS };
