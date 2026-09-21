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

**Adjacent, verified — not findings.** Checked while here and found sound:
`resolveInScope`/`resolveInSubtree` (realpath for existing ancestors, sibling-prefix
trap avoided, NUL rejected), layer ordering (`permissionLayers` puts `inherited`
last itself rather than trusting callers), subagent path reservation
(`reserveWorkspacePath` keys on `ctx.resolvePath`, the same normalizer), archive
extraction in all three unzip sites (skills intake, resource archive, backup
restore — each refuses traversal twice), approval→session-rule conversion (the
pattern stored is the user's own matched glob, not the call's subject), and the
keystore (AES-256-GCM, key outside the DB, `0o600`).

**Not yet audited** (next sessions, in the order they look worth the time): HTTP
route input validation outside the agent routers, `mcp_config.json` writes,
web-push payload privacy, the memory plugin's local store, and per-provider egress
handling in `colibri.ts`.

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
| 12 | Per-task cost accounting (migration 018) | 🆕 V4 | ⬜ Proposed |
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

