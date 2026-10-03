# Hyperion

**Hyperion is a personal, single-user AI workbench.** It runs on the owner's
own desktop, binds localhost, and has no authentication by design — it is a
private project, not a product: no hosted version, no multi-user mode, no
plan for either. (Remote access, when the owner wants it, is via their own
Tailscale network — never by exposing this app publicly.)

## What it is

Think "an agentic IDE in a browser tab, against any provider": one local web
app with a sidebar of tools — Chat, Code, Cowork, Design, Playground, Skills,
Settings — talking to whichever LLM provider is configured, through a
swappable gateway layer rather than being locked to one vendor. One provider
is active at a time, with standby failover to alternates.

## Build status

- **Backend core: complete.** Providers, failover, security,
  storage, orchestration, configuration.
- **Agentic layer: complete.** Code (multi-file editing loop),
  Cowork (knowledge-first research loop), Design (iterative HTML/CSS + SVG
  loop) and the MCP process lifecycle, all on one shared agent loop.
- **Frontend: in progress.** The foundation (checked API contracts, Zod wire
  validation, SSE parsing and reconnection, safe local persistence,
  task-state reconciliation, the shared agent-workspace frame, design-system
  primitives, development state harness) now carries the operational shell —
  eight-tool sidebar, backend health indicator, per-tool routes — and the
  **Chat tool wired end-to-end**: conversation list, transcript, streaming
  with pause/resume, busy handling, and the model picker against the active
  provider. The **Code tool is the frame's first real occupant**: a composer
  that starts a run (task id, ask/plan/act mode, instruction, model) and
  streams its frames as they arrive, settling on the persisted run rather
  than on the socket when the stream ends; the lane rail — running slots,
  queue depth, capacity, and the parked worktrees that hold disk rather than
  a slot — beside the selected task's state, recorded spend and version
  timeline; the parked-task panel, where a held call's arguments are shown
  before it is allowed once, allowed for the session, or denied, and the run
  continues from that answer; and the recovery panel for a run a restart
  interrupted, which reports what it got as far as doing, discards the
  leftover checkout on request, and resumes by filling the composer with the
  task id whose checkout the re-run adopts. Cowork, Design, Playground,
  Plugins, Skills, and Settings still resolve to a placeholder that says so.

The **Code Canvas backend** (1.40) is done and unreferenced by any screen: a
read-only file listing, file read and task diff for a Code task's workspace, plus
a sandboxed browser preview served by a **second HTTP server** on
`HYPERION_PREVIEW_PORT` (default 4320; `0` disables). Nothing calls those routes
yet — the panel is the Code surface's next pass — which is why they are recorded
as `missing` contracts in `frontend/contracts/gaps.md` rather than as work the
frontend already has.

## The agent architecture

One shared loop (`src/services/agent/loop.ts`), three agents plugged into it —
the mode gate, budgets, parking/continuation, cancellation and the `task_runs`
record come from the loop; the agents differ only in prompt and toolset:

| Agent | What it does | What it can reach |
| --- | --- | --- |
| **Code** | Multi-file editing in per-task git worktrees, terminal execution, one-level subagents | The project filesystem and shell, inside scoped roots |
| **Cowork** | Knowledge-first research, scheduled tasks, versioned artifacts | The knowledge library and supervised MCP tools |
| **Design** | Iterative HTML/CSS + SVG drafts with brand memory and a sandboxed preview | Its own artifact lineage only — no shell, no project tree |

## Running it

Requires Node.js **22.6+** (native TypeScript — no build step).

```bash
npm ci
npm start          # serves http://127.0.0.1:4317
```

Runtime data lives **outside the repo** at `~/Hyperion` (database, worktrees,
attachments, knowledge library, skills, MCP venvs) — override with
`HYPERION_HOME`. The bind address is `HYPERION_BIND` (loopback only, with a
refuse-to-start guard against wildcard binds; see `.env.example`). For a
long-running install, `ecosystem.config.cjs` is the PM2 entry point.

The API also refuses requests whose `Host` it does not recognise, and
state-changing requests carrying an `Origin` it does not know — DNS rebinding
and cross-origin form posts, the two things a loopback bind cannot see. Reaching
it over Tailscale means setting `HYPERION_ALLOWED_HOSTS` and
`HYPERION_APP_ORIGINS`; both are documented in `.env.example`. Neither is
authentication.

Reaching a **Code Canvas preview** (`/api/code/tasks/:taskId/preview`, §27) over
Tailscale needs the preview hostname in `HYPERION_ALLOWED_HOSTS` as well — the
listener runs the same Host guard — and the preview port (`HYPERION_PREVIEW_PORT`,
default 4320) open to the browser, since it is a second listener rather than a
path on 4317. The preview port must **not** be added to `HYPERION_APP_ORIGINS`.

```bash
npm run typecheck  # tsc --noEmit, must be clean
npm test           # full suite: real servers, no stubs
```

The frontend remains a separate development package for now. Start the
backend as above, then run Vite in another terminal; browser requests stay on
relative `/api` URLs and Vite proxies them to port 4317.

```bash
cd frontend
npm install
npm run dev        # http://localhost:4318

npm run contracts
npm run typecheck
npm run test
npm run lint
npm run build
```

Static frontend serving from Express is intentionally not part of the current
scope.

## Where the real depth lives

- `docs/SPEC.md` — the original scope document.
- `docs/API.md` — every endpoint, with request/response shapes and error codes.
- `docs/CONTRACTS.md` — the cross-cutting invariants and *why* they exist.
  Read this before changing anything structural.
- `.hyperion/coordination/decisions.md` — the decision register: what was
  decided, when, and what is still open.

## Working on it

Branches and PRs into `main`; nothing pushes to `main` directly. House rules:
docs land in the same commit as the behavior they describe; every bug fix
ships with a test that fails without it; migrations are immutable (the next
one is `028`); tests boot real servers rather than stubbing them.
