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
  `attention.queue` is `implemented` here, and so is `attention.interrupted`: the `TaskRun`
  union gained the `interrupted` state on 2026-09-21 (migration `020`, written by boot
  reconciliation), so an interruption is a state the backend holds rather than one this
  frontend derives. One thing it does not close: there is still no per-project active-task
  listing.
- No complete per-project active-task listing for switch warnings.
- Health summary has no backup component and no explicit provider cooldown detail.
- ~~No per-provider egress-proxy contract.~~ **Closed 2026-09-21 (1.37).**
  `ProviderPublic.egressProxy` carries the redacted URL, and
  `GET /api/providers/active` adds `{redacted, authority, scheme, hasCredentials,
  offMachine}` — the point-of-action privacy line renders it, and the egress class
  already accounts for it (`local` + an off-machine proxy is `remote`).
- ~~Still no Puter provider type.~~ **Closed 2026-09-21 (1.38).** `puter` is a provider
  type (`providerTypeSchema` accepts it) whose difference is the *credential*: an expiring
  session `auth_token` rather than a vendor key, so an expired one is a configuration fact
  and pauses the provider for the hour rather than being retried on every request.
  `GET /api/providers/puter/advisory` states the credential kind, the default base URL and
  what an expiry does — a settings screen needs to hard-code none of it. There is still no
  settings form that creates one.
- No global search endpoint; later shell search must report federated partial coverage.

## Later

- ~~No unified `/api/plugins` surface or durable per-tool plugin availability.~~ **Closed 2026-09-21
  (1.34)**: `GET /api/plugins` composes the MCP servers, the skills and the built-in Memory plugin into one
  catalogue with an offline scan, and `PATCH /api/plugins/:id/availability` stores a per-tool decision
  (migration `025`, default available). What is still missing is a *frontend* Plugins surface — the tool
  is a placeholder — and browser-use is not registered as a plugin yet (1.35).
- ~~No Chat fork endpoint~~ **Closed 2026-09-21 (1.27)**: `POST /api/chat/:id/fork` branches a
  conversation without touching it. A dedicated Chat state endpoint is still missing
  (`chat.state` above): runs and paused runs are the only chat-state reads.
- No Code file-tree, file-read, task-diff, or walkthrough retrieval contracts. (`GET /api/code/tasks`
  reports the live lane — running slots and held worktrees — which is what a task rail needs for
  *active* work; a per-project *history* of code tasks is still absent, and `GET /api/code/tasks/:id/export`
  covers one task's diff. The Code surface (`src/tools/code/`) therefore shows the lane and says
  that a finished task leaves no row here, rather than caching rows the server never sent.)
- No Design file tree, version timeline, rendered diff, or design-system context contract.
- ~~No general artifact lineage/list endpoint.~~ **Partly closed 2026-09-21**: `GET /api/artifacts/versions?key=…`
  lists one artifact's version chain with its derived parent (Prompt 1.39 A6). There is still no
  cross-artifact listing or a "what produced this" graph — the version stack answers "what did this
  replace", not "where did this come from".
- No Pulse, discovery, watchlist, or browser-use assignment contracts.
- Backup does not expose the specified encrypted destination/passphrase system.
- ~~Memory has no direct-add or text-import endpoint.~~ **Closed 2026-09-21**: `POST /api/memory`
  (one memory, bounded to a paragraph) and `POST /api/memory/import` (pasted text, split on blank
  lines, bounded to 100 chunks / 20 000 characters, dropped pieces counted rather than truncated).
  The Settings surface that will call them does not exist yet — the routes are ready and the
  placeholder tool is not.
