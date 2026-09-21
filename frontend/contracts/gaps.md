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
- ~~No way to see what an interrupted run left.~~ **Closed for Code 2026-09-21 (1.31)** —
  read and screen; see the fuller entry below, which `tasks.recovery` is declared
  `partial` against.
- No complete per-project active-task listing for switch warnings.
- Health summary has no backup component (`health.backup` stays `partial`).
- ~~No explicit provider cooldown detail.~~ **Closed 2026-09-22 (1.36).**
  `ProviderPublic.cooldown` carries the class, the `until` deadline, which of the two
  lengths won and the module's own sentence, so the provider read says why a provider
  is being skipped instead of leaving it to the server log; `providers.cooldown` is
  `implemented` here. The point-of-action chip renders it (`PrivacyIndicator`), which
  is the surface a user actually sees before a send.
- ~~No per-provider egress-proxy contract.~~ **Closed 2026-09-21 (1.37).**
  `ProviderPublic.egressProxy` carries the redacted URL, and
  `GET /api/providers/active` adds `{redacted, authority, scheme, hasCredentials,
  offMachine}` — the point-of-action privacy line renders it, and the egress class
  already accounts for it (`local` + an off-machine proxy is `remote`).
- ~~Still no Puter provider type.~~ **Closed 2026-09-21 (1.38), audited against Puter's
  own docs the same day.** `puter` is a provider type (`providerTypeSchema` accepts it) whose
  difference is the *credential*: a minted, revocable access token rather than a vendor key
  (expiry is optional — the create dialog defaults to never), so a rejected one is a
  configuration fact and pauses the provider for the hour rather than being retried on every
  request. Two things the first pass missed and a settings screen must therefore be told:
  the OpenAI-compatible endpoint **requires a paid Puter plan** (a free account gets
  `402 subscription_required`), and the model list comes from Puter's own catalogue
  (`/puterai/chat/models/details`, which carries each model's context window), not from
  `{base}/models`. `GET /api/providers/puter/advisory` now states the credential kind, the
  default base URL and catalogue URL, `requiresPaidPlan` and what a rejection does — a
  settings screen needs to hard-code none of it. There is still no settings form that creates
  one, and nothing renders the advisory.
- ~~No way to see what an interrupted run left.~~ **Closed for Code on 2026-09-21 (1.31).**
  `GET /api/{tool}/tasks/:taskId/recovery` reports the run's bounded step history with SQL
  totals over all of it, the leftover checkout and what discarding it would lose, and
  whether a resume or a discard is available and why not; the Code surface now renders it
  (`components/RecoveryPanel`, mounted in the main region when the selected task's run is
  interrupted) so a restart's leftovers are a screen rather than a badge. Two halves are
  deliberately still open, and `tasks.recovery` stays `partial` for exactly those: the panel
  **reports** resume with its reason and the route that performs it instead of offering a
  button, because resuming an interrupted run is a **re-run** (`POST /api/{tool}/run-task`
  with the same task id, whose provisioning re-attaches the leftover checkout) and no
  surface can start a run yet; and Cowork and Design have no surfaces of their own, so only
  Code mounts the panel. Of the rest of 1.31, the unattended-run notification and the
  interactive-wait timeout both landed on 2026-09-21 (a prompt now expires after
  `approval_wait_ttl_hours`, default 72, and the Attention Center says so instead of
  announcing an allowance that was never applied); the **Design environment** remains, and it
  is the last open half of the item — with its requirement text absent from every document in
  this repository (the phrase appears once, in the register's digest of the owner-supplied
  increments, and nowhere in `docs/SPEC.md`'s Design deep-dive or the Design agent's prose).
  The register's Open decisions records both possible readings and why neither was built: a
  filesystem environment for Design is refused by the ratified `S-2` (its artifacts are
  `artifact_versions` rows and its toolset excludes `write`/`bash`/`command`), and the Design
  *surface* is Prompt-2 frontend work this scope excludes — the placeholder above is that
  scope's honest state, not this entry's.

  One thing this list should carry while it is here: **the approval deadline has no
  settings control.** The value is a setting (three days by default) and the read reports
  each prompt's `expiresAt`, so a settings screen has everything it needs to show or change
  it — nothing does yet, the same gap the context ceiling has. Until then the deadline is a
  default the user cannot see, which is exactly the kind of invisible rule this file exists
  to keep visible.
- No usage or spend *summary* screen. The per-task and per-message figures are rendered
  (the Code surface's `TaskSpend`, the chat footer), and the aggregate read the register
  calls the "usage graph" exists on the backend — `GET /api/usage` with
  `byDay`/`byTool`/`byProvider`/`byModel` buckets carrying cost, unpriced counts, cache
  and reasoning tokens and, since 2026-09-22, the `duration_ms` figures the log had been
  recording with nothing reading them (`rowsWithDuration`, `meanDurationMs`,
  `slowestDurationMs`), plus the `/exposure-summary` sibling — but nothing draws it: no
  Settings surface exists, and the daily-cap read is the summary's only consumer today.
  Whatever renders it must keep `rowsWithCacheReporting`/`rowsWithDuration` beside the
  rates and means, and must not show a `null` measure as zero.
- **Nothing in the frontend posts a task continuation.** `POST /api/{tool}/tasks/:taskId/continue`
  is the call that starts a parked run again — approving a prompt deliberately does not
  (`continuation.ts`: "does not start the agent", it records the decision and answers
  `continuable`) — and no client makes it: `api/tasks.ts` has `state` and `recovery`, the
  Attention Center posts the decision and then tells the user to "open the task and continue
  it", and the Code surface's recovery panel reports resume without actioning it. So an
  approved run can sit parked indefinitely while the copy implies a next step. The route is
  ready and is a `route-mismatch` row (the spec named `/resume`); what is missing is the
  control that calls it.
- **No client posts `POST /api/settings/reload-config` (1.28).** The route re-reads and
  validates the on-disk permissions and profiles on demand, caching nothing, and is covered by
  three route cases; nothing calls it, because there is no Settings surface at all (the same
  reason the memory import routes above are uncalled). A reload control belongs there when
  that surface exists.
- No global search endpoint; later shell search must report federated partial coverage.

## Later

- ~~No unified `/api/plugins` surface or durable per-tool plugin availability.~~ **Closed 2026-09-21
  (1.34)**: `GET /api/plugins` composes the MCP servers, the skills and the built-in Memory plugin into one
  catalogue with an offline scan, and `PATCH /api/plugins/:id/availability` stores a per-tool decision
  (migration `025`, default available). What is still missing is a *frontend* Plugins surface — the tool
  is a placeholder. browser-use *is* registered now (1.35, a seeded MCP server), and the hub reads it as a
  browser-driving server; what is still missing on that front is per-tool MCP selection, so no tool consumes a
  second MCP server yet — Cowork reads `wigolo` by name.
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
- No Pulse, discovery, or watchlist contracts. Browser-use exists as a seeded MCP server (1.35); what has
  no contract is *assigning* browser work to it from a tool.
- Backup does not expose the specified encrypted destination/passphrase system.
- ~~Memory has no direct-add or text-import endpoint.~~ **Closed 2026-09-21**: `POST /api/memory`
  (one memory, bounded to a paragraph) and `POST /api/memory/import` (pasted text, split on blank
  lines, bounded to 100 chunks / 20 000 characters, dropped pieces counted rather than truncated).
  The Settings surface that will call them does not exist yet — the routes are ready and the
  placeholder tool is not.
