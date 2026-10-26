/** Preview states are static facts; these fixtures deliberately make no requests. */
export const canvasPreviewFixtures = [
  { id: 'nothing-to-preview', title: 'Nothing to preview', message: 'No HTML entry file at the task root. Open Files to inspect the workspace.' },
  { id: 'no-session', title: 'No session yet', message: 'No preview session exists. Start preview is an explicit action.' },
  { id: 'expired', title: 'Session expired', message: 'The preview session expired. Renew preview is offered once.' },
  { id: 'disabled', title: 'Preview disabled', message: 'Previews are disabled on this host by HYPERION_PREVIEW_PORT.' },
  { id: 'unreachable', title: 'Preview unreachable', message: 'The preview listener could not be reached.' },
  { id: 'worktree-gone', title: 'Worktree gone', message: 'This task no longer has a worktree to serve.' },
] as const;
