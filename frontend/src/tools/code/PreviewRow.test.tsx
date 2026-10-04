import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PreviewRow } from './PreviewRow';

/**
 * The live preview row, rendered (the session panel's second slice).
 *
 * The claims worth pinning are the ones a plausible implementation gets wrong:
 * that showing a preview does not mint one (a read that minted would rotate the
 * token out from under an open tab), that a host with previews switched off is
 * not rendered as "nothing is running", and that the URL on the row is the URL
 * the backend reported — an origin someone can actually open.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const live = (overrides: Partial<{ url: string; expiresAt: number }> = {}) => ({
  taskId: 'task-1',
  token: 'a'.repeat(64),
  url: 'http://127.0.0.1:4320/p/' + 'a'.repeat(64) + '/',
  expiresAt: Date.now() + 30 * 60 * 1000,
  ...overrides,
});

const statusBody = (preview: unknown) => ({ taskId: 'task-1', preview });

/**
 * A fetch stub that answers each verb with that verb's real shape.
 *
 * The shapes are not interchangeable and conflating them is easy to do by
 * accident: the read answers `{taskId, preview}`, while a mint answers the
 * `MintedPreview` itself (`api/canvas.ts` asks for `mintedPreviewSchema`). The
 * reads are consumed in order, so a test can describe what a poll sequence sees.
 */
function stubFetch({
  reads,
  mint,
  revoke = { revoked: true },
}: {
  reads: unknown[];
  mint?: unknown;
  revoke?: unknown;
}) {
  const calls: { method: string; url: string }[] = [];
  let read = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url: input instanceof Request ? input.url : String(input) });
      if (method === 'GET') return Promise.resolve(json(reads[Math.min(read++, reads.length - 1)]));
      return Promise.resolve(json(method === 'POST' ? mint : revoke));
    }),
  );
  return { calls };
}

function renderRow() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PreviewRow taskId="task-1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the preview row', () => {
  it('shows the live origin as a link a user can open, and stops it on request', async () => {
    const target = live();
    const { calls } = stubFetch({ reads: [statusBody(target), statusBody(null)] });
    renderRow();

    // The origin is rendered as the URL, and as something openable — the row's
    // whole job is to answer "where is it being served".
    const link = await screen.findByRole('link', { name: 'Open' });
    expect(link.getAttribute('href')).toBe(target.url);
    expect(screen.getByText(target.url)).toBeDefined();

    // Nothing minted: the render issues a read and only a read.
    expect(calls.map((call) => call.method)).toEqual(['GET']);

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('No preview is running for this task.')).toBeDefined();
    expect(calls.map((call) => call.method)).toEqual(['GET', 'DELETE', 'GET']);
  });

  it('offers to start one when there is none, and shows what came back', async () => {
    const target = live();
    const { calls } = stubFetch({ reads: [statusBody(null), statusBody(target)], mint: target });
    renderRow();

    expect(await screen.findByText('No preview is running for this task.')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Start preview' }));

    expect(await screen.findByText(target.url)).toBeDefined();
    expect(calls.some((call) => call.method === 'POST')).toBe(true);
    // The URL shown after starting is the one the *mint* reported, not a guess.
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(target.url);
  });

  it('says the host has previews off instead of pretending nothing is running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json(
            {
              error: {
                code: 'capability_disabled',
                message: 'The preview listener is disabled on this host.',
                retryable: false,
                details: { setting: 'HYPERION_PREVIEW_PORT' },
              },
            },
            403,
          ),
        ),
      ),
    );
    renderRow();

    // A disabled feature is a different fact from an idle task, and the row keeps
    // them apart — and names the setting, which is the only actionable thing here.
    expect(await screen.findByText(/Previews are off on this host/)).toBeDefined();
    expect(screen.getByText('HYPERION_PREVIEW_PORT')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Start preview' })).toBeNull();
    expect(screen.queryByText(/No preview is running/)).toBeNull();
  });
});
