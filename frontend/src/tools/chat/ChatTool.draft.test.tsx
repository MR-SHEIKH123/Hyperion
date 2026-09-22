import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PersistenceProvider } from '../../state/persistence/PersistenceProvider';
import { PersistenceStore, type StorageLike } from '../../state/persistence/storage';
import ChatTool from './ChatTool';

/**
 * The draft, end to end through the tool that owns it (1.39 A5).
 *
 * The unit tests prove the pieces (the hook remembers, the composer reports). This
 * proves the wiring: text typed into the real Chat tool lands in presentation
 * memory, and a second mount — the reload — puts it back in the box.
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

const provider = {
  id: 'p1',
  name: 'Test Provider',
  type: 'remote',
  baseUrl: 'https://api.example.test/v1',
  hasKey: true,
  maxContextTokens: null,
  apiKeyHint: 'sk-…',
  enabled: true,
  priority: 1,
  healthStatus: 'healthy',
  lastError: null,
  lastErrorAt: null,
  lastSuccessAt: null,
  modelCount: 1,
  modelsFetchedAt: null,
  modelsError: null,
  createdAt: 1,
  updatedAt: 1,
};

/** The request as a label: the client only ever passes a path, but the global's type is wider. */
function describeRequest(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      if (input === '/api/chat?tool=chat') return Promise.resolve(json({ chats: [] }));
      if (input === '/api/providers/active') {
        return Promise.resolve(
          json({ provider, egress: 'remote', redactionCheckEnabled: true, zdr: { status: 'zdr_requested', requirement: 'prefer' } }),
        );
      }
      if (input === '/api/providers/active/models') {
        return Promise.resolve(json({ providerId: 'p1', providerName: 'Test Provider', models: [{ id: 'model-a', label: 'Model A' }] }));
      }
      return Promise.resolve(json({ error: { code: 'not_found', message: `${input} is not stubbed`, retryable: false } }, 404));
    }),
  );
}

function renderTool(store: PersistenceStore) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PersistenceProvider store={store}>
        <MemoryRouter initialEntries={['/chat']}>
          <Routes>
            <Route path="/chat/*" element={<ChatTool />} />
          </Routes>
        </MemoryRouter>
      </PersistenceProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chat drafts across a reload', () => {
  it('keeps the unsent prompt and puts it back when the tool is opened again', async () => {
    stubFetch();
    const storage = new MemoryStorage();
    const first = renderTool(new PersistenceStore(storage));

    const box = await screen.findByLabelText('Message');
    await userEvent.type(box, 'a prompt worth keeping');

    // Debounced, so it arrives shortly after the typing stops rather than per keystroke.
    await waitFor(() => expect(new PersistenceStore(storage).snapshot().drafts['chat:new']?.text).toBe('a prompt worth keeping'));
    first.unmount();

    // The reload: a new store over the same storage, as a fresh page load would have.
    renderTool(new PersistenceStore(storage));
    expect(await screen.findByLabelText('Message')).toHaveValue('a prompt worth keeping');
  });

  it('drops the new-conversation draft once the chat it belonged to exists', async () => {
    stubFetch();
    const storage = new MemoryStorage();
    const store = new PersistenceStore(storage);
    renderTool(store);

    const box = await screen.findByLabelText('Message');
    await userEvent.type(box, 'first message');
    await waitFor(() => expect(store.snapshot().drafts['chat:new']?.text).toBe('first message'));

    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      input === '/api/chat'
        ? Promise.resolve(
            json({
              chat: {
                id: 'c1',
                title: 'New conversation',
                tool: 'chat',
                modelId: 'model-a',
                providerId: 'p1',
                pinned: false,
                archived: false,
                createdAt: 1,
                updatedAt: 1,
                lastOpenedAt: 1,
              },
            }),
          )
        : Promise.resolve(json({ error: { code: 'not_found', message: `${describeRequest(input)} is not stubbed`, retryable: false } }, 404)),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    // The prompt now belongs to the conversation that will send it; keeping the
    // draft as well would send it twice on a back-navigation.
    await waitFor(() => expect(store.snapshot().drafts['chat:new']).toBeUndefined());
  });
});
