import { useCallback, useEffect, useState } from 'react';

import { usePersistenceStore } from '../../state/persistence/PersistenceProvider';
import { CANVAS_TABS, type CanvasTab } from './CanvasTabs';

const keyFor = (taskId: string) => `code-task:${taskId}`;
function safeTab(value: string | undefined): CanvasTab {
  return value !== undefined && (CANVAS_TABS as readonly string[]).includes(value) ? value as CanvasTab : 'overview';
}

/** Safe presentation preference only: never store preview URLs or file content. */
export function useCanvasTab(taskId: string) {
  const store = usePersistenceStore();
  const [tab, setTabState] = useState(() => safeTab(store.snapshot().projects.active?.selectedViewIds[keyFor(taskId)]));

  useEffect(() => {
    setTabState(safeTab(store.snapshot().projects.active?.selectedViewIds[keyFor(taskId)]));
  }, [store, taskId]);

  const setTab = useCallback((next: CanvasTab) => {
    setTabState(next);
    const previous = store.snapshot().projects.active;
    store.setProject('active', {
      openViewIds: previous?.openViewIds ?? {},
      selectedViewIds: { ...(previous?.selectedViewIds ?? {}), [keyFor(taskId)]: next },
      selectedModelIds: previous?.selectedModelIds ?? {},
      panelLayouts: previous?.panelLayouts ?? {},
      lastViewedVersions: previous?.lastViewedVersions ?? {},
      ...(previous?.lastTool === undefined ? {} : { lastTool: previous.lastTool }),
    });
  }, [store, taskId]);

  return [tab, setTab] as const;
}
