import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { EntryRedirect } from './EntryRedirect';
import { PersistenceProvider } from '../state/persistence/PersistenceProvider';
import { PersistenceStore, type StorageLike } from '../state/persistence/storage';

/**
 * Where the shell lands on a bare entry (1.39 A5).
 *
 * `lastTool` was recorded and never read; these cases are what makes reading it
 * safe — a placeholder is not restored, a typed URL never goes through here, and a
 * value that was never written still lands somewhere real.
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

function renderEntry(seed?: (store: PersistenceStore) => void) {
  const store = new PersistenceStore(new MemoryStorage());
  seed?.(store);
  const view = render(
    <PersistenceProvider store={store}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<EntryRedirect />} />
          <Route path="/chat" element={<p>the chat surface</p>} />
          <Route path="/code" element={<p>the code surface</p>} />
          <Route path="/attention" element={<p>the attention queue</p>} />
          <Route path="/settings" element={<p>the settings placeholder</p>} />
        </Routes>
      </MemoryRouter>
    </PersistenceProvider>,
  );
  return { store, view };
}

const visited = (tool: string) => (store: PersistenceStore) =>
  store.setProject('active', {
    openViewIds: {},
    selectedViewIds: {},
    selectedModelIds: {},
    lastViewedVersions: {},
    panelLayouts: {},
    lastTool: tool as 'chat',
  });

describe('the shell’s entry route', () => {
  it('lands on Chat when nothing has been remembered', () => {
    renderEntry();
    expect(screen.getByText('the chat surface')).toBeInTheDocument();
  });

  it('reopens the tool the user was last in', () => {
    renderEntry(visited('code'));
    expect(screen.getByText('the code surface')).toBeInTheDocument();
    expect(screen.queryByText('the chat surface')).toBeNull();
  });

  it('does not reopen a placeholder, and keeps the fact that it was visited', () => {
    const { store } = renderEntry(visited('settings'));
    // Falling back is a decision, not amnesia: when Settings has a surface, the value
    // already points at it.
    expect(screen.getByText('the chat surface')).toBeInTheDocument();
    expect(store.snapshot().projects['active']?.lastTool).toBe('settings');
  });

  it('reads the memory without rewriting it', () => {
    // The redirect runs on every bare entry, so a version that wrote the project record
    // back (to "normalise" it, say) would rewrite a neighbour's memory on every visit.
    const { store } = renderEntry((seeded) =>
      seeded.setProject('active', {
        openViewIds: { code: ['task-1'] },
        selectedViewIds: { code: 'task-1' },
        selectedModelIds: { chat: 'm1' },
        lastViewedVersions: { 'art-1': 2 },
        panelLayouts: { code: { sizes: { left: 312, right: 400 }, collapsed: ['inspector'] } },
        lastTool: 'code',
      }),
    );
    expect(screen.getByText('the code surface')).toBeInTheDocument();
    expect(store.snapshot().projects['active']).toEqual({
      openViewIds: { code: ['task-1'] },
      selectedViewIds: { code: 'task-1' },
      selectedModelIds: { chat: 'm1' },
      lastViewedVersions: { 'art-1': 2 },
      panelLayouts: { code: { sizes: { left: 312, right: 400 }, collapsed: ['inspector'] } },
      lastTool: 'code',
    });
  });
});
