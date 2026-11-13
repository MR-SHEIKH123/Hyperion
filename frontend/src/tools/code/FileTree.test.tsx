import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileTree } from './FileTree';

/**
 * The Files tab's tree (Addendum 2.4; docs/API.md §27.1).
 *
 * The claims worth pinning are the ones a plausible implementation gets
 * wrong: that expanding a directory under a *complete* walk costs no request
 * (the root listing already held the children), that a `truncated` walk does
 * re-read the subtree it cannot prove anything about, that a symlink is
 * labelled and unopenable, that `.git` never reaches the DOM even if a
 * listing regression sends it, and that the keyboard walks the flattened
 * order — a group-relative index would skip rows.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const file = (path: string, bytes = 12) => ({
  path,
  name: path.split('/').pop() ?? path,
  type: 'file' as const,
  bytes,
});
const dir = (path: string) => ({
  path,
  name: path.split('/').pop() ?? path,
  type: 'directory' as const,
  bytes: null,
});

const rootBody = (entries: unknown[], overrides: Record<string, unknown> = {}) => ({
  taskId: 'task-1',
  mode: 'worktree',
  root: '.',
  truncated: false,
  entries,
  skipped: [],
  ...overrides,
});

/** Answers `?path=` per key; unknown paths 404 like the real route. */
function stubFetch(byPath: Record<string, unknown>, statusFor: Record<string, number> = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      const path = decodeURIComponent(new URL(url, 'http://x').searchParams.get('path') ?? '.');
      const body = byPath[path];
      if (body === undefined) return Promise.resolve(json({ error: { message: 'nope', code: 'not_found', retryable: false } }, 404));
      return Promise.resolve(json(body, statusFor[path] ?? 200));
    }),
  );
  return { calls };
}

function renderTree(selectedPath: string | null = null, onSelect = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <FileTree taskId="task-1" selectedPath={selectedPath} onSelect={onSelect} />
    </QueryClientProvider>,
  );
  return { ...utils, onSelect };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the file tree', () => {
  it('renders one tree with levels, and opens a file on Enter', async () => {
    const user = userEvent.setup();
    stubFetch({ '.': rootBody([file('app.ts'), dir('src'), file('src/main.ts', 40)]) });
    const { onSelect } = renderTree();

    const tree = await screen.findByRole('tree', { name: 'Task files' });
    // The collapsed directory's child is not visible yet: two level-1 rows.
    const rows = within(tree).getAllByRole('treeitem');
    expect(rows.map((row) => row.getAttribute('aria-level'))).toEqual(['1', '1']);

    rows[0]?.focus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('app.ts');
  });

  it('walks the flattened order with the arrow keys, and expands directories in place', async () => {
    const user = userEvent.setup();
    stubFetch({ '.': rootBody([file('app.ts'), dir('src'), file('src/main.ts', 40)]) });
    const { onSelect } = renderTree();

    const tree = await screen.findByRole('tree', { name: 'Task files' });
    const [app, src] = within(tree).getAllByRole('treeitem');

    // Roving start: only one row is in the tab order.
    expect(app?.tabIndex).toBe(0);
    expect(src?.tabIndex).toBe(-1);

    app?.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(src);

    // Enter on a directory expands it; its child appears in flattened order
    // *after* it — ArrowDown from the directory lands on the child, and from
    // the child on nothing (the child is the last visible row here).
    await user.keyboard('{Enter}');
    const main = await screen.findByRole('treeitem', { name: 'main.ts' });
    expect(src?.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(main);

    // ArrowUp from the child lands on its parent — one row, not two: rows
    // nest, so an un-stopped key would bubble into the parent's handler as
    // well and jump past it. Then ArrowLeft on the expanded directory
    // collapses it (on a collapsed one it climbs to the parent instead).
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(src);
    await user.keyboard('{ArrowLeft}');
    expect(screen.queryByRole('treeitem', { name: 'main.ts' })).toBeNull();

    // Home returns to the first row even after wandering.
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(app);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('expands a complete walk without a second request', async () => {
    const { calls } = stubFetch({
      '.': rootBody([dir('src'), file('src/main.ts', 40)]),
      src: rootBody([file('src/main.ts', 40)]),
    });
    const user = userEvent.setup();
    renderTree();

    const src = await screen.findByRole('treeitem', { name: 'src' });
    await user.click(src);
    expect(await screen.findByRole('treeitem', { name: 'main.ts' })).toBeInTheDocument();
    // One request only: the root listing already held the child, so a subtree
    // read here would be a flash of "loading" over data already in hand.
    expect(calls.filter((url) => url.includes('path=src'))).toHaveLength(0);
  });

  it('re-reads the subtree when the walk was truncated — and says so when it fails', async () => {
    const { calls } = stubFetch({
      '.': rootBody([dir('src')], { truncated: true }),
    });
    const user = userEvent.setup();
    renderTree();

    const src = await screen.findByRole('treeitem', { name: 'src' });
    await user.click(src);
    await waitFor(() => {
      expect(calls.some((url) => url.includes('path=src'))).toBe(true);
    });
    // The subtree 404s in this stub (never registered), so the directory says
    // what happened instead of rendering an empty truth.
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be read/);
  });

  it('lists a symlink as one, and Enter does nothing on it', async () => {
    const user = userEvent.setup();
    stubFetch({
      '.': rootBody([
        { path: 'linked-dir', name: 'linked-dir', type: 'symlink', bytes: null },
        file('app.ts'),
      ]),
    });
    const { onSelect } = renderTree();

    const link = await screen.findByRole('treeitem', { name: /linked-dir/ });
    expect(link.getAttribute('aria-label')).toContain('symlink (not followed)');
    expect(link.hasAttribute('aria-expanded')).toBe(false);
    link.focus();
    await user.keyboard('{Enter}');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('never renders a .git entry, even if a listing sends one', async () => {
    stubFetch({
      '.': rootBody([file('.git/config'), file('.gitignore', 3)]),
    });
    renderTree();

    const tree = await screen.findByRole('tree', { name: 'Task files' });
    const names = within(tree)
      .getAllByRole('treeitem')
      .map((row) => row.getAttribute('aria-label'));
    expect(names).not.toContain('.git');
    // The sibling that is *not* `.git` still shows: the filter is a segment
    // test, not a prefix one (`.gitignore` contains `.git` and is kept).
    expect(names).toContain('.gitignore');
  });

  it('reveals a selected file by expanding its ancestors, and marks it selected', async () => {
    stubFetch({ '.': rootBody([dir('src'), file('src/main.ts', 40)]) });
    const { rerender } = renderTree(null);

    await screen.findByRole('tree', { name: 'Task files' });
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <FileTree taskId="task-1" selectedPath="src/main.ts" onSelect={vi.fn()} />
      </QueryClientProvider>,
    );
    // The selection change expands `src`; the query for the child was already
    // served by the root listing, so the row appears without a new fetch.
    const main = await screen.findByRole('treeitem', { name: 'main.ts' });
    expect(main.getAttribute('aria-selected')).toBe('true');
  });

  it('states an empty workspace instead of rendering an empty tree', async () => {
    stubFetch({ '.': rootBody([]) });
    renderTree();
    expect(await screen.findByText('This task workspace has no files to list.')).toBeInTheDocument();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('surfaces a failed root read as the message the backend wrote', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json(
            { error: { message: 'Worktree gone.', code: 'not_found', retryable: false } },
            404,
          ),
        ),
      ),
    );
    renderTree();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The task file tree could not be read: Worktree gone.',
    );
  });
});
