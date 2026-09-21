# Coordination register — decisions and plans

This file exists because major project decisions were being made in chat
sessions and never landed anywhere reconcilable: `.clinerules/` and `.kilo/`
are gitignored, and Master Plan v4 existed only as conversation text. From
here, **a decision is not real until it is in a commit** — that rule is itself
one of the first entries below (S-3).

## Sources and confidence

- **The D-table** is reconstructed from the Master Plan v4 record on
  2026-09-11. The original table lived in `.kilo/plans/` (local-only,
  gitignored); entries below carry what the v4 record states, with a status
  column verified against the code in the same session — nothing transcribed
  on trust alone.
- **S-entries** were locked in during the 2026-09-11 review session and are
  recorded here as decided there.
- **Master Plan v4** is appended verbatim at the end of this file so the
  previously conversation-only plan is diffable and reviewable next to the
  code it governs.

## D-table, reconstructed and reconciled (2026-09-11)

| ID | Decision | Status |
| --- | --- | --- |
| D1 + D11 | Approval channel & task continuation: `ask` verdicts record `pending_approvals` and park `approval_required`; the user resolves via `POST /api/{tool}/tasks/:taskId/approve` (`allow_once` / `allow_session` / `deny`) and the run continues; `task_messages` snapshots the verbatim conversation only at stopping points, deleted on terminal state and stripped from backups. | **Landed** — `src/db/approvals.ts`, `src/db/taskMessages.ts`, `src/http/continuation.ts`; CONTRACTS "Task-run continuation (1.27)". |
| D4 | Profile model: built-in `ask` / `plan` / `act` profiles frozen in code; a built-in `design` profile's base mode is `act` with a restricted tool allow-list, for when Design lands. | **Core landed** (migration 017, `profiles.ts`); the `design` profile arrives with the Design agent. |
| D7 | Remove the subagent `mode: 'act'` hardcode so delegated children follow the profile system. | **Landed** 2026-09-11 — the child inherits the parent run's mode; a restricted parent whose rules allow `delegate` no longer produces an unrestricted child. |
| D8, D13–D15 | Profile system completion: `AgentProfile` gains `visibility` / `hidden` / `variant` / `permissions` and JSON permission blocks; the reasoned-effort variant maps per provider (`reasoning_effort` / Responses `{ effort }` / omit). | **Landed** (migration 017; `visibility` and the per-provider variant handling verified in `profiles.ts`). |
| D9 | `POST /api/settings/reload-config`. | **Landed** — `src/http/settings.ts`. |
| D12 | A parked task keeps its worktree, so continuation actually continues. | **Landed** — CONTRACTS "park no longer releases the worktree"; the worktree hold/release calls in the agents router. |
| D-1.2 | Write-path injection hardening: before any `allow` verdict on a write-capable tool, path+content run through `findSensitive()`; a hit downgrades the verdict to `ask` regardless of the allow-rule, deliberately independent of the outbound redaction toggle (local writes are not egress). | **Landed** — `src/services/agent/permissions.ts` (allow + write-capable → `ask` on a finding, matched layer and pattern preserved in provenance). |

Entries the v4 record names without defining (the numbering gaps) are not
reconstructed here: the original table is the owner's local copy, and this
register records what the shared record actually said rather than inventing
content to fill holes.

## Session pre-registrations (locked 2026-09-11)

- **S-1 — §6.6 sequencing.** Subagent worktree-collision protection ships as
  auto-acquire-only v1: a path is reserved the first time a child writes it.
  Pre-declaration (children claiming their path sets up front) is the
  sequenced v2 upgrade, gated on observed collision frequency — deferred, not
  dismissed.
- **S-2 — §6.6 scope exclusions.** The reservation is Code-agent-only.
  Cowork is collision-safe by construction (append-version DB rows, no shared
  mutable location, so there is no surface to protect). Design is
  pre-excluded for when it lands, for two compounding reasons: its artifacts
  are DB-backed `artifact_versions` rows (`design:file:{runId}:{path}`) and
  its §3.3 toolset contractually excludes `write` / `bash` / `command` — it
  has no shared filesystem surface either. Recorded now so it is never
  re-litigated.
- **S-3 — provenance rule.** Decisions land in commits (this register), not
  in conversation or code comments alone. Conversation-only items are treated
  as undecided until committed.
- **S-4 — one canonical register (locked 2026-09-18).** This file is the only
  coordination record for the repo. The 1.32-spec three-file set
  (`STATUS.md`/`QUESTIONS.md`/`HANDOFF-LOG.md`) has never existed in this
  repo's tree or history (audited 2026-09-18: single-commit history, no such
  paths anywhere on the machine), so there is no second live system and
  nothing was lost folding — by S-3 it was never real here. If those files
  ever land from another workspace, their content folds into this register
  and the parallel files are deleted in the same commit. No second
  coordination convention may coexist with this one.

## Landed since this register opened

- **Sandbox working-state quirk (2026-09-21).** Session boundaries here can reset
  the checked-out branch ref to `main` while the worktree keeps every file, and
  `remote.origin.fetch` can come back narrowed to `refs/heads/main` — so a bare
  `git fetch origin` silently creates no other remote-tracking ref and the branch
  looks lost. Recovered twice now: `git fetch origin '+refs/heads/*:refs/remotes/origin/*'`,
  confirm the worktree matches the remote tip (`git diff --stat <tip>`, and the
  untracked set against the tip's added files), then `git reset --hard <tip>`.
  Nothing is lost in this shape — the commits are on the remote and the worktree
  content is identical — but do **not** reset before checking.

- **Full suite + typecheck, first run this cycle** (2026-09-18): `npm test`
  green, 854/854 across 149 suites (13.5s); `tsc --noEmit` clean. This
  retires the v4 §7 checklist line "4 | Full suite run | ⬜ Never started" —
  that checklist is the verbatim 2026-09-11 snapshot, not live status; live
  status is this section and "Resolved verifications". Prompt-3's two
  verification claims were re-audited against the code in the same session
  and hold as written below.

- **v4 §6.1 — model-aware context windows** (2026-09-12): `findCachedModel`
  (cache-only, active provider then failover order, never fetches) and all
  three agents resolve the requested model's real `contextLength` at run
  start; unknown models keep the honest `assumed` default. Tests in
  `test/modelwindow.test.ts`, mutation-verified.
- **v4 §6.4 — verified already landed** (per-run `unattended` on TaskInput,
  scheduler-allocated `task_runs` rows, push on unattended parks gated by
  `push_enabled`). Nothing to build; reconciled, not rebuilt.
- **v4 §6.8 — landed.** reload-config, the agent-profiles and
  resolved-permissions endpoints, and the activity-feed dedupe of scheduler
  rows (`visibleTaskRuns`) were verified already in the tree; the one missing
  piece was built 2026-09-12: the golden-run regression harness
  (`test/goldenruns.test.ts` + `test/golden/*.json`), one recorded run per
  agent replayed byte-for-byte, re-recordable via `HYPERION_RECORD_GOLDEN=1`,
  drift-catch verified by a prompt mutation.

- **The Design agent (v4 §3 / Prompt 3's last slice)** — 2026-09-11:
  `src/services/design/{agent,tools}.ts`, registered third in
  `composition.ts`, the sandboxed preview route in `src/http/design.ts`,
  the `design` built-in profile, and `test/designagent.test.ts` (agent-level
  against the real artifact store, plus real-server HTTP with the mock
  provider). Closed toolset, `design:` artifact namespace, brand proposals
  unapproved by construction, vision stub, guidance-not-fatal state errors.

- **Queue-wait timeout could never fire — fixed (2026-09-19).** Both queue
  waiters in `src/orchestrator/lock.ts` (`acquire` and `acquireCodeLane`)
  called `waiter.timer.unref?.()` on their wait-timeout, with the stated
  intent of not holding the event loop open during shutdown. That intent
  conflicts with the wait-give-up contract (CONTRACTS.md: a queued task is
  only skipped "after `waitMs` expires"): the timeout is the *only* mechanism
  that moves a parked waiter forward, so if the waiter was the only pending
  work, an unref'd timer never fired and the waiter hung forever — the event
  loop drained and the process exited out from under the promise. Symptom on
  2026-09-19: full suite reported 823 pass / 31 *cancelled* (not 854/854),
  all of them in the queue-timeout tests (`test/codetasks.test.ts` "the Code
  lane" + the worktree suites, `test/scheduledtasks.test.ts` lock-skip
  tests). The unref was removed from both sites. Shutdown stays bounded
  without it: a client disconnect aborts the waiter (its `cleanup()` clears
  the timer), the running server's socket already holds the loop, and the
  6 s force-exit timer in `installShutdownHandlers` caps anything left
  behind. The pre-existing tests that pin the contract
  (`waitMs: 40` give-up in `codetasks.test.ts`, the scheduler's
  `scheduledTaskWaitMs` skip) are the failing tests this fix ships with;
  post-fix the full suite is 854/854 pass / 0 fail / 0 cancelled and
  `tsc --noEmit` is clean.

- **Milestone B, increment 1 — operational shell + Chat tool (frontend),
  landed (2026-09-19).** The Milestone-A foundation now carries the
  operational shell (`src/shell/`: eight-tool sidebar, polling health
  indicator over `GET /api/health/summary`, per-tool routes, honest
  `ToolPlaceholder` for unbuilt tools) and the Chat tool end-to-end
  (`src/tools/chat/`): conversation list (pin / archive / delete-with-
  confirmation, archived view), transcript rendered from persisted truth with
  live rows from the stream hook, pause banner + resume (fresh prompt on a
  paused run = switch-and-resume), busy/refusal handling that keeps the
  composer's draft, and the model picker against the active provider. New
  Chat wire contracts in `src/contracts/wire/chat.ts` (records, run
  snapshots, cursor page, stream payloads); the SSE chat decoders in
  `src/api/sse/events.ts` now validate the full documented payloads — the
  chat `error` event carries the run error shape, not the HTTP error
  envelope, which the schema and a comment now pin. Stream settlement:
  terminal frame → refetch; non-terminal close → apply the reconciliation
  the api layer fetched (cache when one page, refetch when longer); a dropped
  stream is never replayed. New-chat fast path: the chat is created on first
  send and the pending prompt rides on location state, cleared on
  consumption so a reload cannot double-send. Verified: all five frontend
  gates green (contracts, typecheck, 84/84 tests incl. new wire/module/hook/
  composer suites, lint `--max-warnings 0`, build with per-tool code
  splitting), and a live smoke test against the real backend through the Vite
  proxy — with no provider configured, `POST /api/chat/stream` returned the
  contract-correct SSE `paused` (`no_healthy_provider`) and the run persisted
  paused, which is exactly what the frontend's resume banner consumes.
  Remaining increments: the Code, Cowork, and Design tool workflows, then
  Playground, Plugins, Skills, and Settings.

## Security audit — the S-series

An audit series of backend findings, each fixed with a test that fails without
it. The list has until now lived only in the conversation that produced it —
`S12` (MCP permission-key collision, PR #6) is the only one whose existence is
recoverable from this repo, and the register's own rule (S-3) says a
conversation-only item is undecided until committed. So this section is the
series' durable home: findings are numbered here, with evidence and status, and
a finding is closed only by a commit that says so.

**A second, older series shares these numbers.** The owner's Prompt-1 ledger
(2026-09-21) identifies the original **Prompt 1.39** security items — `S1`, `S3`,
`S4`, `S17` of them still undone — as a list that descends from the same `S12`
this register recorded. The audit rows below were numbered by this register as
they were found, and the two sequences collide (`S17` is the unchecked list
`limit` here and the takeover bypass there). The owner's items are therefore
recorded with a `P1-` prefix in the section that follows the audit detail, and the
audit rows keep the numbers their commits and docs already use.

**Method.** Read the security-relevant code against the contract its own docs
state, then try to make the *documented* guarantee fail — not to find style, but
to find the class this series exists for: a control that is well-formed, that the
user believes applies, and that a differently-shaped input walks around. Every
claim below was reproduced against the code before it was fixed; claims that
turned out to be covered by an existing test are recorded as verified, not as
findings.

| ID | Finding | Status |
| --- | --- | --- |
| S12 | MCP tool names that normalize to one permission key (`a.b_c` / `a_b.c`) shared rules silently. | **Fixed** — PR #6; registration fails closed under `assertNoPermissionKeyCollisions`. |
| S13 | A path rule was matched against the raw argument, so a respelled path dodged a `deny` while resolving to the denied file. | **Fixed** 2026-09-21 — this commit. CONTRACTS "A path rule matches the file, not the spelling the model chose". |
| S14 | `primaryArgument`'s comment described a raw-JSON fallback the engine deliberately does not implement, next to a test that pins the opposite. | **Fixed** 2026-09-21 — comment corrected in the same commit as S13; no behaviour change. |
| S15 | A **global** model price could not be updated: `ON CONFLICT(model_id, provider_id)` never fires when `provider_id IS NULL` (SQLite treats NULLs as distinct), so saving one twice inserted a duplicate and the lookup kept returning the older row. The user's edit did nothing, and the stale figure stayed in force for cost reporting and the daily spend cap. | **Fixed** 2026-09-21 — partial unique index + NULL-aware upsert target (migration 018); found by the §6.2 tests, which is the audit finding its own class. |
| S16 | A chat id with no chat row behind it raised the FK on `usage_log`, and `recordUsage` swallows its own errors — so the spend row was **discarded**. The agent path passes exactly such an id (`linkedChatId` nulls it for the task row for this reason), which meant §6.2's recording could have failed invisibly. | **Fixed** 2026-09-21 — the linkage is resolved at write time (an id with no row is stored as NULL, the spend kept), same treatment a temporary chat already got. |
| S17 | `limit` reached SQL unchecked on seven of the nine list routes: `limit=2.5` was a **500** quoting SQLite ("datatype mismatch"), and `limit=-1` returned the **whole table**, because SQLite reads a negative `LIMIT` as no limit at all. The two routes that got it right (`/api/activity`, `/api/chat/:id/messages`) proved the rule was known and simply not applied. | **Fixed** 2026-09-21 — `queryLimit`/`queryOffset` in `src/http/params.ts`, one bound per route; found by the HTTP-input audit, pinned by `test/listlimits.test.ts` (nine routes, five of its eight cases failed before the fix). |
| S18 | A **default** backup (`includeKeys=false`) shipped `mcp_config.json` unconditionally, and `registry.ts::toEntry` writes a remote server's token into it as a plaintext `Authorization: Bearer` header — so the archive whose own comment promises it "exposes conversations but not credentials" contained a working credential in the clear. | **Fixed** 2026-09-21 — the file travels only with `includeKeys`, on the same reasoning as the key itself; the manifest's `warning` names the omission. Pinned by `test/backupsecrets.test.ts` (asserted against the archive's bytes). |
| S19 | The notification body was the run's summary, unbounded past the transport: a long report built a push message over the 4,096-octet cap, the push service refused it, the refusal is not 404/410 so the subscription was kept — and **no notification arrived, silently, for exactly the runs with the most to report**. | **Fixed** 2026-09-21 — `buildPushBody` clamps every text field (title 240 B, body 600, url 512, tag 128, cut on a character boundary); pinned by `test/pushpayload.test.ts`. The privacy half of the item was verified clean. |
| S20 | The **incognito guarantee was walked around by the memory plugin.** After a completed turn, `rememberTurn` handed the exchange to mem0 — durable facts under `~/Hyperion/memory/`, injected into later turns, with the private chat's id as metadata. The storage-layer guard that enforces the temporary-chat rule never saw it: a memory row is not a chat row. "This conversation is not being recorded" held for the transcript and not for its substance. | **Fixed** 2026-09-21 — the guard lives in the writer, `rememberTurn` returns `'temporary'` and never loads the backend; pinned by `test/memoryincognito.test.ts`. Found by auditing the memory plugin's local store. |
| S21 | **The egress class was taken from the provider's type, and the URL was never checked.** `normalizeBaseUrl` accepts any http(s) host, and `local`/`colibri` *claim* locality — so a Colibrì (or Ollama) on another machine could be registered, enabled and used while `GET /api/providers/active` served `egress: "local"`, the credential scan was skipped, `zdrStatusFor` answered `local_no_egress` (a value that *satisfies* a `require` policy), and the exposure summary stamped the row `local`. One URL, four false statements, all of them "your bytes stayed home". | **Fixed** 2026-09-21 — the class is derived from type **and** URL (`egressClassFor`); loopback is this machine and nothing else is; a declared remote is never downgraded; the class is stamped to `usage_log.provider_egress` (migration 019). Found by the queue's last item, per-provider egress in `colibri.ts`. |
| S22 | The **provider side of S16**: a usage row naming a provider id with no row raised the FK on `usage_log`, and `recordUsage` swallows its own errors, so the spend was discarded. `ON DELETE SET NULL` already says what a departed provider's link means; the FK failure only added the loss of the money. | **Fixed** 2026-09-21 in the same lookup S21 needed — an unresolvable provider id is stored as NULL with the spend kept, pinned by `test/taskcost.test.ts`. |

### S13 in full — a path rule matched the string, not the file

`evaluate()` took its glob subject from the model's argument verbatim, while the
file tools resolve that argument through `ctx.resolvePath` before touching disk
(`locate()` in `code/files.ts` computes exactly the workspace-relative path the
rule should have been matched against). So with
`{"write":{"secrets/**":"deny","*":"allow"}}`:

```
secrets/key.txt        -> deny   (the rule worked for this spelling)
./secrets/key.txt      -> allow  -> writes <workspace>/secrets/key.txt
src/../secrets/key.txt -> allow  -> writes <workspace>/secrets/key.txt
<absolute path>        -> allow  -> writes <workspace>/secrets/key.txt
```

Three of four spellings of the denied file were allowed by the file's own rule.
The write really landed in the denied directory: `writeCodeFile` →
`locate()` → `resolvePath`, so the bytes go where the canonical path says,
whatever the argument looked like.

**Fix.** Path subjects are canonicalized before matching: a lexical pass (POSIX
normalization, separator unification) for every relative respelling, plus an
optional `pathResolver` the caller supplies — the Code adapter passes
`ctx.resolvePath` on both sides of a `path.relative` — which closes the absolute
and symlinked spellings, since that is realpath work and only the caller knows
the run's root. Only path tools (`read`, `write`, `restore`) get this treatment; a
`bash` subject is a command line and is never path-normalized. A resolver that
refuses the path falls back to the lexical form, so a permission check cannot fail
for a different reason than the tool would.

**Tests.** `test/permissions.test.ts` — every spelling of a denied file is
denied, an allowed file stays allowed, `..` is not popped beyond the workspace, a
throwing resolver does not become an allow. `test/codepermissionpaths.test.ts` —
the real adapter, a real project `permissions.json`, real `writeCodeFile` to the
real filesystem: the denied file is absent afterwards and the refusal names
`project:secrets/**`. Both were run against the unfixed code first: the engine
tests fail on the verdict, and the adapter test fails for the absolute spelling if
the `pathResolver` wiring is removed, which is the assertion that keeps the seam
from being dropped silently.

### S15/S16 in full — both found by building §6.2, which is the point of the pair

Neither was found by reading cost code looking for trouble. Both were found by the
§6.2 tests failing, which is worth recording: an audit that only re-reads what it
already suspects finds what it already suspects.

**S15 — `setPrice` never updated a global price.** `model_prices` is
`UNIQUE (model_id, provider_id)` and the upsert said
`ON CONFLICT(model_id, provider_id) DO UPDATE`. SQLite treats NULLs as distinct in
a unique index, and a conflict target containing NULL matches nothing — so the
*global* price (`provider_id IS NULL`, the common case: "all providers") inserted a
new row on every save. `findPrice` orders by `provider_id IS NULL` and takes one,
so it returned whichever row came first, normally the oldest: the user's edit had
no effect. The cost that stays in force is not cosmetic — `usage_log.cost_usd` is
computed from `findPrice`, and the daily spend cap sums `cost_usd`, so a price the
user lowered to match reality kept capping them at the old figure. `deletePrice`
handles the NULL case explicitly, which is exactly how the omission went unnoticed:
the semantics were known in one place and missed in the other. Fixed with a partial
unique index (`018`) plus a conflict target that names it; existing duplicates
collapse to the newest row.

**S16 — a chat id with no chat row discarded the spend.** `usage_log.chat_id` has a
real foreign key to `chats`, so an insert naming a chat that does not exist raises
SQLITE_CONSTRAINT — and `recordUsage` swallows its own errors by design, so the row
was dropped silently. The agent path passes exactly such an id: `chatId` is whatever
the client sent, which is why `linkedChatId` in `http/agents.ts` already nulls it for
the *task run* row. Had §6.2 landed without this, the recording would have looked
correct in tests that create their chat first and dropped real spend in production
for the very callers the feature exists for. Fixed where every caller is covered:
the linkage is resolved at write time, an id naming no row is stored as NULL, and
the spend stays on the books — the same treatment a temporary chat already got, for
a different reason.

Both are pinned in `test/taskcost.test.ts`, and both were verified against the
unfixed code before being fixed.

### S17 in full — a limit is a whole number, and the bound is the API

**How it was found.** Not by reading `params.ts`, which is careful, but by
asking which query values reach SQL as a *type* rather than as a value to
compare. `limit` is the only one `queryNumber` could not safely serve: every
other number lands in a comparison, where `2.5` compares fine, while `LIMIT 2.5`
is a driver error and `LIMIT -1` is SQLite's spelling of *no limit at all*.

**The evidence, before the fix** (real app on an ephemeral port, `limitprobe.mjs`
at the repo root, deleted after use):

```
500  internal_error  "datatype mismatch"   /api/chat?limit=2.5
500  internal_error  "datatype mismatch"   /api/chat/:id?limit=2.5
500  internal_error  "datatype mismatch"   /api/storage/assets?limit=2.5
500  internal_error  "datatype mismatch"   /api/storage/cleanup/log?limit=2.5
500  internal_error  "datatype mismatch"   /api/errors?limit=2.5
500  internal_error  "datatype mismatch"   /api/design/assets/approved?limit=2.5
500  internal_error  "datatype mismatch"   /api/storage/assets?offset=2.5
200  the whole table                        /api/chat?limit=-1
200  the whole table                        /api/errors?limit=-1
200  (clamped to 1 row by the service)      /api/storage/assets?limit=-5
400  bad_request, correctly                  /api/activity?limit=2.5
400  bad_request, correctly                  /api/chat/:id/messages?limit=2.5
```

Two things make this a finding rather than a rough edge. The 500 is
**mislabelled**: the request was wrong and the response says the server broke,
quoting the driver, and `error_log` gains a row asserting a server fault — so the
error console fills with rows caused by clients and the log stops being a
statement about the server. And the two routes that already validated (`activity`,
`chat/:id/messages`, both with a test asserting `1.5` → 400) show the rule was
understood; it simply was not applied to the other seven, which is exactly the
drift the audit exists to catch.

**The fix.** `queryLimit(req, name, { fallback, max })` and
`queryOffset(req, name, fallback)` in `src/http/params.ts`, built on
`asPositiveInteger`, which gained an optional `max`. Every list route passes its
own bound in its own call, so the number a caller can exceed is visible where it
is enforced: `chat` 500, `chat/:id` 500, `chat/:id/messages` 500, `storage/assets`
1000, `storage/cleanup/log` 500, `errors` 500, `design/assets/approved` 500,
`cowork/.../history` 500, `memory` 200. Out of range is a **400 naming the field**,
with the bound in the message when the value is only too large.

**Refused rather than clamped, deliberately.** Three of the services already
clamped internally (`gallery.ts` 1000, `cleanup.ts` 500, `memory/index.ts` 200) —
which is why those routes were "safe" for `limit=-5` and still 500 on `2.5`. The
internal clamps stay, because the agent-side callers never pass through HTTP, but
at the boundary a clamp is the wrong answer: a caller handed 200 rows after asking
for 5000 concludes the table holds 200. `activity.ts` had already reasoned this
out in a comment; the section title above is that reasoning made general.

**Adjacent, fixed in passing:** `settings.ts` had a private `positiveLimit` that
duplicated `asPositiveInteger` with a different message — the same rule written
three times across the routers is how the limit routes drifted apart, so the copy
is gone.

**Adjacent, verified — not a finding:** `errors?since=2.5` is accepted, and should
be: `since` is a comparison value, so a fractional timestamp is merely useless, not
a driver error. Every other query parameter outside the two helpers is an enum, a
string, a boolean or a timestamp (`usage?from`/`to`), and none of them reach SQL as
a type. The `/api/activity` `before` cursor was already validated as a whole number.

### S18 in full — the backup that promised not to carry credentials

**How it was found.** The audit queue's next item was "`mcp_config.json` writes",
which is about the writer (`configFile.ts`: atomic, 0o600, unknown fields
preserved, corrupt file quarantined — all sound). Reading it led to what the file
*contains*, and from there to the one place the app sends it somewhere:
`exportBackup`, which added it to the archive unconditionally.

**Evidence, before the fix** (a remote server with a token, then a default
export; `mcpprobe.mjs` at the repo root, deleted after use):

```
manifest contents: {"database":true,"mcpConfig":true,"skills":0,"attachments":0,"encryptionKey":false}
entries: hyperion.db, manifest.json, mcp_config.json
--- mcp_config.json in the archive ---
{"mcpServers":{"remote-thing":{"url":"https://mcp.example.com/sse",
  "headers":{"Authorization":"Bearer SUPER-SECRET-MCP-TOKEN"},"disabled":false}}}
token present in archive: true
```

The same archive deliberately leaves out `secret.key`, on the stated grounds that
shipping the key with the database makes the archive a credential store. The
token does not need the key: it is already plaintext.

**Why not redact.** A redaction pass over `headers`/`env`/`args` is a guess
dressed as a guarantee — the format does not distinguish a workspace path from a
bearer token, and the failure mode of an incomplete guess is the leak itself, now
with a comment saying it cannot happen. The switch that already exists is the
honest one: **the file travels only with `includeKeys`**, which is also the only
case where its tokens are worth anything (without the key, `token_enc` in the
restored database cannot be decrypted, so a plaintext copy would be *the only*
working credential in the archive).

**What a restore loses:** nothing it could use. The registry's authority is the
database — `listServers()`, the process manager and `GET /api/mcp/servers` read
the table, and `POST /api/mcp/sync` regenerates the file. The servers travel as
rows; the archive simply stops carrying the one plaintext copy of their tokens.
The omission is reported: `contents.mcpConfig: false` plus a human-readable
`warning`, because "the archive is missing a file it used to contain" should not
have to be inferred.

**Tests.** `test/backupsecrets.test.ts` — the token does not appear anywhere in
the zip's bytes, the file is absent from the archive while still present on disk
(the omission is a decision about what leaves, not a reading of the machine), the
manifest warns, the server still travels in the database with its token as
ciphertext, and `includeKeys: true` restores full fidelity with the key warning
instead. Two of its five cases fail without the fix.

**Tests.** `test/listlimits.test.ts` — nine routes as a table, each with its
documented maximum: fractional, above-max, zero and negative are 400 naming the
field (and naming the bound when too large), the boundary values 1 and `max` are
accepted, an omitted limit falls back to the route default, and the two offset
rules are pinned separately. Run against the unfixed code first: 5 of its 8 cases
failed (`1.5` → 500, above-max → 200, `0` → 200, `offset=1.5` → 500,
`offset=-1` → 200). A new list route that bypasses `queryLimit` fails here.

**Adjacent, verified — not findings.** Checked while here and found sound:
`resolveInScope`/`resolveInSubtree` (realpath for existing ancestors, sibling-prefix
trap avoided, NUL rejected), layer ordering (`permissionLayers` puts `inherited`
last itself rather than trusting callers), subagent path reservation
(`reserveWorkspacePath` keys on `ctx.resolvePath`, the same normalizer), archive
extraction in all three unzip sites (skills intake, resource archive, backup
restore — each refuses traversal twice), approval→session-rule conversion (the
pattern stored is the user's own matched glob, not the call's subject), and the
keystore (AES-256-GCM, key outside the DB, `0o600`). Also verified sound during
§6.2: `assertWithinSpendCap`'s live-vs-autonomous split (no defaulted `origin`, so
a caller must say which work it is), `TaskBudget`'s read-once ceilings, and
`usageByRun`'s parameterised `IN` list (the ids are bound, never interpolated).

**Audited in this pass — input validation across the HTTP routers** (S17 above is
what it found). All of `src/http/*` was read against the contract each router
states: the only raw `req.body`/`req.query`/`req.params` access outside
`params.ts` is the sanitized copy `errors.ts` keeps for the error log, and the
only path built from a caller-supplied string is `projects.ts`, which resolves
through the same scope guard the file tools use. Verified sound: the settings
catch-all `/:key` is declared last (the literal routes above it cannot be
shadowed), `publicSettings()` filters the two secret keys, `storage/assets/:id/file`
resolves through `assetPath` rather than the request, `download.ts` strips quotes
from the filename it puts in `Content-Disposition`, and the `multer` routes take a
buffer, never a client-chosen destination.

**Audited in this pass — `mcp_config.json` and what leaves in it** (S18 above).
The writer itself is sound: writes are atomic (temp file + rename), created
`0o600` because the file holds tokens, unknown fields from other hosts survive a
rewrite, and a corrupt file is quarantined with the database left as the
authority. What was not sound was the export, and that is fixed.

### S19 in full — what a notification carries, and how much of it

**Privacy first, because that was the queued question, and the answer is: clean.**
Verified rather than assumed:

* The payload is encrypted to the browser's own subscription keys (`web-push`
  encrypts with `aes128gcm`; VAPID is authentication, not the privacy layer), so
  the push service relays ciphertext. The module has said so since it was written;
  the check here was that `sendPush` really does hand the payload to
  `sendNotification` rather than to an `unencrypted`-style path — it does, and
  there is no other send path in the repo.
* Nothing logs a payload. `sendPush` logs `{ reason, sent, removed }`, failures log
  `{ endpoint: short(endpoint), status, error }`, and `short()` is 32 characters.
  `String(error)` on a `WebPushError` is `"Error: Received unexpected response
  code"` — the endpoint and the service's response body live on properties the log
  call does not touch.
* The VAPID private key is encrypted at rest and never leaves the server
  (`publicKey()` is the only half exposed), which the settings work pinned earlier.

What the item *did* find is a body that could not be delivered. A scheduled run's
summary is model output bounded only at 4,000 characters by the code agent
(`MAX_SUMMARY`), and it was used verbatim as the notification body. A Web Push
message is capped at 4,096 octets — the size a push service is required to accept
— and `web-push` adds about 103 bytes of envelope on top. So a task that produced a
long report built a message the service refused.

**Why it was invisible.** `sendPush` deletes a subscription only on 404/410, and
deliberately: every other failure is treated as transient so a wifi blip cannot
unsubscribe someone (that rule is in this file's push section, and it is right).
A 413 from an oversized body lands in that bucket: the failure is logged at warn
level, the subscription survives, and the user — who is not reading server logs —
gets no notification. The runs most likely to be long are the ones most worth
being told about.

**Fix.** `buildPushBody(payload)` is the only thing `sendPush` serializes, and it
clamps `title` (240 bytes), `body` (600), `url` (512) and `tag` (128), cutting on a
character boundary and appending `…`. UTF-8 bytes rather than characters, because
the limit is bytes and a status emoji is four of them; a byte-wise cut would put a
replacement character in the tray. Worst case ≈ 1.5 KB, half the budget, so no
combination of maximal fields can reach the cap.

**Considered and kept:** showing the summary at all. A notification that says only
"your task finished" would be privacy-perfect and useless; the lock-screen
exposure is the feature working as intended, and the clamp is about the transport,
not about hiding the text.

**Tests.** `test/pushpayload.test.ts` — a 20,000-character summary is clamped to
the budget and visibly clipped, a short body passes through untouched, the optional
fields survive being clamped, multi-byte text is cut on a code-point boundary (no
`U+FFFD`, no lone surrogate), and the maximal case fits the protocol with room for
the envelope. All five fail before the fix — four of them on the missing export,
one on the size assertion.

### S20 in full — the memory plugin kept what incognito promised not to

**How it was found.** The queued item was "the memory plugin's local store", and
the first question was what is *in* it. Following `rememberTurn`'s callers reached
`orchestrator/chat.ts`, where the call site is unconditional —

```ts
if (input.prompt) {
  rememberTurn(input.prompt, content, { tool: input.tool, chatId: chat.id });
}
```

— and `chat.id` is whatever chat the turn ran in, including a temporary one.
`temporaryChats.ts` states the invariant and the reason the guard sits in the
storage layer: *"every writer must pass through it. Branching inside the
orchestrator instead would mean each of the six write sites had to remember, and
the one that forgot would persist the transcript with no visible symptom."*
Memory is a seventh writer, and it writes to a different store, so the guard never
saw it. The prediction in that comment is exactly what had happened.

**What was actually written.** mem0 extracts facts from the exchange and stores
them with `metadata: { tool, chatId }`. So an incognito conversation left behind
(a) facts distilled from it, retrievable through `GET /api/memory` and injected
into later turns, and (b) the private chat's id on every one of them — the same id
the 1.20 work went to some trouble to keep off disk in `usage_log`.

**The fix, and where it goes.** `rememberTurn` returns early on
`isTemporaryChat(meta.chatId)`, before `getMemory()` — a private turn must not
even cause the backend to be constructed. It returns a `RememberOutcome`
(`queued` | `disabled` | `temporary` | `empty`) rather than `void`, because the
failure mode here was invisibility: a decision nobody can observe is a decision a
later refactor can erase with no test objecting.

**Considered and deliberately kept:** recall. An incognito turn may still be given
memories to *read* — the promise is about what is written, and silently degrading
the assistant inside incognito would trade a real capability for nothing. Spending
likewise: `usage_log` writes an anonymous row, and that is load-bearing in the
other direction (a cap bypassable by toggling incognito is not a cap).

**Adjacent, verified — not findings:** the other stores a turn can reach either
cannot see a temporary id or refuse it. `usage_log` nulls it by design; `task_runs`
stores NULL through `linkedChatId` for an id with no row (the S16 fix, same
mechanism); `attachments.chat_id` is a real foreign key, and the only asset write
on a tool path — `design.brand_propose` — passes no chat id at all, so it stays
NULL rather than raising or storing it.

**Tests.** `test/memoryincognito.test.ts` — with the toggle **on**, a temporary
chat yields `'temporary'` and the memory directory is still empty after the
detached dispatch would have run (250 ms later, with the backend pointed at a dead
port so a write that *was* started fails fast); a saved chat still yields
`'queued'`; the toggle still reports `'disabled'`; an empty turn reports
`'empty'`. All four fail before the fix, on the outcome alone.

### S21 in full — "local" was a claim about the type, not about the URL

**How it was found.** The queue's last item was per-provider egress in
`colibri.ts`, and the question was whether a Colibrì provider's base URL could
point off this machine while everything classified it local. It could, and the
probe (`egressprobe.mjs`, deleted after recording) showed all five answers from
one provider — a colibri row whose stored `base_url` was
`http://192.0.2.10:8000/v1`, accepted verbatim by `normalizeBaseUrl`:

| Surface | Before | After |
| --- | --- | --- |
| `classifyProviderType('colibri')` | `local` | `local` — unchanged, and that is the point: the type-only mapping cannot see a URL |
| `GET /api/providers/active` | `egress: "local"` | `egress: "remote"` |
| credential gate (check on, prompt with `sk-…`) | passed through, `report = null` | refused, `code: redaction_flagged` |
| `zdrStatusFor` | `local_no_egress` — satisfies `require` | `zdr_unknown` — fails closed under `require` |
| `summarizeExposure()` | `local:1` | `remote:1` |

**Why the type-only mapping existed, and why it was not wrong then.** `002` and
`005` introduced `opencodex` and `colibri` as provider *types*, and the
classification was written as a fact about the products: opencodex is a local
proxy that forwards to upstream vendors (remote), Colibrì serves a model on this
machine (local). Both statements are true of the *intended* deployment. What was
missing is that the deployment is not enforced: `normalizeBaseUrl` validates the
scheme and nothing else, so "on this machine" was an assumption held in a doc
comment while the URL lived in a column.

**The fix, and the rule it settles.** `egressClassFor(provider)` takes the type
*and* the base URL, and `assertOutboundSafe` now takes the provider record rather
than a type string — the same shape of fix as S20: a decision nobody can make
from the information they were handed is a decision that will be made wrongly.

  - **Only a loopback URL is this machine**: `localhost`, `*.localhost` (RFC
    6761), `::1`, and the whole 127/8 block. No DNS: `127.0.0.1.nip.io` resolves
    to loopback but is still a name handed to a resolver, so it is `remote`.
  - **A declared remote is never downgraded** — `opencodex` at 127.0.0.1 stays
    `remote`. It forwards to upstream vendors, and a `remote` provider may be
    anything; calling either local would *skip* the scan.
  - **An unverifiable claim is not believed**: a local-typed provider with an
    absent or unparseable URL is `remote`. An unreadable address is not evidence
    of locality.
  - **An unknown type stays `unknown`**, URL or not; not knowing what a provider
    *is* cannot be improved by looking at its address.

**The record had to change too.** Classifying correctly while the summary still
read `provider_type` would have left every future row in the wrong bucket, so the
resolved class is stamped at write time — `usage_log.provider_egress` (migration
`019`) — for the same anti-retroactivity reason `013` stamped the type. Rows
written before `019` fall back to the type mapping they were written under, which
is a **permanent, recorded understatement** for any pre-`019` local-typed provider
that pointed elsewhere: the URL was never stored, so nothing can re-decide it, and
a backfill would only restate the old judgement in SQL. No backfill; no second
copy of the mapping in SQL; `classifyProviderType` keeps the type half and
`rowEgressClass` is the one place the stamp is preferred.

**Checked while here, and sound:** `zdrFlagFor` was already remote-only (so a
misclassified provider did not get a retention header); the failover residual in
`CONTRACTS.md` is unchanged and now compensates with the *class* rather than the
type; `docs/API.md` §9.1's `providerTypes` list still names the type, so a user
can see why a row landed in a bucket.

**Tests.** `test/egressclass.test.ts` — 16 cases, all 16 failing before the fix:
the classifier table (remote URLs, loopback literals, `127.0.0.2`, `[::1]`,
nip.io, absent/garbage URLs, declared-remote-never-downgraded, unknown types), the
gate refusing and reporting `providerClass: 'remote'`, `zdrStatusFor` asking the
question instead of answering `local_no_egress`, `GET /api/providers/active`
reporting where the bytes would go, the summary stamping `remote` at write time,
and the pre-`019` fallback keeping its bucket.

### S22 in full — the provider side of S16, found by the S21 lookup

`recordUsage` resolves a chat id against `chats` before writing (S16). It did not
do the same for a provider id, and `usage_log.provider_id` is
`REFERENCES providers (id) ON DELETE SET NULL` — so an id with no row behind it
raised FOREIGN KEY, the catch swallowed it, and the **spend row was dropped**. A
provider deleted while a request is in flight is enough to hit it, and the
schema's own answer (`ON DELETE SET NULL`) says the link should simply go.

The S21 fix needed the provider row anyway, to read its URL, so the same lookup
settles this: an unresolvable provider id is written as NULL, the name is kept,
and the spend stays on the books. `provider_egress` for such a row is `remote`
when the type claims locality — with no URL there is nothing to verify, and the
record does not take a locality claim on faith.

**Tests.** `rowsFor` gained `provider_id`/`provider_egress`, and
`test/taskcost.test.ts` gained "a provider id with no provider behind it keeps the
spend, and does not claim locality"; it fails with the lookup reverted, which is
how it was confirmed to be red before the fix.

## The ledger's undone security items (owner-supplied 2026-09-21)

**Attribution corrected 2026-09-21:** the ledger says these four were specified
"during Prompt 1.39". The 1.39 text the owner then supplied is the *frontend
expansion addendum* and contains no security items at all, so that attribution is
wrong — they belong to the Prompt-1 security series (the same series as `S12`) and
no 1.39 requirement text describes them. The items below and their `P1-` prefix
stand (the prefix exists to keep them apart from this register's audit series, not
to date them); what is corrected is where they came from. The real 1.39 ledger is
the section after this one.

The owner's ledger names the four security items still undone. They are recorded here with a `P1-` prefix because
their numbers are not the audit series' numbers (see the intro above). The
requirement text below is the ledger's, kept close to verbatim so the contract is
not lost; the seam column is this repo as it actually is.

| ID | Requirement (owner-supplied) | Seam in this tree | What is missing |
| --- | --- | --- | --- |
| `P1-S1` | **Approval-bound execution ticket** — bind continuation approvals to a tamper-proof cryptographic digest over tool name, permission key, exact command, canonical worktree, task/run IDs, parent ID, config revision and nonce. | `src/db/approvals.ts` stores `toolName`/`arguments`/`permissionKey`/`runId`/`taskId` (and `matchedPattern`/`matchedLayer`) per `PendingApproval`; `src/http/continuation.ts` replays `arguments` verbatim (`:465`). A park is recorded, but nothing binds the resumed call to what was approved. | The code. Also a *config revision* concept, which does not exist in this tree — the digest's exact field encoding is the part that must come from the spec, not from invention. |
| `P1-S3` | **Process ownership registry** — in-flight registry tracking opaque process IDs, OS PID, task/run IDs, worktree, exact command, output buffers, and timing-safe ownership tokens. | `src/services/terminal/executor.ts` spawns with `shellInvocation`, keeps buffers, and kills the tree on timeout; `src/orchestrator/agents.ts::executeCommand` is the single choke point that could establish ownership. No registry exists. | The code, plus who consumes the registry (routes? approval resume?) and the token semantics. |
| `P1-S4` | **Filesystem TOCTOU defenses** — pre-spawn and pre-write canonical boundary revalidation, rejection of intermediate directory symlinks (`lstat`), realpath validation against canonical boundaries at point of use. | **Landed 2026-09-21** — `src/security/toctou.ts` is new (the file name the 1.39 spec itself names, so a later reconciliation of that document lands on the same path), wired at both seams: the file tools through `files.ts::locate` (write/read/restore) and the command cwd through `containAgentCwd` (spawn). `test/toctou.test.ts`, 11 cases, 3 of them red before the change. | Nothing, for the three mechanisms as the ledger lists them. See the section below for the three policy decisions this needed and the one limit it cannot remove. |
| `P1-S17` | **Structurally authenticated takeover bypass** — interactive terminal user takeover authenticated by server-minted session tokens tied to live user actions, never a client `{ userTyped: true }` flag. | **None.** There is no interactive terminal takeover surface in this tree at all (`takeover`, `userTyped`, pty/stdin paths: nothing), so there is currently nothing to authenticate. | The feature (or a decision that it is out of scope here). |

**Verified absent, not assumed.** `src/security/executionTicket.ts`,
`src/services/terminal/processRegistry.ts`, `src/security/toctou.ts`,
`src/security/takeover.ts` and `test/security139.test.ts` do not exist in the working
tree, in any local or remote branch, or in the repository's history; GitHub code
search finds no `executionTicket` and no `takeover` anywhere on the remote, and the
string `1.39` appears in no file on any branch. The ledger says these were authored in
a different workspace and never committed — uncommitted work in another sandbox does
not travel with the repository, so it is not recoverable from here.

**None of the four was implemented in this tree at the time of that check**, and
none is a regression of anything that landed here: the register's audit series
(`S13`–`S22`) is a different list of findings, all of them fixed.

**Amended 2026-09-21: `P1-S4` is landed on this branch, and the absence paragraph
above now describes history rather than the tree.** `src/security/toctou.ts` was
created *by* that work, so the file that was verified absent is the file that now
exists — the check is left standing because it answers the right question about the
1.39 workspace (was anything of that spec committed here?) and the answer was no;
what changed afterwards is that one item was built from its own mechanism list. The
other three are still absent and still blocked: `P1-S1` needs the digest's field
encoding and the config-revision concept, `P1-S3` needs the registry's consumer and
token semantics, `P1-S17` needs a decision that the feature is in scope at all. The
test file is `test/toctou.test.ts` rather than the spec's `test/security139.test.ts`
on purpose: that name would claim coverage of three items this branch does not
touch, and this repo's suite is named per subject (`egressclass`, `outbound`,
`taskcost`, ...).

#### `P1-S4`, built from the mechanism list — what the code does and what it chose

The ledger's three mechanisms map onto two functions in `src/security/toctou.ts`,
because one of them has to run at a different time from the other two:

- `assertNoSymlinkedTraversal(boundary, candidate)` — walks the components of the
  path **as spelled**, `lstat`ing each, and refuses a symlink even when it currently
  resolves back inside the boundary. It runs on the spelling, before the caller's
  resolver, and that order is the whole design: `resolveInScope` canonicalises, so a
  walk placed after it would inspect the real path, find no link, and be dead code
  that reads like a defence. This is the mechanism that closes the class rather than
  the instance — a link that points inward today is the hook a later swap needs, and
  "the path was fine when it was resolved" is the exact shape of the failure.
- `assertStillInside(boundary, resolved)` — the realpath re-check at the point of
  use, against the **task's** boundary rather than the scope: two parallel Code
  tasks share `projects`/`worktrees` and are not each other's workspace, which a
  scope-wide resolver cannot express. It replaces `locate`'s lexical prefix
  comparison as the *named* refusal, while that comparison stays (it is what catches
  an escape spelled with `..` before resolution).

Both seams carry both checks: `files.ts::locate` for write/read/restore, and
`containAgentCwd` for the cwd `executeCommand` spawns in. Both refusals are
`scope_violation` with `details.reason` of `intermediate_symlink` (naming the
`component`) or `resolves_outside`, because the two need different user responses.

**Three policy decisions this needed, none of them in the ledger's list:**

1. **A symlink at the target itself is allowed** (only intermediate directory links
   are refused); if it points outside, the containment check refuses it anyway.
2. **An inward link is refused too**, which costs a project that intentionally
   symlinks a directory: the model's canonical respelling of the same file succeeds
   and the refusal message names the directory to use. Refusing the class is the
   point — "is this link about to be re-pointed?" is not decidable at use time.
3. **A refusal stops the task** rather than being fed back to the model as tool
   output, matching what the file tools already do for `not_found` and a stale
   `expectedSha256` (`runTool` rethrows; `runCodeTask` reports `ok: false` with the
   coded error, which `subagents.test.ts` already asserts elsewhere).

**The limit, written down so it is not overclaimed:** the window between the check
and the syscall cannot be removed by a pre-check — they are two operations. What is
closed is the *unbounded* window, where a path resolved once at task start was
trusted for the task's whole lifetime. An escape now needs a race won in
microseconds instead of a symlink planted minutes earlier, and the traversal refusal
removes the pre-planted hook that race would use. If the real 1.39 text asks for
more (a flat "no symlinks anywhere along the path", for example), the target-link
clause is the single place to change.

## Prompt-1 series — the owner-supplied text, digested (2026-09-21)

The owner converted the planning PDF (134 pages) to text and supplied it. It
contains **Prompt 1** (backend core), **addenda 1.5 → 1.38**, Prompt 3's opening,
the four consistency audits of that period, and the other workspace's coordination
files (`STATUS.md`, `QUESTIONS.md`, `HANDOFF-LOG.md`). Two things it settles about
the series itself, before any status:

- **It does not contain 1.39, and it contains no item named `S1`/`S3`/`S4`/`S17`.**
  The last addendum in it is **1.38** (Puter as a provider), so 1.39 is the document
  *after* this batch — which is consistent with the ledger's "during Prompt 1.39 the
  final five top-tier security items were specified", and means those four items'
  requirement text is still not in hand. `1.13` appears three times (two
  pre-correction copies and the corrected one); nothing else is duplicated.
- **The original S-series is five items, not an open-ended list**: `S1`, `S3`, `S4`,
  `S12` and `S17` — "the final five top-tier Security items", `S12` landed in PR #6,
  the other four are the ones still undone. The `P1-` prefix stays (this register's
  audit series numbered itself `S13`–`S22` and the two sequences collide on `S13`–
  `S16` and `S18`+), but the series is now enumerated. `S2`, `S5`–`S11` and
  anything above `S17` remain unknown — nothing in the source names them.

**Status per addendum, verified against this tree.** "Landed" means the behaviour
is in the code with its docs; "Partial" names exactly which clause is missing.
This ledger is what a future session should read instead of re-deriving status from
the prose.

**Method, including one correction this table caught.** Every "landed" row is a
file and a route, and every "not landed" row is a case-insensitive search that
found nothing — not an impression. Writing it, `1.13` was first recorded as absent
because the grep looked for `'/rules'` and the route is `'/code/rules'`; the
re-check found all three endpoints. That is the failure shape this register's
audit series exists for, committed while describing it, so: re-run the search
before trusting an "absent" row, and prefer the router's own route list over a
substring.

| Addendum | Scope | Where it stands |
| --- | --- | --- |
| Prompt 1 | Backend core: registry + failover + Ollama detect, pause/resume, schema, encryption, scoped roots, MCP config CRUD, skills intake, cleanup sweep, usage + backup, single-active-job lock | **Landed**, and since corrected in places by this register's audit series (`S15`–`S22`) and `§6.2` |
| 1.5 | mem0 as the Memory backend, wigolo as a default MCP server, opencodex as a provider type | **Landed.** `services/memory/index.ts` (`mem0ai/oss`, self-hosted, under the app's own data dir); `services/mcp/defaults.ts` seeds wigolo (and graphify) **disabled**; `ProviderType` carries `opencodex` with its own adapter; key encryption is 1.23's, unchanged |
| 1.6 | Skill dependency provisioning (per-skill venv / scoped `node_modules`, `ready`/`partial`/`failed`) | **Landed** — `services/skills/{deps,provision,intake}.ts` |
| 1.7 | 4-month retention, manual delete, archive, base-URL `/v1` normalization, sharp | **Landed** — 120-day retention; `/:id/archive` + `/:id/unarchive`; `OPENAI_COMPATIBLE_TYPES` gets the `/v1` fill; `sharp` 0.34.4 |
| 1.8 | System-binary provisioning, configurable backup destination + schedule, cursor-paginated transcripts (the fallback Code-agent section stayed dormant) | **Landed** — `009_skill_binary_approval.sql` with the curated allow-list and the user-approval path; `services/backup/schedule.ts` (destination + schedule); transcripts are cursor-paginated |
| 1.9 | Code parallelism: worktrees + a 2-slot lane separate from the global lock | **Landed** — `orchestrator/lock.ts` lane + `services/code/worktree.ts` |
| 1.10 | `POST /api/resources/detect` (skill vs MCP server vs both vs invalid) | **Landed** — `services/resources/detect.ts`, mounted at `/api/resources` |
| 1.11 | AIStudio → Hyperion rename | **Landed** (paths, env vars, DB filename) |
| 1.12 | Colibrì as an optional local provider type, with the hardware/speed caveat surfaced | **Landed** — provider type + `colibriAdvisory` + the acknowledgement gate. (The egress half of this surface was `S21`.) |
| 1.13 | `GET /api/code/{rules,agents,commands}` listing endpoints | **Landed** — all three at `http/agents.ts` (`/code/rules`, `/code/agents`, `/code/commands`), with the `HYPERION.md` fallback handled in the rules route as the correction in the source requires. The conventions themselves also load for the agent (`services/code/projectContext.ts`) |
| 1.14 | Scheduled tasks, knowledge sources, push notifications | **Landed** — `services/cowork/{scheduledTasks,knowledge}.ts`, `services/notify/push.ts` (payload capped by `S19`) |
| 1.15 | Error handling, `error_log`, `:id/state` reconnection endpoints | **Landed** — migration `007`, the error-log route, the three task-state routes |
| 1.16 | Projects: CRUD + open/activate, scoping resolves against the active project | **Landed** — `http/projects.ts`, `fsScope.setProjectRoot` |
| 1.17 | Health summary + activity feed | **Landed** |
| 1.18 | Per-item export (chat / artifact / code task) | **Landed** — `services/export/index.ts`; bulk export reuses it |
| 1.19 | Per-task ceiling, daily spending cap (autonomous only), subagent count limit | **Landed** — `services/limits/budget.ts` |
| 1.20 | Response preferences, capability toggles, bulk export, bulk delete, temporary chats | **Landed** — incl. the temporary-chat guarantee, which `S20` then had to close for the memory plugin |
| 1.21 | Structured memory, memory import, skill metadata, tool access mode, network egress, `blocked`/`ready_for_review` | **Landed 2026-09-21.** The two missing writes exist: `POST /api/memory` (one memory, at most 4 000 characters) and `POST /api/memory/import` (pasted text split on blank lines, capped at 100 chunks / 20 000 characters, dropped pieces counted rather than truncated). The rules they keep: a **disabled plugin refuses** (`403 capability_disabled`) instead of answering a success-shaped no-op, an empty or oversized body names the field and the bound, and a backend that will not load is `storage_error` with the reason `GET /status` would have given. Import adds sequentially — each chunk is a local-model extraction pass — and a run that stops early returns its counts with `error` set, except when nothing landed, which is the one case a success-shaped answer would have hidden. Everything else in the item was already landed (`003`/`009`-era schema, `tool_access_mode`, `network_egress` enforcement, migration `010` states) | 10 cases in `test/memorywrite.test.ts` (the three refusals over HTTP, the disabled case red-checked, and the splitter's bounds tested directly) |
| 1.22 | Brand-approved assets, distinct from pinning | **Landed** — `brandApproved`, `/api/design/assets/approved` |
| 1.23 | Outbound data safety: local/remote indicator, opt-in redaction check, exposure summary | **Landed**, and `S21` fixed the class that made "local" a claim about the type rather than the URL |
| 1.24 | Cancellation across Code/Design/Cowork | **Landed** — three `/tasks/:taskId/cancel` routes |
| 1.25 | Cowork fallback reassignment Sol → Opus 5 | **Closed — nothing to build.** A dormant fallback assignment ("relevant only if Kimi becomes unavailable again"); the standing "1.25 unknown" item is now resolved |
| 1.26 | ZDR: support/requestFlag/confirmation, `off`/`prefer`/`require`, honesty rule ("confirmed" only ever user-set) | **Landed** — `services/safety/zdr.ts`, `/api/settings/zdr`; `S21` made the local short-circuit URL-aware |
| 1.27 | Permission engine + provenance, subagent deny-inheritance/recursion guard/cost roll-up, doom-loop detection, session fork, compression split, agent profiles | **Landed except two clauses**: session fork has its column (`chats.forked_from`, migration `017`) and no route; and the prune/summarize split ships as the owner-signed **AD-1** deviation (summarize is a receipt, not a model summary) |
| 1.28 | Context ceiling: `maxContextTokens`, detection, resume-in-new-session, usage graph, `hidden`, parallel subagents, `reasoningTokens`/`cacheHitRate`, `defaultAgentProfile`, profile import, Reload Config | **Partial** — `providers.max_context_tokens`, `hidden`, `default_agent_profile`, `reasoningTokens`, parallel subagents and compaction are in; **`cacheHitRate` and `resume-in-new-session` are not** (no such route) |
| 1.29 | Encrypted pluggable backup: Argon2id key from a passphrase, archive-level AES-256-GCM, destinations, retention, audited restore with a diff preview | **Not landed.** The tree's AES-256-GCM is `security/keystore.ts` — provider keys at rest (1.23), a different thing. Backup export is an archive with the `S18` key exclusion and no passphrase layer, no destinations, no retention, no restore preview |
| 1.30 | Cowork Pulse, Design preview sandboxing | **Not landed** (no `pulse` anywhere; there is no Design preview surface yet to sandbox) |
| 1.31 | `interrupted` state + boot reconciliation, resume/view-partial/discard, unattended notification, interactive-wait timeout, Design environment | **Partial — the state half landed 2026-09-21.** `reconcileOrphanedTaskRuns()` already demoted orphaned `running`/`blocked` rows on boot (which is what releases the lane); it now writes **`interrupted`** rather than `error` (migration `020` adds the value to the CHECK and the doc argues why it is neither `error` — nothing failed — nor `paused` — nothing can resume), and the state reaches everything that reads it: the task-state routes, the attention queue (which still reports the pre-`020` `error` + `internal_error` pair, because existing databases hold those rows), the frontend wire enum, `TaskViewState`, the state banner and the harness fixture, which no longer records the state as **not exposed**. Still absent, and not implied by the above: the recovery UX (resume / view partial / discard), the unattended-run notification, the `orphaned_worktree` check, the interactive-wait timeout and the Design environment |
| 1.32 | `.hyperion/coordination/` three-file convention | **Folded.** `S-4` locked this register as the one canonical file; the source's own STATUS/QUESTIONS/HANDOFF-LOG never existed in this tree, and their state claims are stale by inspection (they describe the other workspace: 39 uncommitted files, HEAD `cf3a94e`). Two of their still-open questions are folded into Open decisions below |
| 1.33 | Ask/Plan/Act complete pass: enumerated Ask shell allowlist, concise default, structured living plan, plan-suggestion heuristic, Verifier profile, two-tier loop-back, mode transitions, `reversibility`, learned patterns, walkthrough | **Partial, with one deliberate divergence.** Modes exist as permission-engine profiles; the rest is absent (no plan structure, no `verifier.md`, no `learned-patterns.md`, no `reversibility`, no mode-transition tool, no walkthrough). **The divergence:** §1's read-only Ask shell allowlist is *refused* here on purpose — `profiles.ts` argues a glob over a shell command line is not a security boundary (`git status*` matches `git status; rm -rf /`), so Ask grants no shell at all. Recorded in Open decisions as needing owner sign-off, the way AD-1 got it |
| 1.34 | Plugins hub (`/api/plugins`), per-tool availability, offline security scan with a trust grade | **Not landed** (no plugins router — and the frontend contract snapshot already names this as a missing expected contract: `contracts/gaps.md`, `/api/plugins` + `/api/plugins/:id/availability` in `frontend-contracts.json`) |
| 1.35 | browser-use as an MCP server in the Plugins hub | **Not landed** |
| 1.36 | Failover hardening: per-error-type cooldowns (401/403 60m, 402 30m, 429 5m + `retry-after`, 404 2m, 5xx 1m, network 30s), capped backoff, deadlock reset, `ModelSlot` | **Landed except `ModelSlot`, 2026-09-21.** `src/providers/cooldowns.ts` is the addendum's table, and the hole it closes was real and specific: because `health.ts` excludes non-retryable failures from its threshold *on purpose* (one wrong key must not evict a live provider) and the router throws immediately for them, a 401 was retried on every single request, and a 429 was answered by the router's own immediate second attempt. Cooldowns are per class, with no threshold — one 401 sets the hour. The status decides the class where there is one (a 400 sets nothing: it is this process's bug, and cooling would hide it); `Retry-After` is honoured only on a 429, only above the table, and never beyond the hour (**capped backoff** — no header outlasts the longest judgement this process makes on its own); cooling providers **sort last rather than being excluded**, so the only provider that can serve a model is still tried; the switch is a new `SwitchReason` (`cooldown`) reported as `provider_failure` with the class named in words, because "the credentials were rejected" is what the user can act on. **Deadlock reset** is the expiry-on-read plus `resetHealth` now clearing both the tracker and the cooldown — every user action re-evaluates from scratch, so nothing can hold a provider out permanently. **`ModelSlot` is not implemented:** the addendum names it with no mechanism, and nothing in this tree resembles a slot abstraction over models; recorded as unavailable rather than guessed at. | `src/providers/cooldowns.ts` (new), `router.ts` (ordering, selection, record/clear), `health.ts` (`resetHealth` clears both), `adapters.ts` (`Retry-After` into public details, both header forms); `test/cooldowns.test.ts` **18 cases** (13 unit incl. the table, the clamp, and classification, 5 end-to-end over real sockets: a 401 pauses for the hour without counting toward health, the next request goes elsewhere, a 429 honours `Retry-After` and is not asked again, a success clears a cooldown, and a cooling-only provider is still used); `docs/CONTRACTS.md` "A cooldown is not a health verdict", `docs/API.md` §4.3 |
| 1.37 | Per-provider `egressProxy`, honest disclosure, audit field | **Landed 2026-09-21.** Three parts, and each was checked against the failure it invites. *The field* is `providers.egress_proxy` (migration `022`), validated at the write: `http`/`https` only, because a SOCKS URL is a different transport and storing one this process cannot dial would send traffic direct while the disclosure said otherwise — a `400` rather than a silent fallback. *The transport* is real: `adapters.ts` passes an undici `ProxyAgent` as the `fetch` dispatcher whenever the provider has a proxy, so a proxied provider's bytes are inside the tunnel (asserted by a test proxy that records the CONNECT it was asked for) and an **unreachable proxy fails the request rather than going direct** (asserted by counting the provider's calls). `undici` is now a declared dependency for exactly this — the runtime's own copy is not importable. *The disclosure* is on `GET /api/providers/active` and in `ProviderPublic` as `user:***@host:port` at most: reads are redacted at the boundary in `toPublic`, so a new route cannot forget, and a test asserts the password appears nowhere in the payload. *The audit field* is `usage_log.egress_proxy`, stamped at write time like `provider_egress` beside it and holding the credential-free `authority` — the audit question is where the bytes went, not which credential carried them, and a usage row is exported and aggregated far more widely than the providers table is read. **The part that is more than plumbing:** `egressClassFor` now sees the proxy, so a loopback provider tunnelled through a proxy elsewhere is `remote` — the credential scan, the retention policy and the exposure summary all branch on that, and saying `local` would have been 019's mistake one hop further out. | `src/db/migrations/022_provider_egress_proxy.sql`, `src/services/safety/outbound.ts` (`parseEgressProxy`, redaction, the class rule), `src/providers/transport.ts` (new), `adapters.ts`/`repository.ts`/`usage.ts`, `http/providers.ts`; `test/egressproxy.test.ts` **12 cases** (5 of them red before the change: 2 without the transport, 3 without the class rule); frontend `contracts/wire/providers.ts` + `PrivacyIndicator` (3 new cases) |
| 1.38 | Puter as a provider type on the auth-token path | **Not landed** (`ProviderType` = `remote \| local \| opencodex \| colibri`) |

**The audits in the same source** (consistency passes over 1.26–1.30 and the
"atonement" pass) found fourteen issues, of which the ones that apply to *this*
tree are already handled or recorded here: the terminal takeover exemption
(Finding E) is the `P1-S17` seam; the header-UI collision and the Pulse/backup
audit findings concern addenda that are not built here, so they stay part of
those addenda's scope rather than separate items; and Finding 1's worry — that
"Ask/Plan/Act re-expressed as permission profiles" was never verified against real
code — is verified here: in this tree they **are** permission profiles
(`services/agent/profiles.ts`, migration `017`).

## Prompt 1.39 — Frontend Expansion Layer (owner-supplied text, 2026-09-21)

The owner supplied the 1.39 requirement text itself. It is an **addendum to
Prompt 2 v2** (frontend), explicitly not a replacement: A1–A6 are new scope, B
refines existing spec, C is backlog, D fixes the build order. Items are cited as
"1.39 A1" etc., so they can never be confused with the audit series' `S`-numbers in
this register.

**Status, verified against the tree (2026-09-21).**

| Item | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1.39 A1 | Attention Center — one actionable queue across all tools, deep-linked | **Landed 2026-09-21, both halves.** The server-side aggregation is real: `GET /api/attention` (`src/http/attention.ts` + `src/services/attention/queue.ts`) returns items from pending approvals across every task, live task-run states (paused / blocked / ready-for-review-with-a-plan / interrupted), paused chat runs, `scheduled_tasks.last_status`, backup failures, the spend cap and MCP errors — each with the call that resolves it, ordered by urgency then by how long it has waited, with a `sources` block that reports an unreadable category as `unavailable` plus a reason rather than omitting it. The gap this closes is the one `frontend/contracts/gaps.md` named first ("no cross-tool pending-approval endpoint"). The UI half is now real too: `/attention` renders that queue through `src/attention/` — one polled query shared by the surface and the rail badge, the server's order preserved, ten kinds labelled and toned, per-approval inline *Allow once* / *Deny* only (`allow_session` stays on the page that owns the rule), a `sources` list that shows an unreadable category with its reason instead of quietly dropping it, a read failure shown as a failure rather than an empty queue, and a rail entry above the eight tools carrying the waiting count. Deep links are the frontend's own route space, keyed by kind and tool (`/code?task=…&run=…`, `/chat/<chatId>`, `/cowork`, `/design`, `/research`, `/settings`), while the *call* that resolves an item is the backend's `resolve` — never a frontend route. Keyboard path is the requirement's: roving focus off the row's link (ArrowUp/ArrowDown/Home/End, labels naming item and destination) with Tab into that row's buttons, and focus re-homed to the successor when a poll removes the row it was on. `frontend-contracts.json` records `attention.queue`, `attention.approvals` and — since migration `020` gave the union the state — `attention.interrupted` as `implemented`: an interrupted run is a state the backend holds and the queue reports, and the pre-`020` shape (`error` + `internal_error`) is still reported so no existing database goes silent. | `test/attention.test.ts` (8 cases, real app over a socket, rows written by the real writers); `frontend/src/attention/{links,AttentionList,AttentionCenter}.test.ts(x)` (23 cases) |
| 1.39 A2 | Contract-driven layer: typed contracts from backend source, boundary validation, error mapping, capability discovery, startup version check, dev-time report | **Landed** (Milestone A), tightened in this commit | `src/contracts/{wire,capabilities,compatibility}`, `api/errors.ts` (`ErrorCode` → `ApiError`), `npm run contracts` prints implemented/partial/route-mismatch/missing/undocumented. This commit enumerates `egress`/`zdr` and requires `zdr` — the one place where the contract accepted `z.unknown()` |
| 1.39 A3 | One shared workspace frame for Code/Design/Cowork | **Landed for Code, 2026-09-21.** The frame's eight regions were already built; the Code tool is now the first real occupant, and the Attention Center's Code items therefore stop landing on a placeholder — `attentionDestination` emits a genuine `/code?task=…&run=…` link with **no caveat**, while Cowork/Design keep theirs, because the caveat is derived from what exists rather than hard-coded. The surface itself is deliberately a *read* view: the lane (`GET /api/code/tasks`) with running slots, queued count, capacity and separately-listed parked worktrees that hold disk but not a lane slot; the selected task's state through the same task machine the stream will feed (`GET /api/code/tasks/:id/state`); its recorded spend; and — with `?file=` — the A6 version timeline in the frame's own `versionTimeline` panel. Three things it refuses to fake, each stated in the surface rather than implied by a missing control: **it does not start a task** (the composer says so; `POST /api/code/run-task` streams SSE and deserves the chat stream's care), **it does not show a task history** (the backend has none, so the rail is the lane — a cached list in the browser would be a lie that decays), and **it never renders an absent figure as a zero** (`requests: 0` reads "nothing was recorded, which is not the same as free"; a null cost reads "unpriced"; a partially priced total is labelled a floor). Design and Cowork are still placeholders. | `frontend/src/tools/code/CodeTool.tsx`, `CodeSurface.tsx` (rail + spend, split out so the harness can render them), `CodeTool.test.tsx` (8 cases); router `code/*` route; harness fixtures (`fixtures/codeSurface.ts`, 6 states) |
| 1.39 A4 | Dev-only state harness for hard-to-reach states | **Extended in this commit.** 12 states named: streaming (`running`), paused, approval-required, reconnecting, worktree-lane-full, MCP-disconnected, backup-diff, spending-cap-reached, dangerous-command-confirm now render; `interrupted`, provider-cooldown and design-preview-failure are recorded as **not exposed** with the reason. No dialogs are faked: the dangerous-command confirmation uses the production `Dialog`, labelled a primitive preview. **The attention queue joined the harness with the A1 surface:** `fixtures/attentionQueue.ts` is one queue holding all ten kinds plus an `unavailable` source, rendered by the production `AttentionList` with the decision recorded locally and nothing sent — the fetching container stays out of the harness, whose contract is that it makes no network call. | `src/dev-harness/fixtures/{operationalStates,attentionQueue}.ts`, `HarnessRouter.tsx` + 5 tests |
| 1.39 A5 | Workspace restoration + draft safety | **Landed for the surface that exists, 2026-09-21.** The store is now mounted in the app (`PersistenceProvider`, one store per tab, in-memory fallback when the browser refuses storage) and the two things a user can actually lose are remembered: an **unsent chat draft** — the new-conversation box and each conversation, keyed `chat:new` / `chat:<id>`, dropped once the chat it belonged to exists — and the **reading position in a transcript**, stored as an anchor (row id + pixel offset) rather than a `scrollTop`, restored before paint, and dropped rather than guessed at when the row is gone. Following the tail is now conditional: content growth moves the view only while the viewport is at the end, so streaming no longer pulls the page away from anyone reading back. What was already there and is unchanged: the schema and the forbidden-key classification (credentials, keys, passphrases, attachment content), now guarding live writes instead of only test ones. **Still missing, and named rather than implied:** *open views* and *selected views* remain unused (nothing offers a view list yet); the Code frame restores its **panel widths and collapsed panels** and records `lastTool` (a resize persists, and a reopen mounts at the stored width — asserted in `CodeTool.test.tsx`), and its region scroll positions will use the same anchor hook when the regions hold enough to scroll; Chat and the placeholders have no layout to restore. | `src/state/persistence/{PersistenceProvider.tsx,scrollAnchor.ts,useScrollAnchor.ts,usePersistedDraft.ts,storage.ts,schemas.ts}`; `src/tools/chat/drafts.ts`; tests: 31 in `src/state/persistence/` (5 pure anchoring cases, 6 DOM cases with a stubbed layout, 4 draft cases, 3 store cases added) + 2 in `ChatTool.draft.test.tsx` (typed text lands in storage and comes back on a second mount) + 2 in `Composer.test.tsx`; `docs/CONTRACTS.md` "What the shell is allowed to remember" |
| 1.39 A6 | Provenance: add only parent version + knowledge sources used | **Landed 2026-09-21, exactly the two fields.** *Parent version* is derived rather than stored (`GET /api/artifacts/versions?key=…`): `artifact_versions` has no `parent` column because the parent of version *n* is *n-1* under `UNIQUE (artifact_key, version)`, so `parentVersion: null` means "version 1, where the artifact started" and never "unknown". *Knowledge sources used* are recorded where they are read (migration `021`, `run_knowledge_sources`, keyed by run so a restart replaces its set) and read back with the run (`GET /api/cowork/tasks/:taskId/provenance`) — **used keeps the meaning the prompt already gave it**: only sources marked `usable` are evidence, and a source consulted and found missing/binary/hash-mismatched is deliberately absent, because listing it would claim evidence the run never had. `readKnowledgeSource` now reports the digest and length of the bytes it read, so a row can say *which version of a file* a run was given. One display (`frontend/src/components/Provenance/`, 6 tests + a harness fixture) renders both. **Hosted since 2026-09-21** by the Code surface (A3): `/code?file=<artifact key>` renders the version chain in the frame's `versionTimeline` panel, reaching it from the Attention Center's Code links or a direct URL. **Still missing:** a diff beside the timeline (there is no diff contract for an artifact), the same panel for Design, and knowledge-source provenance outside Cowork, whose route is the only one that reports it | `src/db/{migrations/021_run_knowledge_sources.sql,runKnowledge.ts,artifactVersions.ts}`, `src/http/{artifacts,agents}.ts`, `test/provenance.test.ts` (9 cases) + the Cowork agent's recorded-source assertion; `frontend/src/components/Provenance/`, `frontend/src/contracts/wire/provenance.ts`; `docs/API.md` §12.3a, `docs/CONTRACTS.md` "Provenance is two fields" |
| 1.39 B | Point-of-action privacy indicators (refinement, not a new system) | **Landed in this commit** for the Chat composer: egress, retention status, standing requirement, redaction check, from `/api/providers/active`. **No data source exists** for proxy profile, attachment/URL egress or Pulse source tier (`grep` finds none), so no control is rendered for them — recorded in CONTRACTS.md. Point-action placement for Code/Cowork/Design follows their tools | `src/components/PrivacyIndicator/` + 6 tests; `docs/CONTRACTS.md` |
| 1.39 C | Backlog the Code review tooling, Design review tooling and wider a11y/security hardening | **Recorded as backlog.** Not Milestone-D-blocking; nothing was built from it | this register |
| 1.39 D | Adopt the six-milestone order with A1–A6 folded in (attention + contract → Foundation/Operational shell; workspace framework → Agent workspaces) | **Adopted.** Contract layer landed in Foundation; workspace frame landed ahead of the Agent-workspaces milestone; the Attention Center landed both halves 2026-09-21, which is its Foundation/Operational-shell fold-in done; the Agent-workspaces fold-in is still open, because A3's frame has no populated tool. **Honest labelling of the milestone:** the cross-tool queue is now a screen and all three of its contract rows say `implemented` — including `attention.interrupted`, which stopped being `partial` when migration `020` put the state in the union rather than leaving it derived from `error` | Milestone A/B history; the table above; `frontend/contracts/frontend-contracts.json` |

**Overlap check, run on request (2026-09-21).** Because A1–A6 were built into a
tree that already had surfaces answering nearby questions, each new piece was
checked against what was there rather than assumed to be additive:

- **The queue vs the three things beside it.** `GET /api/attention` adds a
  *fourth* surface next to `GET /api/health/summary` (capability), `GET
  /api/activity` (history) and the MCP status route; it duplicates none of them —
  the three keep their routes, and the queue reads the same tables they do rather
  than a second copy of the data. Approvals are the one place it needed a new
  query, and it adds `listAllPendingApprovals`/`countPendingApprovals` **beside**
  `listPendingApprovals` rather than widening the per-task function — so the
  continuation route keeps its bounded read, and a caller that forgot the task
  cannot accidentally read every task's prompts.
- **`interrupted` vs everything that read the old shape.** Boot reconciliation
  was the only writer of `error` + `internal_error`; the attention queue was the
  only reader that treated that pair as something other than a failure. Both were
  updated together, and the old pair is still accepted, so nothing depends on
  rows having been rewritten.
- **Presentation memory vs the rest of the browser.** `src/state/persistence/` is
  the only module that touches `localStorage` (`grep` over `frontend/src` finds no
  other call site), the classification pass runs on every write rather than only
  in tests, and the anchor hook is the single scroll-memory implementation — the
  workspace frame has none, so there is nothing to reconcile when its regions are
  populated.
- **The A1 surface vs the shell.** The rail entry is one more `NavLink` above the
  eight tools with its own count; the health indicator is untouched. No route
  collides: `/attention` is a new child of the shell, not a tool.

**Its own quality gates** (real backend integration, full state coverage, keyboard
nav, responsive layout, no duplicate/lost events on reconnect, no sensitive data
in local storage or logs, typecheck+tests, docs matching behaviour, honest
labelling of unsupported capability, visual review before done) are adopted as
written.

**How to do the visual review** (the one gate this register cannot run itself):
`npm start` in the repository and `npm run dev` in `frontend/` — the dev server
proxies `/api` to `127.0.0.1:4317`, so one origin serves the whole app. Four
screens are worth the time: **`/attention`**, whose queue is empty on a fresh
database but whose `sources` block is not (it names every category it read, and a
category it cannot read says so with a reason); **`/code`**, the workspace frame's
first occupant — on a fresh database the lane is empty and says *nothing is
running* rather than showing an empty list, and the two things it will not fake are
visible in the same view (the composer states that starting a task is unbuilt, and
`/code?file=<artifact key>` either lists a real version chain or says the file was
never edited through the tools); **`/__dev/states`**, the development harness, which
renders every fixture — the ten attention kinds, the task lifecycle including
`interrupted`, the Code lane busy and idle, spend priced / a floor / unpriced /
nothing-recorded, and the states recorded as *not exposed*, which are there
precisely so that "not built" cannot read as "nothing to show"; and **`/chat`**,
whose composer carries the point-of-action privacy line. The gates these commits
were held to: **honest labelling** (the harness's
`not exposed` cards, the composer's missing indicators named in CONTRACTS rather
than defaulted) and **docs matching behaviour** (same commit). Run the same pass
again whenever a surface gains a state: the fixtures are the coverage argument, so
a new state without a fixture is an unverified claim.

## Prompt-1 scope — status (2026-09-21, verified against the code, not transcribed)

"Prompt 1" is not a document in this repo and never was — it is the working name
for the **backend core** scope, and three of its four parts are recoverable from
the tree: `docs/SPEC.md` (the original scope, its nine deliverables and the
integration contract), the increment series tagged through `docs/API.md` and
`docs/CONTRACTS.md` (1.1 → 1.28), and the Master Plan v4 backend items (`§6.1`–
`§6.8`). The fourth part — the **S-series** audit — existed only in conversation
until the section above, which is why that section now exists.

Where the scope says done, this is what was checked:

| Scope | Where it stands |
| --- | --- |
| SPEC deliverables 1–9 (server + endpoint surface, schema/migrations, provider registry + failover + Ollama detect, pause/resume, MCP config CRUD + test, skills intake, storage sweep, encryption + bind guard + scoped roots, usage + backup) | **Landed.** Every route in the spec's suggested surface resolves (see `docs/API.md` §25 for the deliberate deltas). 20 migrations, `001`–`020`; the next is `021`. |
| Increment series (now known to run **1.5 → 1.38**, not 1.1–1.28) | **Mostly landed, and the exceptions are now enumerated.** `1.25` is resolved (Cowork fallback reassignment — dormant, nothing to build). Unlanded in full: `1.29` encrypted backup, `1.30` Pulse, `1.34` plugins hub, `1.35` browser-use, `1.38` Puter (`1.37` landed 2026-09-21). `1.36` is landed except `ModelSlot` (the cooldown table, capped backoff and deadlock reset are in; the addendum names the slot with no mechanism, so it is recorded as unavailable rather than guessed at). Partial: `1.21` (memory add/import), `1.27` (fork route; prune/summarize is the AD-1 deviation), `1.28` (`cacheHitRate`, resume-in-new-session), `1.31` (state half landed 2026-09-21 — see the row above; recovery UX, notification, worktree check, wait timeout and Design environment remain), `1.33` (spec pass; one deliberate refusal, in Open decisions). The per-addendum ledger above is the record. |
| D-table decisions (D1/D4/D7/D8/D9/D11/D12/D13–D15, D-1.2) | **Landed**, each with the code and test the D-table entry names. |
| v4 backend items `§6.1` context windows, `§6.3` approvals + continuation, `§6.4` unattended hardening, `§6.5` write-path downgrade, `§6.6` subagent isolation, `§6.7` profiles, `§6.8` observability + golden runs | **Landed.** |
| v4 `§6.2` cost accounting per task | **Landed 2026-09-21.** `usage_log` gained `run_id` (migration `018`; `task_id` was `017`), the agent context records one priced row per provider request — so every task run is attributed whatever started it, and a delegated child's spend lands in its parent's task total — the task-state route returns a `usage` summary, and the activity feed carries each run's `spend`. The two findings this surfaced are S15 and S16 above. |
| S-series audit (S12 fixed in PR #6; S13–S22 fixed 2026-09-21) | **Continuous.** The original series is five items — `S1`, `S3`, `S4`, `S12`, `S17` — of which **three** are undone (`P1-S4` landed 2026-09-21) and are recorded above with a `P1-` prefix; their code is not in this repo and the 1.39 document that specifies them has not been supplied. `S2`, `S5`–`S11` and anything above `S17` are not named anywhere in the source text either. |
| Prompt 1.39 (frontend addendum) | **A1–A6 landed; B landed for Chat; C is backlog by the spec's own words; D adopted.** The A3 dependency is closed for **Code**: the shared frame has a real occupant, which is what lets A6's timeline have a host and A5's layout fields have a reader — and the Attention Center's Code items are now genuine deep links instead of placeholders-with-ids. What remains under A3/A6 is the *other two* tools (Design and Cowork are still placeholders) plus per-tool start controls, which is Prompt-2 work and what this register would schedule next. |
| Frontend (Prompt 2) | Out of this scope by design. Shell + Chat tool landed; Code, Cowork, Design, Playground, Plugins, Skills, Settings remain. Frontend-side items that *wait on backend contracts* are tracked in `frontend/contracts/gaps.md`, and one of them (no cross-tool pending-approval endpoint, no per-project active-task listing) is the earliest backend work the frontend will ask for. |

**So: the backend core is complete, including `§6.2` as of 2026-09-21, and one of
the four security items is now built.** What is *not* complete is enumerated rather
than assumed: the series ledger above lists five unlanded addenda, one landed-except-
`ModelSlot`, and six partial ones, `1.25` is closed, and of the four undone security items (`P1-S1`, `P1-S3`,
`P1-S4`, `P1-S17`) **`P1-S4` is landed** — it was the one item specific enough to
build against its own mechanism list without inventing policy, and the section above
records the three choices that had to be made anyway plus the limit it cannot
remove. The other three stay blocked on the 1.39 document: each of them needs a
field encoding, a consumer, or a scope decision that no amount of reading the seam
can supply. The audit
queue is **empty**: HTTP input validation was S17, `mcp_config.json` S18,
the push payload S19, the memory store S20, and the last item — per-provider
egress in `colibri.ts` — became S21 (with S22 falling out of the same lookup).
Suite baseline for every future claim in this file: **983 tests / 176 suites
green, `tsc --noEmit` clean** (backend — `P1-S4` 11 tests / 3 suites, the attention
queue 8 / 2, the `interrupted` state 1 / 1, the memory writes 10 / 2, provenance
10 / 2, cooldowns 18, the egress proxy 12), **168 tests and five gates green** (frontend — 24 belong to the Attention
Center, 31 to presentation memory, 4 to the task-state / `interrupted` mapping, 7 to
provenance, 8 to the Code surface and 7 to the harness; gates are contracts
`167 routes / 37 contracts` — memory +2, provenance +2 — typecheck, lint **and**
production build).

## Resolved verifications

- **Cowork: complete against Slice 4, not a stub** (verified against the code
  2026-09-12, answering v4 §2's "registered != completed" flag):
  knowledge-first prompting with sources statused before content
  (`readKnowledgeSource` enforces sha256, UTF-8, size and type bounds);
  wigolo offered only when configured, enabled AND running under the MCP
  supervisor, with an honest status line in the prompt otherwise; the shared
  compaction hook wired (`context: { messages, replace, window }`); partial
  text and artifacts preserved on a failed late turn (pinned by
  `coworkagent.test.ts`); `cowork.save_artifact` writes real
  `artifact_versions` rows. The one genuinely open sub-item is a product
  question, not an implementation gap: when wigolo is absent there is no
  fallback research path at all — the absence is reported honestly. Whether
  a fallback should exist is the owner's call.

## Corrections to inherited claims (2026-09-18)

Direct re-verifications against the code, recorded so stale plan wording stops
being inherited as background fact. The v4 text below stays verbatim (it is
the record of what was said); this section is the correction layer.

- **MCP process manager — re-verified directly, not via Cowork's wigolo
  check.** `processManager.ts` / `registry.ts` / `supervisor.ts` all present;
  the entrypoint calls `startMcpSupervisor()` at boot (`src/index.ts:267`)
  which registers the manager synchronously (`supervisor.ts:91`) before any
  server connects, and the shutdown path unregisters it (`supervisor.ts:157`)
  so status cannot outlive the servers. Focused suite green: mcpprocesses,
  mcpsupervisor, mcpsupervisordisabled, mcpdefaults — 31/31. The supervisor's
  own module comment records the pre-fix state (registered nowhere) as
  history, not current truth.
- **Subagent dispatch is strictly serial — D7's finding confirmed against
  this tree.** `loop.ts:761` runs `for (const call of calls) { await
  dispatchToolCall(...) }` — no `Promise.all`, no interleaving. So yes:
  parallel delegation genuinely is not real yet, and that is exactly why the
  §6.6 path-reservation `conflict` cannot currently fire (its own comment
  says so). What *is* real, re-pinned 2026-09-18: `delegate` at depth 0 only
  (throws at depth 1 + the tool is stripped from the child's set), max **5**
  children per task (`subagent_count_limit` default 5, `settings.ts:315`,
  enforced by `TaskBudget.claimSubagent`), child inherits the parent's mode
  (D7), denial-inheritance (test-pinned), `subagent_runs` persistence with
  sequence slots and bounded terminal results, and the tested path-reservation
  guard waiting for the day dispatch parallelises.
- **"Confirmed parallel" is a direction, not a fact — corrected.** v4 §5's
  "confirmed parallel via batch `delegate`", the matching "confirmed parallel
  execution" in the external Doc 18 §1, and the old lead sentence of the
  `code/agent.ts` reservation comment all overstate: what is confirmed is
  that batch `delegate` is the parallelisation *direction*; current dispatch
  is serial. CONTRACTS.md's full paragraph was already accurate ("the day
  batch delegation actually parallelises… under the loop's current serial
  tool dispatch"); the comment's lead sentence is tightened in the same
  commit as this entry. Do not cite parallel delegation as existing.
- **The shared compression hook is one mechanism, and its chain is not the
  v4 §4 "full 4-step" wording.** Implemented in `compaction.ts` and shared
  by all three agents: **gate** (estimate, 80% trigger, 50% target) →
  **prune** (oldest-first, group-atomic so a tool result never leaves its
  call; pinned: system messages, the latest tool-result group, the last two
  groups) → **receipt digest** (deterministic role/count/tool-name receipt as
  a `system` message at the drop point — deliberately *not* a model-written
  summary; the module docstring rejects that) → **escalate** (nothing
  droppable → `compacted:false` → the loop parks `context_exhausted`, a
  user-actionable state). Of the spec's four named steps: **prune** ✓ and
  **escalate** ✓ exist; **summarize** exists only as the deterministic
  receipt, by design; **truncate** has no stage in the chain (agent-side
  output caps like `MAX_TOOL_OUTPUT` are ingest bounds, not compaction).
  The receipt-for-summary swap is owner-signed as **AD-1** below.

## Accepted deviations (owner-signed)

- **AD-1 — the compaction digest is a deterministic receipt, not a model
  summary (accepted 2026-09-18).** This deviates from the v4 §4 wording
  ("full 4-step compression chain": prune → truncate → summarize → escalate);
  the shipped chain is gate → prune → receipt → escalate. Reasoning, also
  carried at the definition site (`compaction.ts` module docstring) and in
  CONTRACTS.md "Context compaction": a model-written summary (a) needs an
  extra provider request at exactly the moment the run is already in trouble,
  so the recovery path acquires its own failure mode; (b) can fail, and then
  compaction fails, and the run dies for a reason unrelated to the user's
  task; (c) can hallucinate — an invented file edit in a summary is worse
  than no summary, because the agent acts on it. The receipt is always
  correct, always cheap, and never quotes dropped content. **Do not "fix" the
  digest into a model summary without an explicit owner decision** — same
  standing as the 120-day retention note in SPEC.md. Migration audit behind
  this entry: of the original `truncate-oldest → summarize → escalate`
  design, `truncate-oldest`'s job (shorten from the oldest end when over the
  window) is performed by `prune` — hardened, not lost (group-atomic so a
  tool result never leaves its call; pinned system messages, latest tool
  result, last two groups; 80%-trigger/50%-target so it doesn't stutter) —
  and `escalate` survives as the `nothing_droppable` → parked
  `context_exhausted` path. `summarize` is the only stage whose *mechanism*
  changed, and that change is this signed deviation, not drift.

## Open decisions

- **Open #3 — who builds Design.** Whether Design's Slice 5 output is worth
  shipping from a non-Kimi fallback, or whether Kimi's LMArena Frontend Code
  Arena advantage is real and visible in practice. Identity checks gate on
  product-level confirmation (model family + harness), not sub-tier claims no
  self-report can verify. Status 2026-09-11: **open, evidence submitted** — the identity
  gate was dropped (structurally unfalsifiable from inside a session) and
  replaced with artifact judgment: `open-decision-3/EVIDENCE.md` plus
  `open-decision-3/component/v1..v3`, 2 revisions, uncertainty and a
  production-trust judgment included.

  **RESOLVED 2026-09-11 (practical question only):** the owner verified the
  artifact directly and ruled this channel's output good enough to build the
  Design agent against. The narrower question — whether Kimi specifically
  outperforms this channel — stays genuinely open until a confirmed-Kimi
  session exists. Do not conflate the two.
- **v4 ratification.** §6.6 (S-1/S-2) was ratified and shipped 2026-09-11.
  The remaining v4 upgrade-track items not already marked landed above
  (§6.1, §6.4, §6.8) stay proposals until the owner ratifies them.
- **Ask-mode shell allowlist — needs owner sign-off (raised 2026-09-21).**
  Addendum 1.33 §1 enumerates a read-only `bash` allowlist for Ask mode. This
  tree refuses that: `services/agent/profiles.ts` argues a glob over a shell
  command line is not a security boundary (`git status*` matches
  `git status; rm -rf /`, and every `;`, `&&` and `$( )` is another path), so Ask
  grants no shell at all. That is a divergence from an owner-supplied
  requirement, not an oversight — it needs either a signed deviation (the AD-1
  precedent) or an explicit instruction to build the allowlist anyway.
- **Terminal "Take over": keep or drop (folded from the source's `QUESTIONS.md`,
  2026-08-28, still open).** No takeover surface exists in this tree, and 1.27 §1
  carries the exemption forward ("commands entered directly by the user through
  the terminal's 'Take over' control bypass the permission engine's `ask`/`deny`
  evaluation"). `P1-S17` is that control's authentication — so the answer decides
  whether S17 authenticates something that exists or is closed out as moot.
- **Wigolo ships disabled — is silence the right fallback?** (Folded from the same
  `QUESTIONS.md`.) `services/mcp/defaults.ts` seeds it (and graphify) disabled on
  purpose, documented as possibly needing a one-time `wigolo init`. If Cowork's
  research loop finds it off with nothing to fall through to, does it need an
  explicit "not enabled, here is how" state? User decision, still open.
- **`P1-S4`'s symlink policy — three choices made without the requirement text
  (2026-09-21).** The ledger's mechanism list says "rejection of intermediate
  directory symlinks", so a policy was unavoidable and is recorded in full in the
  `P1-S4` section and in CONTRACTS. Two of the three are narrow (a link *at* the
  target is allowed; a refusal stops the task), and one has a real cost worth a
  decision rather than a footnote: an *inward* directory link is refused even though
  it resolves inside the boundary, so a project that intentionally symlinks a
  directory gets a refusal on the linked spelling and a successful retry on the
  canonical one. If the real 1.39 text is stricter ("no symlinks anywhere"), the
  target-link clause is the only thing to loosen; if it is looser (inward links
  followed), that is the `assertNoSymlinkedTraversal` call sites to drop. Both edits
  are one line plus its test.

---

# Master Plan v4 — verbatim record

> Appended 2026-09-11. This is the plan text as recorded in session; the
> D-table above reconciles its decision references against the shipped code.


# Prompt 3 — Master Plan **v4** (Upgrades Added, Originals Preserved)

## 0. Identity & Posture *(OG, unchanged)*

| | |
|---|---|
| **Executing model** | Kimi K3 (AI Hub Mix) — Round 3 confirmed, provisionally good |
| **Handoff rule** | What's done stays done; recovery protocol governs any future switch |
| **Founding rule** | Verify tree before trusting documents |

---

## 1. Verified Ground Truth *(OG — all verified this session)*

- HEAD `cf3a94e`; **44 modified + 27 untracked = 71 files** uncommitted; none of it `.kilo` state
- Migrations on disk go **001 → 017** (`017_permissions_profiles_continuation.sql`) — `.clinerules/04`'s "next is 006" claim is **stale debt**
- MCP process manager **intact**: `src/services/mcp/processManager.ts`, `registry.ts`, `supervisor.ts`, wired via `registerMcpProcessManager` in the orchestrator
- Design absent — `http/agents.ts` returns coded 501
- Cowork registered but depth unverified
- **Full `npm test` has never run this cycle** — no marker files ever created

---

## 2. Scope Reconciliation *(OG, updated)*

| Slice | Owner | Status |
|---|---|---|
| Code multi-file editing loop | Efesto | ✅ Done — never touch |
| MCP process lifecycle | Kimi | ✅ Verified intact |
| Design full generation | Kimi | ❌ Absent — build for real |
| Cowork agentic loop | Undecided | ⚠️ Registered ≠ completed; resolve (a) rebuild vs (b) gap-fill **first** |

---


## 3. ⭐ THE DESIGN AGENT — Full Deep-Dive (OG spec + V4 engineering detail)

This is the most important remaining slice. Here's the complete picture, original mandate first, then the engineering breakdown.

### 3.1 Original Mandate *(OG — from reactivation doc §3, verbatim in force)*

1. Iterative HTML/CSS + SVG generation/revision — **iterative like Code, not one-shot**
2. Brand memory pull/write-back via `is_brand_approved` flag
3. Separate `design:` undo namespace, distinct from Code's snapshot stack
4. Vision-verification stub (deferred, matches Code's stub)
5. **Mandatory sandboxed iframe preview** — `sandbox` present, `allow-same-origin` **deliberately omitted**
6. Built for real, not provisional

### 3.2 Placement & Wiring 🆕 V4

```
src/services/design/agent.ts        — new: creates design agent, plugs into shared loop
src/services/design/tools.ts        — new: design toolset definitions
src/http/design.ts                  — new: /api/design/* router
composition.ts                      — register third agent (Code, Cowork, Design)
```

- Plugs into **`runAgentLoop`** from `src/services/agent/loop.ts` — design does NOT get its own loop
- Inherits the **permission engine** (currently does so trivially because there's nothing behind the 501)
- Design profile follows the D4 profile model: a built-in `design` profile whose base mode = `act` but with a restricted tool allow-list

### 3.3 Design Toolset 🆕 V4

| Tool | Behavior | Read/Mutate |
|---|---|---|
| `design.generate_html` | Produce/replace current HTML+CSS draft | mutate |
| `design.generate_svg` | Produce/replace SVG asset | mutate |
| `design.revise` | Apply a revision instruction to the current draft — **the iterative core** | mutate |
| `design.preview_snapshot` | Render current draft state for preview | read |
| `design.save_asset` | Persist to `artifact_versions` with `kind: 'design'` | mutate |
| `design.brand_read` | Pull approved brand assets (colors, fonts, logo refs) | read |
| `design.brand_propose` | Write candidate brand asset with `is_brand_approved = false` | mutate |
| `design.undo` | Roll back within `design:` namespace only | mutate |
| `design.vision_verify` | **Stub** — returns `unverified` with structured checklist; real implementation deferred | read |

**Explicitly absent:** `bash`, `command`, `write` (arbitrary file writes), `delegate` v0. Design is a closed toolset — it cannot touch the shell or the project tree. This is a security decision, not a convenience: the only mutation surface is its own artifact lineage plus brand-proposal writes that require approval.

### 3.4 The Iterative Revision Loop 🆕 V4

The "iterative, not one-shot" requirement has mechanics:

- Each revision produces a **new version row** in `artifact_versions` — never in-place overwrite
- User feedback → `design.revise` → new version; the loop's existing `RepeatGuard` (byte-identical args, limit 3) naturally terminates degenerate revision cycles
- Convergence is the user's: they keep iterating or call `design.save_asset` to close
- Version history is browsable and any version is restorable → this *is* the undo substrate; `design:` undo namespace sits on top as a session-scoped stack keyed per design run


### 3.5 Brand Memory 🆕 V4

- Migration `011_brand_approved_assets.sql` **already exists on disk** — the schema is there; Design is its first real consumer
- Read path: only `is_brand_approved = true` rows are injected into generation context
- Write path: proposals land as `is_brand_approved = false`; user approval flips the flag (UI-side, out of LLM reach — the model **cannot approve its own brand writes**)

### 3.6 Sandboxed Preview — The Mandatory Part 🆕 V4

This requirement exists for a reason and needs engineering, not just an attribute:

- Drafts are **served over the localhost API**, not `file://` or `data:` URIs: `GET /api/design/preview/:versionId`
- Response carries a strict CSP: `default-src 'none'; style-src 'unsafe-inline'; img-src data:` — no scripts, no network, no fonts exfiltration
- Frontend embeds it in `<iframe sandbox src="/api/design/preview/...">` — **no `allow-same-origin`, no `allow-scripts`**; even if a model emits `<script>` or an exfiltrating `<img src="http://...">`, the sandbox + CSP + localhost bind is a triple layer
- **Test:** assertion suite verifies the iframe attribute set, the CSP header, and that a poisoned draft (script tags, external URLs) is served inert

### 3.7 Vision Verification Stub 🆕 V4

- Interface-first: `design.vision_verify(versionId)` → `{ status: 'unverified', checks: [...] }`
- The future implementation is a Playwright screenshot of the preview URL fed to a vision-capable provider — the stub reserves the contract so callers don't change when it lands

### 3.8 Design Tests 🆕 V4

Real-server tests per `.clinerules/05`: boot `createApp()` on port 0, drive the design routes with `fetch`, assert sandbox/CSP headers, brand round-trip, undo restore, and that the design agent **cannot** reach `bash`/`write` even if the model requests it.

---


## 4. Cowork Spec *(OG, unchanged)*

Knowledge Sources before wigolo (fallback-state decision open), doc/sheet generation, full 4-step compression chain, partial-result preservation + `artifact_versions`. Applies only if §2 lands on rebuild.

---

## 5. Subagents *(OG, unchanged)*

Depth 1, max 5, profile-first, denial-inheritance, recursion guard, confirmed parallel via batch `delegate`.

---

## 6. 🆕 V4 UPGRADE TRACK — New Work Not in the Original Plan

All items below are **new proposals**, sourced from real verified gaps (the 1.27/1.28 ground-truth table, D-decisions, and tree audit). None modifies original mandates; each is optional-by-decision.

### 6.1 Model-Aware Context Windows *(fixes verified gap #2)*

**Problem:** both agents call `resolveContextWindow({})` with no model → always 8,192 → every compaction percentage is wrong for every real model.
**Upgrade:** resolve per provider: override → `ModelInfo.contextLength` → default; stop reporting `assumed` for known models; wire both trigger moments (compaction threshold + ceiling warning). **Test:** known model reports real window; unknown reports `assumed`.

### 6.2 Cost Accounting per Task *(fixes verified gaps #3 + #7)*

**Problem:** `TaskBudget.charge()`/`.step()` have zero call sites; `usage_log` has no `task_id` — per-task cost is unqueryable.
**Upgrade:** add `task_id` column (migration **018**), wire `TaskBudget` into the loop, surface per-task cost in the task API and activity feed.

### 6.3 Approval Channel & Task Continuation *(D1 + D11 — the largest new capability)*

**Problem:** `ask` verdicts currently dead-end; task runs have no resume path at all (`taskRuns.ts:218` admits it).
**Upgrade:**
- `ask` → record `pending_approvals`, park `approval_required` → user resolves via `POST /api/{tool}/tasks/:taskId/approve` (`allow_once`/`allow_session`/`deny`) → continuation resumes
- `task_messages` table: verbatim conversation snapshotted **only at stopping points**, deleted on terminal state (security property — bounds at-rest exposure), stripped from backups
- Parked tasks **keep their worktree** (D12) — continuation actually continues
- 409 with coded reason if no snapshot exists

### 6.4 Unattended/Scheduled Run Hardening *(fixes verified gaps #10–#11)*

**Problem:** `deps.unattended` is undefined in production so `redaction_blocked`/`zdr_blocked` are unreachable; scheduled parks leave no durable record.
**Upgrade:** `unattended` moves onto `TaskInput` (per-run, not per-module); scheduler allocates real `task_runs` rows; unattended `ask` parks durably + optional push (respects `push_enabled`, default off).


### 6.5 Write-Path Injection Hardening *(D-1.2 from plan)*

**Upgrade:** before any `allow` verdict on a write-capable tool, run path+content through `findSensitive()`; a hit **downgrades to `ask` regardless of allow-rule**. Deliberately independent of the outbound redaction toggle (local writes ≠ egress).

### 6.6 Subagent Worktree Isolation *(fixes verified gap #8)*

**Problem:** parallel children share the parent's worktree and can collide.
**Upgrade:** per-child branch/worktree (or disjoint-sequence claiming with aggregated results); `mode: 'act'` hardcode is already scheduled for removal under D7 — verify it's in the 71-file diff before adding duplication.

### 6.7 Profile System Completion *(D4/D8/D13–D15 landing)*

**Upgrade:** in-code built-in profiles (`ask`/`plan`/`act`, frozen), `AgentProfile` gains `visibility`/`hidden`/`variant`/`permissions`/JSON permission blocks; reasoned-effort variant maps per provider (`reasoning_effort` / Responses `{ effort }` / omit). Much of this may already be **in the 71-file diff given `017` exists** — reconcile before building.

### 6.8 Observability & Golden-Run Evals *(new capability)*

- Activity-feed dedupe check for scheduler rows (plan explicitly flags double-count risk)
- `GET /api/settings/reload-config` (D9), agent-profiles endpoint, resolved-permissions endpoint
- **Regression harness:** recorded golden agent runs replayed against mock providers — the project's stated testing philosophy (real servers over stubs) extended to agent behavior, catching prompt/regression drift like `terminalroute.test.ts`'s staleness caught composition drift

---

## 7. Deliverables Checklist — v4 (OG items 1–10 + V4 additions)

| # | Deliverable | Track | Status |
|---|---|---|---|
| 1 | Gate fixes | OG | ✅ Green |
| 2 | Tree re-audit | OG | ✅ 71 files |
| 3 | MCP manager intact | OG | ✅ Verified |
| 4 | Full suite run | OG | ⬜ Never started |
| 5 | Commit in logical groups | OG | ⬜ Blocked by 4 |
| 6 | Docs in-commit (API/CONTRACTS/SPEC) | OG | ⬜ With commits |
| 7 | Fix stale `.clinerules/04` | OG | ⬜ Found |
| 8 | Cowork question resolved | OG | ⬜ Decision |
| 9 | **Design agent per §3 full spec** | OG | ⬜ Kimi, after 4–8 |
| 10 | Subagents where needed | OG | ⬜ |
| 11 | Model-aware context windows | 🆕 V4 | ⬜ Proposed |
| 12 | Per-task cost accounting (migration 018) | 🆕 V4 | ✅ Landed 2026-09-21 — see the status table above |
| 13 | Approvals + task continuation | 🆕 V4 | ⬜ Proposed (biggest) |
| 14 | Unattended/scheduled hardening | 🆕 V4 | ⬜ Proposed |
| 15 | Injection downgrade-on-write | 🆕 V4 | ⬜ Proposed |
| 16 | Subagent worktree isolation | 🆕 V4 | ⬜ Check diff first |
| 17 | Profile system completion | 🆕 V4 | ⬜ Likely in 71-file diff — reconcile |
| 18 | Observability + golden-run evals | 🆕 V4 | ⬜ Proposed |

---

## 8. Sequencing — How V4 Layers onto the OG Path

```
Phase A (OG, blocking):  4 → 5 → 6 → 7          [green + committed tree]
Phase B (OG, core):      8 → 9 (Design) → 10     [original promises kept]
Phase C (🆕 V4, parallel-after):  11, 12, 17    [foundations — cheap, unblock others]
Phase D (🆕 V4, structural):      13 → 14 → 15 → 16  [continuity + security]
Phase E (🆕 V4, quality):         18             [observability + evals]
```

**Hard constraint (OG):** Design starts only after the tree is committed. V4 items never interleave before Phase A completes.

**Cost note:** the 71-file diff almost certainly already contains D-numbered work (migration `017` is named exactly that). Before building *any* V4 structural item, reconcile the diff so Phase C/D doesn't rebuild what Phase-1 already wrote.

---

This v4 preserves every original commitment and adds only verifiable, gap-grounded upgrades. The immediate next action is unchanged: the detached full-suite run has never been started. Reconcile-open question for you: do you want V4 proposals ratified into the plan now, or held as provisional until Phase A lands?

