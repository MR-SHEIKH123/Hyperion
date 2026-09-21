import { createContext, useContext, type PropsWithChildren } from 'react';
import { PersistenceStore, type StorageLike } from './storage';

/**
 * Presentation memory, mounted once for the app.
 *
 * What may be remembered is decided by the store's schema and its classification
 * pass, not here: this file only decides *where* the memory lives. `window.localStorage`
 * when it is usable, an in-memory fallback when it is not, and never a thrown error in
 * either case — a browser that refuses storage (private mode, a blocked origin) gets a
 * session that cannot remember, which is a downgrade rather than a broken app.
 *
 * The provider is optional by construction: `usePersistenceStore()` falls back to the
 * one store for this tab, so a component rendered outside the provider (a test, the dev
 * harness) still reads and writes the real thing instead of silently losing state.
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

function hostStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Some browsers throw on the property access itself, not just on writes.
    return null;
  }
}

const StoreContext = createContext<PersistenceStore | null>(null);

let tabStore: PersistenceStore | null = null;
function storeForThisTab(): PersistenceStore {
  tabStore ??= new PersistenceStore(hostStorage() ?? new MemoryStorage());
  return tabStore;
}

/** Resets the tab store. Tests only: the app never re-reads storage mid-session. */
export function resetPersistenceForTests(): void {
  tabStore = null;
}

export function PersistenceProvider({ children, store }: PropsWithChildren<{ store?: PersistenceStore }>) {
  return <StoreContext.Provider value={store ?? storeForThisTab()}>{children}</StoreContext.Provider>;
}

export function usePersistenceStore(): PersistenceStore {
  return useContext(StoreContext) ?? storeForThisTab();
}
