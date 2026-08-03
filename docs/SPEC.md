# Build Prompt 1 of 3 — Backend Core, Orchestration & Security

> Saved verbatim into the repo on 2026-07-29. This is the authoritative scope
> document for the backend core. It was originally supplied as a chat prompt and
> nearly lost; keep it here so scope is reviewable and diffable next to the code.

**Target model: Claude Opus 5** (Anthropic's current flagship, released July 24, 2026, replacing Opus 4.8 — assigned here for its verified self-verification and error-recovery behavior and strong coding/knowledge-task results, which matter most on correctness-critical infrastructure)

---

## Project Overview (read this even though it's not all your scope)

We're building **Hyperion** — a personal, web-based AI workbench, similar in spirit to Cline but running in a browser instead of VS Code. It's for one user (the owner), runs entirely on their own desktop, has no usage caps, and can talk to any LLM provider through a swappable gateway system rather than being locked to one vendor.

The app has a sidebar with these tools: **Chat, Code, Cowork, Design, Playground, Plugins, Skills, Settings**. Each tool has its own independent model selection (Chat could run GPT while Code runs Claude, simultaneously configured though only one runs a request at a time). The whole app is dark-mode-only, styled in a clean, card-based "serious engineering tool" aesthetic inspired by arize.com — but the actual visual build is not your job (see Prompt 2).

**Three-way build split:**
- **You (Claude Opus 5)** — backend core: providers, failover, security, storage, config logic. This document.
- **GPT-5.6 Sol** — entire frontend/UI, the Design tool's full agentic loop, and the Code tool's terminal/shell execution logic.
- **Kimi K3** — the Code tool's multi-file agentic editing loop, the Cowork tool's full agentic loop, and MCP process lifecycle management.

You are building **the backbone all three depend on**: the API server, the database, the provider system, and every piece of logic where correctness matters more than visual polish. Sol's frontend and Kimi's agentic modules both call into the API surface you build — treat this as the contract other people's code depends on, and design it to be stable and predictable.

**Tech stack**: Node.js backend (Express or Fastify — your choice), SQLite via `better-sqlite3`, runs as a plain local web server (no Electron/Tauri — just a browser tab). No authentication (single trusted user) — this is intentional and must not change; remote access is handled separately via Tailscale (a private mesh VPN the user installs on their own devices), not by adding public auth to the app itself.

**Runtime persistence**: the server should run continuously in the background (like a XAMPP stack), not something manually started each session. Structure it so it can be run under **PM2** (or an equivalent Node process manager) for auto-restart-on-crash and start-on-boot behavior. Bind to `127.0.0.1` by default, but keep the bind address configurable (env var) since Tailscale exposes the machine on a private virtual network interface — the user may want to bind there instead of strictly `127.0.0.1` to allow their other devices (over Tailscale) to reach it. Do not build any public-facing hardening (rate limiting, login, HTTPS) — this app is never meant to be reachable from the open internet.

---

## Your Scope

### 1. Multi-provider registry & failover

Build a provider registry, not a single hardcoded gateway integration:
- Providers can be added/removed/enabled/disabled. Types: **remote gateway** (e.g. AgentRouter — a key + base URL, OpenAI-compatible `/chat/completions` style), and **local runner** (auto-detected, e.g. Ollama).
- **Only one provider is active/enabled at a time.** Enabling a new one automatically disables the previous active one (standby, not deleted).
- **No fixed/curated model list.** Models are identified by their raw model ID and pulled live from whichever provider is currently active (e.g. `GET /v1/models` on the active provider, or Ollama's local model list endpoint).
- **Local provider detection (Ollama)**: on enabling the "Local provider" toggle, probe `http://localhost:11434` (or configured port).
  - Not detected at all → return "not detected" immediately, no background re-scanning.
  - Detected but flaky (connection reset, timeout, garbled response) → retry up to **3 attempts** before giving up and reporting "not detected."
- **Auto-failover (health check, separate from the above detection logic)**: while a provider is active and serving live requests, if it fails **2 consecutive times within a short window (~15-20 seconds)**, automatically mark it unhealthy, disable it, and switch to the next configured healthy provider. This is a *runtime* health check, distinct from the one-time Ollama detection above — don't conflate the two.
- **Capability check vs. health check — these are two different failure modes, handle them differently:**
  - *Capability mismatch* (the active provider doesn't list the requested model at all, e.g. AgentRouter doesn't offer DeepSeek): this is **not a retry-able failure** — check the provider's cached model list *before* sending the request, and if the model isn't there, immediately look for another configured provider that has it. Don't waste a request finding this out.
  - *Health failure* (provider lists the model but the request times out/errors): this is where the 2-consecutive-failure threshold applies.

### 2. Pause/resume state machine (this is the most important behavioral contract in the whole app)

- **On provider failure mid-chat**: the conversation **pauses, never crashes**. Message history stays completely intact. Show a clear error reason. Do **not** auto-retry into the same broken state — it stays paused until the provider recovers or the user manually intervenes (retry / switch provider).
- **On a manual model/provider switch mid-chat**: pause the current exchange, reconfigure to the new model/provider, then **automatically resume** the conversation once the switch succeeds. If the switch itself fails, remain paused (don't fall back silently).
- Expose this as clear state your API surface emits (e.g. SSE events: `paused`, `resumed`, `error`) so the frontend (Sol's layer) can render the paused banner without needing to infer state from HTTP status codes alone.

### 3. Storage layer (SQLite)

Design a schema covering at minimum:
- `chats`, `messages` (with tool + model + provider used per message, for the cost dashboard)
- `providers` (registry: type, config, enabled/active flag, health status)
- `attachments` (metadata + **file-path reference**, not the file blob itself — actual files live on disk under something like `~/Hyperion/attachments/`, not inside SQLite)
- `mcp_servers` (mirrors `mcp_config.json` — name, type [local/remote], command-or-url, optional token, last test-connection result)
- `skills` (name, description, source path, optional token/key, parsed from the skill's own `SKILL.md`)
- `settings` (theme — fixed to dark, no toggle needed — cost tracking config, etc.)
- `artifact_versions` (snapshot stack per artifact — see Code/Design/Cowork undo history; you own the storage table, the agentic loops that populate it live in Kimi's/Sol's layers)
- `usage_log` (tokens in/out, tool, model, provider, timestamp — powers the cost dashboard)

### 4. Security

- **Encrypt API keys at rest.** Use Node's `crypto` module; the encryption key itself should live outside the database (e.g. a separate file with restricted OS permissions), not alongside the encrypted data.
- **Bind the server to `127.0.0.1` only** — never `0.0.0.0`. This is the single most important setting; without it, anyone on the same network could reach the app and its stored keys.
- **Never send provider API keys to the frontend**, even transiently. The browser talks only to your backend; your backend attaches real keys server-side before calling any provider.
- **Scope filesystem access for MCP/Code** to a specific root directory (e.g. `~/Hyperion/projects/`), not the whole filesystem — this bounds the blast radius of anything the Code tool or filesystem MCP server does.

### 5. MCP config-writer backend logic

- Own the read/write logic for `mcp_config.json` (the same file format used by tools like Cline — don't invent a new format).
- Support both **local/stdio** servers (a `command` field, e.g. `npx -y @modelcontextprotocol/server-filesystem /scoped/path`) and **remote/URL** servers (a `url` + optional auth token/header).
- **Editing an existing server reuses the same entry** (update-by-name), not delete-and-recreate.
- Expose a **non-blocking test-connection** endpoint: attempting to save a config should succeed regardless of whether the live test passes — the test is informational, not a gate.
- You write the config file and expose CRUD endpoints; **actually spawning and monitoring the MCP server processes is Kimi's responsibility** (see integration contract below) — don't implement process spawning yourself, just the config persistence and the API surface around it.

### 6. Skills backend logic

- Accept skill intake via **file/folder upload or URL-fetch** (e.g. a GitHub repo link), store the skill's files under a scoped directory.
- **Auto-parse the skill's own `SKILL.md`** header for name/description — don't require the user to type these manually. Return a preview for confirmation before final registration.
- Support an **optional token/API key field** per skill (encrypted the same way provider keys are), for skills that need their own credentials.
- **Recommendation check**: if the parsed `SKILL.md` (or an accompanying manifest field) indicates the skill expects a credential, surface that in the intake response so the frontend can prompt the user to fill in the token field before finalizing.
- **Basic risk-scan check**: before finalizing registration of any externally-sourced skill (uploaded file/folder or URL-fetched — not a small hand-authored default set), run a lightweight heuristic scan over its files and flag: unexpected binary/executable files, obfuscated/minified code where plain text is expected, embedded network calls in scripts, or prompt-injection-style phrasing in the instructions (text attempting to override system instructions). Return these flags (if any) in the intake response for the frontend to display as a warning. **Be explicit in the API response wording that this is a heuristic check, not a guarantee of safety** — the frontend will surface this caveat directly to the user, not imply a clean scan means the skill is safe.
- Expose an endpoint that assembles a **summary of all registered skills** (name + description only, not full content) for injection into an active model's system prompt — this is what makes skill relevance-detection possible without a separate AI call. The actual decision of "is this skill relevant right now" happens in whichever model is running the live task (Kimi's or Sol's layer, depending on the tool) — your job is just to supply the list.

### 7. Storage/cleanup engine

- Background job: auto-delete **assets untouched for 3 months**, auto-delete **chats not opened for 1 month**.
- Respect a **pin/keep flag** on both chats and assets — pinned items are exempt from the timer entirely.
- The Storage/Gallery view's data (list all uploaded/generated files with metadata) is served by you; the actual gallery UI is Sol's.

> **Implementation note — chat retention is 120 days, not 30.**
> The bullet above is the original requirement and is left as written. The
> shipped default is `HYPERION_CHAT_TTL_DAYS=120`, an accepted deviation
> decided by the owner, not an oversight — **do not "fix" it back to 30.**
>
> The reasoning is the asymmetry of the mistake. This sweep runs unattended
> and its deletions are irreversible, so holding a dead chat too long costs
> only disk, while sweeping a live one too early destroys work that cannot be
> recovered. The threshold is therefore tuned toward the survivable error.
> Pinning and archiving remain the explicit "keep forever" signals; the timer
> is the backstop, not the primary control.
>
> Asset retention is unchanged at the specified 3 months (`assetTtlDays: 90`),
> since assets are re-derivable in a way conversations are not. The value is
> env-overridable, and `src/config/env.ts` carries the same note at the
> definition site.


### 8. Cost/usage tracking & backup

- Log every request's token usage (input/output), tool, model, and provider to `usage_log`.
- Expose an aggregated usage/cost endpoint (by tool, by provider, by time range) for the cost dashboard UI (Sol builds the UI, you supply the data).
- **Export/import backup**: package the SQLite database + `mcp_config.json` + skill registry into a single downloadable archive; support restoring from that same archive.

### 9. Single-active-job lock

- Enforce **one active generation/request at a time across the whole app**, regardless of which tool or model. Once the AI finishes responding in one tool, the lock releases and any tool can start the next request. This isn't a hard technical multi-session block so much as a simple server-side lock/queue — reject or queue a new request if one is already in flight.

---

## Integration Contract (what Sol's frontend and Kimi's agent modules expect from you)

Design your HTTP/SSE API as the **single spine** of the application. Sol's frontend talks only to this API — never directly to Kimi's internals. Kimi's agentic modules are backend services that your API layer invokes for long-running tool tasks (Code, Cowork) — they are not separate HTTP servers.

Suggested endpoint surface (adjust naming as you see fit, but keep the shape):

```
GET  /api/providers                    — list registry (enabled/disabled, health)
POST /api/providers/:id/enable         — enable one (auto-disables previous active)
GET  /api/providers/active/models      — live model list from the active provider

POST /api/chat/stream                  — {tool, modelId, messages, attachments}
                                          → SSE: token / paused / resumed / error events

GET|POST|PUT|DELETE /api/mcp/servers   — CRUD for mcp_config.json entries
POST /api/mcp/servers/:id/test         — non-blocking connection test
GET  /api/mcp/status                   — live running-server status (populated by
                                          Kimi's process manager, exposed by you)

GET|POST|DELETE /api/skills            — CRUD, upload or URL-fetch intake
GET  /api/skills/summary               — name+description list for context injection

GET  /api/storage/assets               — gallery listing (files + metadata)
POST /api/storage/assets/:id/pin       — toggle pin/keep exemption

GET  /api/usage                        — aggregated cost/usage data
GET  /api/backup/export                — download full backup archive
POST /api/backup/import                — restore from archive

POST /api/code/run-task                — invokes Kimi's code agent module
POST /api/cowork/run-task              — invokes Kimi's cowork agent module
POST /api/design/run-task              — invokes Sol's design agent module
POST /api/code/execute-command         — invokes Sol's terminal-execution module
                                          (called BY Kimi's code agent when it
                                          decides a shell command is needed)
```

Kimi's code-agent module will need to call `executeCommand()` (implemented by Sol) when it decides a shell command should run — treat this as an internal function call/module import within your Node process, not a network call, for lowest latency. Document the exact function signature you expect (e.g. `executeCommand(cwd, command): Promise<{stdout, stderr, exitCode}>`) so Sol can implement a matching module.

---

## Deliverables

1. Express/Fastify server scaffold with the endpoint surface above (stubs are fine for `/code/run-task`, `/cowork/run-task`, `/design/run-task` — those bodies are Kimi's/Sol's to fill in)
2. SQLite schema + migrations
3. Provider registry + failover + Ollama detection, fully working against at least one real remote provider
4. Pause/resume state machine, testable via a simulated provider failure
5. MCP config CRUD + test-connection (process spawning stubbed — Kimi fills that in)
6. Skills CRUD with upload/URL intake + SKILL.md parsing
7. Storage cleanup cron job + pin/keep logic
8. Encrypted key storage, localhost-only binding, scoped filesystem root
9. Cost/usage logging + backup export/import

---

## Addendum — Build Prompt 1.5 (Backend Boost)

Three additive changes on top of everything above. Nothing here replaces an
existing contract; the provider registry, MCP CRUD, skills intake, storage
cleanup and pause/resume all behave exactly as documented earlier. Full request
and response shapes live in `docs/API.md`.

### 1. Memory plugin (mem0, self-hosted)

The Memory toggle is now backed by [`mem0ai/oss`](https://www.npmjs.com/package/mem0ai),
running fully local. Vector store and history DB live under `~/Hyperion/memory/`
(`vectors.db`, `history.db`).

- **Toggle**: settings key `plugins.memory.enabled`, boolean, **default `false`**.
  Read/written through the normal `/api/settings` surface, or via
  `POST /api/memory/enable` / `POST /api/memory/disable` (which also reset the
  cached backend so a previously failed load is retried).
- **Per-turn integration, not a separate flow.** `src/orchestrator/chat.ts` calls
  `recallForTurn(prompt, tool)` before building the request and injects the result
  as one extra `system` message after the main system prompt — a short bounded
  list of facts (`HYPERION_MEMORY_RETRIEVE_LIMIT`, default 5), never a dump. After
  a successful completion it calls `rememberTurn(...)` fire-and-forget.
- **When the toggle is off, nothing happens at all** — no retrieval, no
  background writes. Same when the backend failed to load.
- **Never fatal.** `mem0ai/oss` statically imports `better-sqlite3`, so the import
  is a guarded dynamic `import()` inside try/catch; any failure degrades to a
  no-op and is reported through `GET /api/memory/status` (`available`, `error`).
- **Local models only.** mem0's own `ollama` provider needs an uninstalled peer
  package, so the service talks to Ollama through mem0's OpenAI-compatible
  provider (`baseURL: ${HYPERION_OLLAMA_URL}/v1`, dummy API key). Knobs:
  `HYPERION_MEMORY_LLM_MODEL` (`llama3.1:8b`), `HYPERION_MEMORY_EMBED_MODEL`
  (`nomic-embed-text`), `HYPERION_MEMORY_EMBED_DIMS` (`768`).
- **API for Settings** (Sol): `GET /api/memory` (`?query=` for semantic search,
  `?limit=`, default 50 / max 200), `GET /api/memory/status`,
  `POST /api/memory/enable|disable`, `DELETE /api/memory/:id`, `DELETE /api/memory`.
  The list route returns `{ memories: [] }` rather than an error when memory is
  off or unavailable — `/status` is the single place that explains why.

### 2. wigolo — default research MCP server (Cowork)

`src/services/mcp/defaults.ts` seeds two entries at boot via the normal MCP
registry, so they appear in the existing status bar and setup form with no
special-casing:

| name | command | seeded state |
| --- | --- | --- |
| `filesystem` | `npx -y @modelcontextprotocol/server-filesystem <projects dir>` | **enabled** |
| `wigolo` | `npx -y wigolo` | **disabled** |

wigolo ships disabled on purpose: it needs a one-time `init` before it can run,
so enabling it is the user's explicit action. Seeding is idempotent through
`settings` keys `mcp_seeded.<name>` — a default the user deletes stays deleted,
and a default the user reconfigures is never overwritten. A failed seed logs a
warning and never blocks boot. Process lifecycle is still Kimi's
`McpProcessManager`; this is config only.

### 3. opencodex — third provider type

`ProviderType` is now `'remote' | 'local' | 'opencodex'` (migration
`002_opencodex_provider_type.sql` widens the `providers` CHECK constraint).

- **Purely additive.** opencodex providers go through the same registry,
  single-active-provider rule, health tracking and failover as everything else.
  No special path anywhere.
- **Never auto-enabled.** `enabled` stays body-only on create, so local detection
  can't switch one on; the user enables it manually.
- **It is not Chat-Completions-compatible inbound.** opencodex's local proxy
  accepts `GET /v1/models` and `POST /v1/responses` (Responses API) — not
  `/v1/chat/completions`. So `openCodexAdapter` in `src/providers/adapters.ts`
  delegates `listModels` to the OpenAI adapter but has its own `stream()` that
  POSTs `/responses`, hoists `system` messages into `instructions`, and reads
  `response.output_text.delta` frames. From the frontend's perspective the
  streaming contract is unchanged.
- **Setup, for the UI's help text**: the real npm package is
  `@bitkyc08/opencodex` (`npm i -g @bitkyc08/opencodex`), then `ocx init`, then
  `ocx start`. Default base URL `http://localhost:10100`. Note the bare `ocx`
  package on npm is an unrelated project — don't install it.


