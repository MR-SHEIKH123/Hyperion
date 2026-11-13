import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PreviewTab } from './PreviewTab';

/**
 * The Preview tab's shell (Addendum 2.4; docs/API.md §27.4).
 *
 * The claims worth pinning: rendering the tab costs a read and *only* a read
 * (a mint on display revokes the URL the user already has open), Start is
 * the one gesture that mints, the expiry is read against the last session
 * the tab saw (the server drops expired sessions, so the flip to null is
 * the only signal there is), the no-root-HTML state comes from the cached
 * root listing rather than from loading a 404 into the frame, and an
 * artifact burst reloads the frame once — after the debounce, not before.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TOKEN = 'e'.repeat(64);
const PREVIEW = {
  taskId: 'task-1',
  token: TOKEN,
  url: `http://127.0.0.1:4320/p/${TOKEN}/`,
  expiresAt: Date.now() + 30 * 60_000,
};
const statusBody = (preview: unknown) => ({ taskId: 'task-1', preview });
const treeBody = (entries: unknown[]) => ({
  taskId: 'task-1',
  mode: 'worktree',
  root: '.',
  truncated: false,
  entries,
  skipped: [],
});

/**
 * Answers each route in order; `reads` is consumed per GET of the status
 * route, so a test can describe what successive polls see. An entry of
 * `{status, body}` answers with that status — the refusals are 4xx/5xx
 * envelopes, and a 200 carrying an `error` body would be a different wire
 * than the route actually writes.
 */
/** A refusal answer: the envelope with the status it actually arrives with. */
function isStatusAnswer(value: unknown): value is { status: number; body: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    'body' in value &&
    typeof (value as { status: unknown }).status === 'number'
  );
}

function stubFetch({
  reads,
  mint = PREVIEW,
  tree = treeBody([{ path: 'index.html', name: 'index.html', type: 'file', bytes: 12 }]),
}: {
  reads: unknown[];
  mint?: unknown;
  tree?: unknown;
}) {
  const calls: { method: string; url: string }[] = [];
  let read = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ method, url });
      if (url.includes('/files')) return Promise.resolve(json(tree));
      if (url.includes('/preview')) {
        if (method === 'POST') return Promise.resolve(json(mint, 201));
        if (method === 'DELETE') return Promise.resolve(json({ revoked: true }));
        const answer = reads[Math.min(read++, reads.length - 1)];
        if (isStatusAnswer(answer)) return Promise.resolve(json(answer.body, answer.status));
        return Promise.resolve(json(answer));
      }
      return Promise.resolve(json({}));
    }),
  );
  return { calls };
}

function renderTab(options: { writeRevision?: number; onOpenFiles?: () => void } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const onOpenFiles = options.onOpenFiles ?? vi.fn();
  const view = (writeRevision: number) => (
    <QueryClientProvider client={client}>
      <PreviewTab taskId="task-1" writeRevision={writeRevision} onOpenFiles={onOpenFiles} />
    </QueryClientProvider>
  );
  const utils = render(view(options.writeRevision ?? 0));
  return { ...utils, client, onOpenFiles, rerenderWith: (revision: number) => utils.rerender(view(revision)) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Preview tab', () => {
  it('renders from a read alone — never a mint — and keeps the token out of the text', async () => {
    const { calls } = stubFetch({ reads: [statusBody(PREVIEW)] });
    renderTab();

    expect(await screen.findByTitle('Preview of task task-1')).toBeDefined();
    const routes = calls.map((call) => `${call.method} ${call.url.includes('/files') ? 'files' : 'preview'}`);
    expect(routes).toEqual(['GET preview', 'GET files']);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
  });

  it('mints once, on the Start button, and only there', async () => {
    const user = userEvent.setup();
    // The first read sees nothing; the read after the mint sees the session
    // the mint created (the tab invalidates rather than trusting the POST's
    // echo alone).
    const { calls } = stubFetch({ reads: [statusBody(null), statusBody(PREVIEW)] });
    renderTab();

    expect(await screen.findByText('No preview is running for this task.')).toBeDefined();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Start preview' }));
    expect(await screen.findByTitle('Preview of task task-1')).toBeDefined();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('names the setting when the listener is off, and offers no start', async () => {
    stubFetch({
      reads: [
        {
          status: 403,
          body: {
            error: {
              code: 'capability_disabled',
              message: 'The preview listener is disabled on this host.',
              retryable: false,
              details: { setting: 'HYPERION_PREVIEW_PORT' },
            },
          },
        },
      ],
    });
    renderTab();

    expect(await screen.findByText(/Previews are off on this host/)).toBeDefined();
    expect(screen.getByText('HYPERION_PREVIEW_PORT')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Start preview' })).toBeNull();
  });

  it('reports a read it could not make as a failure with its message', async () => {
    stubFetch({
      reads: [
        {
          status: 500,
          body: {
            error: { code: 'internal_error', message: 'The listener exploded.', retryable: true },
          },
        },
      ],
    });
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent('The listener exploded.');
    expect(screen.queryByText('No preview is running')).toBeNull();
  });

  it('says a released workspace is gone rather than idle', async () => {
    stubFetch({
      reads: [
        {
          status: 404,
          body: {
            error: {
              code: 'not_found',
              message: 'No active code task with id "task-1".',
              retryable: false,
            },
          },
        },
      ],
    });
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No active code task with id "task-1".',
    );
    expect(screen.queryByRole('button', { name: 'Start preview' })).toBeNull();
  });

  it('reads a live session that later polls drop as an expiry, not as never having run', async () => {
    const { calls } = stubFetch({ reads: [statusBody(PREVIEW), statusBody(null)] });
    const { client } = renderTab();

    expect(await screen.findByTitle('Preview of task task-1')).toBeDefined();

    // The server drops an expired session: the next poll says null. The tab
    // remembers the session it was told about, so the flip reads as an
    // expiry — the state that offers a renewal — and not as "no preview is
    // running", which would be a different claim about the same answer.
    await client.refetchQueries({ queryKey: ['canvas', 'preview', 'task-1'] });
    expect(await screen.findByRole('button', { name: 'Renew preview' })).toBeDefined();
    expect(screen.queryByText('No preview is running for this task.')).toBeNull();

    // And nothing here re-minted on its own.
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('sends the reader to the Files tab when the root has no index.html', async () => {
    const user = userEvent.setup();
    stubFetch({
      reads: [statusBody(PREVIEW)],
      tree: treeBody([{ path: 'src/app.ts', name: 'app.ts', type: 'file', bytes: 9 }]),
    });
    const { onOpenFiles } = renderTab();

    expect(await screen.findByRole('button', { name: 'Open Files' })).toBeDefined();
    // No dead frame: the root URL would be the listener's 404.
    expect(document.querySelector('iframe')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open Files' }));
    expect(onOpenFiles).toHaveBeenCalledTimes(1);
  });

  it('reloads the frame once, after an artifact burst settles — not on mount', async () => {
    stubFetch({ reads: [statusBody(PREVIEW)] });
    const { rerenderWith } = renderTab({ writeRevision: 3 });
    const first = await screen.findByTitle('Preview of task task-1');

    // A revision already on screen must not reload the frame that just
    // loaded: the counter starts applied.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(document.querySelector('iframe')).toBe(first);

    // A new artifact frame (a save) schedules one remount, debounced so a
    // multi-file write's burst produces a single reload.
    rerenderWith(4);
    // Not synchronously — the debounce is the point.
    expect(document.querySelector('iframe')).toBe(first);
    await waitFor(
      () => {
        expect(document.querySelector('iframe')).not.toBe(first);
      },
      { timeout: 1_500 },
    );
  });
});
