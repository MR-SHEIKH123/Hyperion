import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AttentionCenter from './AttentionCenter';

import type { AttentionQueue } from '../contracts/wire/attention';

const NOW = 1_700_000_000_000;

function queue(items: AttentionQueue['items'], sources: AttentionQueue['sources'] = []): AttentionQueue {
  return {
    generatedAt: NOW,
    total: items.length,
    counts: {},
    items,
    sources,
  };
}

const APPROVAL = {
  id: 'approval:a1',
  kind: 'approval_required' as const,
  tool: 'code' as const,
  title: 'bash needs a decision',
  detail: 'The project rules deny this command.',
  createdAt: NOW - 60_000,
  taskId: 'task-1',
  resolve: { method: 'POST' as const, path: '/api/code/tasks/task-1/approve' },
};

const PAUSED = {
  id: 'paused:run-2',
  kind: 'paused' as const,
  tool: 'chat' as const,
  title: 'A response is paused',
  detail: 'The provider timed out.',
  createdAt: NOW - 120_000,
  chatId: 'chat-1',
  runId: 'run-2',
  resolve: { method: 'POST' as const, path: '/api/chat/resume', body: { runId: 'run-2' } },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type FetchCall = [input: string, init: RequestInit | undefined];

/**
 * A fetch stub that records what it was called with.
 *
 * `vi.fn(async (input, init) => …)` would type `input` as the whole `RequestInfo`
 * union, and turning that into a string for a comparison is exactly the kind of
 * coercion the lint rules exist to stop. The client only ever passes a path, so the
 * stub says so and keeps the call list typed.
 */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response) {
  const calls: FetchCall[] = [];
  const mock = vi.fn((input: string, init: RequestInit | undefined) => {
    calls.push([input, init]);
    return Promise.resolve(handler(input, init));
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

function renderCenter() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AttentionCenter />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the attention center', () => {
  it('renders what the server sent, in the order it sent it', async () => {
    stubFetch(() => json(queue([APPROVAL, PAUSED])));
    renderCenter();

    expect(await screen.findByText('bash needs a decision')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Items waiting on you' });
    const titles = within(list)
      .getAllByRole('heading', { level: 2 })
      .map((node) => node.textContent);
    expect(titles).toEqual(['bash needs a decision', 'A response is paused']);
  });

  it('replaces the queue on refresh instead of merging it, so nothing duplicates', async () => {
    let reads = 0;
    const { mock } = stubFetch(() => {
      reads += 1;
      // The second read answers the approval: it is gone, and a scheduled failure
      // has appeared in its place.
      return reads === 1
        ? json(queue([APPROVAL, PAUSED]))
        : json(
            queue([
              PAUSED,
              {
                id: 'schedule:s1',
                kind: 'scheduled_run_failed' as const,
                tool: 'cowork' as const,
                title: 'Scheduled task "Morning briefing" failed on its last run',
                detail: 'no provider could be reached',
                createdAt: NOW - 30_000,
                taskId: 's1',
              },
            ]),
          );
    });

    const queryClient = renderCenter();
    expect(await screen.findByText('bash needs a decision')).toBeInTheDocument();

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['attention'] });
    });

    await waitFor(() => {
      expect(screen.queryByText('bash needs a decision')).toBeNull();
    });
    expect(screen.getByText(/Morning briefing/)).toBeInTheDocument();
    // Exactly one copy of the item that stayed: a merge would have shown two.
    expect(screen.getAllByText('A response is paused')).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('answers a prompt from the queue and says what happens next', async () => {
    // The approval is answered, so the next read of the queue does not contain it —
    // which is what makes the row disappear for the right reason (the server said
    // so) rather than because the frontend removed it optimistically.
    let answered = false;
    const { calls } = stubFetch((url) => {
      if (url === '/api/attention') return json(queue(answered ? [] : [APPROVAL]));
      if (url === '/api/code/tasks/task-1/approve') {
        answered = true;
        return json({ tool: 'code', taskId: 'task-1', approvalId: 'a1', state: 'allow_once', applied: true, continuable: true });
      }
      throw new Error(`unexpected request ${url}`);
    });

    renderCenter();
    await screen.findByText('bash needs a decision');

    const group = screen.getByRole('group', { name: /Decide bash needs a decision/ });
    fireEvent.click(within(group).getByRole('button', { name: 'Allow once' }));

    await waitFor(() => {
      expect(calls.some(([url]) => url.endsWith('/approve'))).toBe(true);
    });
    const call = calls.find(([url]) => url.endsWith('/approve'));
    expect(call?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ approvalId: 'a1', decision: 'allow_once' }),
    });
    // Allowing is not resuming, and the notice says so rather than implying the
    // task has continued.
    expect(await screen.findByText(/waiting to continue/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('bash needs a decision')).toBeNull();
    });
  });

  it('reports a failed decision in the server’s words, and keeps the item', async () => {
    stubFetch((url) =>
      url === '/api/attention'
        ? json(queue([APPROVAL]))
        : json({ error: { code: 'not_found', message: 'No approval "a1" was found for this task.', retryable: false } }, 404),
    );

    renderCenter();
    await screen.findByText('bash needs a decision');
    const group = screen.getByRole('group', { name: /Decide bash needs a decision/ });
    fireEvent.click(within(group).getByRole('button', { name: 'Deny' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No approval "a1" was found for this task.');
    // The row stays: nothing was answered, and pretending otherwise would hide a
    // prompt that is still parked.
    expect(screen.getByText('bash needs a decision')).toBeInTheDocument();
  });

  it('never renders an empty queue when the read failed', async () => {
    stubFetch(() => json({ error: { code: 'internal_error', message: 'boom', retryable: true } }, 500));
    renderCenter();

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong here');
    expect(screen.queryByText(/Nothing is waiting/)).toBeNull();
  });
});
