import { Navigate } from 'react-router-dom';

import { usePersistenceStore } from '../state/persistence/PersistenceProvider';

/**
 * Where a bare entry into the shell lands (1.39 A5, the "last tool" clause).
 *
 * The shell used to send every entry to `/chat`, which is a fine default and a poor
 * answer to "I was working in Code a minute ago": the store had been recording
 * `lastTool` since the layout hook landed and **nothing read it**, which is the same
 * defect class as a route with no caller — a written value whose reader was still
 * missing. This is the reader.
 *
 * Three rules, each one a way restoring would be worse than not:
 *
 *   - **Only a real surface is restored.** `chat` and `code` have one; the other six
 *     tools are honest placeholders, and reopening the shell onto a placeholder every
 *     time would be a trap rather than a memory. The stored value is *kept* when it
 *     names a placeholder, not wiped — the user was in Settings when the surface
 *     lands, and deleting the fact would lose it for good. `panelLayouts` is untouched
 *     for the same reason. (The Attention Center is a real screen too, but it is not a
 *     *tool*: `toolIdSchema` cannot hold it, so a store cannot name it here and this
 *     map must not pretend otherwise.)
 *   - **Only the bare entry.** This renders at the index route alone, so a typed or
 *     linked URL is never rewritten: `/code?task=…` from the attention queue means
 *     Code, whatever was last open.
 *   - **Nothing remembered, nothing invented.** An absent `lastTool` — a first visit, a
 *     browser that refuses storage, or a value the schema refused to parse — falls back
 *     to `/chat`, the shell's original default.
 */
const RESTORABLE: Record<string, string> = { chat: '/chat', code: '/code' };

export function EntryRedirect() {
  const store = usePersistenceStore();
  const lastTool = store.snapshot().projects['active']?.lastTool;
  const target = lastTool === undefined ? undefined : RESTORABLE[lastTool];
  return <Navigate to={target ?? '/chat'} replace />;
}
