import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileViewer } from './FileViewer';

/**
 * The Files tab's read pane (Addendum 2.4; docs/API.md §27.2).
 *
 * The claims worth pinning: that every refusal the route can answer is
 * rendered as a state with its facts (the two byte counts of a too-large
 * file, the byte count of a binary one from the shared listing, the honest
 * sentence for a file the agent has since deleted), that line numbers are
 * decoration rather than content, and that a file containing markup is
 * displayed — the page does not grow the elements the file names.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const envelope = (message: string, code: string, status: number, details?: unknown) =>
  json({ error: { message, code, retryable: false, ...(details === undefined ? {} : { details }) } }, status);

/** Answers `/file?path=` and the shared root listing `/files?path=.`. */
function stubFetch({
  file,
  fileStatus = 200,
  entries = [] as unknown[],
}: {
  file?: unknown;
  fileStatus?: number;
  entries?: unknown[];
}) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url.includes('/file?')) {
        return file === undefined
          ? Promise.resolve(envelope('gone', 'not_found', 404))
          : Promise.resolve(json(file, fileStatus));
      }
      return Promise.resolve(
        json({ taskId: 'task-1', mode: 'worktree', root: '.', truncated: false, entries, skipped: [] }),
      );
    }),
  );
  return { calls };
}

function renderViewer(path: string | null = 'app.ts') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FileViewer taskId="task-1" path={path} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the file viewer', () => {
  it('asks for a file when none is selected', () => {
    renderViewer(null);
    expect(screen.getByText('Select a file to read it.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders text with line numbers, counting a trailing newline correctly', async () => {
    stubFetch({ file: { path: 'app.ts', sha256: 'a'.repeat(64), bytes: 11, content: 'one\ntwo\n' } });
    renderViewer();

    expect(await screen.findByText(/app\.ts · 2 lines/)).toBeInTheDocument();
    // Line numbers are decoration; the file's own text is what is read.
    expect(screen.getByText(/^1$/)).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.getByText('two')).toBeInTheDocument();
    // Exactly two numbered rows — the trailing newline is not a third line.
    expect(screen.getByText(/^2$/)).toBeInTheDocument();
    expect(screen.queryByText(/^3$/)).toBeNull();
  });

  it('displays markup in a file as text — it never becomes elements on this page', async () => {
    stubFetch({
      file: {
        path: 'page.html',
        sha256: 'b'.repeat(64),
        bytes: 30,
        content: '<span id="owned-by-page">hi</span>\n',
      },
    });
    renderViewer('page.html');

    expect(await screen.findByText(/page\.html · 1 line/)).toBeInTheDocument();
    // The text is readable...
    expect(screen.getByText('<span id="owned-by-page">hi</span>')).toBeInTheDocument();
    // ...and the document did not grow the element the file names.
    expect(document.querySelector('#owned-by-page')).toBeNull();
  });

  it('states a binary file with its byte count from the shared listing', async () => {
    stubFetch({
      fileStatus: 400,
      entries: [{ path: 'logo.png', name: 'logo.png', type: 'file', bytes: 2048 }],
    });
    // The 400 body the backend actually writes for non-UTF8:
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('/file?')) {
          return Promise.resolve(
            envelope('The Code file is not valid UTF-8 text.', 'bad_request', 400),
          );
        }
        return Promise.resolve(
          json({
            taskId: 'task-1',
            mode: 'worktree',
            root: '.',
            truncated: false,
            entries: [{ path: 'logo.png', name: 'logo.png', type: 'file', bytes: 2048 }],
            skipped: [],
          }),
        );
      }),
    );
    renderViewer('logo.png');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'logo.png is a binary file, 2048 bytes — only text files are shown.',
    );
  });

  it('states a too-large file with both byte counts', async () => {
    stubFetch({ fileStatus: 400 });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('/file?')) {
          return Promise.resolve(
            envelope('The Code file is too large to read.', 'bad_request', 400, {
              bytes: 5_000_000,
              limitBytes: 2_097_152,
            }),
          );
        }
        return Promise.resolve(
          json({ taskId: 't', mode: 'worktree', root: '.', truncated: false, entries: [], skipped: [] }),
        );
      }),
    );
    renderViewer('huge.bin');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'huge.bin is too large to show: 5000000 bytes read, the 2097152-byte limit.',
    );
  });

  it('says a deleted file was deleted — the honest 404, not a generic one', async () => {
    stubFetch({});
    renderViewer('gone.ts');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'gone.ts is not in the workspace — the agent has since deleted it.',
    );
  });

  it('renders a scope refusal as the sentence the backend wrote', async () => {
    stubFetch({ fileStatus: 403 });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('/file?')) {
          return Promise.resolve(
            envelope('This path leaves the task workspace.', 'scope_violation', 403),
          );
        }
        return Promise.resolve(
          json({ taskId: 't', mode: 'worktree', root: '.', truncated: false, entries: [], skipped: [] }),
        );
      }),
    );
    renderViewer('../outside.ts');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '../outside.ts could not be read: This path leaves the task workspace.',
    );
  });
});
