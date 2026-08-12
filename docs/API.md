# Hyperion Backend — API Reference

Generated from the implementation, not from the spec. Every endpoint, field name
and status code below was read off the routers in `src/http/` and the service
types they serialize. Where the implementation diverges from the "Suggested
endpoint surface" in `docs/SPEC.md`, that is called out in the last section.

- Base URL: `http://127.0.0.1:4317` by default (`HYPERION_BIND`, `HYPERION_PORT`).
- **There is no authentication, no CORS, no rate limiting and no request logging.**
  This is deliberate per the spec: single trusted user, loopback bind, remote
  access via Tailscale. Do not expose this port publicly.
- Request bodies are JSON (`express.json`, 25 MB limit) except the two multipart
  upload routes. `x-powered-by` and ETags are disabled.

---

## 1. Conventions

### 1.1 Error envelope

Every non-2xx response — including 404s and validation failures — has exactly
this body, produced by `AppError.toJSON()` in `src/util/errors.ts`:

```json
{
  "error": {
    "code": "bad_request",
    "message": "tool is required and must be a string.",
    "retryable": false,
    "details": { "field": "tool" }
  }
}
```

`details` is omitted when nothing was attached. **Branch on `code`, never on the
HTTP status or the message text** — codes are the stable contract.

This is the complete set, transcribed from `ERROR_STATUS` in
`src/util/errors.ts`. Only four codes default to `retryable: true` —
`DEFAULT_RETRYABLE` in the same file — and every other code is `false` unless a
call site overrides it explicitly.

| code | HTTP | retryable |
| --- | --- | --- |
| `bad_request` | 400 | false |
| `not_found` | 404 | false |
| `conflict` | 409 | false |
| `no_active_provider` | 409 | false |
| `no_provider_for_model` | 409 | false |
| `provider_unreachable` | 502 | **true** |
| `provider_error` | 502 | **true** |
| `provider_auth_failed` | 401 | false |
| `provider_timeout` | 504 | **true** |
| `no_healthy_provider` | 503 | false |
| `local_provider_not_detected` | 404 | false |
| `busy` | 409 | **true** |
| `run_not_paused` | 409 | false |
| `run_not_found` | 404 | false |
| `aborted` | 499 | false |
| `agent_not_registered` | 501 | false |
| `terminal_not_registered` | 501 | false |
| `capability_disabled` | 403 | false |
| `network_egress_disabled` | 403 | false |
| `spending_cap_reached` | 429 | false |
| `scope_violation` | 403 | false |
| `encryption_failed` | 500 | false |
| `storage_error` | 500 | false |
| `internal_error` | 500 | false |

**`capability_mismatch` is not an error code.** An earlier revision of this table
listed it as a `409`; it is a *pause reason* on a chat run (§4) and a provider
switch reason, and it never appears in an error envelope. It is called out here
because the mistake is an easy one to reintroduce from the other direction — the
string is real, it is just not in this vocabulary.

`spending_cap_reached` is a **429**, not a 403: the daily cap lifts by itself at
the next local midnight, which is a quota rather than a prohibition. It carries
`windowResetsAt` in `details` so a client can say when work resumes (§20.5).

`aborted` is **499**, a non-standard status for a client that went away. Nothing
is wrong on the server, so it is deliberately not a 5xx.

**Known wrinkle**: a multer `LIMIT_FILE_SIZE` rejection returns **HTTP 413 with
body `code: "internal_error"`**. Oversized uploads have no distinct machine code
yet; detect them by status 413.

### 1.2 Parameter validation (`src/http/params.ts`)

All of these throw `bad_request` with `details: { field }`:

- A body that is present but not a JSON object (array, string, number) →
  `"Request body must be a JSON object."` An absent body is treated as `{}`.
- Required string missing → `"<field> is required and must be a string."`;
  present but empty/whitespace → `"<field> must not be empty."` Strings are trimmed.
- Booleans accept real `true`/`false` and the strings `"true"`/`"false"`; anything
  else → `"<field> must be a boolean."`
- Enums list the legal values in the message and in
  `details: { field, allowed: [...] }`.

Tri-state string fields (documented as *nullable* below) follow one rule
everywhere: **omit to keep the current value, send `null` or `""` to clear it.**

### 1.3 SSE wire format (`src/orchestrator/sse.ts`)

Streaming responses are `text/event-stream; charset=utf-8` with
`Cache-Control: no-cache, no-transform`, `Connection: keep-alive`,
`X-Accel-Buffering: no`. Frames look like:

```
event: token
data: {"text":"Hello"}

```

**The event name is on the `event:` line and is not repeated inside the JSON** —
use `addEventListener('token', ...)`, not a `type` field. A comment heartbeat
(`: ping`) is sent every 15 s. The stream ends with `res.end()` and **no terminal
sentinel event**; treat `done`, `error`, or socket close as the end.

Validation happens **before** the SSE headers are written, so a bad request or a
`busy` conflict arrives as an ordinary JSON error response with a real status
code. Once the stream is open, failures arrive as an `error` event on a 200.

---

## 2. Health

### `GET /api/health`

```json
{ "ok": true, "name": "hyperion", "uptimeSec": 412, "loopback": true }
```

`loopback` is false when the server was bound to a non-loopback address (e.g. a
Tailscale interface).

### `GET /api/health/summary`  *(new in 1.17)*

One verdict over providers, MCP servers and recent errors, so a dashboard can
render a status light without making three requests and knowing which fields
matter in each.

**Always 200.** A `degraded` or `error` verdict is the answer to the question,
not a failure to answer it.

```json
{
  "status": "degraded",
  "checkedAt": 1786178129794,
  "uptimeSec": 412,
  "components": {
    "providers": {
      "status": "degraded",
      "detail": "The active provider \"openrouter\" is unhealthy; 1 other provider(s) can take over.",
      "total": 2,
      "active": { "id": "1f2e...", "name": "openrouter", "health": "unhealthy" },
      "failoverCandidates": 1,
      "healthy": 1,
      "degraded": 0,
      "unhealthy": 1,
      "unknown": 0
    },
    "mcp": {
      "status": "ok",
      "detail": "No MCP supervisor is registered, so no servers are being managed.",
      "managed": false,
      "total": 0,
      "running": 0,
      "errored": 0
    },
    "errors": {
      "status": "ok",
      "detail": "No server errors in the last hour.",
      "windowMs": 3600000,
      "count": 0
    }
  }
}
```

`status` is `ok` | `degraded` | `error`, and the top-level value is the worst of
the three components — a summary that rounded up would hide the fault.

Only the provider component can reach `error`, and only in one case: the active
provider is unhealthy *and* `failoverCandidates` is 0, meaning a request sent
right now has nowhere to go. Note that `active` is a single provider, not a list:
`enabled` is a single active flag guarded by a partial unique index. A standby
provider is disabled and still counts as a failover candidate, because
`listFailoverCandidates` ignores `enabled`.

MCP is capped at `degraded` because it is auxiliary, and the error count is
capped at `degraded` because a failure an hour ago is history, not a statement
about what works now. `unknown` providers are never counted as failing — every
provider is `unknown` until something is actually sent to it.

---

## 3. Providers — `/api/providers`


### 3.1 `ProviderPublic`

Returned wherever a provider appears. **The API key is never present in any
form** — only `hasKey` and a short `apiKeyHint`.

```ts
{
  id: string; name: string;
  type: 'remote' | 'local' | 'opencodex' | 'colibri';
  baseUrl: string;
  hasKey: boolean; apiKeyHint: string | null;
  enabled: boolean; priority: number;
  healthStatus: 'unknown' | 'healthy' | 'degraded' | 'unhealthy';
  lastError: string | null; lastErrorAt: number | null; lastSuccessAt: number | null;
  modelCount: number | null;          // null = never fetched
  modelsFetchedAt: number | null; modelsError: string | null;
  createdAt: number; updatedAt: number;
}
```

`ModelInfo` (in the model-list routes): `{ id, label?, ownedBy?, contextLength? }`.

Three routes also spread a registry summary into the response:
`{ activeProviderId: string|null, activeProviderName: string|null, providerCount: number, hasAnyProvider: boolean }`.

### 3.2 Routes

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/providers` | `{ providers: ProviderPublic[], ...summary }` |
| POST | `/api/providers` | **201** `{ provider }` |
| POST | `/api/providers/detect-local` | `LocalDetectionResult` (bare) |
| GET | `/api/providers/colibri/advisory` | `ColibriAdvisory` (bare) |
| POST | `/api/providers/colibri/probe` | `ColibriProbeResult & { defaultBaseUrl }` |
| GET | `/api/providers/active/models` | `{ providerId, providerName, models }` |
| GET | `/api/providers/active/current` | `{ provider: ProviderPublic \| null }` |
| GET | `/api/providers/:id` | `{ provider }` |
| PATCH | `/api/providers/:id` | `{ provider }` |
| DELETE | `/api/providers/:id` | **204**, no body |
| POST | `/api/providers/:id/enable` | `{ provider, ...summary }` |
| POST | `/api/providers/:id/disable` | `{ provider, ...summary }` |
| GET | `/api/providers/:id/models` | `{ providerId, models }` |
| POST | `/api/providers/:id/test` | `{ ok, message, modelCount?, code? }` |

**POST /api/providers** body: `name` (req), `type` (req, one of
`remote` / `local` / `opencodex` / `colibri`), `baseUrl` (req), `apiKey?`,
`priority?`, `enabled?`. `enabled` is body-only and defaults to false, so
nothing — including local detection — can auto-enable a provider the user
didn't turn on.

**PATCH /api/providers/:id** body: `name?`, `baseUrl?`, `priority?`,
`apiKey?` (nullable — send `null` to remove a stored key). `type` is immutable.

**Enable** applies the single-active rule: enabling one disables the previous
active provider (standby, not deleted). For `colibri` providers the body must
carry `acknowledgeSlow: true` — see §3.3.

**Model lists** accept `?refresh=true` to bypass the cache
(`HYPERION_MODEL_CACHE_TTL_MS`). `/active/models` 503s with `no_healthy_provider`
when nothing is enabled.

**POST /api/providers/detect-local** body `{ baseUrl? }`, defaults to
`OLLAMA_URL` (the env var is unprefixed — `src/config/env.ts` reads
`OLLAMA_URL`, not `HYPERION_OLLAMA_URL`, which an earlier revision of this line
claimed). Retries up to 3 attempts before reporting not-detected; it never starts
a background rescan.

### 3.3 Colibrì

Colibrì runs a very large quantised model on ordinary hardware by streaming
expert tensors from disk instead of holding them in VRAM. It serves a genuine
OpenAI-compatible surface (`GET /v1/models`, `POST /v1/chat/completions`), so it
uses the same adapter as `remote` and needs no special request handling. What is
different is its performance profile, and that is what these two routes exist
for.

**GET /api/providers/colibri/advisory** — no body. Returns:

```ts
{
  type: 'colibri';
  defaultBaseUrl: string;        // 'http://localhost:8000/v1'
  caveat: string;                // multi-line prose, safe to render verbatim
  acknowledgementRequired: true;
  acknowledgementField: 'acknowledgeSlow';
}
```

`defaultBaseUrl` is a suggestion for pre-filling a form, never an assumption:
Colibrì's port is a CLI flag (`coli serve --port 8000`), so each provider row
carries its own explicit `baseUrl`. There is no separate `port` field anywhere
in the API.

**POST /api/providers/colibri/probe** body `{ baseUrl? }`, defaulting to
`defaultBaseUrl`. Returns
`{ detected, baseUrl, models: ModelInfo[], reason?, defaultBaseUrl }`.

A miss is a normal answer — `detected: false` with a `reason` — not an error, so
a client never has to special-case a failed probe. An empty/whitespace
`baseUrl` is the one exception and 400s. Unlike `detect-local` this makes a
**single** attempt: the URL was typed by hand moments earlier, so a failure is
far more likely a wrong port than a cold start, and retrying it three times only
delays saying so. **The probe registers nothing** — create the provider with
`POST /api/providers` afterwards.

**The acknowledgement.** `POST /api/providers/:id/enable` refuses a `colibri`
provider unless the body contains `acknowledgeSlow: true`, responding **400
`bad_request`** with `details: { field: 'acknowledgeSlow', providerType:
'colibri', caveat }`. The caveat text is repeated in that response
deliberately: it means the warning travels with the refusal, so a client that
never called `/colibri/advisory` still has everything it needs to show the user.
The intended flow is show the caveat → user accepts → retry with the flag.

Two deliberate limits on that gate:

- It applies **only to this user-initiated route**, not to `enableProvider()`
  itself. Automatic failover promotes a standby provider with no human present;
  gating there would make a Colibrì provider unusable as a fallback at exactly
  the moment a slow-but-working provider is most wanted.
- It gates **enabling**, not creating. `POST /api/providers` with
  `type: 'colibri'` needs no flag, because a provider that is merely configured
  and switched off cannot surprise anyone.

---

## 4. Chat — `/api/chat`

### 4.1 Record shapes

```ts
ChatRecord   { id, tool, title, modelId, providerId, pinned, archived,
               lastOpenedAt, createdAt, updatedAt }
MessageRecord{ id, chatId, role: 'system'|'user'|'assistant'|'tool', content,
               tool, modelId, providerId, providerName,
               status: 'streaming'|'paused'|'complete'|'error',
               errorCode, errorMessage, tokensIn, tokensOut, seq,
               createdAt, updatedAt }
RunStateSnapshot { runId, chatId, tool, state: 'idle'|'running'|'paused'|'complete'|'error',
               pauseReason, errorCode, errorMessage, modelId, providerId,
               providerName, messageId, attempt, updatedAt }
```

`tool` is always one of `chat | code | cowork | design | playground`.
`pauseReason` is one of `provider_failure | provider_switch | model_switch |
no_healthy_provider | capability_mismatch | user_request`.

### 4.2 Routes

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/chat` | `{ chats }` — query `tool`, `includeArchived`, `archivedOnly`, `limit` |
| POST | `/api/chat` | **201** `{ chat }` |
| POST | `/api/chat/stream` | **SSE** |
| POST | `/api/chat/resume` | **SSE** |
| GET | `/api/chat/runs/paused` | `{ runs }` — query `chatId` |
| GET | `/api/chat/:id` | `{ chat, messages }` — query `limit` (default 500) |
| PATCH | `/api/chat/:id` | `{ chat }` |
| DELETE | `/api/chat/:id` | `{ deleted: true, id }` |
| GET | `/api/chat/:id/messages` | `{ messages, nextBefore }` — query `limit` (default 50, 1–500), `before` |
| POST | `/api/chat/:id/open` | `{ chat, messages, latestRun }` |
| POST | `/api/chat/:id/pin` | `{ chat }` |
| POST | `/api/chat/:id/archive` | `{ chat }` |
| POST | `/api/chat/:id/unarchive` | `{ chat }` |
| GET | `/api/chat/:id/runs` | `{ latest, paused }` |

**GET /api/chat/:id/messages** is **cursor-paginated, never offset-paginated**
*(new in 1.8)*. `before` names a **message id**, and the page returned is the
`limit` messages immediately older than it, oldest-first. Feed `nextBefore` back
as `before` to walk further up the transcript; `null` means the first message has
been reached.

An offset would be wrong here rather than merely different: a chat grows at the
end while it is being scrolled, so every appended message shifts `?offset=` by
one and the client silently re-reads or skips a row. A message's id never moves.
Internally the cursor resolves to the message's `seq`, which is monotonic within
a chat — a timestamp cursor would have the same defect as an offset, because two
messages can share a millisecond.

With no `before` the **newest** page is returned, so opening a long chat lands at
the end of the conversation. An unknown `before`, or one belonging to a different
chat, is **400 `bad_request`** naming `before` rather than a silent fallback to
the newest page, which would read as the transcript duplicating itself.

`GET /api/chat/:id` and `POST /api/chat/:id/open` are unchanged: both still
return up to `limit` messages oldest-first with no cursor, which is what a client
restoring a whole short chat wants.


**POST /api/chat** body: `tool` (req), `title?`, `modelId?` (nullable),
`providerId?` (nullable), `id?` (supply your own id).

**PATCH /api/chat/:id** body: `title?`, `modelId?` (nullable),
`providerId?` (nullable), `opened?`.

**DELETE /api/chat/:id** removes the chat immediately, along with its messages.
`404 not_found` if it does not exist.

**POST /api/chat/:id/pin** body `pinned?`; omit it to toggle. Pinned chats are
exempt from the cleanup timer.

**POST /api/chat/:id/archive** and **POST /api/chat/:id/unarchive** set
`archived`. Two idempotent routes rather than one toggle, because archiving is
driven by a menu item with a definite intent and the frontend should not have to
know the current state to call it.

Archiving means "keep this, just get it out of my way". Archived chats are hidden
from `GET /api/chat` by default **and are exempt from the idle cleanup sweep,
exactly as pinned chats are** — archiving is never a step toward deletion.

`GET /api/chat` list filtering:

| query | result |
| --- | --- |
| *(neither)* | unarchived chats only — the sidebar default |
| `includeArchived=1` | everything |
| `archivedOnly=1` | only archived chats — a dedicated "Archived" view |

`archivedOnly` wins if both are passed, being the more specific request.

**POST /api/chat/:id/open** resets the idle timer that drives auto-deletion, and
returns the latest run so the UI can restore a paused banner on reload.

### 4.3 `POST /api/chat/stream`

Body:

| field | required | notes |
| --- | --- | --- |
| `chatId` (or `id`) | yes | chat must exist |
| `tool` | yes | one of the five tools |
| `modelId` | yes | raw provider model id |
| `prompt` | yes | also accepted as `message`, or as the last user turn of a `messages[]` array |
| `systemPrompt` | no | |
| `providerId` | no | pin this turn to one provider |
| `temperature`, `maxTokens` | no | |
| `attachments` | no | `{ id, filename }[]` |
| `resumeRunId` | no | continue an existing run |

**History is rebuilt server-side from the database.** A `messages[]` array is
only mined for the newest user turn; client-supplied history is never trusted.

Events, in order:

| event | data |
| --- | --- |
| `open` | `{ runId, chatId, messageId, providerId, providerName, modelId }` |
| `token` | `{ text }` |
| `usage` | `{ tokensIn, tokensOut, costUsd }` — `costUsd` is **null when the model is unpriced** |
| `resumed` | `{ runId, providerId, providerName, modelId, attempt }` |
| `paused` | `{ runId, reason, code, message, retryable, partialContent }` |
| `done` | `{ runId, messageId, finishReason? }` |
| `error` | `{ runId, code, message, retryable }` |

`paused` is a **normal event on a 200 response**, never an HTTP error, and the
stream stays open. Partial assistant text is preserved both in `partialContent`
and in the persisted message. A transparent failover before the first token
emits `resumed` and the user sees nothing; a failure after output has started
pauses instead of silently restarting.

`busy` (409, retryable, `details: { jobId }`) is returned as JSON when a job is
already in flight and `concurrency_mode` is `reject`. Under `queue` the request
waits for the lock instead.

### 4.4 `POST /api/chat/resume`

Body: `runId` (req), `modelId?`, `providerId?`, `tool?`. Same event stream.
Requires the run to be in `paused` state — otherwise `run_not_paused` (409) as
JSON. A manual model/provider switch resumes automatically on success and stays
paused on failure.

---

## 5. Memory — `/api/memory`  *(new in 1.5)*

Backed by self-hosted mem0. Off by default; toggle is the setting
`plugins.memory.enabled`.

```ts
MemoryEntry  { id, memory, createdAt: string|null, updatedAt: string|null,
               score: number|null, tool: string|null, chatId: string|null }
MemoryStatus { enabled, available, error: string|null,
               llmModel, embedModel, retrieveLimit, storeDir }
```

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/memory` | `{ memories: MemoryEntry[] }` — query `query` (semantic search), `limit` (default 50, max 200) |
| GET | `/api/memory/status` | `{ status: MemoryStatus }` |
| POST | `/api/memory/enable` | `{ status }` |
| POST | `/api/memory/disable` | `{ status }` |
| DELETE | `/api/memory/:id` | `{ deleted: boolean }` |
| DELETE | `/api/memory` | `{ cleared: boolean }` |

The list route returns an **empty array rather than an error** when memory is
disabled or the backend failed to load, so `GET /status` is the single place that
explains why (`enabled` vs `available` vs `error`). `/status` never starts the
backend. The enable/disable routes reset the cached client, so a backend that
failed once is retried instead of staying broken until restart.

Retrieval and storage happen inside the chat turn, not here — see
`docs/SPEC.md` §Addendum. When the toggle is off there are no background writes.

---

## 6. MCP — `/api/mcp`

```ts
McpServerPublic { id, name, type: 'local'|'remote',
                  command: string|null, args: string[], env: Record<string,string>,
                  url: string|null, headers: Record<string,string>,
                  hasToken: boolean, tokenHint: string|null, enabled: boolean,
                  lastTestStatus: 'ok'|'failed'|'unknown',
                  lastTestMessage: string|null, lastTestAt: number|null,
                  createdAt, updatedAt }
McpServerStatus { name, state: 'running'|'stopped'|'starting'|'error',
                  pid?, uptimeMs?, toolCount?, lastError? }
```

The stored token is never returned — only `hasToken` / `tokenHint`.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/mcp/status` | `{ managed: boolean, servers: McpServerStatus[] }` |
| POST | `/api/mcp/sync` | `{ synced: true, servers }` |
| POST | `/api/mcp/import-orphans` | `{ imported: number, servers }` |
| GET | `/api/mcp/servers` | `{ servers }` |
| POST | `/api/mcp/servers` | **201** `{ server }` |
| GET | `/api/mcp/servers/:id` | `{ server }` |
| PUT / PATCH | `/api/mcp/servers/:id` | `{ server }` (same handler) |
| DELETE | `/api/mcp/servers/:id` | `{ deleted: true, id }` |
| POST | `/api/mcp/servers/:id/test` | `{ ok, message, static, durationMs }` |

**Create** body: `name` (req), `type` (req, `local` \| `remote`), `command?`,
`args?: string[]`, `env?: Record<string,string>`, `url?`,
`headers?: Record<string,string>`, `token?`, `enabled?`. **Update** takes the
same fields, all optional. Editing updates the existing entry in place — never
delete-and-recreate — and rewrites `mcp_config.json` in the standard format.

`managed: false` means Kimi's process manager hasn't registered yet, so
`servers` reflects config only. `POST .../test` is **informational, not a gate**:
saving succeeds regardless of the result. `static: true` means the config was
only inspected, nothing was connected to. The outcome is also persisted onto
`lastTestStatus` / `lastTestMessage` / `lastTestAt`.

`POST /api/mcp/import-orphans` adopts servers that exist in `mcp_config.json`
but not in the database. It runs **only when called** — never at boot.

Three default entries are seeded at first boot: `filesystem` (enabled),
`wigolo` (disabled, pending its one-time `init`) and `graphify` (disabled,
pending its one-time venv setup — see the Recommended MCP servers section of
`docs/CONTRACTS.md`). Deleting a default keeps it deleted.

---

## 7. Skills — `/api/skills`

```ts
SkillPublic { id, name, description: string|null,
              sourceType: 'upload'|'url'|'builtin', sourceRef: string|null,
              relPath: string, hasToken: boolean, tokenHint: string|null,
              needsCredential: boolean, riskFlags: RiskFlag[],
              riskDisclaimer: string, enabled: boolean,
              dependencies: SkillDeps, createdAt, updatedAt }
RiskFlag    { category: 'binary'|'obfuscated'|'network'|'injection'|'oversize',
              severity: 'info'|'warning', file: string, message: string,
              excerpt?: string, line?: number }
RiskReport  { scanned: number, skipped: number, flags: RiskFlag[],
              hasWarnings: boolean, disclaimer: string }
SkillDeps   { status: 'none-declared'|'ready'|'partial'|'failed'
                    |'needs-user-approval',
              runnable: boolean, installing: boolean, stale: boolean,
              ecosystems: ('python'|'node')[], manifests: string[],
              declared: string[], installed: string[],
              failed: { ecosystem, name, spec, error }[],
              rejected: { name, spec, reason }[],
              lifecycleScriptsSkipped: string[],
              binaries: CheckedBinary[], missingBinaries: string[],
              error: string|null,
              pythonPath: string|null, nodeModulesPath: string|null,
              provisionedAt: number|null }
CheckedBinary { name: string, declared: boolean, source: string,
              present: boolean }

IntakePreview { stagingId, name: string|null, description: string|null,
              sourceType, sourceRef: string|null, hasSkillMd: boolean,
              manifestSource: 'frontmatter'|'markdown'|'none',
              needsCredential: boolean, credentialHint: string|null,
              files: string[], fileCount: number, risk: RiskReport,
              riskDisclaimer: string, nameConflict: boolean, warnings: string[],
              dependencies: { noneDeclared, ecosystems, manifests, declared,
                              rejected, lifecycleScriptsSkipped,
                              binaries: string[], inferredBinaries: string[] } }
SkillSummaryEntry { name: string, description: string,
              status: SkillDeps['status'], runnable: boolean,
              missingBinaries: string[] }
```


`riskDisclaimer` is repeated at the top level of every read **by design** — a UI
cannot render findings without also having the caveat that this is a heuristic
check, not a guarantee of safety.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/skills` | `{ skills: SkillPublic[], disclaimer }` |
| GET | `/api/skills/summary` | `{ skills: SkillSummaryEntry[] }`, or `{ prompt: string }` with `?prompt=true` |
| POST | `/api/skills/upload` | **201** `{ preview: IntakePreview }` |
| POST | `/api/skills/fetch` | **201** `{ preview }` |
| POST | `/api/skills/confirm` | **201** `{ skill }` |
| DELETE | `/api/skills/staging/:id` | `{ discarded: true, id }` |
| GET | `/api/skills/:id` | `{ skill }` |
| POST | `/api/skills/:id/provision` | `{ skill }` — retries dependency installation |
| POST | `/api/skills/:id/binaries` | `{ installed, message, installable, skill }` — installs one system binary, confirmation required |
| PATCH / PUT | `/api/skills/:id` | `{ skill }` (same handler) |
| DELETE | `/api/skills/:id` | `{ deleted: true, id }` — query `keepFiles` (default false) |


**Intake is two-phase.** `POST /upload` is `multipart/form-data` with field name
**`files`** (up to 200 files, folder uploads keep their relative paths) plus an
optional `sourceRef` text field. `POST /fetch` takes JSON `{ url }` and accepts
either a zip or a raw `SKILL.md`. Both parse the skill's own `SKILL.md` for
name/description, run the risk scan, and return a staged preview **without
registering anything**.

`POST /confirm` body: `stagingId` (req), `name?` (required if none was parsed),
`description?`, `token?`, `enabled?`, `acknowledgeRisk?` — the last is required
when the report has warning-level flags. Abandoned staging entries are pruned by
the cleanup job, or discard one explicitly.

`PATCH /api/skills/:id` body: `name?`, `description?`, `token?` (nullable),
`enabled?`.

`GET /summary` supplies the name+description list for system-prompt injection.
Note that the chat orchestrator does **not** inject it today — assembling and
inserting it is the caller's job (Kimi's and Sol's agent loops).

### 7.1 System binaries and `needs-user-approval`

A skill can declare system commands it needs — `requires_binaries` in its front
matter (`system_dependencies` and `binaries` are accepted as aliases) — and when
it declares none, a scan of its own files infers them from usage. Each entry
appears in `dependencies.binaries` as a `CheckedBinary`, where `declared: false`
marks an inferred one: a guess must be visibly a guess, because acting on it
installs a program the author never asked for.

Version constraints are stripped (`ffmpeg >= 6` is recorded as `ffmpeg`), and an
entry that is a path rather than a command name is dropped and reported in the
preview's `warnings` instead of being run.

**`needs-user-approval` is not a failure.** It means every declared package
installed fine and the only thing still missing is a system program that Hyperion
will not install without being asked. Nothing went wrong and there is nothing to
retry — the run is waiting on a person, so `failed` stays empty and `error`
carries the sentence explaining what to do. `runnable` is `false` for it, and
**`dependencies.runnable` remains the single boolean to branch on**; only
`none-declared` and `ready` are runnable.

`GET /api/skills/summary` therefore carries `missingBinaries` alongside `status`
and `runnable`, and the `?prompt=true` block says so in words —
`[needs ffmpeg installed — ask the user before using it]` rather than the generic
dependency-failure note. An agent that reads only the prompt should still know
the difference between "this skill is broken" and "this skill needs your
permission".

**`POST /api/skills/:id/binaries`** body: `name` (req) and `confirm`.

```json
{ "installed": false,
  "message": "Installing ffmpeg changes this whole computer, so it needs explicit confirmation.",
  "installable": true,
  "skill": { "…": "SkillPublic" } }
```

`confirm: true` is **required and never defaulted**. Everything else in the
skills system installs into a directory that skill owns; this is the one place a
request changes the whole computer, so the confirmation is the feature rather than
a formality. A refusal is a **200**, not a 4xx: "we do not install that" and "you
have not confirmed yet" are answers about this machine, not malformed requests.
`installable` distinguishes "we could do this for you, just confirm" from "you
must install this yourself", so a UI needs no second endpoint to decide which
button to show.

The curated list is deliberately short — **`ffmpeg` only** to begin with. An entry
has to be packaged under the same name by winget, choco, brew and apt, and it has
to install without prompting, or an install becomes a hang. Anything else returns
`installable: false` and asks the user to install it themselves.

Only a missing or non-string `name` is a **400**, and an unknown skill id is a
**404** — the id is checked before the binary is, so a typo in the path is
reported as a typo rather than as a refusal to install. Re-provision afterwards
(`POST /:id/provision`) to move the skill off `needs-user-approval`; an install
re-probes `PATH` rather than trusting the package manager's exit code.

---

## 8. Storage — `/api/storage`

```ts
AssetPublic { id, chatId, messageId, filename, relPath, mimeType, bytes,
              sha256, origin: 'uploaded'|'generated', tool, pinned,
              brandApproved: boolean, brandApprovedAt: number|null,
              createdAt, lastAccessedAt, missing: boolean, url: string }
AssetListing{ assets: AssetPublic[], total, totalBytes, limit, offset }
StorageStats{ assets: { count, bytes, pinned, missing },
              chats:  { count, pinned },
              byTool:   { key, count, bytes }[],
              byOrigin: { key, count, bytes }[] }
CleanupResult { ranAt, dryRun, assetTtlDays, chatTtlDays, chatsDeleted,
              assetsDeleted, bytesFreed, emptyDirsRemoved, stagingPruned, detail }
CleanupLogEntry { id, ranAt, chatsDeleted, assetsDeleted, bytesFreed, dryRun, detail }
```

`missing: true` means the row outlived its file on disk. `url` is where to GET
the bytes, so the frontend never builds paths itself.

`bytes` and `sha256` describe **what was stored**, which is not always what was
uploaded. Images larger than `HYPERION_IMAGE_MAX_EDGE` (default 1568px on the
longest edge) are downscaled once before they are written, so their stored size
and digest differ from the original file's. Images already within the cap, and
every non-image, are stored byte-for-byte. Do not use `sha256` to match an asset
against a local copy of the file the user picked.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/storage/stats` | `StorageStats` (bare) |
| GET | `/api/storage/assets` | `AssetListing` (bare) |
| GET | `/api/storage/assets/:id` | `{ asset }` |
| GET | `/api/storage/assets/:id/file` | the file bytes |
| POST | `/api/storage/assets/:id/pin` | `{ asset }` |
| DELETE | `/api/storage/assets/:id` | `{ deleted: true, keepFile, bytesFreed }` |
| POST | `/api/storage/cleanup` | `CleanupResult` (bare) |
| GET | `/api/storage/cleanup/log` | `{ entries: CleanupLogEntry[] }` — query `limit` (default 50) |

`GET /assets` query: `chatId`, `tool`, `origin` (`uploaded` \| `generated`),
`pinned`, `brandApproved`, `search` (filename substring), `limit`, `offset`.

`brandApprovedAt` is `null` whenever `brandApproved` is `false`. Approval is
managed through `/api/design` (§23), not here — this router only reports and
filters on it.

`POST /assets/:id/pin` body `pinned?`; omit to toggle. Pinned assets are exempt
from the TTL sweep entirely.

`DELETE /assets/:id` accepts `keepFile` as a query param or a body field and
echoes back what it did, including `bytesFreed`.

`POST /cleanup` runs the sweep on demand; body `dryRun?`, `assetTtlDays?`,
`chatTtlDays?` (the TTL overrides exist so a sweep can be rehearsed without
waiting three months). Defaults come from env: assets untouched for 90 days,
chats not opened for 120 days (four months). Pinned assets are exempt; pinned
**and** archived chats are exempt.

---

## 9. Usage & pricing — `/api/usage`

```ts
UsageBucket  { key, requests, tokensIn, tokensOut, costUsd, unpricedRequests }
UsageSummary { range: { from, to }, totals: UsageBucket,
               byTool: UsageBucket[], byProvider: UsageBucket[],
               byModel: UsageBucket[], byDay: UsageBucket[],
               hasUnpriced: boolean }
PriceInput   { modelId, providerId: string|null,
               inputPer1mUsd: number, outputPer1mUsd: number }
```

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/usage` | `UsageSummary` (bare) — query `from`, `to` (epoch ms), `tool`, `providerId` |
| GET | `/api/usage/prices` | `{ prices: PriceInput[] }` |
| PUT / POST | `/api/usage/prices` | `{ price }` (same handler, upsert) |
| DELETE | `/api/usage/prices` | `{ deleted: boolean }` |

Upsert body: `modelId` (req), `providerId` (nullable — `null` is a catch-all
across providers), `inputPer1mUsd` and `outputPer1mUsd` (req numbers). DELETE
reads `modelId` / `providerId` from either the body or the query string.

**Unpriced is not free.** A usage row with no matching price keeps `cost_usd`
NULL rather than 0, so it never silently reads as free. Cost sums skip those
rows, and `unpricedRequests` per bucket plus the top-level `hasUnpriced` tell the
dashboard to show "cost incomplete" instead of a wrong total.

There is no per-row usage endpoint — aggregates only.

---

## 10. Backup — `/api/backup`

```ts
BackupFile   { filename, bytes, createdAt }
BackupManifest { format, app, createdAt, createdAtIso, schemaMigrations: string[],
                 contents: {...}, counts: Record<string, number>, warning?: string }
ArchiveInspection { valid, manifest: BackupManifest|null, hasDatabase, hasMcpConfig,
                 hasEncryptionKey, skillFiles, attachmentFiles,
                 counts: Record<string, number>, problems: string[], warnings: string[] }
RestoreResult { restored, dryRun, inspection, preRestoreBackup: string|null,
                 filesWritten: { database, mcpConfig, skills, attachments },
                 restartRequired }
```

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/backup` | `{ backups: BackupFile[] }` |
| GET | `/api/backup/export` | **a file download**, not JSON |
| POST | `/api/backup/inspect` | `{ inspection: ArchiveInspection }` |
| POST | `/api/backup/import` | `RestoreResult` (bare) |

`GET /export` query: `includeKeys` (**default false**), `includeAttachments`
(default true). The archive bundles the SQLite database, `mcp_config.json` and
the skills registry. Including the encryption key makes the archive as sensitive
as the keys themselves, which is why it is opt-in and why the manifest carries a
`warning`.

`POST /inspect` and `POST /import` take the archive either as an upload —
`multipart/form-data`, field name **`file`**, one file (note this differs from
skills, which uses `files`) — or as JSON `{ file: "<name>" }` naming an archive
already in the backups directory.

`POST /import` body also takes `dryRun` (default false) and
`includeAttachments` (default true). **Always inspect or dry-run first**: a real
import overwrites the live database. It takes a pre-restore backup automatically
and reports it as `preRestoreBackup`. `restartRequired: true` means the process
must be restarted for the restored database to take effect.

---

## 11. Settings — `/api/settings`

Untyped key/value store; values may be string, number, boolean, or null.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/settings` | `{ settings, resolved }` |
| PUT / PATCH | `/api/settings` | `{ updated: string[], settings }` |
| PUT | `/api/settings/:key` | `{ updated: [key], settings }` — body `{ value }` |
| DELETE | `/api/settings/:key` | `{ cleared: key, settings }` |

`resolved` exposes the interpreted values the backend actually acts on:
`{ concurrencyMode, autoResumeAfterFailover, costTrackingEnabled }`.

Bulk PUT/PATCH applies every key in the body; an empty body is a 400
(`No settings provided`). Objects and arrays are rejected —
`Setting "<key>" must be a string, number, boolean, or null`, with
`details: { key, received }`. DELETE writes NULL, which restores the default
rather than removing the concept.

Known keys: `theme` (`'dark'`, fixed), `cost_tracking_enabled` (`true`),
`auto_resume_after_failover` (`true`), `concurrency_mode`
(`'reject'` \| `'queue'`), `plugins.memory.enabled` (`false`),
`mcp_seeded.<name>` (internal seed markers).

---

## 12. Agent tools — `/api/code`, `/api/cowork`, `/api/design`, `/api/agents`

These are the seams for Kimi's and Sol's modules. **The bodies are not mine** —
the routes are wired, validated, locked and streamed here, but until a module
registers they return **501** (`agent_not_registered` / `terminal_not_registered`)
as plain JSON.

| Method | Path | Response |
| --- | --- | --- |
| POST | `/api/code/run-task` | **SSE** |
| POST | `/api/cowork/run-task` | **SSE** |
| POST | `/api/design/run-task` | **SSE** |
| POST | `/api/code/execute-command` | plain JSON |
| GET | `/api/code/tasks` | plain JSON *(new in 1.9)* |
| GET | `/api/code/tasks/:taskId/state` | plain JSON *(new in 1.15)* |
| GET | `/api/cowork/tasks/:taskId/state` | plain JSON *(new in 1.15)* |
| GET | `/api/design/tasks/:taskId/state` | plain JSON *(new in 1.15)* |
| GET | `/api/code/rules` | plain JSON *(new in 1.13)* |
| GET | `/api/code/agents` | plain JSON *(new in 1.13)* |
| GET | `/api/code/commands` | plain JSON *(new in 1.13)* |
| GET | `/api/agents/status` | `{ agents, terminal, registered: { code, cowork, design } }` |

`run-task` body (`TaskInput`): `tool`, `chatId`, `modelId`, `prompt`, `cwd?`,
`attachments?`, `options?`. Input parsing, agent lookup and the busy check all
happen **before** the SSE headers, so a 501 or 400 is a normal JSON error.

**`/api/code/run-task` additionally requires `taskId`** (string, required). It
names the run for its whole life: it is the key for the worktree, the lane slot
and `GET /api/code/tasks`. Allowed characters are letters, digits, `.`, `-` and
`_`, up to 100 — it becomes a directory name and a git ref, so anything else is a
`bad_request` rather than something quietly rewritten.

Agent progress rides a single `agent` event whose data is an open
`Record<string, unknown>` — the module owns the channel schema. On completion the
route emits `event: agent` with `{ channel: 'result', tool, chatId, ...TaskResult }`
where `TaskResult` is
`{ ok, summary, changedFiles?, artifacts?: {key,version}[], error?: {code,message} }`.
Code adds `taskId` to that payload.

Code also emits one `agent` event **before** the agent starts, once its slot is
held and its checkout exists:

```
event: agent
data: {"channel":"started","tool":"code","chatId":"…","taskId":"…",
       "mode":"worktree","dir":"…/worktrees/<taskId>","reason":null}
```

`dir` is where the task will actually work — display that, not the `cwd` that was
requested. `mode` is `worktree` when the task got its own isolated checkout, or
`direct` when it is working in the project directory itself, in which case
`reason` says why isolation was not possible (no git on PATH, not a repository,
no commits yet). **`direct` is a supported outcome, not an error** — the task
runs either way. Under `concurrency_mode: queue` the stream can open and then sit
silent until a slot frees; `started` is the signal that waiting is over.

Agent modules receive an `AgentContext`: `{ emit, llm: { stream, complete },
executeCommand, saveArtifactVersion, getSkillsSummary, resolvePath, signal, log }`.
`executeCommand(cwd, command)` resolves
`{ stdout, stderr, exitCode, timedOut }` — this is an **in-process module call,
not an HTTP hop**. `resolvePath` enforces the scoped filesystem root and throws
`scope_violation` outside it. `signal` aborts when the client disconnects.

### 12.1 Concurrency: Code is the exception  *(new in 1.9)*

`cowork` and `design` `run-task` share the app-wide single-job lock with chat, so
one of those and a chat turn cannot run at once.

**Code does not.** It runs in a separate counting lane —
`HYPERION_CODE_LANE_LIMIT`, default 2 — so two Code tasks may be in flight
together, and neither blocks nor is blocked by a chat turn. The reasoning is that
a Code task is minutes of agentic editing rather than seconds of streaming, so
making an unrelated refactor wait out the current one is the actual defect.

When the lane is full the behaviour follows `concurrency_mode` exactly as the
global lock does: `reject` (default) returns **409 `busy`** as JSON before the
stream opens, with `details: { running, limit, queued }`; `queue` parks the
request FIFO and opens the stream when a slot frees.

Each Code task gets its own git worktree at `~/Hyperion/worktrees/<taskId>/`, on
a branch named `hyperion-task-<taskId>`. Two consequences worth knowing:

- **`resolvePath` and `executeCommand` are narrowed to that one directory**, not
  to `projects/` at large. A Code task cannot read or write another task's
  checkout, or the original project directory, even though all of them are inside
  the allowed roots. Escapes are `scope_violation`, as everywhere else.
- **Commits survive; scratch space does not.** When a task ends its worktree is
  removed, but only when removing it provably loses nothing. Uncommitted changes
  leave the directory in place, and a branch that is ahead of where the task
  started is kept, so the work is reachable in the user's own repository with
  plain `git log hyperion-task-<taskId>`. Set
  `HYPERION_CODE_KEEP_WORKTREES=1` to keep every worktree for debugging.

### 12.2 `GET /api/code/tasks`  *(new in 1.9)*

The live view of the lane. Finished tasks disappear — this is not a journal.

```json
{
  "running": 1,
  "limit": 2,
  "queued": 0,
  "active": [
    {
      "id": "b3f1…",
      "taskId": "refactor-auth",
      "label": "chat-42:refactor-auth",
      "startedAt": 1767225600000,
      "worktree": "/home/u/Hyperion/worktrees/refactor-auth"
    }
  ]
}
```

`id` is the lane slot; `taskId` is what the caller named the run. Both `taskId`
and `worktree` are `null` for a slot taken without a task id, and `worktree` is
also `null` once the directory has been released.

### 12.3 Project context listings  *(new in 1.13)*

| Method | Path |
| --- | --- |
| GET | `/api/code/rules?project=<dir>` |
| GET | `/api/code/agents?project=<dir>` |
| GET | `/api/code/commands?project=<dir>` |

Read-only listings of what a project declares in `.hyperion/`. Unlike the rest of
section 12 these need no registered agent — they are lock-free, they never run
anything, and they exist for the **frontend's** discoverability needs (an "N rules
active" indicator, an agent picker, a command palette). The agent's own loading
logic reads these files directly through its filesystem access and does not call
these routes, which is why none of them return a file body.

`project` is optional and defaults to `.`. It is resolved inside the `projects`
scope, so a traversal such as `?project=../../etc` is **403 `scope_violation`**,
not a read.

A missing directory is an *answer*, not a failure: it lists as `200` with an empty
array. Only `.md` files are listed, sorted by filename so the order is stable
across calls.

Each entry's `name` is the front-matter `name`, else the first Markdown heading,
else the filename with separators turned into spaces — a file that declares
nothing still has to be recognisable in a dropdown. `description` is the
front-matter `description` or the first paragraph, clamped to 200 characters, and
is `null` when the file gives neither.

```json
// GET /api/code/rules
{
  "source": "hyperion",
  "count": 1,
  "rules": [
    {
      "name": "No console.log",
      "description": "Use a real logger instead of console.",
      "scope": "*.ts",
      "path": ".hyperion/rules/no-console.md"
    }
  ]
}
```

**Rules follow a fallback chain**, because a project that predates this convention
already carries its instructions somewhere:

    .hyperion/rules/  →  CLAUDE.md  →  .claude/rules/

The first location that **exists** wins, and `source` reports which one it was —
`hyperion`, `claude-md`, `claude-dir`, or `none` when no location exists at all.
The UI needs that distinction: rules arriving through the fallback path are still
active, and showing an empty list there would tell the user the opposite of the
truth. A directory that exists but holds no Markdown still reports its own
`source` with `count: 0`, since "your rules directory is empty" and "you have no
rules" are different things to say.

Only `ENOENT`/`ENOTDIR` counts as "absent". A directory that exists but cannot be
read is a real problem, so it surfaces as an error rather than silently falling
through to the next location and misreporting where the rules came from.

`scope` carries a `scope:`/`applies_to:` glob when the rule declares one, else
`null`. Agents additionally carry `tools` (`tools: [read, bash]`, or a lone
`tool: bash`, normalised to an array) and `model`, both `null` when undeclared.
Commands carry only `name`, `description` and `path`.

### 12.4 Task state endpoints  *(new in 1.15)*

Code, Cowork and Design tasks persist their run state so a dropped SSE stream is
recoverable. A phone locking its screen or a laptop sleeping drops the
connection; the state endpoint tells a reconnecting client whether to wait,
retry, or show a result.

```ts
TaskRun {
  runId: string; taskId: string; tool: 'code'|'cowork'|'design';
  chatId: string|null;
  state: 'running'|'paused'|'complete'|'error';
  pauseReason: string|null; errorCode: string|null; errorMessage: string|null;
  startedAt: number; updatedAt: number; completedAt: number|null;
}
```

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/code/tasks/:taskId/state` | `{ run: TaskRun }` |
| GET | `/api/cowork/tasks/:taskId/state` | `{ run: TaskRun }` |
| GET | `/api/design/tasks/:taskId/state` | `{ run: TaskRun }` |

Returns the **most recent** run for the task id — a retry reuses the same id,
and the latest attempt is what a reconnecting client needs. A task that has
never run is **404 `not_found`** with `details: { taskId }`; `run` is never
`null`.

The three tools keep separate namespaces, so the same `taskId` under `code` and
under `cowork` are different runs and do not collide.

`completedAt` is stamped only for terminal states (`complete`, `error`); it is
`null` for `running` and `paused`, so a resumed run does not carry a completion
time it has not reached.

---

## 13. Error Log — `/api/errors`  *(new in 1.15)*

Read-only access to structured error records for the debug console. Entries are
written by the error middleware (every 500) and the process-level handlers
(uncaught exceptions, unhandled rejections) — nothing here creates or deletes
them.

```ts
ErrorLogEntry {
  id: number; timestamp: number; severity: 'warning'|'error';
  endpoint: string|null; method: string|null; status: number|null;
  error_code: string|null; error_message: string;
  stack_trace: string|null; request_context: string|null;
  created_at: number;
}
```

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/errors` | `{ entries: ErrorLogEntry[], total: number }` |

Query parameters: `limit` (default 100), `severity` (`warning` \| `error`),
`since` (epoch milliseconds). All three narrow the result. `total` counts every
row matching the same filters ignoring `limit`, so a console can say "showing
100 of 4213" without a second request.

`request_context` is a sanitized JSON string: auth headers are stripped, and
body content is recorded as **keys only, never values**, so a pasted secret in a
request body cannot appear in the log. The full shape — including the private
details — is server-side only and never crosses the HTTP boundary.

---

## 14. Resources — `/api/resources`

A read-only probe surface. Nothing here registers, installs, or modifies state.

```ts
DetectResult {
  type: 'skill' | 'mcp-server' | 'both' | 'invalid';
  confidence: 'strong' | 'weak' | null;   // null only when type is 'invalid'
  reason: string;                          // human-readable explanation
  skillPreview?: { name: string|null, description: string|null };
  mcpPreview?:   { suggestedName: string|null, type: 'local'|'remote' };
}
```

| Method | Path | Response |
| --- | --- | --- |
| POST | `/api/resources/detect` | `DetectResult` (bare) |

**POST /api/resources/detect** body: `url` (req, string).

Always **200** when the URL is syntactically valid, even when the answer is
`invalid`. An unreachable host, a 404, an oversized response, or a repository
with nothing recognisable all come back as `{ type: 'invalid', confidence: null,
reason: "…" }` — the reason is for the UI to display, not for the client to
branch on. Only a malformed or non-http(s) URL is a **400 `bad_request`**, because
that is the one case the user can fix by retyping.

`confidence` signals how certain the classification is:

| confidence | meaning |
| --- | --- |
| `strong` | fixed manifest check (SKILL.md present) or declared SDK dependency |
| `weak` | naming or prose hint only — no dependency found |
| `null` | `type` is `invalid`; no classification was possible |

`skillPreview` is present when `type` is `skill` or `both`.
`mcpPreview` is present when `type` is `mcp-server` or `both`.
`mcpPreview.type` is `remote` when the README documents a hosted endpoint (a
URL ending in `/sse` or `/mcp`, documentation hosts ignored), and `local`
otherwise — a clonable repository is normally something you run yourself.


Detection never installs anything. The user's next step is either
`POST /api/skills/fetch` (to stage the skill for review) or
`POST /api/mcp/servers` (to add the MCP server).

---

## 15. Projects — `/api/projects`  *(new in 1.16)*

The registry of directories Hyperion may work in, and which one is open. The
active project is what `projects`-scoped filesystem containment resolves against,
so opening one moves the boundary for Code tasks, worktree provisioning,
`.hyperion/rules|agents|commands/` discovery and the default filesystem MCP
server. The choice is stored in `settings` under `active_project_id` and is
restored on boot.

A project is either **managed** (Hyperion created the directory under
`~/Hyperion/projects/`) or **external** (an existing checkout the user pointed
at). `managed` is reported on every project object.

### `GET /api/projects`

```json
{
  "projects": [
    {
      "id": "8f3c…",
      "name": "Hyperion",
      "path": "C:\\Users\\DELL\\Documents\\Hyperion",
      "managed": false,
      "createdAt": 1765000000000,
      "lastOpenedAt": 1765100000000
    }
  ],
  "activeId": "8f3c…",
  "activeRoot": "C:\\Users\\DELL\\Documents\\Hyperion",
  "defaultRoot": "C:\\Users\\DELL\\Hyperion\\projects"
}
```

Most recently opened first; never-opened projects sort last. `activeId` comes
from the registry and `activeRoot` from the containment layer, so the two
disagreeing is visible rather than hidden. `activeId` is `null` and `activeRoot`
is `defaultRoot` when no project is open.

### `POST /api/projects`

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | User-facing label. Also the directory name for a managed project. |
| `path` | no | An **existing absolute** directory to adopt. Omit for a managed project. |

`201` with `{ "project": { … } }`. Creating a project does **not** open it — that
is a separate call, so adding a project cannot move the scope out from under a
run in progress.

Errors:

| Code | Status | When |
| --- | --- | --- |
| `bad_request` | 400 | `name` missing or blank; `path` relative, containing a NUL byte, non-existent, a file, or overlapping `~/Hyperion` |
| `conflict` | 409 | that directory is already registered (`details.projectId` names the existing one) |

`path` is only accepted if it already exists: creating an arbitrary directory
anywhere on disk from a request body is a much broader permission than adopting
one the user already made. The `~/Hyperion` overlap check runs in both
directions — a project inside the data directory would put the database and
stored credentials in project scope, and a project *containing* it (`C:\`, a home
directory) does the same thing transitively.

### `GET /api/projects/:id`

`{ "project": { … } }`, or `404 not_found` with `details.projectId`.

### `PATCH /api/projects/:id`

`{ "name": "New label" }` → `{ "project": { … } }`. The name only. A project's
path is its identity here: every artifact, worktree and task run recorded against
it assumes the directory did not move. Pointing at a different directory is a new
project.

### `POST /api/projects/:id/open`

Marks the project active, stamps `lastOpenedAt`, repoints filesystem containment,
drops per-task worktree assignments, and re-scopes the default filesystem MCP
server.

```json
{ "project": { … }, "activeRoot": "C:\\…\\project" }
```

`404 not_found` for an unknown id, and a failed open never moves the scope.
Switching is a clean boundary, not a union: the previous project's paths are
refused immediately afterwards.

### `DELETE /api/projects/:id`

```json
{ "deleted": true, "path": "C:\\…\\project", "filesRemoved": false, "activeRoot": "…" }
```

**Registry only. The directory and its contents are never deleted**, for managed
and external projects alike — "remove from my list" must not be the same gesture
as "destroy my code". `filesRemoved: false` states this in the response rather
than leaving the caller to assume. Deleting the active project deselects it and
returns `activeRoot` to `defaultRoot`.

---

## 16. Activity feed — `/api/activity`  *(new in 1.17)*

What the app has been doing, in chronological order and in sentences. **This is
not the debug console** — §13 already serves raw error records. The feed is for
the ordinary case where the user has been away and wants to catch up, so every
entry is prose with a status and a link, and nothing here carries a stack trace
or an internal error code.

```ts
ActivityEntry {
  id: string;                       // namespaced: `task:<runId>` or `scheduled:<id>`
  kind: 'task' | 'scheduled-task';
  timestamp: number;                // when the run started
  status: 'running' | 'paused' | 'success' | 'failed' | 'skipped';
  title: string;                    // a whole sentence, ready to render
  detail: string | null;            // the reason, when there is one worth reading
  link:
    | { kind: 'chat'; chatId: string }
    | { kind: 'artifact'; key: string; version: number }
    | null;
}
```

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/activity` | `{ entries: ActivityEntry[], nextBefore: number \| null }` |

Query parameters: `limit` (default 50, 1–200) and `before` (a timestamp cursor,
exclusive). Both are validated, so `limit=0`, `limit=201`, `limit=1.5`,
`limit=lots` and `before=-1` are all **400 `bad_request`** with the offending
field in `details.field`.

```json
{
  "entries": [
    {
      "id": "scheduled:sch_9f2a",
      "kind": "scheduled-task",
      "timestamp": 1786170000000,
      "status": "success",
      "title": "Scheduled task \"Morning briefing\" finished",
      "detail": "Wrote up 6 stories.",
      "link": { "kind": "artifact", "key": "briefing.md", "version": 3 }
    },
    {
      "id": "task:run-4f1c",
      "kind": "task",
      "timestamp": 1786169000000,
      "status": "paused",
      "title": "Cowork task paused",
      "detail": "waiting for your approval",
      "link": { "kind": "chat", "chatId": "chat_18ba" }
    }
  ],
  "nextBefore": 1786169000000
}
```

**Two sources, merged:** `task_runs` (interactive Code, Cowork and Design runs,
§12.4) and `scheduled_task_runs` (runs that fired on a timer). Their stored
status vocabularies differ and are mapped onto the one set above, so the UI
branches once rather than per source. `paused` only ever comes from an
interactive run and `skipped` only from a scheduled one.

`skipped` is a real entry, not an absence: a task that came due while the app was
busy and gave up waiting has to be distinguishable from the scheduler never
having fired.

**Pagination.** Feed `nextBefore` back as `before` for the next page. `null`
means the last page, which is how a client knows to stop without a count query.
`before` is exclusive, so a page never repeats the entry it ended on.

Ordering is by start time, never by "last updated". A start time cannot change
after the row is written, and a cursor is only sound over a key that holds still —
ordering by an updated time would let a long-running task jump forward past a
cursor a client is holding and take rows with it, which reads as entries silently
vanishing.

**Subagent delegation is deliberately absent.** The feature described three
sources, but nothing in the backend records a delegation event today — no table
and no writer. Inventing entries from something adjacent would misreport history.
When a producer exists it joins the merge with no change to this response shape.

---

## 17. Cowork storage — `/api/cowork`  *(new in 1.8)*

Cowork's own CRUD: the standing reference library and the scheduled-task
registry. These are **separate from `/api/cowork/run-task`** (§12) and need no
registered agent module — a user can file documents and set up a nightly task on
a backend where no agent loop has ever attached.

### 17.1 Knowledge sources

```ts
KnowledgePublic { id, label: string|null, filename, relPath,
                  mimeType: string|null, bytes, sha256: string|null,
                  createdAt, missing: boolean, url: string }
```

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/cowork/knowledge` | `{ count, sources: KnowledgePublic[] }` |
| POST | `/api/cowork/knowledge` | **201** `{ source }` |
| GET | `/api/cowork/knowledge/:id` | `{ source }` |
| GET | `/api/cowork/knowledge/:id/file` | the file bytes |
| DELETE | `/api/cowork/knowledge/:id` | `{ deleted: true, id, bytesFreed }` |

**POST** is `multipart/form-data`, field name **`file`**, exactly one file, plus
an optional `label` text field. A request with no file is **400 `bad_request`**
with `details: { field: 'file' }`. `label` is the user's own handle for the
document and is deliberately separate from `filename`: `Q3-final-FINAL-v2.pdf`
is what they uploaded, "Q3 board pack" is what they will search for later.

**Knowledge sources never expire.** This is the decisive difference from gallery
assets (§8), and the exemption is structural rather than a flag: the table has no
`last_accessed_at` and no `pinned` column, the bytes live under their own
`knowledge` filesystem scope rather than inside `attachments/`, and the cleanup
sweep never names the table. There is no query that could reap these rows even if
one were written carelessly. An explicit DELETE is the only way one goes away.

Unlike attachments, **nothing is downscaled or re-encoded on the way in**. An
attachment exists so a vision model can see it; a knowledge source is a document
of record, so `bytes` and `sha256` always describe the file exactly as uploaded.

Reading a document records nothing — there is no access timestamp to update,
because nothing ever expires one. `missing: true` means the row outlived its
file, and `GET /:id/file` for such a row is **404 `not_found`** about the file
rather than a 500. `bytesFreed` may legitimately be `0` when the file was already
gone; the delete still reports `deleted: true`, because the row existed and now
does not.

### 17.2 Scheduled tasks

```ts
ScheduledTask { id, name, prompt, schedule, modelId,
                chatId: string|null, cwd: string|null, enabled: boolean,
                lastRunAt: number|null,
                lastStatus: 'running'|'success'|'failed'|'skipped'|null,
                createdAt, updatedAt, nextRunAt: number }
TaskRun       { id, taskId, startedAt, finishedAt: number|null,
                status: 'running'|'success'|'failed'|'skipped',
                artifact: { key, version }|null, summary: string|null,
                error: { code, message }|null }
```

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/cowork/scheduled-tasks` | `{ count, tasks: ScheduledTask[] }` |
| POST | `/api/cowork/scheduled-tasks` | **201** `{ task }` |
| GET | `/api/cowork/scheduled-tasks/:id` | `{ task }` |
| PUT / PATCH | `/api/cowork/scheduled-tasks/:id` | `{ task }` (same handler) |
| DELETE | `/api/cowork/scheduled-tasks/:id` | `{ deleted: true, id }` |
| GET | `/api/cowork/scheduled-tasks/:id/history` | `{ taskId, count, runs: TaskRun[] }` |
| POST | `/api/cowork/scheduled-tasks/:id/run` | **202** `{ started: true, id }` |

**Create** body: `name`, `prompt`, `schedule`, `modelId` (all required),
`chatId?` / `cwd?` (nullable), `enabled?`. Update takes the same fields, all
optional, and an omitted one is left alone — so the enable/disable toggle is a
one-key PATCH rather than a read, merge and write. `/history` takes `limit`
(default 50).

**`schedule` has exactly two forms**: `daily:HH:MM` and `weekly:D:HH:MM` (`D` is
0–6, Sunday = 0). Anything else — including a bare `daily`, or a cron expression
— is **400 `bad_request`** naming the `schedule` field. v1 has no cron.

`nextRunAt` is computed on read from the schedule, so a client never has to parse
the format to show "next run in 3 hours".

**`POST /:id/run` fires the task immediately, out of schedule**, and returns
**202** rather than a result. It is the same `runScheduledTask` the timer calls,
so "test my task now" exercises the real path instead of a preview of it. That
function never throws — a failure is recorded on the run row — so the outcome is
read from `/history`, not from this response. It also takes the app-wide job lock
in queue mode, meaning a run-now can legitimately sit and wait behind whatever is
already running rather than being refused.

`skipped` is a real run status: a task that came due while the app was busy and
gave up waiting (`HYPERION_SCHEDULED_TASK_WAIT_MS`, default 15 minutes) records
itself skipped, so "did not run" stays distinguishable from "never fired". Those
rows are what §16's feed merges as `kind: 'scheduled-task'`.

The scheduler, including the automatic daily backup, is disabled by
`HYPERION_SCHEDULER_DISABLED=1` — which is what the test helper sets, so a suite
that boots the app never fires real Cowork runs against live providers.

---

## 18. Push notifications — `/api/push`  *(new in 1.14)*

Standard Web Push: the browser mints the subscription, the server holds a VAPID
keypair and posts to the endpoint the browser gave it. No native app, no bespoke
transport, no custom crypto.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/push/status` | `{ enabled, available, publicKey, subscriptions }` |
| GET | `/api/push/key` | `{ publicKey: string \| null }` |
| POST | `/api/push/subscribe` | **201** `{ subscribed: true, ...status }` |
| POST | `/api/push/unsubscribe` | `{ removed: boolean, ...status }` |
| POST | `/api/push/test` | `{ sent, removed, skipped? }` |

**`enabled` and `available` are separate answers on purpose.** `enabled` is the
user's switch; `available` is whether this build can send at all — the `web-push`
dependency is optional and may be absent. "You turned this off" and "this build
cannot send" need different messages in the UI.

**The on/off switch is not here.** It is the `push_enabled` key on
`/api/settings` (§11), so the settings screen keeps one write path. This router
owns only the subscription list and the status view.

The router exists at all because a push subscription is an **object**, and the
generic settings routes deliberately reject objects (§11) so a malformed write
cannot land as `"[object Object]"`. The subscription is validated field by field
before it is stored — a half-formed one otherwise fails much later, at send time,
in a background job nobody is watching.

**POST /subscribe** accepts the subscription either wrapped as
`{ subscription: {...} }` or as the bare object, and requires
`{ endpoint, keys: { p256dh, auth } }`; anything else is **400 `bad_request`**.
Re-subscribing with the same `endpoint` **replaces** the existing entry rather
than adding a duplicate, so a browser that rotates its subscription does not
produce two notifications per event.

**POST /unsubscribe** body: `endpoint` (req). `removed: false` means it was not
on the list — which is the desired end state either way, so this is a **200, not
a 404**.

`publicKey` is minted lazily on first request and is only surfaced by `/status`
once push is enabled, so merely opening the settings screen does not mint a
keypair the user never asked for. The private half is stored encrypted.

**POST /test** sends a real notification, so the user can confirm the permission
prompt and the service worker are wired up before trusting the feature with a 3am
job result. It never fails as an error: when push is off, unavailable, or has no
subscriptions, it returns `skipped` with that reason —
`disabled` | `unavailable` | `no-subscriptions`. Endpoints the push service
reports as permanently gone are dropped and counted in `removed`.

The payload delivered to the service worker is
`{ reason: 'scheduled-task' | 'attention-needed', title, body, url?, tag?, sentAt }`.
`tag` collapses repeat notifications about the same thing in the OS tray.

---

## 19. Per-item export  *(new in 1.18)*

Three download endpoints. Each returns a **file body, not a JSON envelope** — a
`Content-Type` describing the file and
`Content-Disposition: attachment; filename="..."`. Errors still use the standard
envelope, so a client must check the status before treating the body as a file.

Filenames are derived from stored data (a chat title, an artifact's `rel_path`),
so both the stem *and* the extension are reduced to `[A-Za-z0-9._-]` and capped
at 80 characters. That is not only for the filesystem: the name is interpolated
into a header, and a stored path containing a quote or a newline would otherwise
break the header apart.

### GET /api/chat/:id/export

Query: `format` — `markdown` (default) or `json`. Anything else is a `400`
`bad_request` with `details.field = "format"`.

- `markdown` → `text/markdown; charset=utf-8`, `<title>.md`. A title heading, a
  `*<tool> · exported from Hyperion*` line, `---`, then `## User` / `## Assistant`
  turns. Messages with empty content are **omitted**: a cancelled or failed
  stream leaves a row with no text, and a heading followed by nothing reads as a
  broken export rather than as a fact about the chat.
- `json` → `application/json; charset=utf-8`, `<title>.json`, shaped
  `{ chat: { id, title, tool, modelId, createdAt, updatedAt }, messages: [{ id, role, content, modelId, providerName, tokensIn, tokensOut, createdAt }] }`.

Unknown id → `404` `not_found`.

**The path is `/api/chat`, singular.** The prompt text for this feature says
`/api/chats/:id/export`, but the router has been mounted at `/api/chat` since
`001`, and every existing chat endpoint (section 4) lives under it. Adding a
plural sibling for one endpoint would leave the API with two spellings of the
same resource, so the mount won.

### GET /api/artifacts/:id/export

One artifact version, in whatever format wrote it. `application/octet-stream` —
deliberately generic, because the real type is whatever the producing tool used
and claiming a specific one we have not verified would mislead the browser.
Filename is `<artifact-key-or-basename>-v<version><ext>`, the extension taken
from the stored `rel_path`.

`content` is nullable in the schema: small artifacts are stored inline, large
ones by file reference. A file-backed version is read from disk through the
`projects` scope check, so:

- backing file missing → `404` `not_found` naming the artifact and its `relPath`.
  The resolved absolute path is `privateDetails` and never reaches the client.
- stored path now outside the scope → `403` `scope_violation`. The check is made
  at read time rather than trusted from write time, because the row outlives the
  working tree and the projects root can be repointed under it.

Unknown id → `404` `not_found`.

### GET /api/code/tasks/:taskId/export

The task's changes as a unified patch: `text/x-patch; charset=utf-8`,
`<taskId>.patch`. The diff is taken against the commit the worktree started
from, so it covers committed **and** uncommitted work — which is what "the
changes this task made" means to the person asking.

- No such active task → `404` `not_found`. Worktrees are an in-process registry,
  so a task from a previous run of the server is genuinely gone.
- The task ran in `direct` mode, or has no base commit → `400` `bad_request` with
  `details.mode` and `details.reason`. git was missing or the target was not a
  repository; there is no diff to produce, and an empty patch would read as
  "this task changed nothing".

---

## 20. Settings depth  *(new in 1.20 / 1.19)*

Five typed sub-resources under `/api/settings`, all reading and writing the same
`settings` table as §11. They exist because each one has a shape the untyped
key/value routes cannot validate: an object of booleans, a closed enum, a
positive integer. **Every write here is a `PUT`** — the only `PATCH` on this
router is the bulk one in §11.

Route order matters and is fixed in the router: every literal path below is
declared **above** `PUT /:key`, or the generic handler would swallow it and store
`preferences` as an untyped string.

### 20.1 Response preferences — `GET|PUT /api/settings/preferences`

Free text the user writes once ("be brief", "always show your reasoning"), stored
under `response_preferences`.

```json
{ "preferences": "Answer in British English. No preamble." }
```

`PUT` requires the `preferences` key; omitting it is **400 `bad_request`** with
`details.field = "preferences"`. **A blank or whitespace-only value clears the
setting** rather than being rejected — the textarea the user typed into is the
only control they have, so emptying it has to be the way to unset it.

Two consequences worth knowing before branching on this:

- **Unset reads back as `""`, not `null`.** `responsePreferences()` returns an
  empty string when nothing is stored so callers can concatenate without a
  guard, and the route echoes what the getter returns.
- **Cleared means no row at all**, not a row holding `""`. If you need to know
  whether the user has ever configured preferences, that is the distinction —
  `GET /api/settings` will not list the key.

These preferences are stored and returned; **nothing in the backend injects them
into a prompt today**. Assembling them into a system prompt is the caller's job,
exactly as with `GET /api/skills/summary` (§7).

### 20.2 Capability toggles — `GET|PUT /api/settings/capabilities`

```json
{
  "capabilities": { "code_execution": true, "network_egress": false },
  "effective":    { "code_execution": true, "network_egress": false }
}
```

`PUT` adds `updated: string[]`, naming only the capabilities the request actually
changed. `GET` returns the two maps alone.

**`capabilities` is the stored switch; `effective` is what the backend acts on.**
They differ wherever one capability depends on another — `network_egress` is only
effective when `code_execution` is also on (§20.4) — so a UI can show a toggle as
on-but-inert instead of silently lying about it.

Validation is **all-or-nothing**: every entry is checked before any is written,
because a half-applied set is worse than a rejected one, the user having no way
to see which half landed.

| Body | Response |
| --- | --- |
| not an object, or an array | **400**, `details.field = "capabilities"` |
| `{}` | **400** `No capabilities provided.`, same field |
| unknown capability name | **400**, `details.field = "capabilities.<name>"` |
| a non-boolean value | **400**, `details.field = "capabilities.<name>"` |

An unknown name is rejected rather than ignored: skipping it would return `200`
for a request that changed nothing, and a typo would be indistinguishable from a
toggle that did not stick.

### 20.3 Tool access mode — `GET|PUT /api/settings/tool-access-mode`

```json
{ "mode": "load_when_needed" }
```

`always_loaded` | `load_when_needed`. A missing or unrecognised `mode` is
**400 `bad_request`** with `details.field = "mode"`.

**This is advisory.** Nothing in the backend enforces it — it is a preference an
agent loop reads when deciding whether to put every tool definition in the
context window up front. It is recorded here so the setting has one home rather
than living in each agent's own configuration.

### 20.4 Network egress — `GET|PUT /api/settings/network-egress`

`network_egress` under a name matching how the setting is actually discussed.

```json
// GET
{ "enabled": false, "effective": false,
  "requiresCodeExecution": true, "enforced": "command_prefix_match" }

// PUT  { "enabled": true }
{ "enabled": true, "effective": false }
```

The two extra fields are **on the GET only** — they are constants describing the
feature, and repeating them in the write response would imply the write could
change them.

`effective` stays `false` while `code_execution` is off, because a network call
is made *by* a command: with no command execution there is nothing for the
setting to permit. `requiresCodeExecution` states that dependency so a UI does
not have to encode it.

**`enforced: "command_prefix_match"` is a deliberately honest label.** The check
inspects the beginning of a command string for known network tools; it is not a
sandbox, a firewall rule or a namespace. A determined command can defeat it, and
the field is named so nobody builds a security claim on top of it. Refusals use
`network_egress_disabled` (403).

### 20.5 Spending cap and ceilings — `GET|PUT /api/settings/limits`

```json
{
  "ceilings": { "tokenCeiling": 200000, "iterationCeiling": 50, "subagentLimit": 5 },
  "spend": {
    "capUsd": 10,
    "spentUsd": 3.4172,
    "remainingUsd": 6.5828,
    "capReached": false,
    "unpricedRequestsToday": 2,
    "windowResetsAt": 1786204800000
  }
}
```

`PUT` responds with the same two objects plus `updated: string[]`. The GET reads
both from one snapshot, so the cap and the progress toward it can never
disagree.

Body fields, all optional — only what is present is written:

| Field | Rule |
| --- | --- |
| `dailySpendCapUsd` | **`0` clears the cap.** Negative → 400. |
| `tokenCeiling` | positive whole number; `0`, negative and fractional all → 400 |
| `iterationCeiling` | same |
| `subagentLimit` | same |

A body that sets **nothing** is **400 `No limits provided.`** — note this one
carries **no `details.field`**, since no single field is at fault.

`0` clearing the cap rather than storing zero is the one asymmetry: stored, zero
would mean "refuse all autonomous work", which nobody types on purpose, and the
reader already treats a missing row as no cap. Writing it would leave a value
that displays as a cap and behaves as none. The three ceilings reject `0` for the
opposite reason — there is no sensible reading of "this task may run zero
iterations".

**`spend` is honest about what it cannot see.** `capUsd` and `remainingUsd` are
`null` when no cap is configured, and `unpricedRequestsToday` counts requests
whose model has no price row. Those are real spend the cap cannot measure, so the
number is surfaced rather than folded into a total that would look complete.

**The cap gates autonomous work only.** A scheduled task or a subagent spawn
refused by it returns **429 `spending_cap_reached`** with `label`, `capUsd`,
`spentUsd`, `windowResetsAt` and `unpricedRequestsToday` in `details`.
**Work the user starts themselves is never blocked** — see the matching entry in
`docs/CONTRACTS.md` for why that exemption is structural rather than a branch.
A scheduled run refused this way records itself `skipped`, not `failed` (§17.2).

Ceilings are enforced *during* a run rather than at its start. A task that trips
one stops cleanly and is recorded `stopped` with `pause_reason:
'ceiling_reached'` — **not `error`**, because nothing broke.

---

## 21. Temporary chats and bulk delete  *(new in 1.20)*

### 21.1 Opening a temporary chat

`POST /api/chat` with `temporary: true` opens an incognito session instead of
inserting a row.

```json
{ "chat": { "…": "ChatRecord" }, "temporary": true }
```

**201, and the shape is identical to an ordinary create apart from the flag** —
so a client renders both the same way, and the flag is what lets it show that
nothing is being saved. An ordinary create now also echoes `temporary: false`
rather than omitting the key, so the field is always present to branch on.

The chat lives in an in-memory registry and **never reaches SQLite**: not written
and deleted, not written with a flag — never inserted. It ends when it is
deleted, when its idle timer expires, or when the process exits, and it is not
listed by `GET /api/chat`.

Several operations are refused for one, each naming `details.field = "id"`:

| Operation | Result |
| --- | --- |
| pin | **400** — it is never saved, so there is nothing to exempt from cleanup |
| archive | **400** — same reason |
| create with an id that is already open | **409 `conflict`** |
| create a *persisted* chat under a temporary id | **409 `conflict`** |

**Usage is still recorded, anonymously.** A temporary turn writes a real
`usage_log` row with real tokens and cost, but `chat_id` and `message_id` NULL,
so it counts toward the daily spend cap (§20.5) while the private chat's id never
reaches disk. This is load-bearing: an earlier version wrote the id, the foreign
key rejected the row, `recordUsage` swallowed the error, and incognito tokens
were free as far as the cap could tell.

### 21.2 `DELETE /api/chat/:id`

Now `{ "deleted": true, "id": "…", "temporary": false }`.

One route ends both kinds, because it is one user gesture and a temporary session
is already at least as gone as a deleted row. `temporary` is read **before** the
delete — afterwards there is nothing left to ask — and reported so the UI can
word the confirmation correctly.

### 21.3 `POST /api/chat/bulk-delete`

```json
// → { "deleted": ["a", "b"], "missing": ["c"] }
{ "ids": ["a", "b", "c"] }
```

`ids` must be a non-empty array of strings; missing or empty is **400
`bad_request`** with `details.field = "ids"`. Declared above `/:id` so
`bulk-delete` is never read as a chat id.

**`missing` is reported, not treated as an error.** The end state the caller
asked for has been reached either way, and a 404 for the whole batch would undo
39 successful deletions because of one row someone else had already removed.

For the same reason the operation is **deliberately not transactional**: each id
is deleted independently, so one failure cannot roll back the rest. This is a
considered exception to wrapping multi-row writes in a transaction — the entry in
`docs/CONTRACTS.md` records why, so it is not "fixed" later.

---

## 22. Bulk export — `POST /api/export/bulk`  *(new in 1.18)*

A zip of many items, where §19 exports one. Responds with **the archive itself**,
not a JSON envelope pointing at one.

```json
{ "contentType": "all", "timeframe": { "from": 1767225600000, "to": 1769904000000 } }
```

| Field | Rule |
| --- | --- |
| `contentType` | `chats` \| `artifacts` \| `all` — defaults to `all`; anything else → 400 `details.field = "contentType"` |
| `timeframe` | optional object; **each end is optional too** |
| `timeframe.from` / `.to` | epoch ms; non-numeric → 400 naming `timeframe.from` / `timeframe.to` |

A non-object `timeframe` is **400** with `details.field = "timeframe"`. An
open-ended range is legitimate — "everything before I started paying attention" —
so supplying only one end is fine, and supplying neither is the same as omitting
the object.

**POST, though nothing is created.** The selection is a body with a nested
timeframe; encoding that into a query string would make the endpoint most likely
to be bookmarked the hardest one to read.

Response: `application/zip` as `hyperion-export-<stamp>.zip`, with the standard
download headers plus

```
X-Export-Summary: {"counts":{"chats":12,"artifacts":3},"skipped":1}
```

A header rather than a body field, because the body is the file. The same counts
and the full skip list are also written into `MANIFEST.json` inside the archive,
so the header is a convenience for a client that does not want to open the zip.

Inside: `chats/` markdown, `artifacts/` in their stored formats, and
`MANIFEST.json` carrying `generatedAt`, `contentType`, `timeframe`, `counts`, the
per-item lists, and `skipped`. Colliding filenames are made unique — two chats
called "Notes" both survive.

**An item that fails to export is skipped and named, never dropped silently**;
`skipped` entries carry `{ kind, id, reason }` and the key is present even when
empty, so its absence never has to be interpreted.

**An empty selection is a 200 containing a manifest, not a 404.** "Nothing
matched that timeframe" is an answer, and a zip stating so is more useful than an
error the user has to interpret. Temporary chats (§21) cannot appear in the
output, having never been stored.

---

## 23. Brand-approved design assets — `/api/design`  *(new in 1.22)*

Promoting a gallery asset to "this **is** the brand" — the file an agent should
reach for when it needs the real logo rather than generating something that
merely resembles it.

**Approval is a separate axis from `pinned` (§8).** A pin says "do not
auto-delete this"; approval says "this is canonical" — and it implies the cleanup
exemption without the user also having to pin. Two different questions, two
columns (migration `011`).

These live under `/api/design` rather than `/api/storage` because the decision
belongs to the design surface, not the disk-space panel. Durable notes about *why*
something was approved go through `/api/memory` (§5) — approval itself is a flag,
not a record with a rationale.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/design/assets/approved` | `{ assets, total }` — query `limit` (default 100) |
| POST | `/api/design/assets/:id/approve` | `{ asset }` |
| POST | `/api/design/assets/:id/unapprove` | `{ asset }` |

`GET /assets/approved` returns the whole approved set, newest decision first, as
a plain list — **not a paginated gallery view**. An agent asking "what is the
brand" wants all of it. `total` is the length of what was returned, so it equals
`assets.length` and is not a count of everything approved beyond `limit`. The
literal path is declared before the `:id` routes so a future `/assets/:id` GET
cannot shadow it.

`POST /:id/approve` takes an **optional** `approved` boolean: omit it and the flag
**toggles**, which is what a single gallery button wants. `POST /:id/unapprove`
always revokes, and exists separately so the frontend can revoke idempotently —
clicking "remove from brand" twice must not re-approve the asset.

Unknown id → **404 `not_found`** on all three write paths.

The public asset shape (§8) carries two fields for this:

```ts
brandApproved: boolean;
brandApprovedAt: number | null;   // null whenever brandApproved is false
```

`brandApprovedAt` is **cleared on revocation**, not left behind. The approved
list is ordered by it, so a stale timestamp on an unapproved asset would corrupt
that ordering the moment the asset were approved again.

`GET /api/storage/assets` accepts `brandApproved` as a filter (§8) — `true` for
only approved, `false` for only unapproved, omitted for both.

---

## 24. Where this differs from SPEC.md's suggested surface

The spec framed its endpoint list as "Suggested … adjust naming as you see fit,
but keep the shape" (`docs/SPEC.md` line 110). The shape is intact. Concrete
deltas:

1. **`POST /api/chat/stream` ignores client-supplied `messages`** beyond the
   newest user turn. The spec's `{tool, modelId, messages, attachments}` implied
   the client owns history; the server rebuilds it from SQLite instead, so a
   reload or a mid-stream pause can't corrupt the transcript.
2. **`paused` / `resumed` are SSE events on a 200 response**, as the spec asked,
   and the stream stays open so the same connection can carry the resume.
3. **Providers gained routes the spec didn't list**: full CRUD, `disable`,
   `detect-local`, `/:id/test`, `/active/current`, and per-provider model lists.
   `type` now includes `opencodex` and `colibri`, and Colibrì adds
   `/colibri/advisory` and `/colibri/probe` plus an acknowledgement flag on
   enable (§3.3).
4. **`/api/skills` intake is two-phase** (`upload`/`fetch` → preview →
   `confirm`) rather than a single POST, because the spec requires a parsed
   preview, a credential recommendation and a risk report *before* registration.
5. **`/api/mcp/servers` PUT and PATCH share one handler** and update by entry
   rather than delete-and-recreate. `/status` reports `managed: false` until
   Kimi's process manager registers.
6. **`/api/storage` adds `/stats`, `/cleanup` and `/cleanup/log`** so the sweep
   is inspectable and rehearsable instead of being an invisible cron.
7. **`/api/usage` adds a price table** (`/prices`, CRUD). Without it every cost
   is zero; with it, unpriced models stay NULL and are surfaced via `hasUnpriced`.
8. **`/api/backup` adds `GET /` and `POST /inspect`**, and import supports
   `dryRun`, because restoring overwrites the live database.
9. **`/api/settings` and `/api/memory` are new routers** — the first was implied
   by the `settings` table, the second is Prompt 1.5's Memory plugin.
10. **`/api/cowork` carries CRUD the spec never listed** — the knowledge library
    and the scheduled-task registry (§17). The spec framed `/api/cowork` as a
    single `run-task` seam, but both of these are user-owned records that outlive
    any single run, and they have to be manageable on a backend where no agent
    module has ever attached.
11. **`/api/push` is its own router** (§18) rather than settings keys, because a
    subscription is an object and the settings routes deliberately reject objects
    (§11). The on/off switch itself does stay in `/api/settings`, as
    `push_enabled`.
12. **No `/api/plugins` router.** Plugins are settings keys
    (`plugins.<name>.enabled`); Memory is the only one with a backend today.
13. **No authentication endpoint of any kind**, deliberately.
