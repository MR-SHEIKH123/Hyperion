/**
 * Remembering an agent workspace's layout (1.39 A5), owned by the frame.
 *
 * Every occupant needs the same two things — the layout it was last left in, and
 * somewhere to write the one it has now — and the first occupant wrote the
 * translation itself: read `panelLayouts[tool]`, map `sizes.left`/`sizes.right`
 * into the frame's fields, filter `collapsed` against the panel union, and on every
 * change spread the other project fields back so they are not clobbered. That is
 * forty lines of store plumbing per tool, and the second occupant would have copied
 * them with one value changed.
 *
 * So it lives here. The stored shape stays generic (`sizes` is a record, not two
 * named fields) for the same reason it did before: the frame can add a panel
 * without a migration, and an unrecognised id written by a newer build is dropped
 * on read rather than cast into a union it does not belong to.
 *
 * Writes are debounced, like the draft hook: a drag reports once on release, but
 * folding three panels in a row should not rewrite the whole persisted state three
 * times. The pending write is flushed on unmount, so navigating away is not a way
 * to lose the last change.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { usePersistenceStore } from './PersistenceProvider';
import { WORKSPACE_PANEL_IDS } from '../../workspaces/AgentWorkspace.types';

import type { AgentWorkspaceTool, WorkspaceLayoutState } from '../../workspaces/AgentWorkspace.types';

const LAYOUT_DEBOUNCE_MS = 250;

export interface WorkspaceLayoutMemory {
  /** The remembered layout, or `undefined` when this tool has none yet. */
  initialLayout: WorkspaceLayoutState | undefined;
  onLayoutChange: (layout: WorkspaceLayoutState) => void;
}

function layoutFromStore(
  saved: { sizes: Record<string, number>; collapsed: string[] } | undefined,
): WorkspaceLayoutState | undefined {
  if (saved === undefined) return undefined;
  return {
    leftWidth: saved.sizes.left ?? 280,
    rightWidth: saved.sizes.right ?? 340,
    collapsed: saved.collapsed.filter((panel): panel is WorkspaceLayoutState['collapsed'][number] =>
      (WORKSPACE_PANEL_IDS as readonly string[]).includes(panel),
    ),
  };
}

function layoutToStore(layout: WorkspaceLayoutState): { sizes: Record<string, number>; collapsed: string[] } {
  return { sizes: { left: layout.leftWidth, right: layout.rightWidth }, collapsed: [...layout.collapsed] };
}

export function useWorkspaceLayout(tool: AgentWorkspaceTool): WorkspaceLayoutMemory {
  const store = usePersistenceStore();
  const [initialLayout] = useState(() => layoutFromStore(store.snapshot().projects['active']?.panelLayouts[tool]));
  const latest = useRef<WorkspaceLayoutState | null>(null);
  const timer = useRef<number | null>(null);

  const write = useCallback(() => {
    const layout = latest.current;
    if (layout === null) return;
    const previous = store.snapshot().projects['active'];
    store.setProject('active', {
      // Everything the layout does not own is carried across unchanged: the store
      // replaces a project record wholesale, so a spread that dropped a field
      // would silently erase another feature's memory.
      openViewIds: previous?.openViewIds ?? {},
      selectedViewIds: previous?.selectedViewIds ?? {},
      selectedModelIds: previous?.selectedModelIds ?? {},
      lastViewedVersions: previous?.lastViewedVersions ?? {},
      panelLayouts: { ...(previous?.panelLayouts ?? {}), [tool]: layoutToStore(layout) },
      lastTool: tool,
    });
  }, [store, tool]);

  const onLayoutChange = useCallback(
    (layout: WorkspaceLayoutState) => {
      latest.current = layout;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        write();
      }, LAYOUT_DEBOUNCE_MS);
    },
    [write],
  );

  useEffect(
    () => () => {
      if (timer.current === null) return;
      window.clearTimeout(timer.current);
      timer.current = null;
      write();
    },
    [write],
  );

  return { initialLayout, onLayoutChange };
}
