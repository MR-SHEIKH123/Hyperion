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

The build was split into three prompts (the split and the contract are in
`docs/SPEC.md`):

- **Prompt 1 — backend core: complete.** Providers, failover, security,
  storage, orchestration, configuration.
- **Prompt 3 — agentic layer: complete.** Code (multi-file editing loop),
  Cowork (knowledge-first research loop), Design (iterative HTML/CSS + SVG
  loop) and the MCP process lifecycle, all on one shared agent loop.
- **Prompt 2 — frontend: Milestone B in progress.** The Milestone-A foundation
  (checked API contracts, Zod wire validation, SSE parsing and reconnection,
  safe local persistence, task-state reconciliation, the shared
  agent-workspace frame, design-system primitives, development state harness)
  now carries the operational shell — eight-tool sidebar, backend health
  indicator, per-tool routes — and the **Chat tool wired end-to-end**:
  conversation list, transcript, streaming with pause/resume, busy handling,
  and the model picker against the active provider. The Code, Cowork, and
  Design tool workflows, plus Playground, Plugins, Skills, and Settings,
  remain later increments.

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

```bash
npm run typecheck  # tsc --noEmit, must be clean
npm test           # full suite: real servers, no stubs
```

The frontend remains a separate development package during Prompt 2. Start the
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

Static frontend serving from Express is intentionally not part of Milestone A.

## Where the real depth lives

- `docs/SPEC.md` — the original scope document and the three-way build split.
- `docs/API.md` — every endpoint, with request/response shapes and error codes.
- `docs/CONTRACTS.md` — the cross-cutting invariants and *why* they exist.
  Read this before changing anything structural.
- `.hyperion/coordination/decisions.md` — the decision register: what was
  decided, when, and what is still open.

## Working on it

Branches and PRs into `main`; nothing pushes to `main` directly. House rules:
docs land in the same commit as the behavior they describe; every bug fix
ships with a test that fails without it; migrations are immutable (the next
one is `018`); tests boot real servers rather than stubbing them.
