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
    activeTab="overview" onTabChange={onTabChange} onOpenFiles={vi.fn()} onSelectFile={onSelectFile}>
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
        onTabChange={vi.fn()} onOpenFiles={vi.fn()} onSelectFile={(path) => { selected(path); setFile(path); }}>
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

describe('Preview tab', () => {
  const secret = 'c'.repeat(64);
  const livePreview = () => ({ taskId: 'task-a', token: secret, url: `http://preview.test:4320/p/${secret}/`, expiresAt: Date.now() + 60_000 });
  const tree = (files: { path: string; name: string }[] = [{ path: 'index.html', name: 'index.html' }]) => ({
    taskId: 'task-a', mode: 'worktree', root: '.', truncated: false, skipped: [],
    entries: files.map((file) => ({ ...file, type: 'file', bytes: 10 })),
  });
  const harness = (client: QueryClient) => <QueryClientProvider client={client}><CanvasTabs taskId="task-a" file={null}
    activeTab="preview" onTabChange={vi.fn()} onOpenFiles={vi.fn()} onSelectFile={vi.fn()}><p>Overview</p></CanvasTabs></QueryClientProvider>;

  it('reads status without minting, then embeds with the exact locked-down sandbox', async () => {
    let minted: ReturnType<typeof livePreview> | null = null;
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? 'GET';
      calls.push(method);
      if (url.includes('/files?')) return Promise.resolve(json(tree()));
      if (method === 'POST') { minted = livePreview(); return Promise.resolve(json(minted)); }
      return Promise.resolve(json({ taskId: 'task-a', preview: minted }));
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(harness(client));

    expect(await screen.findByText('No preview session exists for this task.')).toBeInTheDocument();
    expect(calls).not.toContain('POST');
    expect(screen.queryByTitle('Preview of task task-a')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Start preview' }));
    const frame = await screen.findByTitle('Preview of task task-a');
    expect(calls).toContain('POST');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-pointer-lock');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(frame).not.toHaveAttribute('allow');
    expect(document.body.textContent).not.toContain(secret);
    expect(window.location.href).not.toContain(secret);
    expect(localStorage.getItem('hyperion.frontend.state') ?? '').not.toContain(secret);
    expect(screen.getByText('http://preview.test:4320')).toBeInTheDocument();
    expect(screen.getByText(/HYPERION_APP_ORIGINS/)).toBeInTheDocument();
    expect(screen.getByText(/Browser storage is unavailable/)).toBeInTheDocument();
  });

  it('links to Files when no root HTML entry exists and never renders a blank iframe', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      return Promise.resolve(json(url.includes('/files?') ? tree([{ path: 'README.md', name: 'README.md' }]) : { taskId: 'task-a', preview: null }));
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(harness(client));
    expect(await screen.findByText(/nothing to preview/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Files' })).toBeInTheDocument();
    expect(screen.queryByTitle('Preview of task task-a')).toBeNull();
  });

  it('names the disabled setting and does not offer mint', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/files?')) return Promise.resolve(json(tree()));
      return Promise.resolve(json({ error: { code: 'capability_disabled', message: 'disabled', retryable: false, details: { setting: 'HYPERION_PREVIEW_PORT' } } }, 403));
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(harness(client));
    expect(await screen.findByText(/HYPERION_PREVIEW_PORT/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start preview' })).toBeNull();
    expect(screen.queryByTitle('Preview of task task-a')).toBeNull();
  });

  it('renders unreachable and gone-worktree states rather than a blank frame', async () => {
    for (const [status, code, message] of [[503, 'network_error', 'down'], [404, 'not_found', 'gone']] as const) {
      vi.unstubAllGlobals();
      vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('/files?')) return Promise.resolve(json(tree()));
        if (code === 'network_error') return Promise.reject(new TypeError('offline'));
        return Promise.resolve(json({ error: { code, message, retryable: false, details: { taskId: 'task-a' } } }, status));
      }));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { unmount } = render(harness(client));
      expect(await screen.findByText(status === 404 ? /worktree is gone/ : /listener is unreachable/)).toBeInTheDocument();
      expect(screen.queryByTitle('Preview of task task-a')).toBeNull();
      unmount();
    }
  });
});
