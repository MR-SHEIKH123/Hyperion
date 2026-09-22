import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';

import { PersistenceProvider } from './PersistenceProvider';
import { PersistenceStore, type StorageLike } from './storage';
import { usePersistedDraft } from './usePersistedDraft';

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

function setup(seed?: (store: PersistenceStore) => void) {
  const store = new PersistenceStore(new MemoryStorage());
  seed?.(store);
  const wrapper = ({ children }: PropsWithChildren) => <PersistenceProvider store={store}>{children}</PersistenceProvider>;
  return { store, hook: renderHook(() => usePersistedDraft('chat:1'), { wrapper }) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('persisted chat drafts', () => {
  it('comes back to the text that was typed, and writes it debounced', () => {
    vi.useFakeTimers();
    const { store, hook } = setup((s) => s.setDraft('chat:1', { text: 'half a thought', attachments: [], updatedAt: 1 }));
    expect(hook.result.current.initial).toBe('half a thought');

    act(() => hook.result.current.onChange('half a thought, finished'));
    // Not on every keystroke: the store is not on the typing hot path.
    expect(store.snapshot().drafts['chat:1']?.text).toBe('half a thought');
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(store.snapshot().drafts['chat:1']?.text).toBe('half a thought, finished');
  });

  it('stores no draft at all once the text is empty or only whitespace', () => {
    vi.useFakeTimers();
    const { store, hook } = setup((s) => s.setDraft('chat:1', { text: 'typed', attachments: [], updatedAt: 1 }));
    act(() => hook.result.current.onChange('   '));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    // A saved blank is indistinguishable from a draft the user deliberately cleared.
    expect(store.snapshot().drafts['chat:1']).toBeUndefined();
  });

  it('drops the draft immediately when the text was sent', () => {
    const { store, hook } = setup((s) => s.setDraft('chat:1', { text: 'sent already', attachments: [], updatedAt: 1 }));
    act(() => hook.result.current.clear());
    expect(store.snapshot().drafts['chat:1']).toBeUndefined();
  });

  it('flushes a pending write when the surface unmounts', () => {
    vi.useFakeTimers();
    const { store, hook } = setup();
    act(() => hook.result.current.onChange('navigating away'));
    hook.unmount();
    expect(store.snapshot().drafts['chat:1']?.text).toBe('navigating away');
  });
});
