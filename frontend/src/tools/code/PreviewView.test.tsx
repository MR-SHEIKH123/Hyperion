import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PreviewView, describeRemaining, type PreviewViewProps, type PreviewVm } from './PreviewView';

/**
 * The Preview tab's view (Addendum 2.4; docs/API.md §27.4).
 *
 * The claims worth pinning are the ones a plausible implementation gets
 * wrong: the iframe's sandbox string is *exactly* three permissions (no
 * `allow-same-origin` for agent-authored content), the referrer policy is
 * `no-referrer`, the frame has a title, the token appears nowhere a reader
 * can read it while the href keeps the URL a preview actually is, and every
 * honest state in the brief renders its own words — disabled names the
 * setting, expired offers a renewal, no-root-HTML offers the Files tab.
 */

const TOKEN = 'f'.repeat(64);
const URL_ = `http://127.0.0.1:4320/p/${TOKEN}/`;

function renderView(vm: PreviewVm, props: Partial<PreviewViewProps> = {}) {
  const noop = vi.fn();
  const utils = render(
    <PreviewView
      taskId="task-1"
      vm={vm}
      onStart={noop}
      onStop={noop}
      onReload={noop}
      onOpenFiles={noop}
      {...props}
    />,
  );
  return { ...utils, noop };
}

describe('the preview view', () => {
  it('embeds a live preview with the exact sandbox, policy and title — and no token as text', () => {
    renderView({ kind: 'live', url: URL_, origin: 'http://127.0.0.1:4320', expiresAt: Date.now() + 60_000 });

    const frame = document.querySelector('iframe');
    expect(frame).not.toBeNull();
    // Exactly these three: scripts run (a preview with no JS is not one),
    // forms and pointer lock work, and the origin stays opaque — the
    // agent-authored content cannot reach the app that embedded it.
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-pointer-lock');
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame?.getAttribute('title')).toBe('Preview of task task-1');
    expect(frame?.getAttribute('src')).toBe(URL_);

    // The URL is the frame's to load; the reader's eyes get the origin.
    expect(screen.getByText('http://127.0.0.1:4320')).toBeDefined();
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(document.querySelector('iframe')?.textContent ?? '').not.toContain(TOKEN);
    // Not in storage, not in the app's own URL either.
    expect(JSON.stringify(localStorage)).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
  });

  it('offers the start button for no session, and only on a click', () => {
    const { noop } = renderView({ kind: 'no-session' });
    expect(screen.getByText('No preview is running for this task.')).toBeDefined();
    expect(noop).not.toHaveBeenCalled();
    const start = screen.getByRole('button', { name: 'Start preview' });
    expect(start).toBeDefined();
  });

  it('offers a renewal for an expired session — a different fact from never having run', () => {
    renderView({ kind: 'expired' });
    expect(screen.getByText(/preview expired/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Renew preview' })).toBeDefined();
    expect(screen.queryByText('No preview is running for this task.')).toBeNull();
  });

  it('names the setting when previews are off on the host, and offers no start', () => {
    renderView({ kind: 'disabled', setting: 'HYPERION_PREVIEW_PORT' });
    expect(screen.getByText(/Previews are off on this host/)).toBeDefined();
    expect(screen.getByText('HYPERION_PREVIEW_PORT')).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says a released workspace is gone, with the backend’s sentence', () => {
    renderView({ kind: 'gone', message: 'No active code task with id "task-1".' });
    expect(screen.getByRole('alert')).toHaveTextContent('No active code task with id "task-1".');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('reports a failed read as a failure, not as an idle preview', () => {
    renderView({ kind: 'failed', message: 'Hyperion could not be reached.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Hyperion could not be reached.');
    expect(screen.queryByText('No preview is running')).toBeNull();
  });

  it('sends the reader to the Files tab when the root has no index.html — no dead frame', async () => {
    const { noop } = renderView({ kind: 'no-root-html', origin: 'http://127.0.0.1:4320' });
    expect(screen.getByText(/no\s+index\.html|no/)).toBeDefined();
    expect(document.querySelector('iframe')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open Files' }));
    expect(noop).toHaveBeenCalledTimes(1);
  });

  it('shows the reading and minting states as statuses, with no frame', () => {
    const { unmount } = renderView({ kind: 'reading' });
    expect(screen.getByRole('status')).toHaveTextContent('Reading the preview…');
    expect(document.querySelector('iframe')).toBeNull();
    unmount();
    renderView({ kind: 'minting' });
    expect(screen.getByRole('status')).toHaveTextContent('Starting the preview…');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('remounts the frame when the reload key moves — the only reload a cross-origin frame allows', () => {
    const { rerender } = renderView({ kind: 'live', url: URL_, origin: 'http://127.0.0.1:4320', expiresAt: Date.now() + 60_000 });
    const first = document.querySelector('iframe');
    rerender(
      <PreviewView
        taskId="task-1"
        vm={{ kind: 'live', url: URL_, origin: 'http://127.0.0.1:4320', expiresAt: Date.now() + 60_000 }}
        frameKey={1}
      />,
    );
    const second = document.querySelector('iframe');
    expect(second).not.toBe(first);
  });

  it('states the remaining life only when it is worth stating', () => {
    const now = 1_000_000;
    expect(describeRemaining(now + 30 * 60_000, now)).toBeNull();
    expect(describeRemaining(now + 2 * 60_000, now)).toBe('expires in 2 min');
    expect(describeRemaining(now - 1, now)).toBe('expired');
  });
});
