import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { CanvasTabs } from './CanvasTabs';
import type { CanvasTab } from './useCanvasTab';

/**
 * The tab strip (Addendum 2.4).
 *
 * The claims worth pinning: the ARIA tabs contract (roles, the aria-controls
 * /aria-labelledby round trip, the roving tab stop, arrow-key navigation that
 * wraps), that Overview's content is the *same* content — the panel does not
 * re-implement the region it now contains — that a hidden panel which was
 * never opened costs no requests, and that this file declares no motion at
 * all, which is the reduced-motion guarantee by construction.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const treeBody = {
  taskId: 'task-1',
  mode: 'worktree' as const,
  root: '.',
  truncated: false,
  entries: [
    { path: 'app.ts', name: 'app.ts', type: 'file', bytes: 12 },
    { path: 'src', name: 'src', type: 'directory', bytes: null },
    { path: 'src/main.ts', name: 'main.ts', type: 'file', bytes: 40 },
  ],
  skipped: [],
};

function stubFetch() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url.includes('/files')) return Promise.resolve(json(treeBody));
      return Promise.resolve(json({}));
    }),
  );
  return { calls };
}

function renderTabs(initialTab: 'overview' | 'files' = 'overview') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onTabChange = vi.fn();
  const onSelectFile = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <CanvasTabs
        taskId="task-1"
        file={null}
        activeTab={initialTab}
        onTabChange={onTabChange}
        onSelectFile={onSelectFile}
        onSendErrors={vi.fn()}
      >
        <p>Recovery and spend, unchanged.</p>
      </CanvasTabs>
    </QueryClientProvider>,
  );
  return { onTabChange, onSelectFile };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the tab strip', () => {
  it('renders the ARIA tabs contract: roles, controls and labels wired both ways', () => {
    renderTabs();
    const list = screen.getByRole('tablist', { name: 'Task workspace views' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Overview',
      'Files',
      'Diff',
      'Preview',
      'Console',
    ]);

    const overview = screen.getByRole('tab', { name: 'Overview' });
    const files = screen.getByRole('tab', { name: 'Files' });
    expect(overview.getAttribute('aria-selected')).toBe('true');
    expect(files.getAttribute('aria-selected')).toBe('false');

    const panel = document.getElementById(overview.getAttribute('aria-controls') ?? '');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe(overview.id);
    // The active tab is the one in the tab order; the rest are -1 (roving).
    expect(overview.tabIndex).toBe(0);
    expect(files.tabIndex).toBe(-1);
  });

  it('moves with arrow keys, wraps at the ends, and activates what it focuses', async () => {
    const user = userEvent.setup();
    const { onTabChange } = renderTabs();
    const overview = screen.getByRole('tab', { name: 'Overview' });
    const files = screen.getByRole('tab', { name: 'Files' });

    const diff = screen.getByRole('tab', { name: 'Diff' });
    const preview = screen.getByRole('tab', { name: 'Preview' });

    overview.focus();
    await user.keyboard('{ArrowRight}');
    expect(onTabChange).toHaveBeenLastCalledWith('files');
    expect(document.activeElement).toBe(files);
    await user.keyboard('{ArrowRight}');
    expect(onTabChange).toHaveBeenLastCalledWith('diff');
    expect(document.activeElement).toBe(diff);
    await user.keyboard('{ArrowRight}');
    expect(onTabChange).toHaveBeenLastCalledWith('preview');
    expect(document.activeElement).toBe(preview);
    await user.keyboard('{ArrowRight}');
    expect(onTabChange).toHaveBeenLastCalledWith('console');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Console' }));
    // Past the end, back to the start.
    await user.keyboard('{ArrowRight}');
    expect(onTabChange).toHaveBeenLastCalledWith('overview');
    expect(document.activeElement).toBe(overview);
    await user.keyboard('{End}');
    expect(onTabChange).toHaveBeenLastCalledWith('console');
    await user.keyboard('{Home}');
    expect(onTabChange).toHaveBeenLastCalledWith('overview');
    // And backwards from the start wraps to the end.
    await user.keyboard('{ArrowLeft}');
    expect(onTabChange).toHaveBeenLastCalledWith('console');
  });

  it("keeps Overview's content as the panel's content — the region was wrapped, not replaced", () => {
    renderTabs();
    expect(screen.getByText('Recovery and spend, unchanged.')).toBeInTheDocument();
  });

  it('hides a panel it has never opened and spends no request on it', () => {
    const { calls } = stubFetch();
    renderTabs();
    // The strip renders both panels; only the unvisited one is empty.
    const filesPanel = document.getElementById('canvas-panel-files');
    expect(filesPanel).not.toBeNull();
    expect(filesPanel?.hasAttribute('hidden')).toBe(true);
    expect(filesPanel?.textContent).toBe('');
    expect(calls).toEqual([]);
  });

  it('shows the stored tab straight away — an externally-set active tab is visited', async () => {
    stubFetch();
    renderTabs('files');
    const panel = document.getElementById('canvas-panel-files');
    expect(panel?.hasAttribute('hidden')).toBe(false);
    // The Files tab mounts its content on first paint of the active panel
    // (the tree resolves its listing on the next microtask).
    expect(await screen.findByRole('tree', { name: 'Task files' })).toBeInTheDocument();
  });

  it('keeps Overview mounted (hidden, not unmounted) after a switch', async () => {
    const user = userEvent.setup();
    stubFetch();
    // A stateful host: the strip is controlled by the surface, so a test that
    // clicks has to do what CodeTool does and actually move the state.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Host() {
      const [tab, setTab] = useState<CanvasTab>('overview');
      return (
        <QueryClientProvider client={client}>
          <CanvasTabs
            taskId="task-1"
            file={null}
            activeTab={tab}
            onTabChange={setTab}
            onSelectFile={vi.fn()}
            onSendErrors={vi.fn()}
          >
            <p>Recovery and spend, unchanged.</p>
          </CanvasTabs>
        </QueryClientProvider>
      );
    }
    render(<Host />);
    await user.click(screen.getByRole('tab', { name: 'Files' }));
    const panel = document.getElementById('canvas-panel-overview');
    expect(panel?.hasAttribute('hidden')).toBe(true);
    // Still in the document: a switch must not tear the region down.
    expect(screen.getByText('Recovery and spend, unchanged.')).toBeInTheDocument();
  });

  it('opens the Console panel with its empty state, without spending a request', async () => {
    const { calls } = stubFetch();
    const user = userEvent.setup();
    // Stateful host: the strip is controlled, so opening a tab means moving
    // the state the way CodeTool does.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Host() {
      const [tab, setTab] = useState<CanvasTab>('overview');
      return (
        <QueryClientProvider client={client}>
          <CanvasTabs
            taskId="task-1"
            file={null}
            activeTab={tab}
            onTabChange={setTab}
            onSelectFile={vi.fn()}
            onSendErrors={vi.fn()}
          >
            <p>Recovery and spend, unchanged.</p>
          </CanvasTabs>
        </QueryClientProvider>
      );
    }
    render(<Host />);
    await user.click(screen.getByRole('tab', { name: 'Console' }));
    const panel = document.getElementById('canvas-panel-console');
    expect(panel?.hasAttribute('hidden')).toBe(false);
    expect(screen.getByTestId('console-empty')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('declares no motion — the reduced-motion guarantee by construction', () => {
    // Strip comments first: the file's own prose names the words this checks
    // for, and a comment is not a transition.
    const css = readFileSync(`${__dirname}/CanvasTabs.module.css`, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css).not.toMatch(/(^|[^-])(animation|transition|@keyframes)/);
  });
});
