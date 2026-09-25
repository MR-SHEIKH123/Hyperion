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
  frontend derives. One thing it did not close, and which the entry below now
  records: there was no per-project active-task listing.
- ~~No way to see what an interrupted run left.~~ **Closed for Code 2026-09-21 (1.31)** —
  read and screen; see the fuller entry below, which `tasks.recovery` is declared
  `partial` against.
- ~~No complete per-project active-task listing for switch warnings.~~ **Backend closed
  2026-09-22**, and the client with it: `GET /api/projects/:id/tasks` lists every
  unfinished task in the project — all three tools, the latest run per `(tool, taskId)`,
  the four active states, per-state counts — and reports `unattributedActive` for active
  runs that name no project (started with nothing open, or written before migration `027`)
  rather than folding them into whichever project is open. What is **still** missing is the
  surface: `api/projects.ts` has `getProjectTasks` and nothing calls it, so no switch warning
  is shown and the ledger row stays `partial`. The same switch is why the read exists —
  opening another project repoints containment and drops per-task worktree assignments, so
  work in flight keeps running and stops being visible.
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
  interrupted) so a restart's leftovers are a screen rather than a badge. **Resume became a
  gesture on 2026-09-22**: resuming an interrupted run is a **re-run**
  (`POST /api/{tool}/run-task` with the same task id, whose provisioning re-attaches the
  leftover checkout), the Code composer now posts that route, and the panel hands the task
  id to it (`onResume`) with the composer taking focus — one call, so the id is filled and
  the region the id was filled in is the one the user is looking at. `tasks.recovery` stays
  `partial` for the half that is left: Cowork and Design have no surfaces of their own, so
  only Code mounts the panel, and a host without a run-starter still gets the verb, its
  reason and the route in words instead of a dead button. Of the rest of 1.31, the unattended-run notification and the
  interactive-wait timeout both landed on 2026-09-21 (a prompt now expires after
  `approval_wait_ttl_hours`, default 72, and the Attention Center says so instead of
  announcing an allowance that was never applied). The **Design environment** left Prompt 1's
  list on 2026-09-24 by owner decision: it is a frontend surface for Design's eventual
  Prompt 2 build (file/component tree, visual diff, viewport presets), not backend scope,
  so nothing was built for it and the register's Open-decision item is closed. The S-2
  refusal stands for any filesystem reading — Design's artifacts are `artifact_versions`
  rows and its toolset excludes `write`/`bash`/`command` — and the surface half now lives
  in the Later entry below with the Design tool's other deferred surfaces.

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
- ~~Nothing in the frontend posts a task continuation.~~ **Closed 2026-09-22.** The Code
  surface's parked-task panel (`src/tools/code/ParkedTask.tsx`, over
  `src/api/agentStream.ts` and `src/tools/code/useTaskContinuation.ts`) is the caller:
  `POST /api/{tool}/tasks/:taskId/continue` is posted when the selected task's run is
  `blocked` or `ready_for_review` — the two states `requireContinuable` accepts,
  deliberately not `paused` — with the held call and its arguments shown first, an allow
  posted together with the continuation in one call, and a denial sent to `/approve`
  instead, because a denial finishes the run server-side rather than continuing it.
  Continuing without a decision is offered too, and is the way back from an expired
  prompt; it is refused in the panel while a prompt is outstanding, because the route
  would only replay the call and park again. `api/tasks.ts` gained the approvals read
  (`GET /api/{tool}/tasks/:taskId/approvals`) that the panel needs, and the Attention
  Center's sentence now names the button it is telling the user to press. The route stays
  a `route-mismatch` row (the spec named `/resume`) — and it is worth noting what that
  cost: the client-half rule only requires a client of `implemented` rows, so this gap was
  invisible to the gate and was found by hand. Resuming an **interrupted** run is a re-run
  (`POST /api/{tool}/run-task`), which the Code composer has posted since 2026-09-22 and
  which the recovery panel's resume verb hands to it; the gap that remains is the
  `run-task` gap below.
- **`run-task` had no ledger row, and the manifest said `frontend` anyway (found 2026-09-22).**
  `POST /api/{tool}/run-task` is `exposure: "frontend"` in
  `frontend/contracts/backend-routes.json` — a claim written when the manifest was first
  generated — while `frontend-contracts.json` has no row for any of the three routes, so
  the client-half rule had nothing to check and the claim could not have been wrong out
  loud. Code posts it now (the Task composer, §12), which makes the Code half of that
  manifest claim true; Cowork and Design still have no client, and adding ledger rows is a
  review decision about the specification's inventory rather than a fix to make quietly.
  Until then, the honest reading of `exposure: frontend` is *the frontend is meant to call
  this*, not *the frontend does*.
- **No client posts `POST /api/settings/reload-config` (1.28).** The route re-reads and
  validates the on-disk permissions and profiles on demand, caching nothing, and is covered by
  three route cases; nothing calls it, because there is no Settings surface at all (the same
  reason the memory import routes above are uncalled). A reload control belongs there when
  that surface exists.
- **No profile-import client (1.28).** `POST /api/code/agents/import` files uploaded `.md`
  profiles into the active project's `.hyperion/agents/` with per-file results, but nothing
  calls it: there is no profiles surface, and no Settings screen to host one. A folder picker
  can POST the folder's files to it unchanged when that surface exists.
- No global search endpoint; later shell search must report federated partial coverage.

## Later

- ~~No unified `/api/plugins` surface or durable per-tool plugin availability.~~ **Closed 2026-09-21
  (1.34)**: `GET /api/plugins` composes the MCP servers, the skills and the built-in Memory plugin into one
  catalogue with an offline scan, and `PATCH /api/plugins/:id/availability` stores a per-tool decision
  (migration `025`, default available). What is still missing is a *frontend* Plugins surface — the tool
  is a placeholder. browser-use *is* registered now (1.35, a seeded MCP server), and the hub reads it as a
  browser-driving server; what is still missing on that front is *general* per-tool MCP selection. Cowork
  read only `wigolo` by name until 2026-09-25, when the first-party `memory` server became its second
  named server (`memory.memory_search` / `memory.memory_add`); any-server-into-any-tool is still open.
- ~~No Chat fork endpoint~~ **Closed 2026-09-21 (1.27)**: `POST /api/chat/:id/fork` branches a
  conversation without touching it. A dedicated Chat state endpoint is still missing
  (`chat.state` above): runs and paused runs are the only chat-state reads.
- No browser terminal, so the interactive-session routes have no client. `S17` gave
  `POST /api/code/execute-command` a real exemption for a person typing — a session the
  server mints (`POST /api/terminal/sessions`), validated in constant time and expired on
  close or timeout — and everything without one is now evaluated by the permission engine
  as the `bash` tool over the project's own rules. The three `/api/terminal/sessions`
  routes are therefore `deferred-frontend` in the route snapshot: no screen opens or
  closes a session yet, and no screen sends the two headers. They exist because a token
  no server mints is not a mechanism, and the minting half is what makes the exemption
  structural rather than a flag a client could set.
- No Code file-tree, file-read, task-diff, or walkthrough retrieval contracts. (`GET /api/code/tasks`
  reports the live lane — running slots and held worktrees — which is what a task rail needs for
  *active* work; a per-project *history* of code tasks is still absent, and `GET /api/code/tasks/:id/export`
  covers one task's diff. The Code surface (`src/tools/code/`) therefore shows the lane and says
  that a finished task leaves no row here, rather than caching rows the server never sent.)
- No Design file tree, version timeline, rendered diff, or design-system context contract. (1.31's "Design environment" clause lives here now: reclassified out of Prompt 1 to Design's Prompt 2 build, 2026-09-24.)
- ~~No general artifact lineage/list endpoint.~~ **Partly closed 2026-09-21**: `GET /api/artifacts/versions?key=…`
  lists one artifact's version chain with its derived parent (Prompt 1.39 A6). There is still no
  cross-artifact listing or a "what produced this" graph — the version stack answers "what did this
  replace", not "where did this come from".
- ~~No Pulse, discovery, or watchlist contracts.~~ **Partly closed 2026-09-24 (1.30).**
  Pulse is contracted: the `pulse.fetch` tool plus config/history routes
  (`docs/API.md` §17.3), `deferred-frontend` — the UI that would call them does
  not exist yet. Discovery and watchlists remain absent by design: Pulse is
  on-demand only, with no poller and no direct-fetch route. Browser-use exists
  as a seeded MCP server (1.35); what has no contract is *assigning* browser
  work to it from a tool.
- ~~Backup does not expose the specified encrypted destination/passphrase system.~~ **Closed 2026-09-24 (1.29).**
  Both halves now exist: the passphrase half since 2026-09-21 (`.hypbak`
  containers, `docs/API.md` §10.1) and the destinations half since 2026-09-24
  (the env mirror as the local adapter plus S3-compatible destinations,
  `docs/API.md` §10.3). The Settings surface that will call the destination
  routes does not exist yet — the routes are ready and the UI is pending, so
  the three destinations routes are `deferred-frontend` in the snapshot.
- ~~Memory has no direct-add or text-import endpoint.~~ **Closed 2026-09-21**: `POST /api/memory`
  (one memory, bounded to a paragraph) and `POST /api/memory/import` (pasted text, split on blank
  lines, bounded to 100 chunks / 20 000 characters, dropped pieces counted rather than truncated).
  Extended 2026-09-25: the import route also takes `multipart/form-data` with up to 50 `files`
  (one shared chunk budget, per-file breakdown), so a folder picker can POST a folder's files
  unchanged — the 1.28 upload shape, not a server-side path read.
  The Settings surface that will call them does not exist yet — the routes are ready and the
  placeholder tool is not.
