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
  settings screen needs to hard-code none of it. **The form and the rendering landed with
  Settings 2.5 slice 1:** the Add-provider form renders this advisory from the route and
  posts the create, and `providers.puter` / `providers.puter-advisory` are `implemented`.
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
  three route cases; nothing calls it. The Settings surface exists since 2.5 slice 1
  (Providers), and Reload Config belongs to its Slice 2 (Safety and limits), which has not
  been built — the same reason the memory import routes above are uncalled.
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
  routes that open and close a session are therefore `deferred-frontend` in the route
  snapshot: no screen opens or closes one yet, and no screen sends the two headers. They
  exist because a token no server mints is not a mechanism, and the minting half is what
  makes the exemption structural rather than a flag a client could set.
  **`GET /api/terminal/sessions` has a client and a screen since the session panel's
  Processes row (2026-10-04)**: `api/terminal.ts` reads the list and
  `tools/code/Processes.tsx` renders it. It closes nothing, and that is the shape of the
  route rather than an unfinished part of the screen — the list never carries a token,
  and `POST /sessions/:sessionId/close` authenticates with the opener's, so a panel that
  offered a close control would be offering something the server refuses. Two more things
  the row has to get right, both pinned by its test: the list also returns the last 50
  *ended* sessions for the audit trail, so `count` is not the number of live processes
  (`endedAt === null` is), and a run that has ended is history rather than a process.
- **The Canvas has a client, and two of its rows are on screen (1.40 backend, client built
  2026-10-04).** The file tree, the file read, the task diff and the sandboxed preview are real
  routes (`GET /api/code/tasks/:taskId/files|file|diff`,
  `POST|GET|DELETE /api/code/tasks/:taskId/preview`, `docs/API.md` §27),
  `frontend/src/api/canvas.ts` calls all six and `wire/canvas.ts` pins their shapes — all six
  are checked against the real backend by `check-wire.mjs`, and the ledger rows are
  `implemented` on the same standard as `providers.registry` (a client calls the route; a
  screen is not required). **Two screens exist, both in the Code surface's `inspector` region
  — the changed-file list and the live preview row.** The list splits per-file additions and
  deletions out of the patch (`tools/code/patch.ts`), names the base commit and renders a
  direct-mode refusal as a refusal. The preview row (`tools/code/PreviewRow.tsx`) shows the
  live origin as a URL a user can open, starts one, stops one, and names
  `HYPERION_PREVIEW_PORT` when the listener is off instead of rendering "nothing is running"
  for a feature that is switched off. It reads rather than mints, and that is the reason the
  route exists at all: **minting replaces the session, so a row that minted to display would
  revoke the URL the user already has open** — the read is what lets the row be polled. Not
  yet surfaced: the **file tree** and the **file read** (`getTaskFiles`/`getTaskFile` are
  called by nothing) and the **patch text itself** — the list is derived from it, no view
  renders it. What the Canvas still does not
  offer, and what a UI must not pretend it does:
  - **Read-only.** No write, rename, delete or create route; the preview serves files, it
    does not accept them.
  - **Not a dev server.** The preview is a static read: no build step, no bundler, no hot
    reload, no websocket, no directory listing — a page whose `fetch` or module graph needs
    a toolchain will not run. Files are served as they are on disk at request time.
  - **A preview only exists for a task that still holds a worktree.** Parking, releasing or
    forgetting a task takes its token with it (released tasks answer as unknown), and there is
    exactly **one** session per task: minting again revokes the previous URL. A screen cannot
    show two previews of one task side by side.
  - **The diff is text, not a hunk model.** `patch` is the unified diff the exporter already
    produced; there are no per-hunk objects, no line ranges, no "apply this hunk" affordance,
    and a direct-mode task gets the exporter's 400 rather than an empty patch. A rendering
    surface parses the text itself. **In `direct` mode the Diff tab must show that honest
    empty state** — "no base to compare against", from the refusal's `details.mode`/`reason`,
    never a blank panel and never a rendered empty diff — while **the file tree, the file read
    and the preview keep working**, because a task that shares the project directory still has
    a workspace. Only the diff needs a base commit.
  - **A per-project history of code tasks is still absent**, and so is walkthrough
    retrieval. (`GET /api/code/tasks` reports the live lane — running slots and held
    worktrees — which is what a task rail needs for *active* work, and the Code surface
    (`src/tools/code/`) still says that a finished task leaves no row here rather than
    caching rows the server never sent.)
- **The version stack and the step list cannot be joined, and a UI must not imply it
  (1.40, 2026-10-03).** `artifact_versions` rows are **pre-images** — version 1 is the state
  *before* the first edit, which is what makes the first change undoable — and they carry
  `artifact_key`, `tool`, `version`, `content`/`rel_path` and a label, **not** a run id, a
  step id or a timestamped position in a transcript. There is no step↔version link anywhere
  in the schema, so "content as of step k" is a claim the backend cannot support and a UI
  must not make: show the version stack and the step list **side by side**, as two timelines
  of the same task. And a version backed by `rel_path` — the large-artifact half, resolved
  through `services/code/files.ts` — **vanishes when the worktree is released**, because the
  path it names is inside the task's worktree; only the inline `content` rows outlive the
  task. A version timeline that outlives a task therefore has to say which rows are still
  resolvable, rather than rendering a stack of links that 404. That means **labelling the
  versions that are unavailable after release**, not quietly omitting them: a row that
  vanishes teaches the user the edit never happened.
- ~~**`errorCodeSchema` lags the backend by three codes, and nothing checks it (found 2026-10-03,
  pre-existing).**~~ **Closed 2026-10-14.** The frontend's closed enum in
  `src/contracts/wire/common.ts` listed 25 codes; `src/util/errors.ts` has 28.
  Missing were `approval_required`, `permission_denied`,
  `zdr_requirement_unmet` — and no extras, so the enum was a subset, not a divergent set.
  The enum is now synced and `src/contracts/wire/common.test.ts` parses the backend
  union from `src/util/errors.ts` at test time, so the two diverging fails that test.
  Measured by diffing the two declarations, not by reading them. Today the gap is **latent**,
  and it is worth saying exactly why so nobody "fixes" the wrong thing:
  - the chat stream's refusal reaches the client as an **SSE error frame**, whose
    `chatSseErrorSchema` types `code` as `z.string()` — so a ZDR refusal still displays its
    real message rather than failing to parse;
  - the other two codes are thrown only by `POST /api/code/execute-command`, which has no
    frontend client at all (the terminal routes are `deferred-frontend`).

  It stops being latent the first time a surface parses a *JSON* error envelope carrying one
  of those codes: `responseError` in `src/api/errors.ts` runs `errorEnvelopeSchema.safeParse`
  and falls back to `invalid_response` — "Hyperion returned an unreadable error response" —
  which is exactly the failure a closed enum that lags produces. The Canvas routes do not
  widen the gap (they reuse `capability_disabled`, `scope_violation`, `bad_request`,
  `not_found`), which is the point of not minting a new code for a disabled preview.
  Syncing the enum and adding the drift test landed as its own revertable commit,
  as this entry recommended.
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
