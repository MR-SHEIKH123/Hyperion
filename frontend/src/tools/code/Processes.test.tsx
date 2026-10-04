import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Processes } from './Processes';

/**
 * The Processes row (the session panel's third slice).
 *
 * The claim worth pinning is the one the route makes easy to get wrong: the
 * response is an *audit* list that keeps recently ended sessions, so `count` is
 * not the number of running processes and an ended entry is not a process. The
 * second claim is the empty state: "Nothing is running" rather than a blank row.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const live = (overrides: Record<string, unknown> = {}) => ({
  id: 'tsess_11111111-2222-3333-4444-555555555555',
  taskId: 'task-1',
  client: 'cli',
  openedAt: Date.now() - 60_000,
  lastSeenAt: Date.now() - 1_000,
  expiresAt: Date.now() + 10 * 60_000,
  hardExpiresAt: Date.now() + 8 * 60 * 60_000,
  endedAt: null,
  endedReason: null,
  ...overrides,
});

const ended = {
  ...live({ id: 'tsess_99999999-8888-7777-6666-555555555555', endedAt: Date.now() - 30_000 }),
  endedReason: 'closed',
};

function renderPanel(taskId: string | null = 'task-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Processes taskId={taskId} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the processes row', () => {
  it('lists the live sessions and counts only those', async () => {
    vi.stubGlobal(
      'fetch',
      // `count` says 2 because the store keeps the ended one for the audit trail;
      // the row must count sessions that are actually running.
      vi.fn(() => Promise.resolve(json({ count: 2, sessions: [live(), ended] }))),
    );
    renderPanel();

    const list = await screen.findByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText('11111111')).toBeDefined();
    // The session bound to the selected task is named as such, not by id.
    expect(within(rows[0]!).getByText(/this task/)).toBeDefined();
    // The heading carries the live count, and it is 1 — not the route's `count: 2`.
    expect(screen.getByRole('heading', { name: /Processes\s*1/ })).toBeDefined();
  });

  it('says nothing is running rather than rendering blank', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json({ count: 1, sessions: [ended] }))),
    );
    renderPanel();

    expect(await screen.findByText('Nothing is running.')).toBeDefined();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('does not offer a close control it cannot honour', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json({ count: 1, sessions: [live()] }))),
    );
    renderPanel();

    await screen.findByRole('list');
    // Closing needs the opener's token and the list never carries one, so there is
    // no button — and the panel says why instead of leaving it to be guessed.
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/closed by whoever holds the token/)).toBeDefined();
  });
});
