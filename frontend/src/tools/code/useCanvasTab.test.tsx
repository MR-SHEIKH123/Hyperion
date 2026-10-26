import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { PersistenceProvider } from '../../state/persistence/PersistenceProvider';
import { PersistenceStore, type StorageLike } from '../../state/persistence/storage';
import { useCanvasTab } from './useCanvasTab';

class MemoryStorage implements StorageLike {
  value: string | null = null;
  getItem() { return this.value; }
  setItem(_key: string, value: string) { this.value = value; }
  removeItem() { this.value = null; }
}

function Preference({ taskId }: { taskId: string }) {
  const [tab, setTab] = useCanvasTab(taskId);
  return <div><output>{tab}</output><button onClick={() => setTab('files')}>Files</button><button onClick={() => setTab('diff')}>Diff</button></div>;
}

describe('per-task canvas tab memory', () => {
  it('remembers only safe view ids per task in presentation state', async () => {
    const storage = new MemoryStorage();
    const store = new PersistenceStore(storage);
    const view = render(<PersistenceProvider store={store}><Preference taskId="task-a" /></PersistenceProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(store.snapshot().projects.active?.selectedViewIds['code-task:task-a']).toBe('files');

    view.rerender(<PersistenceProvider store={store}><Preference taskId="task-b" /></PersistenceProvider>);
    await waitFor(() => expect(screen.getByText('overview')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Diff' }));
    expect(store.snapshot().projects.active?.selectedViewIds['code-task:task-b']).toBe('diff');
    view.rerender(<PersistenceProvider store={store}><Preference taskId="task-a" /></PersistenceProvider>);
    await waitFor(() => expect(screen.getByText('files')).toBeInTheDocument());
    expect(storage.value).not.toContain('capability-token');
  });
});
