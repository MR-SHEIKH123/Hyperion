import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiffTab } from './DiffTab';

/**
 * The Diff tab (Addendum 2.4; docs/API.md §27.3).
 *
 * The claims worth pinning: the direct-mode refusal is an honest empty state
 * carrying the backend's sentence and its mode/reason facts — never a blank
 * panel, never an empty change list; the selected file's patch is rendered as
 * *text* (markup in a diff stays display); a file outside the diff says so
 * instead of showing a hole; and the truncation flag the backend now sends is
 * rendered by the embedded list.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const diffBody = (patch: string, truncated = false) => ({
  taskId: 'task-1',
  baseCommit: 'abcdef1234567890',
  patch,
  truncated,
});

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' one',
  '+<span id="owned-by-page">two</span>',
  ' three',
  '',
].join('\n');

function stubFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      return Promise.resolve(json(body, status));
    }),
  );
  return { calls };
}

function renderTab(file: string | null = null, onSelectFile = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DiffTab taskId="task-1" file={file} onSelectFile={onSelectFile} />
    </QueryClientProvider>,
  );
  return { onSelectFile };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Diff tab', () => {
  it('says it is reading before the answer lands', () => {
    stubFetch(new Promise(() => undefined));
    renderTab();
    expect(screen.getByRole('status')).toHaveTextContent("Reading the task's diff…");
  });

  it('renders a direct-mode refusal as the honest empty state, with its facts', async () => {
    stubFetch(
      {
        error: {
          code: 'bad_request',
          message:
            'Task "task-1" ran without git isolation, so there is no patch to export.',
          retryable: false,
          details: { taskId: 'task-1', mode: 'direct', reason: 'git was not installed' },
        },
      },
      400,
    );
    renderTab();

    const alert = await screen.findByRole('alert');
    // §27.3's prescription, in words: not blank, and not "no changes".
    expect(alert.textContent).toContain('No base to compare against.');
    expect(alert.textContent).toContain('without git isolation');
    expect(alert.textContent).toContain('direct');
    expect(alert.textContent).toContain('git was not installed');
    expect(screen.queryByText(/No changes against/)).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('renders a dropped read as a failure with its message and a retry', async () => {
    stubFetch(
      { error: { code: 'internal_error', message: 'The export exploded.', retryable: true } },
      500,
    );
    renderTab();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The export exploded.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
  });

  it('lists the change and renders the selected file’s patch as text', async () => {
    stubFetch(diffBody(PATCH));
    renderTab('src/a.ts');

    // The embedded list — the inspector's own component, one query key.
    // (The path appears twice by design: the list row and the patch pane's
    // note; the list renders it as a span.)
    expect(await screen.findByText('src/a.ts', { selector: 'span' })).toBeDefined();
    expect(screen.getByText('+1')).toBeDefined();

    // The selected file's section, as text: the markup in the patch is
    // readable and is not an element on this page.
    expect(document.querySelector('#owned-by-page')).toBeNull();
    expect(screen.getByText(/<span id="owned-by-page">two<\/span>/)).toBeDefined();
    // The patch pane's own heading names the file (the list row is a span;
    // this is the note above the `<pre>`).
    expect(screen.getByText('src/a.ts', { selector: 'p' })).toBeDefined();
  });

  it('names a selected file that the diff does not contain', async () => {
    stubFetch(diffBody(PATCH));
    renderTab('unchanged.ts');

    expect(await screen.findByText(/unchanged\.ts is not among this task's changed files\./)).toBeDefined();
    expect(screen.queryByText(/owned-by-page/)).toBeNull();
  });

  it('asks for a selection when none is made', async () => {
    stubFetch(diffBody(PATCH));
    renderTab(null);

    expect(await screen.findByText('Select a changed file to read its patch here.')).toBeDefined();
  });

  it('says a task has no changes when it truly has none', async () => {
    stubFetch(diffBody(''));
    renderTab(null);

    expect(await screen.findByText('No changes against the base commit.')).toBeDefined();
  });

  it('shows the truncation notice when the backend cut the patch', async () => {
    stubFetch(diffBody(PATCH, true));
    renderTab(null);

    expect(await screen.findByText(/larger than the response limit and was cut/)).toBeDefined();
  });

  it('hands a clicked file to the surface, which is what writes ?file=', async () => {
    stubFetch(diffBody(PATCH));
    const { onSelectFile } = renderTab(null);

    await userEvent.click(await screen.findByText('src/a.ts'));
    expect(onSelectFile).toHaveBeenCalledWith('src/a.ts');
  });
});
