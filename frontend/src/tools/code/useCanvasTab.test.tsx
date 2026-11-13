import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useCanvasTab } from './useCanvasTab';
import { PERSISTENCE_KEY, PersistenceStore, type StorageLike } from '../../state/persistence/storage';
import { PersistenceProvider } from '../../state/persistence/PersistenceProvider';

/**
 * The tab's persistence contract (1.39 A5, safe presentation state).
 *
 * The claims worth pinning are the ones a plausible implementation gets
 * wrong: that the stored value is *validated* rather than cast (a value from
 * a build with different tabs must degrade to Overview, not crash), that the
 * key is namespaced per task, and that writing the tab carries every other
 * field of the project record across — the store replaces the record
 * wholesale, so a spread that dropped one would erase another feature's
 * memory while every test of *this* feature stayed green.
 */

class MemoryStorage implements StorageLike {
  private data = new Map<string, string>();
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

function setup(initial?: string) {
  const storage = new MemoryStorage();
  if (initial !== undefined) storage.setItem(PERSISTENCE_KEY, initial);
  const store = new PersistenceStore(storage);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <PersistenceProvider store={store}>{children}</PersistenceProvider>
  );
  const hook = renderHook(() => useCanvasTab('task-1'), { wrapper });
  return { store, hook };
}

// The two record fields the persisted schema has no default for — everything
// else fills in, and a payload missing these is read as corrupt, not partial.
const stored = (tab: string): string =>
  JSON.stringify({
    version: 1,
    projects: { active: { selectedViewIds: { 'code-task:task-1': tab } } },
    drafts: {},
    navigationHints: [],
  });

describe('useCanvasTab', () => {
  it('starts on Overview when nothing is stored', () => {
    const { hook } = setup();
    expect(hook.result.current[0]).toBe('overview');
  });

  it('restores the stored tab for the task', () => {
    const { hook } = setup(stored('files'));
    expect(hook.result.current[0]).toBe('files');
  });

  it('drops a value it does not know instead of casting it', () => {
    const { hook } = setup(stored('a-tab-from-the-future'));
    expect(hook.result.current[0]).toBe('overview');
  });

  it('writes the tab under its per-task key and carries every other record field across', () => {
    const { store, hook } = setup();
    store.setProject('active', {
      openViewIds: { 'code-task:task-9': ['files'] },
      selectedViewIds: { 'code-task:task-9': 'files', 'shell:last': 'activity' },
      selectedModelIds: { chat: 'model-a' },
      panelLayouts: { chat: { sizes: { composer: 40 }, collapsed: ['inspector'] } },
      lastViewedVersions: { '/x': 7 },
      lastTool: 'chat',
    });

    act(() => {
      hook.result.current[1]('files');
    });

    const project = store.snapshot().projects.active;
    expect(project?.selectedViewIds['code-task:task-1']).toBe('files');
    // The neighbouring keys survive: the write is a carried-fields update,
    // not a replacement of the record.
    expect(project?.selectedViewIds['code-task:task-9']).toBe('files');
    expect(project?.selectedViewIds['shell:last']).toBe('activity');
    expect(project?.openViewIds['code-task:task-9']).toEqual(['files']);
    expect(project?.selectedModelIds.chat).toBe('model-a');
    expect(project?.panelLayouts.chat?.collapsed).toEqual(['inspector']);
    expect(project?.lastViewedVersions['/x']).toBe(7);
    expect(project?.lastTool).toBe('chat');
    // And nothing URL-shaped was written anywhere: the value is a tab name.
    expect(JSON.stringify(store.snapshot())).not.toContain('http');
  });

  it('keeps each task on its own tab', () => {
    const storage = new MemoryStorage();
    const store = new PersistenceStore(storage);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PersistenceProvider store={store}>{children}</PersistenceProvider>
    );
    const first = renderHook(() => useCanvasTab('task-1'), { wrapper });
    act(() => {
      first.result.current[1]('files');
    });

    const second = renderHook(() => useCanvasTab('task-2'), { wrapper });
    expect(second.result.current[0]).toBe('overview');
    expect(first.result.current[0]).toBe('files');
  });
});
