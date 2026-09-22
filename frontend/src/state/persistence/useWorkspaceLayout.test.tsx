import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';

import { PersistenceProvider } from './PersistenceProvider';
import { PersistenceStore, type StorageLike } from './storage';
import { useWorkspaceLayout } from './useWorkspaceLayout';

import type { AgentWorkspaceTool, WorkspaceLayoutState } from '../../workspaces/AgentWorkspace.types';

/**
 * Remembering a workspace layout (1.39 A5).
 *
 * The frame reports one layout per decision; this hook is what turns those
 * reports into a remembered per-tool layout, and the first occupant used to do it
 * itself — which is why these tests are about the *store*, not the frame: a
 * translation that reads the right field but writes over its neighbours is the
 * failure mode they exist to catch.
 */
class MemoryStorage implements StorageLike {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

/** The same store, counting writes: "no write" is a behaviour, not an absence. */
class CountingStorage extends MemoryStorage {
  writes = 0;
  override setItem(key: string, value: string): void {
    this.writes += 1;
    super.setItem(key, value);
  }
}

const layout = (store: PersistenceStore, tool: AgentWorkspaceTool = 'code') =>
  store.snapshot().projects['active']?.panelLayouts[tool];

function setup(tool: AgentWorkspaceTool = 'code', seed?: (store: PersistenceStore) => void) {
  const store = new PersistenceStore(new MemoryStorage());
  seed?.(store);
  const wrapper = ({ children }: PropsWithChildren) => <PersistenceProvider store={store}>{children}</PersistenceProvider>;
  const hook = renderHook(() => useWorkspaceLayout(tool), { wrapper });
  return { store, hook };
}

const STATE: WorkspaceLayoutState = { leftWidth: 312, rightWidth: 400, collapsed: ['inspector'] };

afterEach(() => {
  vi.useRealTimers();
});

describe('workspace layout memory', () => {
  it('has nothing to restore for a tool that was never opened', () => {
    const { hook } = setup();
    expect(hook.result.current.initialLayout).toBeUndefined();
  });

  it('reads a remembered layout back into the frame’s field names', () => {
    const { hook } = setup('code', (store) =>
      store.setProject('active', {
        openViewIds: {},
        selectedViewIds: {},
        selectedModelIds: {},
        lastViewedVersions: {},
        panelLayouts: { code: { sizes: { left: 300, right: 512 }, collapsed: ['taskRail'] } },
      }),
    );
    expect(hook.result.current.initialLayout).toEqual({ leftWidth: 300, rightWidth: 512, collapsed: ['taskRail'] });
  });

  it('drops a panel id it does not know rather than casting it into the union', () => {
    // A newer build may remember a panel that this one has never heard of. Reading
    // it through would put a string into a union it does not belong to; dropping it
    // costs the user one fold, which is recoverable, unlike a crash on load.
    const { hook } = setup('code', (store) =>
      store.setProject('active', {
        openViewIds: {},
        selectedViewIds: {},
        selectedModelIds: {},
        lastViewedVersions: {},
        panelLayouts: { code: { sizes: { left: 280, right: 340 }, collapsed: ['taskRail', 'futurePanel'] } },
      }),
    );
    expect(hook.result.current.initialLayout?.collapsed).toEqual(['taskRail']);
  });

  it('writes a layout only after the user stops moving things', () => {
    vi.useFakeTimers();
    const { store, hook } = setup();

    act(() => hook.result.current.onLayoutChange({ ...STATE, leftWidth: 300 }));
    act(() => hook.result.current.onLayoutChange(STATE));
    // Two reports inside one debounce window are one write, and the write is the
    // *last* state: persisting both would store a layout that was already stale.
    expect(layout(store)).toBeUndefined();

    // Still nothing most of the way through the window: the point is not merely
    // that the write is deferred to a later tick, it is that a burst of drag
    // reports collapses into one write.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(layout(store)).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(layout(store)).toEqual({ sizes: { left: 312, right: 400 }, collapsed: ['inspector'] });
  });

  it('flushes a pending write when the workspace goes away', () => {
    vi.useFakeTimers();
    const { store, hook } = setup();
    act(() => hook.result.current.onLayoutChange(STATE));

    // Navigating away mid-drag is not a reason to lose the drag: the timer is
    // cancelled on unmount only after the pending layout has been written.
    hook.unmount();
    expect(layout(store)).toEqual({ sizes: { left: 312, right: 400 }, collapsed: ['inspector'] });
  });

  it('records the visit without inventing a layout', () => {
    const { store, hook } = setup();
    hook.unmount();
    // Mounting *is* information: it is the tool the user was in, which is what the
    // shell restores on entry (`EntryRedirect`). What must not appear is geometry —
    // nothing was moved, so there is no layout to remember, and a record that carried
    // defaults would make the frame open at a size the user never chose.
    expect(store.snapshot().projects['active']).toEqual({
      openViewIds: {},
      selectedViewIds: {},
      selectedModelIds: {},
      lastViewedVersions: {},
      panelLayouts: {},
      lastTool: 'code',
    });
    expect(layout(store)).toBeUndefined();
  });

  it('does not rewrite the record when it already names this tool', () => {
    // A remount (React's strict mode mounts twice, and a route transition remounts)
    // must not churn the store to say what it already said.
    const storage = new CountingStorage();
    const store = new PersistenceStore(storage);
    const wrapper = ({ children }: PropsWithChildren) => <PersistenceProvider store={store}>{children}</PersistenceProvider>;
    renderHook(() => useWorkspaceLayout('code'), { wrapper });
    expect(storage.writes).toBeGreaterThan(0);
    const writesAfterFirstVisit = storage.writes;
    const second = renderHook(() => useWorkspaceLayout('code'), { wrapper });
    second.unmount();
    expect(storage.writes).toBe(writesAfterFirstVisit);
  });

  it('carries every other field of the project record across a write', () => {
    vi.useFakeTimers();
    const { store, hook } = setup('code', (store) =>
      store.setProject('active', {
        lastTool: 'cowork',
        openViewIds: { code: ['view-a'] },
        selectedViewIds: { code: 'view-a' },
        selectedModelIds: { chat: 'gpt-5.4-nano' },
        lastViewedVersions: { 'artifact:1': 3 },
        panelLayouts: { cowork: { sizes: { left: 260, right: 300 }, collapsed: [] } },
      }),
    );

    act(() => hook.result.current.onLayoutChange(STATE));
    act(() => {
      vi.advanceTimersByTime(250);
    });

    const project = store.snapshot().projects['active'];
    // The store replaces a project record wholesale, so a spread that dropped a
    // field would silently erase another feature's memory — which is exactly what
    // the first occupant's hand-written version risked on every edit.
    expect(project).toMatchObject({
      openViewIds: { code: ['view-a'] },
      selectedViewIds: { code: 'view-a' },
      selectedModelIds: { chat: 'gpt-5.4-nano' },
      lastViewedVersions: { 'artifact:1': 3 },
    });
    // Another tool's layout survives: tools remember their own geometry.
    expect(project?.panelLayouts['cowork']).toEqual({ sizes: { left: 260, right: 300 }, collapsed: [] });
    expect(project?.panelLayouts['code']).toEqual({ sizes: { left: 312, right: 400 }, collapsed: ['inspector'] });
    expect(project?.lastTool).toBe('code');
  });

  it('keeps each tool’s layout separate', () => {
    vi.useFakeTimers();
    const { store, hook } = setup('design');
    act(() => hook.result.current.onLayoutChange(STATE));
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(layout(store, 'code')).toBeUndefined();
    expect(layout(store, 'design')).toEqual({ sizes: { left: 312, right: 400 }, collapsed: ['inspector'] });
  });
});
