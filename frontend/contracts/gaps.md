# Known frontend contract gaps

This is a visibility list, not a request to silently emulate missing backend
behavior in the browser.

## Near term

- No API metadata/version endpoint. Explicitly out of frontend scope.
- ~~No cross-tool pending-approval endpoint.~~ **Closed 2026-09-21 by `GET /api/attention`**,
  the queue behind Prompt 1.39 A1: approvals across every task, paused and blocked runs,
  plans waiting for review, interrupted runs, failed scheduled runs, backup failures, the
  spend cap and MCP disconnects, each with the call that resolves it. The UI landed with it
  on 2026-09-21 (`src/attention/`, the `/attention` surface and its rail entry), so
  `attention.queue` is `implemented` here. Two things it does not close: the `TaskRun` union still has no `interrupted` state — an interrupted task is a
  reconciled `error: internal_error`, which is what the queue reports rather than a state
  the machine gained — and there is still no per-project active-task listing.
- No complete per-project active-task listing for switch warnings.
- Health summary has no backup component and no explicit provider cooldown detail.
- No Puter provider type and no per-provider egress-proxy contract.
- No global search endpoint; later shell search must report federated partial coverage.

## Later

- No unified `/api/plugins` surface or durable per-tool plugin availability.
- No Chat fork endpoint or dedicated Chat state endpoint.
- No Code file-tree, file-read, task-diff, or walkthrough retrieval contracts.
- No Design file tree, version timeline, rendered diff, or design-system context contract.
- No general artifact lineage/list endpoint.
- No Pulse, discovery, watchlist, or browser-use assignment contracts.
- Backup does not expose the specified encrypted destination/passphrase system.
- Memory has no direct-add or text-import endpoint.
