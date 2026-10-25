import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import { CanvasTabs } from './CanvasTabs';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function renderTabs(onSelectFile = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onTabChange = vi.fn();
  const view = render(<QueryClientProvider client={client}><CanvasTabs taskId="task-a" file={null}
    activeTab="overview" onTabChange={onTabChange} onSelectFile={onSelectFile}>
    <p>Existing overview content</p>
  </CanvasTabs></QueryClientProvider>);
  return { ...view, onSelectFile, onTabChange };
}

afterEach(() => vi.unstubAllGlobals());

describe('Canvas tabs and file tree', () => {
  it('keeps Overview content and provides keyboard-operated tabs', async () => {
    const { onTabChange } = renderTabs();
    expect(screen.getByText('Existing overview content')).toBeInTheDocument();
    const overview = screen.getByRole('tab', { name: 'Overview' });
    overview.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onTabChange).toHaveBeenLastCalledWith('files');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-controls', 'canvas-panel-overview');
  });

  it('loads files on demand, follows tree keys, selects through the caller, and labels symlinks', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url.includes('/files?path=.')) return Promise.resolve(json({ taskId: 'task-a', mode: 'worktree', root: '.', truncated: false, skipped: [], entries: [
        { path: 'src', name: 'src', type: 'directory', bytes: null },
        { path: 'jump', name: 'jump', type: 'symlink', bytes: null },
      ] }));
      if (url.includes('/files?path=src')) return Promise.resolve(json({ taskId: 'task-a', mode: 'worktree', root: 'src', truncated: false, skipped: [], entries: [
        { path: 'src/app.ts', name: 'app.ts', type: 'file', bytes: 5 },
      ] }));
      return Promise.resolve(json({ path: 'src/app.ts', content: '<b>x</b>', sha256: 'd'.repeat(64), bytes: 8 }));
    }));
    const selected = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Harness() {
      const [file, setFile] = React.useState<string | null>(null);
      return <QueryClientProvider client={client}><CanvasTabs taskId="task-a" file={file} activeTab="files"
        onTabChange={vi.fn()} onSelectFile={(path) => { selected(path); setFile(path); }}>
        <p>Overview</p>
      </CanvasTabs></QueryClientProvider>;
    }
    render(<Harness />);

    const tree = await screen.findByRole('tree', { name: 'Task files' });
    const folder = await within(tree).findByRole('treeitem', { name: /src/ });
    expect(calls.some((url) => url.includes('path=src'))).toBe(false);
    folder.focus();
    await userEvent.keyboard('{ArrowRight}');
    const file = await within(tree).findByRole('treeitem', { name: /app.ts/ });
    expect(calls.some((url) => url.includes('path=src'))).toBe(true);
    file.focus();
    await userEvent.keyboard('{Enter}');
    expect(selected).toHaveBeenCalledWith('src/app.ts');
    expect(await screen.findByText('<b>x</b>')).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
    expect(within(tree).getByText(/symlink \(not followed\)/)).toBeInTheDocument();
  });
});
