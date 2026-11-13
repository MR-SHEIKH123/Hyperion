import type { PreviewVm } from '../../tools/code/PreviewView';
import type { ConsoleEntry } from '../../tools/code/consoleShim';

/**
 * Every state of the Preview tab, as the production `PreviewView` renders
 * it (Addendum 2.4; docs/API.md §27.4).
 *
 * These are the view model itself — not text describing the view, and not a
 * second implementation of it: the harness card mounts the same component the
 * tab mounts, with the state fed in directly, which is the only way a fixture
 * can show a state that needs a listener, a released worktree or an expired
 * session without any of those existing locally.
 *
 * The live URL is shaped like a real one (token included) because part of
 * what this fixture demonstrates is that the token appears in the frame's
 * `src` and nowhere a reader can select it. The frame will fail to load in
 * the harness — there is no listener behind a fabricated token — and that is
 * the state's own honesty, not a broken fixture.
 */
export const previewStateFixtures: {
  id: string;
  title: string;
  detail: string;
  vm: PreviewVm;
}[] = [
  {
    id: 'preview-reading',
    title: 'Reading the session',
    detail: 'The status read is in flight — a status, not a guess, and not yet a mint.',
    vm: { kind: 'reading' },
  },
  {
    id: 'preview-minting',
    title: 'Starting',
    detail: 'The explicit Start (or Renew) is in flight. Minting never happens on render.',
    vm: { kind: 'minting' },
  },
  {
    id: 'preview-no-session',
    title: 'No session',
    detail: 'Nothing is running for this task; the Start button is the one gesture that mints.',
    vm: { kind: 'no-session' },
  },
  {
    id: 'preview-disabled',
    title: 'Previews off on this host',
    detail:
      'The listener is not up: capability_disabled with details.setting named — a fact about the host, not about the task, so no Start button is offered.',
    vm: { kind: 'disabled', setting: 'HYPERION_PREVIEW_PORT' },
  },
  {
    id: 'preview-network-error',
    title: 'Read failed',
    detail: 'The status could not be read at all — rendered as a failure with its message.',
    vm: { kind: 'failed', message: 'Hyperion could not be reached.' },
  },
  {
    id: 'preview-gone',
    title: 'Workspace released',
    detail:
      'The task no longer holds a worktree the listener will serve: a 404 is a gone workspace, not an idle one.',
    vm: { kind: 'gone', message: 'No active code task with id "task-7f2a".' },
  },
  {
    id: 'preview-expired',
    title: 'Expired',
    detail:
      'The session lived and was dropped; the tab read the flip to null against the expiry it last saw, and offers a renewal — never "no preview running".',
    vm: { kind: 'expired' },
  },
  {
    id: 'preview-no-root-html',
    title: 'No index.html at the root',
    detail:
      'The preview runs, but the root URL would be the listener\'s 404 — no dead frame; the reader is sent to the Files tab instead.',
    vm: { kind: 'no-root-html', origin: 'http://127.0.0.1:4320' },
  },
  {
    id: 'preview-live',
    title: 'Live',
    detail:
      'The frame with the exact sandbox (scripts, forms, pointer lock — no same-origin), the origin as text, and the token only in the src the frame loads.',
    vm: {
      kind: 'live',
      // A fixed far-future expiry keeps the card deterministic; the view
      // states remaining life only inside its five-minute notice window.
      url: `http://127.0.0.1:4320/p/${'a'.repeat(64)}/`,
      origin: 'http://127.0.0.1:4320',
      expiresAt: 4_000_000_000_000,
    },
  },
];

/**
 * The Console tab's states, rendered by the production panel.
 *
 * The gate itself (event source, tag, kinds, bounds) is tested against real
 * `message` events in `ConsoleTab.test`; these cards show what the panel
 * *looks like* for each honest state — two kinds of empty, a live log, an
 * error report, an over-cap log, and hostile text displayed as text.
 */
export const consoleStateFixtures: {
  id: string;
  title: string;
  detail: string;
  entries: readonly ConsoleEntry[];
  frameOpen: boolean;
}[] = [
  {
    id: 'console-empty-no-frame',
    title: 'Console — no frame',
    detail: 'Nothing has been previewed yet: the panel says so instead of pretending to be a log.',
    entries: [],
    frameOpen: false,
  },
  {
    id: 'console-empty-silent',
    title: 'Console — frame open, silent',
    detail: 'A frame is running and has printed nothing; the empty state is the absence of output, not an error.',
    entries: [],
    frameOpen: true,
  },
  {
    id: 'console-log',
    title: 'Console — log lines',
    detail: 'Accepted entries only: the shim\'s four kinds, joined and bounded, rendered as text nodes.',
    entries: [
      { kind: 'log', text: 'app booted in 12ms' },
      { kind: 'info', text: 'fetch /api/code/tasks — 200' },
      { kind: 'warn', text: 'deprioritized queue item after 3 retries' },
      { kind: 'log', text: 'render complete' },
    ],
    frameOpen: true,
  },
  {
    id: 'console-errors',
    title: 'Console — errors, ready to send',
    detail: 'Error entries arm Send-to-composer; the report is prefilled as untrusted data and never auto-sent.',
    entries: [
      { kind: 'error', text: 'TypeError: x is not a function' },
      { kind: 'error', text: 'ReferenceError: y is not defined' },
      { kind: 'log', text: 'last good state' },
    ],
    frameOpen: true,
  },
  {
    id: 'console-overflow',
    title: 'Console — over the cap',
    detail: 'A chatty frame cannot grow the tab: the list keeps the newest entries and drops the oldest.',
    entries: Array.from({ length: 600 }, (_, index) => ({
      kind: 'log' as const,
      text: `line ${index}`,
    })),
    frameOpen: true,
  },
  {
    id: 'console-hostile',
    title: 'Console — hostile text',
    detail: 'Markup in a log line is displayed, never parsed: the entry is a string in a text node.',
    entries: [
      { kind: 'log', text: '<img src=x onerror="alert(1)">' },
      { kind: 'warn', text: '</ol><script>alert("nope")</script>' },
    ],
    frameOpen: true,
  },
];
