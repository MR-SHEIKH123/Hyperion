# Known frontend contract gaps

This is a visibility list, not a request to silently emulate missing backend
behavior in the browser.

## Near term

- No API metadata/version endpoint. Explicitly out of frontend scope.
- No cross-tool pending-approval endpoint. The implemented TaskRun union also has no `interrupted` state or interrupted-task discovery endpoint.
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
