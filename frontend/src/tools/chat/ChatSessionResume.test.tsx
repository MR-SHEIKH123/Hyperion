import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PersistenceProvider } from '../../state/persistence/PersistenceProvider';
import { PersistenceStore, type StorageLike } from '../../state/persistence/storage';
import ChatTool from './ChatTool';

/**
 * Continuing a conversation in a new session (1.28's second half).
 *
 * The backend contract is proven in `test/sessionresume.test.ts`; what matters
 * here is what the surface does with it. The offer has to be *earned* — it
 * appears only when the backend says the transcript has reached the trigger, and
 * it says whether the limit it was measured against was a real one or the
 * conservative default. Acting on it opens the new session and accounts for what
 * was left behind; a refusal leaves the conversation exactly where it was.
 *
 * The failing case that shaped the first draft: the context read is fetched on
 * mount, so a stub that 404s it silently produces "no offer" — which is the same
 * screen as "the conversation fits". These tests therefore assert the request was
 * made, not just that no banner rendered.
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

const message = (
  id: string,
  chatId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  seq: number,
) => ({
  id,
  chatId,
  role,
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

const source = chat('c1', 'Long thread');
const continued = chat('c2', 'Long thread (continued)');
const sourceMessage = message('m1', 'c1', 'user', 'the first question', 1);
const receipt =
  '[Earlier conversation left behind when this session was resumed from "Long thread": ' +
  '3 user message(s), 2 assistant message(s). That span is not in this transcript — ask the ' +
  'user rather than guessing if you need something from it.]';
const continuedMessages = [
  message('m2', 'c2', 'system', receipt, 1),
  message('m3', 'c2', 'user', 'the most recent question', 2),
];

const assessment = {
  chatId: 'c1',
  modelId: 'model-a',
  window: { tokens: 4096, source: 'model', assumed: false },
  estimatedTokens: 3700,
  ratio: 3700 / 4096,
  messageCount: 3,
  needsNewSession: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The request as a label: the client only ever passes a path, but the global's type is wider. */
function labelOf(input: RequestInfo | URL, init?: RequestInit): string {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return `${init?.method ?? 'GET'} ${path}`;
}

interface StubOptions {
  /** The context read. Default: nearly full, a real window. */
  context?: () => Response;
  /** The resume. Default: a 201 with the receipt and the tail. */
  resume?: () => Response;
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
          return Promise.resolve(json({ chat: continued, messages: continuedMessages, latestRun: null }));
        case 'GET /api/chat/c1/context':
          return Promise.resolve(options.context?.() ?? json(assessment));
        case 'POST /api/chat/c1/resume-in-new-session':
          return Promise.resolve(
            options.resume?.() ??
              json(
                {
                  chat: continued,
                  messages: continuedMessages,
                  source: { id: 'c1', title: 'Long thread' },
                  droppedMessages: 5,
                  pausedPartials: 0,
                  receipt,
                  assessment,
                },
                201,
              ),
          );
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

describe('the context ceiling offer', () => {
  it('asks the backend how full the conversation is, and offers a new session', async () => {
    const seen = stubFetch();
    renderTool();

    await screen.findByText('the first question');
    await waitFor(() => expect(seen).toContain('GET /api/chat/c1/context'));

    const banner = await screen.findByText('This conversation is nearly full');
    expect(banner).toBeInTheDocument();
    // The numbers are the backend's, and the window is a real one here.
    expect(screen.getByText(/3,700 of 4,096 tokens/)).toBeInTheDocument();
    expect(screen.queryByText(/the limit is assumed/)).not.toBeInTheDocument();
  });

  it('says so when the limit it compared against was the assumed default', async () => {
    stubFetch({
      context: () =>
        json({
          ...assessment,
          window: { tokens: 8192, source: 'default', assumed: true },
          estimatedTokens: 7000,
          ratio: 7000 / 8192,
        }),
    });
    renderTool();

    await screen.findByText('the first question');
    expect(await screen.findByText(/the limit is assumed, because this model reports no context length/)).toBeInTheDocument();
  });

  it('stays quiet while the conversation still fits', async () => {
    const seen = stubFetch({
      context: () => json({ ...assessment, estimatedTokens: 900, ratio: 900 / 4096, needsNewSession: false }),
    });
    renderTool();

    await screen.findByText('the first question');
    await waitFor(() => expect(seen).toContain('GET /api/chat/c1/context'));

    expect(screen.queryByText('This conversation is nearly full')).not.toBeInTheDocument();
  });

  it('continues into a new session and accounts for what was left behind', async () => {
    const seen = stubFetch();
    renderTool();

    await screen.findByText('the first question');
    await userEvent.click(await screen.findByRole('button', { name: /Continue in a new session/ }));

    await waitFor(() => expect(seen).toContain('POST /api/chat/c1/resume-in-new-session'));

    // The new session is the open conversation, receipt first.
    expect(await screen.findByRole('heading', { name: 'Long thread (continued)' })).toBeInTheDocument();
    expect(await screen.findByText('the most recent question')).toBeInTheDocument();

    const notice = await screen.findByText(/Continued from/);
    expect(notice).toHaveTextContent('Continued from “Long thread” — 5 earlier messages were left behind');
    expect(notice).toHaveTextContent('The original conversation still has them');

    // The source was not refetched: the backend does not touch it, and a refetch
    // here would only risk dropping the page someone was reading.
    expect(seen.filter((label) => label === 'POST /api/chat/c1/open')).toHaveLength(1);
  });

  it('leaves the conversation where it was when the resume is refused', async () => {
    stubFetch({
      resume: () =>
        json(
          {
            error: {
              code: 'conflict',
              message: 'This conversation already fits in the model’s context window (~900 of 4096 tokens).',
              retryable: false,
            },
          },
          409,
        ),
    });
    renderTool();

    await screen.findByText('the first question');
    await userEvent.click(await screen.findByRole('button', { name: /Continue in a new session/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This conversation could not be continued in a new session.');
    expect(alert).toHaveTextContent('This conversation already fits');
    expect(screen.getByRole('heading', { name: 'Long thread' })).toBeInTheDocument();
    expect(screen.queryByText(/Continued from/)).not.toBeInTheDocument();
  });

  it('drops the notice when it is dismissed, leaving the session in place', async () => {
    stubFetch();
    renderTool();

    await screen.findByText('the first question');
    await userEvent.click(await screen.findByRole('button', { name: /Continue in a new session/ }));
    const notice = await screen.findByText(/Continued from/);

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(notice).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Long thread (continued)' })).toBeInTheDocument();
    // The receipt is part of the transcript, not decoration: it stays.
    expect(screen.getByText(/Earlier conversation left behind/)).toBeInTheDocument();
  });
});
