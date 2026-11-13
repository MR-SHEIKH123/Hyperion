/**
 * The Code main surface's tab strip, and the memory of which tab a task was
 * left on (safe presentation state, Prompt 1.39 A5).
 *
 * **The vocabulary lives here, beside its persistence.** `CanvasTabs` renders
 * the strip, but the set of tabs, their validation on read and the key they
 * are stored under are one contract — splitting them across files is how a
 * stored tab the build no longer recognises becomes a crash instead of a
 * dropped preference.
 *
 * **What is stored, and what is not.** One string per task under
 * `selectedViewIds['code-task:<id>']`, exactly like the shell's other
 * presentation memory: an unknown value (a tab renamed by a later build, or a
 * value written by hand) is dropped on read and falls back to `overview` —
 * the same rule `useWorkspaceLayout` applies to stored panel ids, because it
 * costs the user one reopen, where a crash on load costs everything. Never a
 * URL, never file content, never anything the persistence safety walk would
 * (rightly) refuse: the value is a tab name and nothing else.
 *
 * **Read during render, written on change.** The store is an in-memory
 * snapshot, so reading it when the task changes avoids the frame where the
 * previous task's tab would paint under the new one; the write carries every
 * other project field across unchanged, because the store replaces the record
 * wholesale and a spread that dropped a field would silently erase another
 * feature's memory.
 */
import { useCallback, useState } from 'react';

import { usePersistenceStore } from '../../state/persistence/PersistenceProvider';

/** Every tab of the Code main surface, in strip order. */
export const CANVAS_TABS = ['overview', 'files', 'diff'] as const;

export type CanvasTab = (typeof CANVAS_TABS)[number];

export const TAB_LABELS: Record<CanvasTab, string> = {
  overview: 'Overview',
  files: 'Files',
  diff: 'Diff',
};

const keyFor = (taskId: string): string => `code-task:${taskId}`;

/** A stored tab the build recognises, or `overview`. Dropped, never cast. */
function safeTab(value: string | undefined): CanvasTab {
  return value !== undefined && (CANVAS_TABS as readonly string[]).includes(value)
    ? (value as CanvasTab)
    : 'overview';
}

function readTab(
  store: ReturnType<typeof usePersistenceStore>,
  taskId: string,
): CanvasTab {
  return safeTab(store.snapshot().projects['active']?.selectedViewIds[keyFor(taskId)]);
}

export function useCanvasTab(taskId: string): readonly [CanvasTab, (tab: CanvasTab) => void] {
  const store = usePersistenceStore();
  const [state, setState] = useState(() => ({ taskId, tab: readTab(store, taskId) }));

  // Adjust during render rather than re-reading in an effect: an effect would
  // paint the previous task's tab for a frame first, and the effect-body reset
  // this replaces is exactly what `react-hooks/set-state-in-effect` flags.
  if (state.taskId !== taskId) {
    setState({ taskId, tab: readTab(store, taskId) });
  }

  const setTab = useCallback(
    (tab: CanvasTab) => {
      setState({ taskId, tab });
      const previous = store.snapshot().projects['active'];
      store.setProject('active', {
        // Every other field carried across unchanged: the store replaces the
        // project record wholesale (see `useWorkspaceLayout.write`).
        openViewIds: previous?.openViewIds ?? {},
        selectedViewIds: { ...(previous?.selectedViewIds ?? {}), [keyFor(taskId)]: tab },
        selectedModelIds: previous?.selectedModelIds ?? {},
        panelLayouts: previous?.panelLayouts ?? {},
        lastViewedVersions: previous?.lastViewedVersions ?? {},
        ...(previous?.lastTool === undefined ? {} : { lastTool: previous.lastTool }),
      });
    },
    [store, taskId],
  );

  return [state.tab, setTab] as const;
}
