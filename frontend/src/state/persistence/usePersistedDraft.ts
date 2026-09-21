import { useCallback, useEffect, useRef, useState } from 'react';
import { usePersistenceStore } from './PersistenceProvider';

/**
 * An unsent draft that survives a reload (1.39 A5, draft safety).
 *
 * What is kept is the text the user typed and nothing else: attachment *metadata*
 * is all `safeDraftSchema` can hold, and the classification pass refuses a draft
 * key that looks like a credential at all, so this hook cannot be the place a
 * secret escapes into local storage. An empty (or whitespace-only) draft is
 * removed rather than stored, because a saved blank is indistinguishable from a
 * draft the user deleted.
 *
 * Writes are debounced: every keystroke rewriting the whole persisted state would
 * put the store on the hot path of typing. The pending write is flushed on unmount,
 * so navigating away is not a way to lose the last few characters.
 */
const DRAFT_DEBOUNCE_MS = 400;

export interface PersistedDraft {
  /** The remembered text, read once when the draft key mounts. */
  initial: string;
  onChange: (text: string) => void;
  /** Drops the draft now (the text was sent, or the surface was deliberately cleared). */
  clear: () => void;
}

export function usePersistedDraft(key: string): PersistedDraft {
  const store = usePersistenceStore();
  const [initial] = useState(() => store.snapshot().drafts[key]?.text ?? '');
  const latest = useRef(initial);
  const timer = useRef<number | null>(null);

  const write = useCallback(() => {
    const text = latest.current;
    if (text.trim() === '') store.removeDraft(key);
    else store.setDraft(key, { text, attachments: [], updatedAt: Date.now() });
  }, [store, key]);

  const onChange = useCallback(
    (text: string) => {
      latest.current = text;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        write();
      }, DRAFT_DEBOUNCE_MS);
    },
    [write],
  );

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    latest.current = '';
    store.removeDraft(key);
  }, [store, key]);

  useEffect(
    () => () => {
      if (timer.current === null) return;
      window.clearTimeout(timer.current);
      timer.current = null;
      write();
    },
    [write],
  );

  return { initial, onChange, clear };
}
