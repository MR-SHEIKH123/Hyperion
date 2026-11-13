import type { PreviewVm } from '../../tools/code/PreviewView';

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
