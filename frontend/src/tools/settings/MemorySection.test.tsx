import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  memoryAvailableFixture,
  memoryDisabledFixture,
  memoryEntriesFixture,
  memoryImportFixture,
  memoryUnavailableFixture,
} from '../../dev-harness/fixtures/memory';
import { MemorySection } from './MemorySection';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const envelope = (code: string, message: string, status = 400) =>
  json({ error: { code, message, retryable: false } }, status);

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

function stubApi(options: { status?: unknown; statusFails?: boolean; memories?: unknown[] } = {}) {
  const calls: Call[] = [];
  let status = options.status ?? memoryAvailableFixture;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ method, url, body });
      if (url === '/api/memory/status') {
        if (options.statusFails === true) return Promise.resolve(envelope('internal_error', 'The settings table is locked.', 500));
        return Promise.resolve(json({ status }));
      }
      if (url === '/api/memory/enable' || url === '/api/memory/disable') {
        status = url.endsWith('enable') ? memoryAvailableFixture : memoryDisabledFixture;
        return Promise.resolve(json({ status }));
      }
      if (url.startsWith('/api/memory?')) return Promise.resolve(json({ memories: options.memories ?? memoryEntriesFixture }));
      if (url === '/api/memory/import') return Promise.resolve(json(memoryImportFixture));
      if (url === '/api/memory' && method === 'POST') return Promise.resolve(json({ stored: true }, 201));
      if (url === '/api/memory' && method === 'DELETE') return Promise.resolve(json({ cleared: true }));
      if (/^\/api\/memory\/[^/]+$/.test(url) && method === 'DELETE') return Promise.resolve(json({ deleted: true }));
      return Promise.resolve(envelope('not_found', `No stub for ${method} ${url}`, 404));
    }),
  );
  return calls;
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MemorySection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Memory section states', () => {
  it('distinguishes disabled from empty from unavailable from failed', async () => {
    stubApi({ status: memoryDisabledFixture });
    const first = renderSection();
    expect(await screen.findByText(/Off\. Memory is opt-in/)).toBeInTheDocument();
    expect(screen.queryByText('Stored memories')).not.toBeInTheDocument();
    first.unmount();

    stubApi({ status: memoryUnavailableFixture, memories: [] });
    const second = renderSection();
    expect(await screen.findByText(/On, but unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/cannot be listed while the backend is unavailable/)).toBeInTheDocument();
    expect(screen.queryByLabelText('One fact, in your own words')).not.toBeInTheDocument();
    second.unmount();

    stubApi({ statusFails: true });
    renderSection();
    expect(await screen.findByText(/The memory status could not be read/)).toBeInTheDocument();
  });

  it('shows the no-merge line and an honest empty state', async () => {
    stubApi({ memories: [] });
    renderSection();
    expect(await screen.findByText(/not merged, updated, or expired automatically/)).toBeInTheDocument();
    expect(await screen.findByText(/No memories stored yet/)).toBeInTheDocument();
  });

  it('renders memory content as text only', async () => {
    stubApi({
      memories: [{ ...memoryEntriesFixture[0]!, memory: '<b>not bold</b> and <script>alert(1)</script>' }],
    });
    renderSection();
    const entry = await screen.findByText('<b>not bold</b> and <script>alert(1)</script>');
    expect(entry.tagName).toBe('P');
    expect(entry.querySelector('b')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });
});

describe('Memory actions', () => {
  it('adds a memory and refuses an empty one client-side', async () => {
    const calls = stubApi();
    renderSection();
    await screen.findByText('Stored memories (2)');
    await userEvent.click(screen.getByRole('button', { name: 'Store memory' }));
    expect(await screen.findByText(/Write the memory first/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('One fact, in your own words'), 'Keeps Fridays free.');
    await userEvent.click(screen.getByRole('button', { name: 'Store memory' }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.url === '/api/memory' && call.body?.['text'] === 'Keeps Fridays free.')).toBe(true),
    );
  });

  it('shows the import counts and each file’s own result', async () => {
    stubApi();
    renderSection();
    await screen.findByText('Stored memories (2)');
    await userEvent.type(screen.getByLabelText('Paste text to import'), 'One fact.\n\nAnother fact.');
    await userEvent.click(screen.getByRole('button', { name: 'Import paste' }));
    expect(await screen.findByText(/Found 4, imported 3, dropped 1\./)).toBeInTheDocument();
    expect(screen.getByText(/scan\.pdf/).closest('li')).toHaveTextContent(/found 0, imported 0, dropped 0/);
    expect(screen.getByText(/scan\.pdf/).closest('li')).toHaveTextContent('The file is not readable as text.');
  });

  it('deletes one memory without a confirmation dialog', async () => {
    const calls = stubApi();
    renderSection();
    await screen.findByText('Stored memories (2)');
    const entry = screen.getByText(/Prefers tea over coffee/).closest('li') as HTMLElement;
    await userEvent.click(within(entry).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/memory/mem-1')).toBe(true),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('requires a confirmation naming the count before deleting everything', async () => {
    const calls = stubApi();
    renderSection();
    await screen.findByText('Stored memories (2)');
    await userEvent.click(screen.getByRole('button', { name: 'Delete all memories…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete all memories?' });
    expect(dialog).toHaveTextContent('removes 2 stored memories');
    // Nothing has been sent yet: the confirmation is the gate, not a receipt.
    expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/memory')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete all 2 memories' }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/memory')).toBe(true),
    );
  });
});
