import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PersistenceProvider } from '../../state/persistence/PersistenceProvider';
import { PersistenceStore, type StorageLike } from '../../state/persistence/storage';
import ChatTool from './ChatTool';

/**
 * Branching a conversation from the surface that offers it (1.27).
 *
 * The backend contract is proven in `test/chatfork.test.ts`; what matters here is
 * what the client does with it: send the fork where the route says, open the
 * branch, say what was copied, leave the original alone — and when the fork is
 * refused, say so without moving the user.
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

const chat = (id: string, title: string) => ({
  id,
  title,
  tool: 'chat',
  modelId: 'model-a',
  providerId: 'p1',
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
});

const say = (id: string, chatId: string, content: string, seq: number) => ({
  id,
  chatId,
  role: 'user',
  content,
  tool: 'chat',
  modelId: 'model-a',
  providerId: 'p1',
  providerName: 'Test Provider',
  status: 'complete',
  errorCode: null,
  errorMessage: null,
  tokensIn: null,
  tokensOut: null,
  seq,
  createdAt: 1,
  updatedAt: 1,
});

const source = chat('c1', 'Planning');
const branch = chat('c2', 'Planning (fork)');
const sourceMessage = say('m1', 'c1', 'the first question', 1);
const branchMessages = [say('m2', 'c2', 'the first question', 1), say('m3', 'c2', 'a question asked while streaming', 2)];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The request as a label: the client only ever passes a path, but the global's type is wider. */
function labelOf(input: RequestInfo | URL, init?: RequestInit): string {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return `${init?.method ?? 'GET'} ${path}`;
}

interface StubOptions {
  /** Overrides the fork response — a refusal, for instance. */
  fork?: () => Response;
}

function stubFetch(options: StubOptions = {}) {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const label = labelOf(input, init);
      seen.push(label);
      switch (label) {
        case 'GET /api/chat?tool=chat':
          return Promise.resolve(json({ chats: [source] }));
        case 'POST /api/chat/c1/open':
          return Promise.resolve(json({ chat: source, messages: [sourceMessage], latestRun: null }));
        case 'POST /api/chat/c2/open':
          return Promise.resolve(json({ chat: branch, messages: branchMessages, latestRun: null }));
        case 'POST /api/chat/c1/fork':
          return Promise.resolve(options.fork?.() ?? json({ chat: branch, messages: branchMessages, forkedFrom: 'c1', pausedPartials: 1 }, 201));
        case 'GET /api/providers/active':
          return Promise.resolve(
            json({ provider, egress: 'remote', redactionCheckEnabled: true, zdr: { status: 'zdr_requested', requirement: 'prefer' } }),
          );
        case 'GET /api/providers/active/models':
          return Promise.resolve(json({ providerId: 'p1', providerName: 'Test Provider', models: [{ id: 'model-a', label: 'Model A' }] }));
        default:
          return Promise.resolve(json({ error: { code: 'not_found', message: `${label} is not stubbed`, retryable: false } }, 404));
      }
    }),
  );
  return seen;
}

function renderTool(entry = '/chat/c1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const store = new PersistenceStore(new MemoryStorage());
  return render(
    <QueryClientProvider client={client}>
      <PersistenceProvider store={store}>
        <MemoryRouter initialEntries={[entry]}>
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

describe('opening a conversation by URL', () => {
  it('opens the chat named in the path, not the new-conversation pane', async () => {
    stubFetch();
    renderTool('/chat/c1');

    // The route is `/chat/*`, so the id is the splat remainder. Reading
    // `params.chatId` (undefined under a splat) silently rendered the
    // new-conversation pane for every link the list produced.
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeInTheDocument();
    expect(await screen.findByText('the first question')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'New conversation' })).not.toBeInTheDocument();
  });
});

describe('forking a conversation', () => {
  it('branches, opens the branch, and says what came across', async () => {
    const seen = stubFetch();
    renderTool();

    await screen.findByText('the first question');
    await userEvent.click(await screen.findByRole('button', { name: 'Fork conversation' }));

    await waitFor(() => expect(seen).toContain('POST /api/chat/c1/fork'));

    // The branch is the open conversation now, with its own transcript.
    expect(await screen.findByRole('heading', { name: 'Planning (fork)' })).toBeInTheDocument();
    expect(await screen.findByText('a question asked while streaming')).toBeInTheDocument();

    // And the notice accounts for the copy, including the message that was
    // mid-stream and landed paused rather than claiming a run is coming.
    const notice = await screen.findByText(/Branched from/);
    expect(notice).toHaveTextContent('Branched from “Planning” — 2 messages copied');
    expect(notice).toHaveTextContent('1 of them stopped mid-stream and are paused here');

    // The original was not refetched: the copy does not touch it, and a refetch
    // here would only risk dropping the page the user was reading.
    expect(seen.filter((label) => label === 'POST /api/chat/c1/open')).toHaveLength(1);
  });

  it('leaves the conversation where it was when the branch is refused', async () => {
    stubFetch({
      fork: () => json({ error: { code: 'conflict', message: 'a temporary chat cannot be forked', retryable: false } }, 409),
    });
    renderTool();

    await screen.findByText('the first question');
    await userEvent.click(await screen.findByRole('button', { name: 'Fork conversation' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This conversation could not be branched. a temporary chat cannot be forked');
    expect(screen.getByRole('heading', { name: 'Planning' })).toBeInTheDocument();
    expect(screen.queryByText(/Branched from/)).not.toBeInTheDocument();
  });

  it('drops the notice when it is dismissed', async () => {
    stubFetch();
    renderTool();

    await screen.findByText('the first question');
    await userEvent.click(await screen.findByRole('button', { name: 'Fork conversation' }));
    const notice = await screen.findByText(/Branched from/);

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(notice).not.toBeInTheDocument());
    // The branch itself is unaffected — only the note about how it got here goes.
    expect(screen.getByRole('heading', { name: 'Planning (fork)' })).toBeInTheDocument();
  });
});
