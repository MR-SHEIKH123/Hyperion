import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  addMemory,
  clearMemories,
  deleteMemory,
  disableMemory,
  enableMemory,
  getMemories,
  getMemoryStatus,
  importMemoryFiles,
  importMemoryText,
} from '../../api/memory';
import { Button } from '../../design-system/components/Button/Button';
import { Dialog } from '../../design-system/components/Dialog/Dialog';
import type { MemoryEntryWire } from '../../contracts/wire/memory';
import { AddMemoryForm, ImportPanel, MemoryList, MemoryStatusPanel } from './MemoryView';
import { MEMORY_NO_MERGE_LINE } from './memoryModel';
import { describeApiError } from './ProvidersSection';
import styles from './MemoryView.module.css';

/**
 * Memory (Settings 2.5, slice 3a). The status object decides what the rest
 * of the section may show: disabled, unavailable and failed are different
 * answers and render differently, because the list route returns an empty
 * list for the first two and a panel that took the list at face value
 * would show a broken backend as an empty store.
 */
export function MemorySection() {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({ queryKey: ['memory', 'status'], queryFn: ({ signal }) => getMemoryStatus(signal) });
  const listQuery = useQuery({ queryKey: ['memory', 'list'], queryFn: ({ signal }) => getMemories(200, signal) });
  const [togglePending, setTogglePending] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearPending, setClearPending] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const memories = listQuery.data?.memories ?? [];
  const status = statusQuery.data?.status;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['memory'] });
  };

  const toggle = async (on: boolean) => {
    setTogglePending(true);
    setToggleError(null);
    try {
      const result = on ? await enableMemory() : await disableMemory();
      queryClient.setQueryData(['memory', 'status'], result);
      invalidate();
      setNotice(on ? 'Memory is on.' : 'Memory is off. Stored memories are kept; nothing is recalled while it is off.');
    } catch (error) {
      setToggleError(describeApiError(error));
    } finally {
      setTogglePending(false);
    }
  };

  const deleteOne = async (memory: MemoryEntryWire) => {
    setNotice(null);
    try {
      const result = await deleteMemory(memory.id);
      invalidate();
      setNotice(
        result.deleted
          ? 'Memory deleted.'
          : 'The backend reports that memory was not deleted — it may already be gone, or the backend is unavailable.',
      );
    } catch (error) {
      setNotice(describeApiError(error));
    }
  };

  const clearAll = async () => {
    setClearPending(true);
    setClearError(null);
    try {
      const result = await clearMemories();
      invalidate();
      setConfirmClear(false);
      setNotice(
        result.cleared
          ? 'All memories deleted. The list will refill only with what is stored from now on.'
          : 'The backend reports nothing was cleared — the memory backend is unavailable.',
      );
    } catch (error) {
      setClearError(describeApiError(error));
    } finally {
      setClearPending(false);
    }
  };

  const capped = memories.length >= 200;
  const countLabel = capped ? 'at least 200' : String(memories.length);

  return (
    <section aria-labelledby="memory-heading">
      <h2 id="memory-heading">Memory</h2>
      <p className={styles.intro}>
        What Hyperion remembers between conversations, stored only because you opted in. {MEMORY_NO_MERGE_LINE}
      </p>
      {notice !== null ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}

      {statusQuery.isPending ? (
        <p role="status">Loading the memory status…</p>
      ) : statusQuery.isError ? (
        <article className={styles.panel}>
          <p className={styles.panelError} role="alert">
            The memory status could not be read. {describeApiError(statusQuery.error)}
          </p>
          <div className={styles.actions}>
            <Button onClick={() => void statusQuery.refetch()}>Try again</Button>
          </div>
        </article>
      ) : status !== undefined ? (
        <div className={styles.panels}>
          <MemoryStatusPanel
            status={status}
            pending={togglePending}
            error={toggleError}
            onEnable={() => void toggle(true)}
            onDisable={() => void toggle(false)}
          />
          {status.enabled && !status.available ? (
            <article className={styles.panel}>
              <h3 className={styles.panelTitle}>Stored memories</h3>
              <p className={styles.fact}>
                They cannot be listed while the backend is unavailable — which is not the same as there being
                none.
              </p>
            </article>
          ) : !status.enabled ? null : listQuery.isPending ? (
            <p role="status">Loading stored memories…</p>
          ) : listQuery.isError ? (
            <article className={styles.panel}>
              <p className={styles.panelError} role="alert">
                The stored memories could not be listed. {describeApiError(listQuery.error)}
              </p>
              <div className={styles.actions}>
                <Button onClick={() => void listQuery.refetch()}>Try again</Button>
              </div>
            </article>
          ) : (
            <>
              <MemoryList memories={memories} onDeleteOne={(memory) => void deleteOne(memory)} />
              <AddMemoryForm
                onAdd={async (text) => {
                  await addMemory(text);
                  invalidate();
                  setNotice('Memory stored.');
                }}
              />
              <ImportPanel
                onImportText={async (text) => {
                  const outcome = await importMemoryText(text);
                  invalidate();
                  return outcome;
                }}
                onImportFiles={async (files) => {
                  const outcome = await importMemoryFiles(files);
                  invalidate();
                  return outcome;
                }}
              />
              {memories.length > 0 ? (
                <article className={styles.panel}>
                  <h3 className={styles.panelTitle}>Delete everything</h3>
                  <p className={styles.note}>
                    Removes every stored memory. The on/off toggle is left as it is, and this cannot be undone.
                  </p>
                  <div className={styles.actions}>
                    <Button onClick={() => { setClearError(null); setConfirmClear(true); }}>Delete all memories…</Button>
                  </div>
                </article>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <Dialog open={confirmClear} title="Delete all memories?" onClose={() => setConfirmClear(false)}>
        <div className={styles.confirmBody}>
          <p>
            This removes <strong>{countLabel}</strong> stored {memories.length === 1 && !capped ? 'memory' : 'memories'}
            {capped ? ' (the list is capped at 200, so the store may hold more)' : ''}. Nothing merges or expires
            on its own, so this is the only way the whole store goes away — and it cannot be undone.
          </p>
          {clearError !== null ? (
            <p className={styles.panelError} role="alert">
              {clearError}
            </p>
          ) : null}
          <div className={styles.confirmActions}>
            <Button variant="quiet" onClick={() => setConfirmClear(false)} disabled={clearPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void clearAll()} disabled={clearPending}>
              {clearPending ? 'Deleting…' : capped ? 'Delete all memories (at least 200 stored)' : `Delete all ${countLabel} memories`}
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}

export default MemorySection;
