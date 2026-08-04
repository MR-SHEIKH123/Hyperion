# Hyperion Backend — API Reference

Generated from the implementation, not from the spec. Every endpoint, field name
and status code below was read off the routers in `src/http/` and the service
types they serialize. Where the implementation diverges from the "Suggested
endpoint surface" in `docs/SPEC.md`, that is called out in the last section.

- Base URL: `http://127.0.0.1:8787` by default (`HYPERION_BIND`, `HYPERION_PORT`).
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

| code | HTTP | retryable |
| --- | --- | --- |
| `bad_request` | 400 | false |
| `scope_violation` | 403 | false |
| `not_found` | 404 | false |
| `conflict` | 409 | false |
| `busy` | 409 | **true** |
| `provider_unreachable` | 502 | **true** |
| `provider_timeout` | 504 | **true** |
| `provider_error` | 502 | **true** |
| `run_not_paused` | 409 | false |
| `capability_mismatch` | 409 | false |
| `no_healthy_provider` | 503 | false |
| `agent_not_registered` | 501 | false |
| `terminal_not_registered` | 501 | false |
| `encryption_failed` | 500 | false |
| `storage_error` | 500 | false |
| `internal_error` | 500 | false |

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
`HYPERION_OLLAMA_URL`. Retries up to 3 attempts before reporting not-detected;
it never starts a background rescan.

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
| GET | `/api/chat/:id/messages` | `{ messages }` — query `limit` (default 500) |
| POST | `/api/chat/:id/open` | `{ chat, messages, latestRun }` |
| POST | `/api/chat/:id/pin` | `{ chat }` |
| POST | `/api/chat/:id/archive` | `{ chat }` |
| POST | `/api/chat/:id/unarchive` | `{ chat }` |
| GET | `/api/chat/:id/runs` | `{ latest, paused }` |

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
SkillDeps   { status: 'none-declared'|'ready'|'partial'|'failed',
              runnable: boolean, installing: boolean, stale: boolean,
              ecosystems: ('python'|'node')[], manifests: string[],
              declared: string[], installed: string[],
              failed: { ecosystem, name, spec, error }[],
              rejected: { name, spec, reason }[],
              lifecycleScriptsSkipped: string[], error: string|null,
              pythonPath: string|null, nodeModulesPath: string|null,
              provisionedAt: number|null }
IntakePreview { stagingId, name: string|null, description: string|null,
              sourceType, sourceRef: string|null, hasSkillMd: boolean,
              manifestSource: 'frontmatter'|'markdown'|'none',
              needsCredential: boolean, credentialHint: string|null,
              files: string[], fileCount: number, risk: RiskReport,
              riskDisclaimer: string, nameConflict: boolean, warnings: string[],
              dependencies: { noneDeclared, ecosystems, manifests, declared,
                              rejected, lifecycleScriptsSkipped } }
SkillSummaryEntry { name: string, description: string,
              status: SkillDeps['status'], runnable: boolean }
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

---

## 8. Storage — `/api/storage`

```ts
AssetPublic { id, chatId, messageId, filename, relPath, mimeType, bytes,
              sha256, origin: 'uploaded'|'generated', tool, pinned,
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
`pinned`, `search` (filename substring), `limit`, `offset`.

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

---

## 13. Resources — `/api/resources`

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

## 14. Where this differs from SPEC.md's suggested surface

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
10. **No `/api/plugins` router.** Plugins are settings keys
    (`plugins.<name>.enabled`); Memory is the only one with a backend today.
11. **No authentication endpoint of any kind**, deliberately.
