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

This is every code in the module-private `STATUS` record in `src/util/errors.ts`,
transcribed by hand — the record is not exported, so this table has to be updated
when a code is added. (It said "the complete set" while missing three of the
twenty-eight until 2026-09-21, which is the sort of claim a table cannot make on
its own.) Two of the three have no throw site at all, and they are marked below
rather than omitted: they are codes in the vocabulary that reach a client as a
*refusal reason* or an attention item, not as an HTTP error, and a reader who sees
them in the type union deserves to be told that. Only four codes default to
`retryable: true` — `DEFAULT_RETRYABLE` in the same file — and every other code
is `false` unless a call site overrides it explicitly.

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
| `redaction_flagged` | 409 | false |
| `zdr_requirement_unmet` | 403 | false |
| `permission_denied` | 403 | false — no throw site: the engine's refusal reason for a call a rule denied, reported as a step on the run |
| `approval_required` | 409 | false — no throw site: the park reason for a call awaiting the user, delivered over SSE (`approval_required`) and as an attention item |
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
- **`limit` is a positive whole number no greater than the route's own maximum;
  `offset` is a whole number of zero or more.** Anything else is a 400 naming the
  field, and above the maximum the message names the bound (`"limit must be a
  positive integer no greater than 500."`). Refused rather than clamped: a caller
  handed 200 rows when it asked for 5000 is left to conclude the table only holds
  200. Every list route's bound is given with its route below. *(Tightened in the
  S17 fix — see `docs/CONTRACTS.md`; the two ways an unchecked limit used to fail
  were a 500, from `LIMIT 2.5` raising SQLite's "datatype mismatch", and a
  full-table read, because SQLite treats `LIMIT -1` as no limit at all.)*

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
      "detail": "1 of 1 MCP server(s) running.",
      "managed": true,
      "total": 1,
      "running": 1,
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
  type: 'remote' | 'local' | 'opencodex' | 'colibri' | 'puter';
  baseUrl: string;
  hasKey: boolean; apiKeyHint: string | null;
  enabled: boolean; priority: number;
  healthStatus: 'unknown' | 'healthy' | 'degraded' | 'unhealthy';
  lastError: string | null; lastErrorAt: number | null; lastSuccessAt: number | null;
  modelCount: number | null;          // null = never fetched
  modelsFetchedAt: number | null; modelsError: string | null;
  egressProxy: string | null;         // redacted: user:***@host:port at most
  cooldown: {                         // null when the provider is not cooling (1.36)
    until: number;                    // epoch ms it may be tried again
    failureClass: 'auth' | 'payment' | 'rate_limit' | 'not_found' | 'server' | 'network';
    source: 'table' | 'retry_after';
    reason: string;                   // "the credentials were rejected — waiting 60m"
  } | null;
  maxContextTokens: number | null;    // declared ceiling (1.28)
  zdr: ProviderZdr;                   // support / requestFlag / confirmedAt / confirmedNote
  createdAt: number; updatedAt: number;
}
```

`cooldown` is live process state rather than a column, and it is here rather than on
a route of its own because it answers a question asked on every screen that lists
providers: *why is this one being skipped?* The `reason` string is the same sentence
`cooldowns.ts` writes into provider-switch events, so the disclosure and the routing
decision cannot describe one cooldown two ways; `until` is a deadline rather than a
length, because a client rendering a length keeps rendering it after the wait is
over. A provider that is not cooling sends `null` — never an absent field — so a
client cannot mistake "no cooldown" for "we did not say".

`ModelInfo` (in the model-list routes): `{ id, label?, ownedBy?, contextLength? }`.

Three routes also spread a registry summary into the response:
`{ activeProviderId: string|null, activeProviderName: string|null, providerCount: number, hasAnyProvider: boolean }`.

### 3.2 Routes

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/providers` | `{ providers: ProviderPublic[], ...summary }` |
| POST | `/api/providers` | **201** `{ provider }` |
| POST | `/api/providers/detect-local` | `LocalDetectionResult` (bare) |
| GET | `/api/providers/puter/advisory` | `PuterAdvisory` (bare) *(1.38)* |
| GET | `/api/providers/colibri/advisory` | `ColibriAdvisory` (bare) |
| POST | `/api/providers/colibri/probe` | `ColibriProbeResult & { defaultBaseUrl }` |
| GET | `/api/providers/active/models` | `{ providerId, providerName, models }` |
| GET | `/api/providers/active/current` | `{ provider: ProviderPublic \| null }` |
| GET | `/api/providers/active` | `{ provider: ProviderPublic \| null, egress, egressProxy, redactionCheckEnabled }` *(1.23, `egressProxy` in 1.37)* |
| GET | `/api/providers/:id` | `{ provider }` |
| PATCH | `/api/providers/:id` | `{ provider }` |
| PUT | `/api/providers/:id/zdr` | `{ provider }` |
| DELETE | `/api/providers/:id` | **204**, no body |
| POST | `/api/providers/:id/enable` | `{ provider, ...summary }` |
| POST | `/api/providers/:id/disable` | `{ provider, ...summary }` |
| GET | `/api/providers/:id/models` | `{ providerId, models }` |
| POST | `/api/providers/:id/test` | `{ ok, message, modelCount?, code? }` |

**POST /api/providers** body: `name` (req), `type` (req, one of
`remote` / `local` / `opencodex` / `colibri` / `puter`), `baseUrl` (req), `apiKey?`,
`priority?`, `enabled?`, `egressProxy?`, `maxContextTokens?`. `enabled` is
body-only and defaults to false, so nothing — including local detection — can
auto-enable a provider the user didn't turn on.

**PATCH /api/providers/:id** body: `name?`, `baseUrl?`, `priority?`,
`apiKey?` (nullable — send `null` to remove a stored key), `egressProxy?`
(nullable the same way), `maxContextTokens?` (nullable the same way). `type` is
immutable.

**`maxContextTokens`** *(new in 1.28, wired 2026-09-21)* is the first rung of the
context ladder (§4.5): a **positive integer** — the ceiling every model of this
provider is judged against — or `null` for "declared nothing", which falls through
to whatever the model list reported and then to the conservative default. Zero and
fractions are `400`s naming the field, at the route *and* in the repository, because
local-detection and the scheduler create providers without passing through the
route. It is served back on every provider read (including `/api/providers/active`),
so a settings screen can show and edit it. Enabling the field does not invalidate
the model cache the way editing `baseUrl` does: it changes what this build does
with the endpoint's answers, not which endpoint gave them.

**`egressProxy`** *(new in 1.37)* is an `http` or `https` URL that every request
to this provider is tunnelled through. Only those two schemes are accepted: a
SOCKS URL is a different transport, and storing one this process cannot dial
would send traffic directly while the disclosure claimed otherwise — so it is a
`400` at the write, not a silent fallback at the send. Credentials in the URL are
allowed and are **never returned**: reads carry `user:***@host:port` at most, and
the audit column stores `host:port` alone. Changing or clearing the proxy
invalidates the model cache and the recorded health verdict, exactly as changing
the base URL does — the old evidence describes a different route.

**PUT /api/providers/:id/zdr** *(reference completed 2026-09-21)* records what is
known about this provider's zero-data-retention behaviour. It is its own subroute
rather than a nested field on `PATCH /:id` for two reasons: the generic patch is a
"leave undefined alone" partial update, while ZDR needs tri-state semantics of its
own on `requestFlag` plus a `confirmed` flag whose `false` clears two columns —
which a nested optional object cannot express without making "not sent" and "sent
as cleared" indistinguishable. And `confirmed: true` is a user *attestation*
rather than a settings edit, so it deserves a request that cannot be made by
accident while renaming a provider. The policy it feeds is `GET|PUT
/api/settings/zdr` (§20.7).

Body: `support` (required — `unknown` / `supported_default` / `supported_opt_in` /
`not_supported` / `not_applicable`), `requestFlag` (tri-state: absent leaves the
stored flag alone, `null` removes it, `{ location: 'header'|'body', key, value }`
replaces it), `confirmed?` and `note?`. Omitting `confirmed` preserves an existing
attestation, so recording a new support value does not silently discard one.
`requestFlag.value` must be a non-empty string — a flag with no value sends
nothing, and storing one would make the reported ZDR status claim a request that
was never made — and it is refused if `findSensitive()` flags it, because the value
is stored and returned in **plaintext** so the user can check a field they maintain
by hand. Response: `{ provider }`.

**Enable** applies the single-active rule: enabling one disables the previous
active provider (standby, not deleted). For `colibri` providers the body must
carry `acknowledgeSlow: true` — see §3.3.

**Model lists** accept `?refresh=true` to bypass the cache
(`HYPERION_MODEL_CACHE_TTL_MS`). With **nothing enabled**, `/active/models`
refuses with **409 `no_active_provider`** — and this line claimed a `503
`no_healthy_provider` until 2026-09-21, which a live probe of the running app
contradicted. The two codes are not interchangeable: `no_healthy_provider` means
"enabled, and nothing can serve — try later", while `no_active_provider` means
"nothing is switched on, and only you can change that". This route does not
consult health at all; the 503 belongs to the sending path.

**GET /api/providers/active** *(new in 1.23)* answers "where would my next
message go, and is it being checked?" in one call:

```json
{ "provider": { "…": "ProviderPublic" }, "egress": "remote",
  "egressProxy": { "redacted": "http://alice:***@proxy.example.test:3128",
                   "authority": "proxy.example.test:3128", "scheme": "http",
                   "hasCredentials": true, "offMachine": true },
  "redactionCheckEnabled": true }
```

`egress` is `local` | `remote` | `unknown`, computed from the provider's `type`
**and its base URL** by `egressClassFor` (§20.6). It is served rather than derived
client-side because the answer is not guessable from the name — **`opencodex` is
`remote`** (it routes to upstream vendors) and **`colibri` is `local` only when
its URL really is this machine**. A `local` or `colibri` provider pointed at
another host is `remote`, because that is where its bytes go; a declared `remote`
provider is never downgraded to `local`, even at a loopback address. **A
configured `egressProxy` is part of that calculation** (1.37): a loopback
provider tunnelled through a proxy elsewhere is `remote`, because the bytes never
reach this machine's loopback at all. `egressProxy` is `null` for a provider with
no proxy, and otherwise carries the redacted URL, the credential-free
`authority`, and `offMachine` — the flag that says whether the proxy itself is on
this machine, which is the fact that makes the class what it is. A frontend
inferring any of this from the type string would get it backwards.

With nothing enabled this is a **200** with `provider: null` and
`egress: "unknown"`, not a 404: "nothing is configured" is the answer to the
question. `unknown` is deliberately never reported as `local` — understating
exposure is the one error this feature must not make.

This route is declared **above `/:id`**, which is load-bearing: registered after
it, Express matched `/active` as an id and the response was
`404 not_found "No provider with id \"active\""`. There is a test asserting the
200 for exactly that reason.

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

### 3.4 Puter

Puter is not a different *protocol* — it serves an OpenAI-compatible
`/puterai/openai/v1/chat/completions`, so streaming goes through the same code as
`remote`: `puterAdapter.stream` **is** `openAiAdapter.stream`. Three things are not
interchangeable, and they are the entire content of the type.

**1. The credential is a token, not a vendor API key.** It is minted from the Puter
dashboard ("Create token"), it is named, it is shown once, and it can be revoked at
any time under Settings → Security → Manage sessions. Expiry is **opt-in** — the
create dialog offers Never, 7, 30 or 90 days — so a token does not "just expire".
A rejected one comes back `401`, which the failover cooldowns (§4.3) classify as
`auth` and hold for an hour, and the message says *auth token … expired or been
revoked* rather than "API key", because a Puter user has no key to go looking for.

**2. The model catalogue is Puter's own endpoint.** Every other
OpenAI-compatible provider here answers `GET {base}/models`;
`https://api.puter.com/puterai/openai/v1/models` is not Puter's catalogue. Puter
publishes it, unauthenticated, at `GET /puterai/chat/models/details`, with
`/puterai/chat/models` documented as the summary form. `puterAdapter.listModels`
reads the rich endpoint first, then the summary one, then the OpenAI-shaped listing
as a last resort, and reports the *first* failure if all three fail. The payload is
worth the special case: it carries **`context`** — the model's context window —
which becomes `contextLength`, so §4.x/1.28's context ceiling judges a Puter model
against its real window instead of the assumed 8 192 default. The catalogue URL is
*derived from the configured `baseUrl`*: a provider pointed at a compatibility
proxy has no Puter path shape, gets `null`, and keeps the ordinary listing.

**3. The compatible endpoint requires a paid Puter plan.** The same models are
available to every account through Puter's own SDK (`puter.ai.*`), but
`/puterai/openai/v1/*` answers a free account `402 subscription_required`. An
exhausted monthly usage credit answers `402 insufficient_funds`; requests over the
window answer `429 too_many_requests` (30 per 10 s and 3 concurrent on a free plan,
200 and 20 on a paid one). A 402 is **non-retryable** — nothing about the next
request changes the plan or the balance — and it is cooled down under 1.36's
`payment` class for 30 minutes. The two 402s are told apart by the provider's own
`error.code`, which is lifted into `details.providerCode` when it matches a strict
lowercase-identifier pattern (a code cannot carry a key or a prompt, so this stays
inside the disclosure rule) and turned into the sentence that says which condition
it is.

**GET /api/providers/puter/advisory** — no body. Returns:

```ts
{
  type: 'puter';
  defaultBaseUrl: string;       // 'https://api.puter.com/puterai/openai/v1'
  credential: 'auth_token';
  egress: 'remote';
  catalogueUrl: string;         // 'https://api.puter.com/puterai/chat/models/details'
  requiresPaidPlan: true;       // the OpenAI surface is a paid-plan feature
  note: string;                 // multi-line prose, safe to render verbatim
}
```

`defaultBaseUrl` is a suggestion for pre-filling a form, not an assumption:
`baseUrl` is still required on create, exactly as for every other type. The
advisory exists so a settings screen can say what to paste, where the model list
comes from, and what happens next — including the plan requirement, which is a
property of the choice rather than of the first request that fails.

**The token is stored like a secret and hinted like one.** Encrypted at rest, and
`apiKeyHint` is the last four characters — with no `sk-` assumption, because a
Puter token has no prefix. Every read path still refuses to return it, and it is
sent as a bearer token in the `Authorization` header where a vendor key would go.
A minted access token can use the whole Puter API but is refused by Puter's
account-management endpoints (password, email, 2FA, session-cookie sync, minting
further tokens), so pasting one here cannot be escalated into account control.

**Egress is `remote` by type**, never by URL (§20.6): the service is hosted, so
a Puter provider tunnelled through a proxy or reached at a loopback relay is
still remote. `puter` is listed with the declared-remote types for that reason.

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
| GET | `/api/chat` | `{ chats }` — query `tool`, `includeArchived`, `archivedOnly`, `limit` (default 200, max 500) |
| POST | `/api/chat` | **201** `{ chat }` |
| POST | `/api/chat/stream` | **SSE** |
| POST | `/api/chat/resume` | **SSE** |
| GET | `/api/chat/runs/paused` | `{ runs }` — query `chatId` |
| GET | `/api/chat/:id` | `{ chat, messages }` — query `limit` (default 500, max 500) |
| PATCH | `/api/chat/:id` | `{ chat }` |
| DELETE | `/api/chat/:id` | `{ deleted: true, id }` |
| GET | `/api/chat/:id/messages` | `{ messages, nextBefore }` — query `limit` (default 50, max 500), `before` |
| POST | `/api/chat/:id/fork` | **201** `{ chat, messages, forkedFrom, pausedPartials }` *(1.27)* |
| GET | `/api/chat/:id/context` | `{ chatId, modelId, window, estimatedTokens, ratio, messageCount, needsNewSession }` *(1.28)* |
| POST | `/api/chat/:id/resume-in-new-session` | **201** `{ chat, messages, source, droppedMessages, pausedPartials, receipt, assessment }` *(1.28)* |
| POST | `/api/chat/:id/open` | `{ chat, messages, latestRun }` |
| POST | `/api/chat/:id/pin` | `{ chat }` |
| POST | `/api/chat/:id/archive` | `{ chat }` |
| POST | `/api/chat/:id/unarchive` | `{ chat }` |
| GET | `/api/chat/:id/runs` | `{ latest, paused }` |

**POST /api/chat/:id/fork** *(new in 1.27)* branches a conversation. Body:
`upToMessageId?` (copy messages **up to and including** this one; omitted means all
of them), `title?` (default `<source title> (fork)`), `chatId?` (the id for the new
chat — the frontend generates chat ids client-side everywhere else, so a fork can
too). The response carries the new chat, the copied messages with their new ids
and sequence numbers, `forkedFrom` (the source id) and `pausedPartials` (how many
copied messages were mid-stream and land `paused`).

Four properties, each of which is a way a copy could be wrong:

- **The source is untouched** — nothing is renumbered, truncated or re-stamped in
  the original, so forking is safe on a conversation the user is still having, and
  the gesture is offered from exactly there.
- **The copy is a conversation, not a view.** Messages are inserted as new rows, so
  the branch can be continued, renamed, exported and deleted on its own; appending
  to it does not write into the source.
- **A mid-stream message lands `paused`.** The source row may still be written to
  by the run that owns it; the copy has no writer at all, and `streaming` would
  claim a process is about to complete it. `paused` is the status this schema
  already uses for "partial text, nothing running", and `pausedPartials` counts
  them so a surface can say so.
- **Timestamps are preserved**, so the branch's history reads in the order it
  happened instead of every copied row claiming it was said now.

`chats.forkedFrom` records the immediate parent (migration `017`, `ON DELETE SET
NULL`): deleting the original keeps the branch and clears only the provenance
line. A **temporary chat is refused** with `409 conflict` — its messages exist only
in the process, so a fork would write down exactly what the user asked to leave no
trace of.

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
| `acknowledgeSensitive` | no | send anyway after a `redaction_flagged` refusal (§20.6) |

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

`code` is the router's own reason for a pause, so a paused-by-switch event can
carry `capability_mismatch`, `health_failure`, `zdr_requirement` or `cooldown`
while `reason` stays one of the enum values above — a `cooldown` switch reports
`provider_failure`, because the provider did fail and the class of failure is
what the `message` names. A provider that failed in a way worth pausing for (a
rejected key, a rate limit, a 5xx) is *cooled down* for a duration set by the
failure: 60m for 401/403, 30m for 402, 5m for 429 (or the provider's own
`Retry-After`, whichever is longer, capped at an hour), 2m for 404, 1m for 5xx
and 30s for a network fault. Cooldowns live in memory, expire on their own, and
are cleared by any user action that re-evaluates the provider — so a request
that arrives while the active provider is cooling down is routed to another
provider that can serve the model, and the run says so rather than repeating the
same failure.

`busy` (409, retryable, `details: { jobId }`) is returned as JSON when a job is
already in flight and `concurrency_mode` is `reject`. Under `queue` the request
waits for the lock instead.

### 4.4 `POST /api/chat/resume`

Body: `runId` (req), `modelId?`, `providerId?`, `tool?`. Same event stream.
Requires the run to be in `paused` state — otherwise `run_not_paused` (409) as
JSON. A manual model/provider switch resumes automatically on success and stays
paused on failure.

### 4.5 The context ceiling, and continuing in a new session  *(new in 1.28)*

A long conversation eventually stops fitting in the model's window, and the
provider answers that by rejecting the whole request. The agent loops compact
their own context; a chat is the user's transcript, and dropping the middle of it
behind their back would rewrite history they are reading. What a person can act
on is a new session.

**`GET /api/chat/:id/context`** — a read, no provider call, no write:

```jsonc
{
  "chatId": "…", "modelId": "gpt-4o-mini",
  "window": { "tokens": 128000, "source": "model", "assumed": false },
  "estimatedTokens": 104321, "ratio": 0.815,
  "messageCount": 42, "needsNewSession": true
}
```

The window comes from the same ladder the agent loops use (`1.28`'s accounting):
an explicit override, then the context length the provider reported for this
model in its **cached** model list, then a conservative default — which is
**provider-aware**. The override is the provider's declared
`maxContextTokens` (§3.1) — the chat's own provider when it names one, the active
provider otherwise, which is the same choice the send path makes — and it wins over
a reported context length, because a person who typed a number meant it while a
gateway's `context_length` is often the model's marketing maximum.

The bottom rung is `DEFAULT_CONTEXT_TOKENS = 8 192` for every type **except
`local`**, where it is `OLLAMA_DEFAULT_CONTEXT_TOKENS = 4 096`: Ollama's own
documented default (`OLLAMA_CONTEXT_LENGTH` raises it server-wide, a Modelfile
`num_ctx` raises it per model). The two numbers differ because the failures
differ — a gateway that dislikes a long prompt refuses the request, while Ollama
**truncates the input in silence** and answers from what is left, so over-guessing
there buys a wrong answer rather than an error. Either way the rung reports
`source: 'default'` and `assumed: true`, and `maxContextTokens` is how a user who
knows their window overrides the guess. **The window is
resolved once, at the start of the run or the read**, from the provider that would
serve: a mid-run failover to a provider declaring a different ceiling therefore
leaves the run sized against the first one. That is deliberate — the alternative is
a compaction boundary that depends on which endpoint happened to answer — and it is
stated here rather than left to be discovered. `source` names which rung was used and
`assumed: true` marks the default — most OpenAI-compatible gateways report no
context length at all, so this is the common case rather than the edge case, and
the route says so instead of presenting a guess as a measurement.
`estimatedTokens` uses the adapter's own arithmetic (~4 characters per token plus
per-message overhead), so the client and the provider never disagree about
whether a conversation fits. `needsNewSession` is `ratio` against
`COMPACTION_TRIGGER_RATIO` (0.8) — the same threshold that makes an agent run
compact, so "nearly full" means one thing in this build. A chat that does not
exist is a `404`.

**`POST /api/chat/:id/resume-in-new-session`** — body `{}`, `title?`,
`chatId?` (supply your own id for the new session).

- **The source is never modified.** Nothing in it is deleted, truncated or
  re-stamped, so the span the new session leaves behind still exists where it
  always did — that is the only copy of it.
- **The recent tail is kept, sized to `COMPACTION_TARGET_RATIO` (0.5) of the
  window.** Messages are walked newest-first until the budget is spent. The most
  recent message is kept even if it alone exceeds the budget: a session resumed
  without the thing the user is working on has nothing to continue.
- **The dropped span is described, never quoted.** The new session's first
  message is a persisted `system` note — `[Earlier conversation left behind when
  this session was resumed from "…": 7 user message(s), 6 assistant message(s).
  …]` — counting roles and naming counts only. Quoting the dropped messages would
  cost the tokens the resume exists to reclaim, and the text it would quote is
  whatever the user happened to paste. The note is a row rather than a detail of
  the response because a chat's transcript *is* its context: the next turn is
  built from these rows, so a receipt that lived only in the response would
  vanish at the next message and the model would meet a conversation starting
  mid-sentence with no idea it had. `system` is the honest role — context
  supplied by the harness, not words put in the model's mouth.
- **Copied messages get new ids and fresh sequence numbers** (the receipt is
  `seq: 1`), keep their original timestamps, and a message that was mid-stream in
  the source lands `paused`, counted in `pausedPartials` — the copy has no
  writer, and `streaming` would claim one is coming. Same rule as the fork.
- **A conversation that already fits is refused with a `409`** naming both
  numbers (`estimatedTokens`, `windowTokens`, `assumed` in `details`), because
  "resume in a new session" exists to escape a limit and a copy that drops
  nothing solves nothing; the message points at the fork instead.
- **A temporary chat is refused** (`409`), like the fork: its messages exist only
  in the process, and a new session would persist exactly what the user asked to
  leave no trace of.

The response carries `assessment` so a surface can state the numbers the decision
was made from rather than re-deriving them, and `receipt` so it can render the
note without parsing the transcript.

---

## 5. Memory — `/api/memory`  *(new in 1.5; writes added in 1.21)*

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
| POST | `/api/memory` | `{ stored: true }` — body `{ text }`, at most 4000 characters |
| POST | `/api/memory/import` | `{ imported, dropped, found, error }` — body `{ text }` |
| DELETE | `/api/memory/:id` | `{ deleted: boolean }` |
| DELETE | `/api/memory` | `{ cleared: boolean }` |

**The write routes refuse rather than no-op**, which is the one thing a read route
never has to get right. A disabled plugin is `403 capability_disabled` (nothing was
stored, whatever the response looks like), an empty or oversized body is
`400 bad_request` naming the field and the bound, and a backend that will not load
is `500 storage_error` with the reason `GET /status` would have given. A `200 {}`
here would be indistinguishable from a memory that was stored and then lost.

**Import is bounded, and says what it dropped.** Blank lines separate memories and
single line breaks do not — a memory that is a short list is more useful stored
whole than shredded. Chunks are added one at a time (each is a local-model
extraction pass; firing a hundred at once against one Ollama queues them anyway
while making a failure unreadable), capped at 100 chunks or 20 000 characters. A
piece that does not fit is **dropped, never truncated**: storing a memory the user
did not write is worse than storing nothing and saying so. A run that stops early
returns its counts with `error` set, because 40 of 60 chunks landing is a real
outcome and a 500 would throw it away — with one exception: if *nothing* landed,
the response is the storage error, since a success-shaped answer for zero work is
the reading this route must not allow.

The list route returns an **empty array rather than an error** when memory is
disabled or the backend failed to load, so `GET /status` is the single place that
explains why (`enabled` vs `available` vs `error`). `/status` never starts the
backend. The enable/disable routes reset the cached client, so a backend that
failed once is retried instead of staying broken until restart.

Retrieval and storage happen inside the chat turn, not here — see
`docs/SPEC.md` §Addendum. When the toggle is off there are no background writes.

**A temporary (incognito) chat is never handed to the extractor.** No fact is
distilled from it, and its id is not stored as metadata — the promise that the
conversation is not recorded is about the substance, not only the transcript. The
turn may still *read* memories; reading records nothing. `rememberTurn` returns
why it did or did not dispatch (`queued` | `disabled` | `temporary` | `empty`).

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

`managed: true` is the normal answer: the supervisor registers the process
manager during boot, before any server has finished connecting, so a server may
still be `starting` while `managed` is already true. `managed: false` means no
process manager is registered — because `HYPERION_MCP_DISABLED=1` was set, boot
has not reached the supervisor yet, or shutdown has already stopped the servers
— and `servers` then reflects config only, with nothing actually supervised.

`POST .../test` is **informational, not a gate**: saving succeeds
regardless of the result. `static: true` means the config was
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

`GET /summary` supplies the id+name+description list for system-prompt injection.
The library read is **unfiltered**: every enabled skill is listed, including ones
switched off for a given tool in the Plugins hub (§25), because the Settings panel
that can explain the switch is the same read. The **agent loops** apply that
filter (`services/plugins/consumers.ts`); the chat orchestrator still does not
inject skills at all.

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
| GET | `/api/storage/cleanup/log` | `{ entries: CleanupLogEntry[] }` — query `limit` (default 50, max 500) |
| GET | `/api/storage/worktrees` | `OrphanScan` (bare) *(new in 1.31)* |
| POST | `/api/storage/worktrees/:name/discard` | `{ name, dir, method, lostReason, scan }` — body `force?` *(new in 1.31)* |

`GET /assets` query: `chatId`, `tool`, `origin` (`uploaded` \| `generated`),
`pinned`, `brandApproved`, `search` (filename substring), `limit` (default 200,
max 1000), `offset` (default 0). The listing echoes both back, so a client can
tell what it actually received.

`brandApprovedAt` is `null` whenever `brandApproved` is `false`. Approval is
managed through `/api/design` (§23), not here — this router only reports and
filters on it.

`POST /assets/:id/pin` body `pinned?`; omit to toggle. Pinned assets are exempt
from the TTL sweep entirely.

`DELETE /assets/:id` accepts `keepFile` as a query param or a body field and
echoes back what it did, including `bytesFreed`.

### 8.1 Orphaned worktrees — the check that reports and does not delete  *(new in 1.31)*

Per-task checkouts live under the `worktrees` scope, and the registry that maps a
directory to a task is **in-memory**. So a restart makes everything on disk an
orphan: the directories survive, the knowledge of which task they belonged to does
not. Before this, nothing looked, and two things were silently true — a leftover
directory was indistinguishable from a leak, and a task continued after a restart
got a *fresh* checkout (`freePath` deliberately suffixes past anything already on
disk) with its previous edits stranded beside it.

```ts
OrphanedWorktree { name, dir, taskId, lastModified, risk: string|null, checked: boolean }
OrphanScan       { root, scannedAt, orphans: OrphanedWorktree[],
                   holding, unchecked, registered }
```

`GET /api/storage/worktrees` scans the scope on demand — never a cached listing,
because this is the route a user reaches when they want to know — and reports every
directory no task owns. Each one carries what removing it would lose:

| `risk` | meaning |
| --- | --- |
| `it has uncommitted changes` | `git status --porcelain` is not empty |
| `it has commits on a detached HEAD that no branch would keep` | commits exist and no ref points at them |
| `its state could not be checked (…)` | git could not answer. `checked: false` — an unverifiable directory is never reported as safe |
| `null` | it provably holds nothing |

`limit` bounds how many directories are inspected (default 50, one git spawn
each), and **`unchecked` counts the ones it skipped**. A bounded scan that
reported itself as complete would be a lie about coverage.

Nothing here deletes. `POST /api/storage/worktrees/:name/discard` is the explicit
request, and it is narrow:

- **Only orphans.** A directory a running task owns is a `409`, so this can never
  be a route that breaks a live run.
- **A directory holding work needs `force: true`.** Without it the answer is a
  `409` naming what would be lost (`details.reason`). With it, the removal happens
  and `lostReason` records what it cost. A user who read the reason and asked again
  has made a decision; the response states the price.
- **An unverifiable directory also needs `force`**, and without it the answer is a
  `409` naming what git said, not a deletion. Failing closed is the same posture
  `zdr` and the egress classifier take.
- **Git removes it when git can** (`git worktree remove` [+ `--force`], then
  `prune`), because a plain directory delete leaves the parent repository's
  metadata stale — the entry keeps appearing in `git worktree list`. `method` says
  which path was taken. A directory git refused to remove is **not** deleted from
  the filesystem without `force`: that would be this module overruling the second
  opinion it asked for.
- **There is no partial outcome.** The directory is gone, or the response is a
  `409` saying why not; a refusal never leaves a half-removed tree behind.

`name` is a single directory segment — not a task id. `freePath` suffixes a second
directory (`<task-id>-2`) when the first is unusable, so the name is the only
handle that identifies exactly one thing on disk. The response carries the
refreshed `scan`, so a caller need not ask twice.

**Adoption is the other half.** When a task is provisioned after a restart,
`provisionWorktree` looks for a directory left for *that* task id and re-attaches
it if the repository matches (`--git-common-dir` compared with the project's), with
the traversal and containment assertions run on the path exactly as for a new one.
Without this, the check would report work the user could never get back — a finding
nobody can act on is a report, and this build does not ship those. The same fact
reaches the queue: `GET /api/attention` carries a `worktrees` source and one
`orphaned_worktree` item per orphan that holds work. Its `resolve` points at the
discard call, but the item's *link* goes to Code with a caveat: the queue does not
put a destructive call one click away from a row somebody is scanning.

`POST /cleanup` runs the sweep on demand; body `dryRun?`, `assetTtlDays?`,
`chatTtlDays?` (the TTL overrides exist so a sweep can be rehearsed without
waiting three months). Defaults come from env: assets untouched for 90 days,
chats not opened for 120 days (four months). Pinned assets are exempt; pinned
**and** archived chats are exempt.

---

## 9. Usage & pricing — `/api/usage`

```ts
UsageBucket  { key, requests, tokensIn, tokensOut, costUsd, unpricedRequests,
               cacheReadTokens, cacheWriteTokens, reasoningTokens,
               cacheHitRate, rowsWithCacheReporting,
               rowsWithDuration, meanDurationMs, slowestDurationMs }
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
| GET | `/api/usage/exposure-summary` | `ExposureSummary` (bare) — same query params *(new in 1.23)* |
| GET | `/api/usage/prices` | `{ prices: PriceInput[] }` |
| PUT / POST | `/api/usage/prices` | `{ price }` (same handler, upsert) |
| DELETE | `/api/usage/prices` | `{ deleted: boolean }` |

Upsert body: `modelId` (req), `providerId` (nullable — `null` is a catch-all
across providers), `inputPer1mUsd` and `outputPer1mUsd` (req numbers). DELETE
reads `modelId` / `providerId` from either the body or the query string.

**A catch-all price is one row per model, and saving it twice updates it.** That
was not true before 1.29: the upsert's conflict target was
`(model_id, provider_id)`, and SQLite treats NULLs as distinct in a unique index,
so a second save of the *global* price inserted another row instead of replacing
the first — and the lookup kept returning the older one. The user's edit appeared
to do nothing, and the stale figure stayed in force for cost reporting and for the
daily spend cap. A partial unique index (migration `018`) now enforces the
invariant and the upsert names it.

**Unpriced is not free.** A usage row with no matching price keeps `cost_usd`
NULL rather than 0, so it never silently reads as free. Cost sums skip those
rows, and `unpricedRequests` per bucket plus the top-level `hasUnpriced` tell the
dashboard to show "cost incomplete" instead of a wrong total.

**Silence is not zero, on every optional measure in the bucket.** A bucket whose
rows reported no cache figures answers `cacheReadTokens: null` and
`cacheHitRate: null`; one that reported none of a duration answers
`meanDurationMs: null`. A reported `0` is kept as the measurement it is — a
sub-millisecond local reply is a duration. `rowsWithCacheReporting` and
`rowsWithDuration` are the denominators: a mean of 4 s computed from two rows out
of a thousand is a fact about two rows, and a client that quotes it without the
count is quoting a coincidence.

**The duration columns are measured on failed attempts too.** `usage_log` has
recorded `duration_ms` — wall-clock time inside the provider request — since the
log existed; nothing read it until now. `meanDurationMs` is the mean over the rows
in that bucket that recorded one, rounded to whole milliseconds, and
`slowestDurationMs` is the tail of the same rows. Both deliberately include the
`error` and `partial` rows: the endpoint that hangs for a minute before failing is
slower than the one that answers in 40 ms, and a mean over successes alone is the
flattering number. A reader that needs success-only latency has to filter and say
so. This mirrors `rowsWithCacheReporting`'s rule rather than inventing one — and
the same three fields ride on the `ExposureSummary` buckets, whose folded total
merges counts instead of averaging the per-class means.

There is no per-row usage endpoint — aggregates only.

### 9.1 Exposure summary  *(new in 1.23)*

The same spend, grouped by **where the bytes went** rather than by which provider
sent them.

```ts
ExposureBucket  extends UsageBucket { key: 'local'|'remote'|'unknown',
                                      providerTypes: string[] }
ExposureSummary { range: { from, to }, totals: UsageBucket,
                  byClass: ExposureBucket[], hasUnclassified: boolean }
```

`providerTypes` names every provider type folded into the bucket, so a user can
see *why* a row landed under `remote` — `["opencodex", "remote"]` rather than an
unexplained total.

The class comes from a **`provider_egress` column stamped on the usage row at
write time** (migration `019`), not from a join against `providers`. Deleting a
provider therefore does not erase the record of what it sent, and re-pointing one
cannot rewrite history retroactively.

`019` exists because `provider_type` alone was not enough: `local` and `colibri`
*claim* locality, and a base URL is accepted for any http(s) host, so a provider
on another machine used to be counted as never having left. The class is now
derived from the type and the URL (`egressClassFor`), and rows written before the
migration fall back to the type mapping they were written under. That fallback is
a **permanent, recorded understatement** for any pre-`019` local-typed provider
that pointed off this machine — the URL was never stored, so there is nothing to
re-decide it with, and guessing would be worse than the honest gap. (Migration
`013` stamped `provider_type` for the same anti-retroactivity reason.)

**`hasUnclassified` is reported rather than hidden.** The column is nullable —
`recordUsage` swallows its own failures, so a `NOT NULL` constraint would silently
discard spend rows — and rows written before `013`, or by a path that omits the
type, land in the `unknown` bucket. They are never folded into `local`, because a
summary that guessed would understate exposure. `totals` always equals the plain
`/api/usage` total over the same range.

---

## 10. Backup — `/api/backup`

```ts
BackupFile   { filename, bytes, createdAt }
BackupManifest { format, app, createdAt, createdAtIso, schemaMigrations: string[],
                 contents: {...}, counts: Record<string, number>, encrypted?: boolean,
                 warning?: string }
ArchiveInspection { valid, encrypted, manifest: BackupManifest|null, hasDatabase, hasMcpConfig,
                 hasEncryptionKey, skillFiles, attachmentFiles,
                 counts: Record<string, number>, diff: ArchiveDiff,
                 problems: string[], warnings: string[] }
ArchiveDiff  { tables: { table, current, archive, delta }[], onlyInArchive: string[],
                 onlyHere: string[], missingFromArchive: string[],
                 currentMigrations, archiveMigrations }
RestoreResult { restored, dryRun, inspection, preRestoreBackup: string|null,
                 filesWritten: { database, mcpConfig, skills, attachments },
                 restartRequired }
RestoreAuditEntry { id, createdAt, filename, bytes, sha256, encrypted, dryRun, restored,
                 outcome: 'dry_run'|'restored'|'refused', detail, preRestoreBackup }
```

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/backup` | `{ backups: BackupFile[] }` (`.zip` and `.hypbak`) |
| GET | `/api/backup/export` | **a file download**, not JSON |
| POST | `/api/backup/export` | **a file download** — `{ passphrase }` *(1.29)* |
| GET | `/api/backup/restores` | `{ restores: RestoreAuditEntry[] }`, newest first *(1.29)* |
| POST | `/api/backup/inspect` | `{ inspection: ArchiveInspection }` |
| POST | `/api/backup/import` | `RestoreResult` (bare) |

`GET /export` query: `includeKeys` (**default false**), `includeAttachments`
(default true). The archive bundles the SQLite database and the skills registry.
**`mcp_config.json` is included only with `includeKeys`** — a remote server's
token is written into that file as a plaintext `Authorization` header, so an
archive that promises not to carry credentials cannot carry it. The servers
themselves still travel, in the database that is the registry's authority
(`POST /api/mcp/sync` regenerates the file from it), and a restore given no such
file leaves the one already on the machine alone. Including the encryption key
makes the archive as sensitive as the keys themselves, which is why it is opt-in
and why the manifest carries a `warning` — which also names the omitted file when
`includeKeys` is false.

`POST /inspect` and `POST /import` take the archive either as an upload —
`multipart/form-data`, field name **`file`**, one file (note this differs from
skills, which uses `files`) — or as JSON `{ file: "<name>" }` naming an archive
already in the backups directory. Both accept a **`passphrase`** field, required
when the file is a protected container (§10.1).

### 10.1 Passphrase-protected archives *(new in 1.29)*

`POST /api/backup/export` with `{ "passphrase": "…" }` writes a **`.hypbak`**
container instead of a `.zip`: Argon2id derives a 256-bit key from the passphrase
(64 MiB, 3 iterations, 1 lane by default), AES-256-GCM encrypts the archive, and
the parameters travel in the container header so an archive written today opens
on a build that has since changed its defaults. The plain zip is **deleted** once
the protected file exists — an export that left both would make the protection
decorative. `GET /export` stays exactly as it was and takes no passphrase, because
a passphrase in a URL ends up in browser history, `Referer` headers and request
logs; the POST body is the only way in.

There is **no recovery path and no stored key**: the passphrase is used and
dropped, never written to the archive, the manifest, the settings table or a log
line. Losing it loses the archive — that is what the encryption means, and the
container's refused-open message says so rather than implying a support route
exists.

Failures are deliberately coarse. The GCM tag covers the ciphertext *and* the
header, so a wrong passphrase and an edited file are indistinguishable by
construction and share one message ("the passphrase is wrong, or the file has been
modified"). Two cases are precise because they can be: a file whose magic is not
ours ("not an encrypted Hyperion backup… restore it without a passphrase") and a
container whose length disagrees with its header ("incomplete: a truncated
download is the usual cause") — the second is checked *before* the key derivation,
because a corrupt upload should not cost a second of Argon2id to learn about.

A protected archive can be inspected and restored like any other, given the
passphrase: `POST /inspect` and `POST /import` decrypt first and report
`inspection.encrypted: true`. A plain zip still works with no passphrase at all —
every archive written before this feature is plain.

### 10.2 The diff preview and the restore audit *(new in 1.29)*

`ArchiveInspection.diff` answers "what would this change?" with row counts: every
table that exists on either side, `current` (live) against `archive` (this file),
with `delta = archive - current`; `onlyInArchive` and `onlyHere` name the tables
present on one side only, which is what schema drift looks like from here; and
`missingFromArchive` lists the migrations the archive has not been through.
Counts rather than a row-by-row diff on purpose: a restore **replaces** the
database rather than merging it, so the honest pre-confirmation question is
"does this archive know more or less than I have, and where".

`GET /api/backup/restores` (`?limit=`, default 50, max 500) returns the audit
trail: every attempt, `outcome` one of `dry_run` / `restored` / `refused`, with
the archive's `filename`, `bytes`, `sha256`, whether it was encrypted, and the
pre-restore snapshot's name when one was taken. Two properties are worth stating
because they are structural rather than conventional: **a refusal is recorded**
(the interesting entry is the near-miss — a stale archive someone reached for
and was stopped), and **a successful restore's row lives inside the database it
restored** (it is written after the swap, against the reopened handle), so the
record travels with the data instead of with the process that replaced it.
`detail` carries a short human-readable line — the refusal reason, or what the
swap displaced — and there is no column a passphrase could be written into.

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

These routes are wired, validated, locked and streamed here, with the agent
modules registered at boot — `cowork`, `code`, `design` and the terminal, via
`registerProductionModules`. If a module is ever absent they keep returning
**501** (`agent_not_registered` / `terminal_not_registered`) as plain JSON.

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
| POST | `/api/code/tasks/:taskId/cancel` | plain JSON *(new in 1.24)* |
| POST | `/api/cowork/tasks/:taskId/cancel` | plain JSON *(new in 1.24)* |
| POST | `/api/design/tasks/:taskId/cancel` | plain JSON *(new in 1.24)* |
| GET | `/api/code/rules` | plain JSON *(new in 1.13)* |
| GET | `/api/code/agents` | plain JSON *(new in 1.13)* |
| GET | `/api/code/commands` | plain JSON *(new in 1.13)* |
| GET | `/api/agents/status` | `{ agents, terminal, registered: { code, cowork, design } }` |

`run-task` body (`TaskInput`): `tool`, `chatId`, `modelId`, `prompt`, `mode?`,
`cwd?`, `attachments?`, `options?`. Input parsing, agent lookup and the busy check
all happen **before** the SSE headers, so a 501 or 400 is a normal JSON error.
`mode` is the agent mode — `ask`, `plan` or `act` — and defaults to `act`; it is the
same value the agent-context routes take as `?mode=`, and §12's `started` event
reports the worktree mode separately.

**`/api/code/run-task` additionally requires `taskId`** (string, required). It
names the run for its whole life: it is the key for the worktree, the lane slot
and `GET /api/code/tasks`. It must start with a letter or a digit, continue
with letters, digits, `.`, `-` and `_`, be at most 100 characters and contain no `..`
— it becomes a directory name and a git ref, so anything else is a `bad_request`
rather than something quietly rewritten. The rule is `safeTaskId` in
`src/services/code/worktree.ts`, and the composer checks the same three conditions
before it posts so a typo is refused in place.

**Who calls it (2026-09-22).** The Code surface posts the Code route. The *Task
composer* (`frontend/src/tools/code/StartTask.tsx`, over `startCodeTask` in
`frontend/src/api/agentStream.ts`) renders the instruction, the task id, the mode and
the model picker, and the *Task progress* region renders the stream that answers it —
one hook instance, so the frames provably belong to the run the form started. Two body
fields are deliberately not offered: `cwd` and `attachments`. A run started there has
no conversation behind it, so the composer passes `chatId: code_<taskId>`, the
scheduler's own convention for a run whose chat does not exist (`linkedChatId` stores
NULL); that is also why such a run stays continuable, since `POST …/continue` resolves
which conversation to replay as `run.chatId ?? taskId`. Cowork and Design have no
surface of their own yet, so their `run-task` routes still have no client.

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
  Containment is re-checked at the point of use rather than trusted from resolve
  time, and a path is never used *through* a symlinked directory: that refusal is
  also **403** `scope_violation`, with `details.reason` of
  `intermediate_symlink` (plus the offending `component`) or `resolves_outside`.
  CONTRACTS, "A path is not used through a symlink", has the two checks and the
  three deliberate policy choices behind them.
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

**Rules follow a fallback chain**, because a project that keeps its instructions
in one root file should not have to grow a directory to be read:

    .hyperion/rules/  →  HYPERION.md

The first location that **exists** wins, and `source` reports which one it was —
`hyperion`, `hyperion-md`, or `none` when no location exists at all.
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

### 12.3a Provenance  *(new in Prompt 1.39 A6)*

Two read routes, one field each — the version a version replaced, and the
knowledge sources a run used as evidence.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/artifacts/versions` | `{ artifactKey, versions: ArtifactVersion[] }` — query `key` (required), `limit` (default 200, max 1000) |
| GET | `/api/cowork/tasks/:taskId/provenance` | `{ run: TaskRun, knowledgeSources: RunKnowledgeSource[] }` |

```ts
ArtifactVersion     { id, artifactKey, tool, version, label, inline: boolean,
                      bytes: number|null, sha256: string|null, createdAt,
                      parentVersion: number|null }
RunKnowledgeSource  { sourceId, label: string|null, filename, bytes: number|null,
                      sha256: string|null, usedAt }
```

`parentVersion` is **derived**, not stored: the parent of version *n* is *n-1*, and
`UNIQUE (artifact_key, version)` is what makes that unambiguous. `null` therefore
means "version 1 — this is where the artifact started", never "unknown". Versions
come back newest first, so a `limit` drops the oldest.

`knowledgeSources` are the sources whose text went into the prompt as evidence
(status `usable`), not every source the library held: a source that was consulted
and found missing, binary or hash-mismatched is absent on purpose, because listing
it would claim evidence the run never had. The task's `run` travels with them,
because provenance belongs to an attempt — a restarted run replaces its list.
An empty list is a real answer (an empty library, or nothing usable); the library
itself is `GET /api/cowork/knowledge`.

### 12.4 Task state endpoints  *(new in 1.15)*

Code, Cowork and Design tasks persist their run state so a dropped SSE stream is
recoverable. A phone locking its screen or a laptop sleeping drops the
connection; the state endpoint tells a reconnecting client whether to wait,
retry, or show a result.

```ts
TaskRun {
  runId: string; taskId: string; tool: 'code'|'cowork'|'design';
  chatId: string|null;
  state: 'running'|'paused'|'complete'|'error'
       |'blocked'|'ready_for_review'|'stopped'|'interrupted';
  pauseReason: string|null; errorCode: string|null; errorMessage: string|null;
  startedAt: number; updatedAt: number; completedAt: number|null;
}

```

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/code/tasks/:taskId/state` | `{ run: TaskRun, usage: TaskUsage }` |
| GET | `/api/cowork/tasks/:taskId/state` | `{ run: TaskRun, usage: TaskUsage }` |
| GET | `/api/design/tasks/:taskId/state` | `{ run: TaskRun, usage: TaskUsage }` |
| GET | `/api/code/tasks/:taskId/recovery` | `RecoveryReport` — see §12.4a *(new in 1.31)* |
| GET | `/api/cowork/tasks/:taskId/recovery` | `RecoveryReport` |
| GET | `/api/design/tasks/:taskId/recovery` | `RecoveryReport` |

#### `usage` — what the task has spent *(new in 1.29)*

```ts
TaskUsage {
  requests: number;      // provider requests logged against this task id
  runs: number;          // distinct runs that logged under their own id
  tokensIn: number; tokensOut: number;
  costUsd: number|null;  // sum over priced rows; null if no row has a price
  priced: boolean;       // true only when every logged request had a price
  unpricedRequests: number;
}
```

Recorded per provider request by the agent context, so **every** task run is
attributed whatever started it — a route, a continuation, or the scheduler — and
a delegated child's spend lands in its parent's task total (a child carries the
task id and no run id of its own, which is why `runs` is a separate count).

The field is honest about what it cannot see, in the same way §9 and §20.5 are:

* `requests: 0` means **nothing was recorded** — a task from before this
  accounting, or one that never reached a provider. It is not a claim that the
  task was free, and a client must not render it as `$0.00`.
* `costUsd` is `null` unless at least one logged request had a price, and `priced`
  says whether that figure is the whole bill. An unpriced request is recorded with
  its real tokens and a `null` cost, never a zero — the rule §9 states for the
  price table, applied per task.

`usage` is always present; it is a scalar summary, so it costs nothing to include
and its absence would be indistinguishable from a client's own bug.

Returns the **most recent** run for the task id — a retry reuses the same id,
and the latest attempt is what a reconnecting client needs. A task that has
never run is **404 `not_found`** with `details: { taskId }`; `run` is never
`null`.

The three tools keep separate namespaces, so the same `taskId` under `code` and
under `cowork` are different runs and do not collide.

`completedAt` is stamped only for terminal states (`complete`, `error`,
`stopped`); it is `null` for `running`, `paused`, `blocked` and
`ready_for_review`, so a run that has not ended does not carry a completion time
it has not reached.

`blocked` and `ready_for_review` are written mid-run: `blocked` when the run is
waiting on something only the user can resolve, `ready_for_review` when the work
is finished and specifically wants their eyes. **A restart resolves those two
differently.** `blocked` is demoted to `error`, because the confirmation it waits
for is delivered into a live agent loop that no longer exists — nothing can ever
unblock it. `ready_for_review` survives untouched, because its result already
exists and needs no process to display. `stopped` means a configured ceiling was
reached (§20.5), not a fault, and as of 1.24 it is also how a run the user
stopped is recorded — distinguished by `pauseReason` (§12.5).


---

### 12.4a Recovering an interrupted run  *(new in 1.31)*

`GET /api/{tool}/tasks/:taskId/recovery` answers the three questions a person has
after being told a task run ended because the process went away — what did it get
as far as doing, are my edits still on disk, and what can I do about it:

```ts
RecoveryReport {
  run: TaskRun;
  interrupted: boolean;                 // whether this is a recovery case at all
  stop: { code, message, at } | null;   // null when nothing was recorded about why
  partial: {
    steps: TaskStep[];                  // the run's *last* 50, oldest first
    summary: { steps, toolCalls, failures, compressions,
               tokensIn, tokensOut, complete };
    omitted: number;                    // steps left out by that bound
    lastStepAt: number | null;
    conversation: { durable: boolean; messages: number };
  };
  worktree: { name, dir, taskId, lastModified, risk, checked } | null;
  actions: {
    resume: { possible: boolean; reason: string | null };
    discard: { possible: boolean; name: string | null;
               requiresForce: boolean; reason: string | null };
  };
}
```

Four things are deliberate:

- **The step list is bounded and the totals are not.** `partial.steps` is the tail
  (a long run has thousands), `summary` is computed in SQL over every row, and
  `omitted` states the difference — the same rule the worktree scan's `unchecked`
  follows. A bounded list that looked complete would understate the run.
- **Nothing is answered on the run row alone.** This is the first production reader
  of `task_steps`: the loop has been recording every tool call, plan, compaction,
  approval and turn since migration `014`, and until now nothing ever read it back.
- **The worktree answer is live, not the last scan.** `GET /api/attention` reports
  the last completed scan because a scan spawns git per directory; this read asks
  about **one** task, so it finds the directory by name and risk-checks that one.
  "Your uncommitted edits are still there" is a fact about the disk now.
- **A checkout a live task owns is never offered.** `worktree` is null for a
  registered directory and `discard.reason` says *which* case it is — in use, or
  nothing on disk. The two are different answers and a screen must not blur them.

`resume.possible` is a fact about **this process** — no live run owns the task — and
not a promise the re-run will succeed. Resuming an interrupted run is a *re-run*
(`POST /api/{tool}/run-task` with the same `taskId`), not a continuation: the
continuation routes only move a parked (`blocked` / `ready_for_review`) run, and a
killed process leaves no conversation to replay. The leftover checkout is what
makes the re-run worth doing, because provisioning the same task id re-attaches the
directory still holding its edits (§8.1).

A task with no run at all is still a `404`, naming the task. A run that is **not**
interrupted is answered with `interrupted: false` rather than a `404`, because the
state a caller meant to ask about can have moved on between the list and the click.

The Code surface renders this read in its main region whenever the selected task's run
is interrupted (`frontend/src/components/RecoveryPanel`): the step tail with the totals
over all of it, the leftover checkout with what a discard would lose, and a two-step
discard that mirrors the backend's own `force` rule. **Resume is a handoff**: the panel
takes `onResume`, and the Code surface's host fills the composer with the interrupted
task's id and focuses that region, because a re-run is a `run-task` with the same id and
that is exactly what the composer now posts (§12). The panel never starts a run itself,
and a host that cannot start one still gets the verb, its reason and the route in words
rather than a button that would do nothing — which is why `tasks.recovery` carries
`partial` in `frontend/contracts/frontend-contracts.json`: resume is actioned from Code
now, and Cowork and Design still have no surface to mount the panel in.

### 12.5 Stopping a task  *(new in 1.24)*

A long agent run needs a stop button that does not require closing the tab. These
endpoints stop the run **without** tearing down its SSE stream, so the partial
work and the final `stopped` frame still reach the client.

| Method | Path | Response |
| --- | --- | --- |
| POST | `/api/code/tasks/:taskId/cancel` | `CancelResult` |
| POST | `/api/cowork/tasks/:taskId/cancel` | `CancelResult` |
| POST | `/api/design/tasks/:taskId/cancel` | `CancelResult` |

```ts
CancelResult {
  tool: 'code'|'cowork'|'design';
  taskId: string;
  runId: string;
  state: 'stopping'|'complete'|'error'|'stopped';
  wasRunning: boolean;
}

```

No request body. Three outcomes, **all 200**:

- **A live run** — `wasRunning: true`, `state: 'stopping'`. The reply means "the
  signal was delivered", not "the work has ended": the run unwinds
  asynchronously and announces its own end on the SSE stream. Poll §12.4 or watch
  the stream for the terminal state.
- **A run that already finished** — `wasRunning: false` and the state it actually
  reached (`complete`, `error` or a previous `stopped`). Stopping something that
  already stopped is not an error, so this is not a 409.
- **A row stranded in a non-terminal state** — a run whose process died, leaving
  `running` or `paused` behind. There is no signal to send, so the state is
  transitioned directly to `stopped` with `pauseReason: "cancelled"`, and
  `wasRunning` is `false`.

A task id that has **never** run is **404 `not_found`** with
`details: { taskId }` — the same rule as §12.4, and the only non-200 this
endpoint returns apart from a malformed path.

A cancelled run records **`stopped` with `pauseReason: "cancelled"`**, never
`error`. The distinction matters to the UI: an error deserves a retry prompt and
a place in the error log (§13), whereas a stop the user asked for deserves
neither. `pauseReason` is what separates a user stop from a ceiling stop
(§20.5), which also lands on `stopped`.

Queued tasks are cancellable too. A Code task parked behind a full lane (§12.1),
or a Cowork task waiting on the job lock, is registered as cancellable *before*
it acquires the lock — so it can leave the queue instead of having to start
first.

Cancellation is **in-process**, like the job lock: it applies to work this
process is running. It is not persisted, because a registry that survived a
restart would offer to stop runs that no longer exist. Boot-time reconciliation
already demotes rows a dead process left behind.

Scheduled Cowork runs (§17.2) are cancellable through the same
`/api/cowork/tasks/:taskId/cancel` path, using the scheduled task's own id. A
stopped scheduled run is recorded with status `skipped` and its `lastRunAt` is
stamped, so it does not immediately come due again on the next tick.

### 12.6 Approvals, continuation and permissions  *(reference completed 2026-09-21)*

These routes were built, tested and used by the frontend, but this reference did
not describe them — the `{tool}` routes were only ever named in
`docs/CONTRACTS.md`'s prose. The gap was found by diffing the route snapshot in
`frontend/contracts/backend-routes.json` against this file, so the section says
what the handlers do rather than pointing at a design note.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/{code\|cowork\|design}/tasks/:taskId/approvals` | `{ tool, taskId, state, pauseReason, count, approvals:[{…, createdAt, expiresAt }] }` |
| POST | `/api/{code\|cowork\|design}/tasks/:taskId/approve` | `{ tool, taskId, approvalId, state, applied, continuable }` |
| POST | `/api/{code\|cowork\|design}/tasks/:taskId/continue` | SSE stream (the agent protocol) |
| GET | `/api/code/permissions` | `{ project, mode, profile, layers }` |

**Listing** answers "what is this task waiting on". `state` and `pauseReason` come
from the task's latest run and are `null` when there is none, so a client can tell
"parked on an approval" from "nothing is running". `approvals` carries each parked
call's `arguments` **verbatim** — the point of showing an approval is that the user
sees exactly what would run, and a summarised or reformatted call is a different
call from the one they would be authorising. There is no `404` for a task with no
approvals: an empty list is the honest answer, and the cross-task view is
`GET /api/attention` (§19). Each prompt carries `createdAt` and the `expiresAt` the
reaper will hold it to (§12.6b), computed from the same setting the sweep reads — a
client that hard-coded the deadline would show a countdown that reaches zero at a
different moment than the prompt stops being answerable.

**Approving** records a decision (`approvalId`, `decision` one of `allow_once` /
`allow_session` / `deny`) and deliberately **does not start the agent** — that is
`continue`'s job, and keeping them apart lets a client record a decision from a
notification without committing to drive the run from that connection, which
matters because continuing is an SSE stream and answering a prompt is a single JSON
call. It is **idempotent**: approving an already-resolved approval returns the state
it actually reached with `applied: false` rather than failing, because answering a
moment after somebody else did is a race the user cannot avoid. A prompt past its
deadline answers the same way with `state: "expired"` — it was never resolved, so
`applied: false` and `continuable: false`, and the honest client wording is that the
wait expired rather than that an allowance was granted. A `deny` on a parked
run finalises it (`stopped`, `pauseReason` `approval_denied` — or `loop_detected`
when a doom loop was declined), and `continuable` says whether the caller still has
work to do: true only for an allow, and only while the run's conversation still
exists to continue.

**Continuing** resumes a parked task as an SSE stream, with one exception worth
stating because a client has to handle it: a body carrying `decision: "deny"` is
**not** streamed. A denial ends the run (`finishDenied`), so there is no agent to
start and nothing to watch, and the route answers JSON —
`{ tool, taskId, runId, continued: false, state: "stopped", decision: "deny" }` — on
the same 200. Everything else about the request is the stream below. Validation, the claim and
the module lookup all happen **before** the response becomes a stream, so every
refusal is JSON a client can read rather than an error buried in an SSE frame — the
same discipline `run-task` follows. **The claim is released when no continuation
starts**: the parked run is moved to `running` before the Code lane is awaited (that
transition is the mutex, and it has to be taken while queued or a park could be
claimed twice), so a wait that ends without a run — a `reject`-mode refusal on a full
lane, or a client whose stream dropped while queued — would otherwise leave the run
`running` with nothing behind it, uncontinuable (`not parked`) and demoted to
`interrupted` on the next boot. The release writes the park back with the state and
reason it had, and only while no continuation of its own exists. The body may carry `approvalId`/`decision` to
resolve an approval and continue in one call. Answering an **expired** prompt is
refused here (409, `details.reason: "expired"`, with the configured `waitHours`) and
in its own words — `already_resolved` would say somebody answered it, and nobody did.
Continuing **without** an `approvalId` is the way back: the conversation is replayed,
the gated call is re-emitted, and the user is asked again with fresh arguments. The agent rebuilds its own system
prompt for the continuation, which is correct rather than wasteful: the profile,
project rules and session permissions may all have changed while the task was
parked, and that change is usually the reason it was continued. The last user
message becomes the prompt — the task's own description is not replayed as a fresh
turn, which would make the model read it twice.

**The frontend calls it now** (2026-09-22). Until then nothing did: the route had
existed since 1.24 with tests, the `tasks.continue` row was a `route-mismatch` (the
spec named `/resume`), and the Attention Center's "open it to resume" pointed at a
surface with no resume control — a decision could be recorded on an approval and the
run left parked with no way to start it from the UI. The caller is
`frontend/src/api/agentStream.ts` (`continueTask`), mounted by
`src/tools/code/ParkedTask.tsx` in the Code surface's main region whenever the
selected task's run is `blocked` or `ready_for_review` — the two states
`requireContinuable` accepts, and deliberately not `paused`, which is a park with no
continuation path. The panel posts an allow together with the continuation in one
call, sends a denial to `/approve` instead (it is a decision, not a continuation,
and `/approve` is idempotent), and refuses a bare continue while a prompt is
outstanding rather than round-tripping to a `not_parked` park. The frontend's
client-half rule in `scripts/check-contracts.mjs` only requires a client of
`implemented` rows, so this row's `route-mismatch` status never demanded one — the
gap was found by hand and closed by hand.

**`GET /api/code/permissions`** answers the one question the layers exist for:
*why* is this refused. It returns the layers **separately and in evaluation order**
(profile, project, session) rather than a merged map, because a merged answer tells
the user what is allowed but not who said so; reading the layers top to bottom is
exactly how the engine reaches its verdict. `?profile=` selects a profile the way a
run does, `?mode=` supplies the base mode when no profile is named (Ask, Plan and
Act resolve to different baselines, so showing one as "the" answer would be wrong
for the other two), and `?taskId=` adds that run's session rules — omitted, there
are simply no session rules to report.

### 12.6a A parked run records why, and the notification says it  *(new in 1.31)*

Every state transition a run makes to `blocked` or `ready_for_review` is a **park**:
the run stopped somewhere it can continue from, and it is waiting on a person.
`task_runs.pause_reason` now carries the reason, as a **token** from the park
vocabulary (`plan_ready`, `approval_required`, `doom_loop`, `loop_detected`,
`iteration_ceiling`, `context_exhausted`, `redaction_blocked`, `zdr_blocked`).

It did not before, and two readers had already been written as if it did:

- **The Attention Center** read `pause_reason ?? <a generic sentence>` for its
  `blocked`, `paused` and `ready_for_review` items. A fallback sentence only makes
  sense if a sentence is expected, so every parked run showed the fallback. The
  item's `detail` is now the sentence for the recorded reason, and the wording
  differs per reason **because the action does**: `redaction_blocked` invites a
  review of the flagged message, while `zdr_blocked` must not — nothing can be
  approved, and the block lifts only when a setting or a recorded provider fact
  changes.
- **A scheduled run's notification** worded itself from `result.ok`, and a park is
  `ok: false` — so a task that stopped *to ask a question* was announced as
  **"<task> failed"**. An unattended run parked on a plan now says it is waiting for
  review, a blocked one says it is paused, and each says why. A stop that is not a
  park (`cancelled`, `ceiling_reached`) keeps its old wording, because a rule the
  user set is not a park.

Two properties are load-bearing:

- **The column keeps holding a token, never a sentence.** Every other writer writes
  a token (`cancelled`, `ceiling_reached`, `approval_denied`), and a column that
  sometimes holds prose cannot be switched on later. The translation lives in
  `src/services/agent/parkMessages.ts`, at the point of display.
- **A bare transition still clears nothing.** `updateTaskRunState(runId, state)`
  without a reason moves only the state, exactly as before, so a run that becomes
  `ready_for_review` cannot lose an earlier `ceiling_reached`. `finishTaskRun`
  still rewrites the columns, so a finished run does not keep a park's reason.

The reason map is a total `Record<ParkReason, string>`: adding a park reason is a
compile error there until somebody decides what to tell the user.

### 12.6b An unanswered prompt expires  *(new in 1.31)*

The wait for an answer had no end. `pending_approvals` declared an `expired` state and
the comment said why it existed — "the reaper" — while no reaper had ever been written,
so a prompt stayed `pending` indefinitely: still listed as answerable, and a click on a
month-old one still authorised its call, against a conversation and a checkout from a
month ago. The deadline is `approval_wait_ttl_hours` (default **72**; zero and
negatives read as the default, the same rule the worktree TTL uses), and the sweep runs
once at boot and on the cleanup tick — boot because a deadline can pass while the
process is not running, which is exactly the case a timer-only sweep misses.

Four rules, each one a way this could be wrong:

- **The question expires; the task does not.** A parked run whose prompt expired stays
  parked and stays continuable: `POST /continue` without an `approvalId` replays the
  conversation and asks again. Ending the run would make a timer the thing that
  destroyed a recoverable task, so the deadline is on the row, never on the run.
- **Only `pending` is a wait.** `allow_session` is a standing rule and `allow_once` is
  spent by the replay it authorises; `closeApprovals` clears both at the task's
  terminal transition, because session allowances are scoped to the task that granted
  them (1.27 §1). A sweep that expired them would silently revoke a permission.
- **An answer beats the reaper.** The update is guarded on the row still being
  `pending`, so a decision landing in the same instant wins — the same mutex
  `resolveApproval` uses, and the reason the sweep reports only rows it actually moved.
- **A restart closes its own questions.** Boot reconciliation demotes a `blocked` run
  to `interrupted` with the message "it can no longer receive an answer"; leaving that
  run's approvals `pending` was the same bug one layer down, and would keep a dead
  prompt in the task's list and in the Attention Center as a `resolve` call that can
  only fail. The demoted park's approvals are closed in the same pass, session rules
  included.

The Attention Center reads `applied` from the decision response and says what happened:
a prompt that expired reads as **expired** and points at continuing the task, and a
prompt somebody already answered reads as already answered. Announcing an allowance
that was not granted is the one wording a prompt with a deadline must never produce.

### 12.6c Direct terminal execution and the human session  *(new in S17)*

`POST /api/code/execute-command` is the one route with no agent session behind it: a
caller posts a command and a cwd and gets `{ result }`. Two kinds of caller arrive
there, and the difference is what the server can prove about them.

**The exemption.** A request presenting the id and token of a *live interactive
session* is a person typing. Its command is not evaluated by the permission engine —
`ask`/`deny` is what governs agents, and confirming the command you just typed is a
prompt with one answer — and the response says so:

```json
{ "result": { "stdout": "…", "stderr": "", "exitCode": 0, "timedOut": false },
  "bypass": "human_session", "sessionId": "tsess_…" }
```

The claim travels in headers, never in the body:

| Header | Meaning |
| --- | --- |
| `x-hyperion-session` | the session id the server minted |
| `x-hyperion-session-token` | the token it was minted with (32 bytes, hex; shown once) |

No body field can grant the exemption. `human`, `bypass`, `sessionId` or
`sessionToken` in the JSON body are ignored, which is the difference between a
credential and a flag.

**Everything else.** A request without a valid session is an automated execution and
is evaluated by the permission engine as the `bash` tool over the `act` baseline plus
the project's rules (`?project=` selects the project, as in §12.3):

| Verdict | Response |
| --- | --- |
| `allow` | the command runs, and the response carries no `bypass` field |
| `ask` | **409** `approval_required`, naming the layer and rule |
| `deny` | **403** `permission_denied`, naming the layer and rule |

`ask` is a refusal rather than a park because a route-level command has no task and no
conversation to continue; the remedies are to change the rule or to run the command
from a live session.

**The sessions** are mounted at `/api/terminal` and are plain JSON.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/terminal/sessions` | open one; body may carry `{ taskId?, client? }` |
| POST | `/api/terminal/sessions/:sessionId/close` | end one; the token header is required |
| GET | `/api/terminal/sessions` | every live session, newest first, **never a token** |

`POST /sessions` answers **201** with the token once:

```json
{ "session": { "id": "tsess_…", "taskId": null, "client": "browser",
               "openedAt": 1790000000000, "lastSeenAt": 1790000000000,
               "expiresAt": 1790000900000, "hardExpiresAt": 1790028800000,
               "endedAt": null, "endedReason": null },
  "token": "…64 hex characters…", "expiresAt": 1790000900000 }
```

Closing with a wrong token or an unknown id answers **404** with the same sentence for
both, so the route cannot be used to discover which ids exist. A session expires after
**15 idle minutes** — renewed only by an authenticated command, which is the "right
now" half of the claim — and absolutely after **8 hours**; `endedReason` says which of
`closed`, `idle` or `expired` ended it.

**What the exemption does not cover.** The capability gate (including network egress),
the containment boundary (tightened to the session's task when it names one), the
256 KiB per-stream output bound, and the audit line all apply to an exempted command
exactly as to any other. There is **no rate limiter in this build**, so the exemption
neither adds nor removes one. The browser terminal these routes exist for is not built
yet — no frontend module calls them — which is why they are `deferred-frontend` in the
route snapshot and recorded in `frontend/contracts/gaps.md`.

### 12.7 The Design agent  *(new — the Design slice)*

Design registers at boot alongside Cowork and Code, so `/api/design/run-task`
streams SSE like any other agent run. `taskId` is optional (unlike Code): with
no worktree to name, the chat id is the identity when one is not supplied. A
design run shares the app-wide job lock with Cowork and chat (§12.1).

**The toolset is closed.** The model is offered exactly these tools, and the
permission engine refuses anything else as an unknown tool:

| Tool | Effect | What it does |
| --- | --- | --- |
| `design.generate_html` | mutate | Create the run's HTML+CSS draft (version 1) |
| `design.generate_svg` | mutate | Create an SVG asset artifact |
| `design.revise` | mutate | New version of an existing artifact; the `note` becomes the version label |
| `design.preview_snapshot` | read | Latest version + its sandboxed preview URL |
| `design.save_asset` | mutate | Declare the latest version the run's deliverable (returned in `TaskResult.artifacts`) |
| `design.brand_read` | read | The approved brand set; SVG content comes back inline |
| `design.brand_propose` | mutate | Propose a brand candidate — lands **unapproved** (§23) |
| `design.undo` | mutate | Restore the run's previous state of an artifact as a new version |
| `design.vision_verify` | read | Stub: always `{ status: 'unverified', checks: [...] }` |

There is no `bash`, `command`, `write` or `delegate`. Drafts are rows in
`artifact_versions` under keys `design:file:{runId}:{name}` — append-only, so
the history is the undo substrate: `design.undo` writes the prior content as
the next version, and nothing is ever overwritten or deleted. Model-
correctable mistakes (revising a draft that does not exist, undoing past the
first version, generating twice) come back as guidance in the tool output
rather than killing the run — iteration is the core loop here.

#### The sandboxed preview

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/design/preview/:versionId` | the draft bytes — `text/html`, or `image/svg+xml` for `.svg` keys |

Drafts are model output and therefore untrusted markup. The response carries
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src
data:` — no scripts, no network, no fonts — plus `X-Content-Type-Options:
nosniff` and `Cache-Control: no-store`. Embed it as `<iframe sandbox src=...>`
with **no** `allow-same-origin` and **no** `allow-scripts`: the attribute, the
CSP and the localhost bind are three independent layers. An unknown id, another
tool's artifact and a file-backed row all get the same **404 `not_found`**, which
confirms none of them.

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

Query parameters: `limit` (default 100, max 500), `severity` (`warning` \|
`error`), `since` (epoch milliseconds — a comparison value, so a fractional one
is quietly useless rather than refused). All three narrow the result. `total` counts every
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

### `GET /api/projects/:id/tasks`  *(new 2026-09-22)*

What in this project has not finished yet — the read a **switch warning** is made
of. Opening another project repoints containment and drops the per-task worktree
assignments, so a run that is in flight keeps running and stops being visible;
this is how a client can name what is being left behind before the user clicks.

```json
{
  "project": { "id": "8f3c…", "name": "Hyperion", "path": "C:\\…\\Hyperion", "managed": false,
               "createdAt": 1765000000000, "lastOpenedAt": 1765100000000 },
  "active": true,
  "tasks": [
    { "tool": "code", "taskId": "t-4c1…", "runId": "r-9ab…", "state": "blocked",
      "pauseReason": "approval_required", "chatId": null,
      "startedAt": 1765200000000, "updatedAt": 1765200300000 }
  ],
  "counts": { "total": 1, "running": 0, "paused": 0, "blocked": 1, "ready_for_review": 0 },
  "unattributedActive": 0
}
```

- **Tasks, not runs.** A task id can be run more than once (a retry, a
  continuation) and only the latest run per `(tool, taskId)` is listed, the same
  run `GET /api/{tool}/tasks/:taskId/state` answers with — so `tasks[0].runId` is
  the run a client would watch, and `counts.total` counts tasks.
- **Active means unfinished.** `running`, `paused`, `blocked` and
  `ready_for_review` are listed, including across all three tools. A run parked on
  an approval has not ended; it is the one most worth mentioning before somebody
  navigates away. Terminal states (`complete`, `error`, `stopped`, `interrupted`)
  are not history here and are omitted.
- **`active`** says whether this is the project the tools are scoped to right now
  (`activeId` of `GET /api/projects`), which decides whether the warning reads as
  "you are leaving this" or "you are coming back to this".
- **`unattributedActive`** is the count of active runs that name **no** project —
  started with nothing open, or written before migration `027` recorded a scope.
  They are never folded into whichever project happens to be open; the count is
  how a client can say "something else is running" instead of presenting the
  per-project number as the whole answer. It reaches zero for old rows only by
  those runs finishing.
- **`counts`** carries every key at zero, so a client branching on
  `counts.blocked` never has to tell "none" from "not said".

`404 not_found` for an unknown id (with `details.projectId`), like the other
per-project reads.

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
  id: string;                       // namespaced: `task:<runId>`, `scheduled:<id>` or `subagent:<id>`
  kind: 'task' | 'scheduled-task' | 'subagent';
  timestamp: number;                // when the run started
  status: 'running' | 'paused' | 'success' | 'failed' | 'stopped' | 'interrupted' | 'skipped';
  title: string;                    // a whole sentence, ready to render
  detail: string | null;            // the reason, when there is one worth reading
  link:
    | { kind: 'chat'; chatId: string }
    | { kind: 'artifact'; key: string; version: number }
    | null;
  spend: {                          // null when nothing was recorded
    requests: number;
    tokensIn: number; tokensOut: number;
    costUsd: number | null;         // null when no logged request had a price
    priced: boolean;
  } | null;
}
```

`spend` is scoped to the **run**, and a delegated child's requests are logged
against the run that made them — the parent's — so the parent's entry here already
includes them and the task total on `/api/{tool}/tasks/:taskId/state` (§12.4) is
the same money seen the other way. (This paragraph previously said the run figure
*excluded* delegated work. That was wrong: `childContext` hands a child the
parent's `llm`, so the wrapper that logs a request closes over the parent's task
**and run** ids. `subagent` entries therefore carry `spend: null` — not because
nothing was spent but because a child's share is not separable from its parent's,
and the parent's entry beside it is already the whole figure. No child requests
would be logged under a child run id.) `null` means nothing is known and must not
be rendered as `$0.00`; within a present value, `costUsd: null` with
`priced: false` means the figure is not the whole bill.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/activity` | `{ entries: ActivityEntry[], nextBefore: number \| null }` |

Query parameters: `limit` (default 50, max 200) and `before` (a timestamp cursor,
exclusive). Both are validated, so `limit=0`, `limit=201`, `limit=1.5`,
`limit=lots` and `before=-1` are all **400 `bad_request`** with the offending
field in `details.field`. This route was the first to keep the rule §1.2 now
states for every list route.

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
      "detail": "A step needs your go-ahead before it runs.",
      "link": { "kind": "chat", "chatId": "chat_18ba" }
    },
    {
      "id": "subagent:7c1e",
      "kind": "subagent",
      "timestamp": 1786168900000,
      "status": "success",
      "title": "Delegated task “Review the parser changes.” finished",
      "detail": "The change is safe; two nits in the tokenizer.",
      "link": null
    }
  ],
  "nextBefore": 1786169000000
}
```

**Three sources, merged:** `task_runs` (interactive Code, Cowork and Design runs,
§12.4), `scheduled_task_runs` (runs that fired on a timer) and `subagent_runs`
(one Code parent delegating to a child). Their stored status vocabularies differ
and are mapped onto the one set above, so the UI branches once rather than per
source. `paused` only ever comes from an interactive run and `skipped` only from a
scheduled one.

The mapping is worth stating because two of the words are easy to lose:
`task_runs.stopped` (012 — a user stop, a cancellation, a budget ceiling)
and `task_runs.interrupted` (020 — the process disappeared, or a park whose answer
can never arrive) are **not** `failed`. Migration 012 argued against printing a
failure the work did not suffer, and `success` would invent an outcome the run
never reached. A park (`blocked`, `ready_for_review`) reads as `paused`, and
`paused` itself is not written by any run in this tree — it is kept because the
column can hold it and older rows do.

`subagent` entries are the one kind with no link and no spend: a child has no chat
of its own (linking the parent's would make two entries look like one place), and
its spend is already inside its parent's entry. Its `detail` is the child's own
summary or the error it reported, and its title is built from the first line of
the prompt the parent wrote — a child has no name, and its prompt is the only
thing about it a person would recognise.

Every `detail` here is prose: the park tokens (`plan_ready`, `approval_required`,
`context_exhausted`, …) are translated by `src/services/agent/parkMessages.ts`
before they reach a reader. This route used to print `task_runs.pause_reason`
verbatim, which meant a real park rendered as the bare token `approval_required`
— the same defect the attention queue had, in another reader of the same column.

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

The listing is newest first: `created_at` descending, insertion order breaking
ties — two sources filed inside the same millisecond still list the later one
first.

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
(default 50, max 500).

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

**Text fields are clamped to fit the transport** (title 240 bytes, body 600, url
512, tag 128 — UTF-8, cut on a character boundary and marked with `…`). A Web
Push message is capped at 4,096 octets, and a scheduled run's summary is model
output bounded only at 4,000 characters, so it used to build a message the push
service refused: the rejection is not 404/410, so the subscription was kept and
the notification was simply never delivered — silently, and precisely for the
runs that produced the longest reports. The tray truncates anyway; the full text
is in the app the notification opens. See `buildPushBody`.

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

Both maps always carry every known capability: `cowork_research`,
`code_execution`, `network_egress`, `web_research`, `artifacts`, `chat_search`,
`memory_generation`. All of them default to **on**.

**`capabilities` is the stored switch; `effective` is what the backend acts on.**
They differ wherever one capability depends on another — `network_egress` is only
effective when `code_execution` is also on (§20.4) — so a UI can show a toggle as
on-but-inert instead of silently lying about it.

`network_egress` is the **only** derived entry. In particular `web_research` is a
peer capability, not a sub-toggle of `code_execution`: it governs the agent
fetching pages through a supervised MCP server, which needs no shell at all, so
turning code execution off leaves `effective.web_research` **true**. Refusals name
it as `capability_disabled` with `details.capability = "web_research"`.

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
| `tokenCeiling` | positive whole number; `0`, negative and fractional all → 400 (`asPositiveInteger`, the same helper the list routes use for `limit`) |
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

**What the cap counts, since 1.29: every provider request a task ran.** Agent
runs used to reach a provider without writing a `usage_log` row — only chat did —
so `spentUsd` omitted Code, Cowork and Design spend, and the cap judged autonomous
work against a total that was short by exactly the tasks it exists to bound. The
recording now happens in the agent context (§12.4), which every task run passes
through. A provider that quoted no tokens is still left out rather than entered as
zero, so `unpricedRequestsToday` and this total keep meaning what they say.

**The cap gates autonomous work only.** A scheduled task or a subagent spawn
refused by it returns **429 `spending_cap_reached`** with `label`, `capUsd`,
`spentUsd`, `windowResetsAt` and `unpricedRequestsToday` in `details`.
**Work the user starts themselves is never blocked** — see the matching entry in
`docs/CONTRACTS.md` for why that exemption is structural rather than a branch.
A scheduled run refused this way records itself `skipped`, not `failed` (§17.2).

Ceilings are enforced *during* a run rather than at its start. A task that trips
one stops cleanly and is recorded `stopped` with `pause_reason:
'ceiling_reached'` — **not `error`**, because nothing broke.

### 20.6 Outbound data safety — `GET|PUT /api/settings/redaction-check`  *(new in 1.23)*

A check on the way out: before a chat turn is sent to a **remote** provider, the
payload is scanned for credential-shaped text, and a match refuses the send.

```json
// GET
{ "enabled": false, "appliesTo": "remote", "enforced": "pattern_match" }

// PUT  { "enabled": true }
{ "enabled": true, "appliesTo": "remote" }
```

`enabled` is required on the `PUT`; omitting it is **400 `bad_request`** with
`details.field = "enabled"`. As in §20.4 the descriptive constants are on the GET
only.

**This is not a capability (§20.2), and the difference is the default.** Every
capability defaults to *on* and is something the user switches off. This defaults
to **off**: a false positive here blocks a message the user is trying to send, so
it has to be opted into rather than discovered by being interrupted.

`enforced: "pattern_match"` is deliberately honest, exactly like
`command_prefix_match`. The scan recognises vendor-prefixed keys (`sk-…`,
`ghp_…`, `AIza…`), `Authorization`-style values, and `api_key=`/`password=`-shaped
fields. It cannot recognise a secret that looks like ordinary text, and nothing
should be built on the assumption that it does.

**Only remote sends are checked**, and "remote" is decided from the provider's
type *and* its base URL. A `local` or `colibri` provider is a model on this
machine — but only if that is where its URL points, which is why the URL is part
of the question: a Colibrì or Ollama on another host is remote, and its payload
is scanned. Warning about a payload that never left would train the user to
dismiss the prompt, and so would warning about `unknown`; the gate fires on
`remote` and nothing else.

A declared `remote`/`opencodex`/`puter` provider is never downgraded to `local`,
even at `127.0.0.1`: `opencodex` is a local proxy that forwards to upstream
vendors, `puter` is a hosted service whose type is about its credential rather
than its address, and understating egress is the one direction this feature must
not fail in.

#### The refusal

A flagged send is **`redaction_flagged`** (status 409), raised *before* the
request leaves and before anything is written:

```json
{ "error": {
    "code": "redaction_flagged",
    "message": "This request appears to contain an API key with a recognisable vendor prefix, and the selected provider is remote. Review it, or resend with acknowledgeSensitive to send it anyway.",
    "retryable": false,
    "details": {
      "kinds": ["vendor_prefixed_key"],
      "providerClass": "remote",
      "hits": [{ "messageIndex": 3, "role": "user", "kind": "vendor_prefixed_key",
                 "index": 42, "length": 51 }]
    } } }
```

**On `POST /api/chat/stream` the refusal arrives as an SSE `error` frame under
HTTP 200, not as the envelope above** *(confirmed by HTTP smoke testing)*. The
stream is opened before the orchestrator runs, so by the time the gate refuses
the status line is already sent and cannot be changed. The frame carries only
what `sendError` puts on the wire (§1.3):

```
event: error
data: {"runId":null,"code":"redaction_flagged","message":"This request appears to contain an API key with a recognisable vendor prefix, and the selected provider is remote. Review it, or resend with acknowledgeSensitive to send it anyway.","retryable":false}
```

So **`details.kinds` and `details.hits` do not reach a streaming client** — only
`code` and `message` do. A client that wants to highlight the offending span has
to re-derive it, or branch on `code` alone and show the message. The envelope
form is what non-streaming callers of the gate receive. This is a known
limitation of the SSE frame shape rather than a property of the gate, and
widening `sendError` is deliberately left out of 1.23: it changes the wire format
for every existing event type.

**A hit is offsets and a rule name — never the matched text.** `index` and
`length` locate the span so the UI can highlight it in text the client already
has; putting the secret in the error would leak it into logs, the error log
(§13) and any crash reporter. There is a test asserting the serialized envelope
does not contain the key.

**409, not 403.** The request is not forbidden — it conflicts with the current
state of the message, and the user can resolve it. It is deliberately **not
retryable**: resending the identical body cannot succeed, so nothing should retry
it automatically.

#### Acknowledging

Resend with `acknowledgeSensitive: true` (§4.3) and the same message goes through.
The flag is **per request, not a stored preference** — consent to send one key is
not consent to send the next one.

**A refusal leaves the conversation exactly as it was.** The gate runs before the
user turn is persisted, so the transcript shows no half-written message and the
acknowledged resend stores the prompt **once**, not twice. This ordering is
load-bearing and there is a test for it.

One residual gap, stated rather than hidden: the scan classifies the provider the
turn is *about to* be sent to. A mid-run failover can move the turn to a provider
of a different egress class, and the gate does not re-run. The usage row records
the class that actually served the turn (§9.1), so the exposure summary stays
accurate even where the gate could not intervene.

---

## 21. Temporary chats and bulk delete  *(new in 1.20)*

### 20.7 ZDR, agent profiles and reload-config  *(reference completed 2026-09-21)*

Four settings routes that existed only in the handler comments until the
2026-09-21 sweep diffed the route snapshot against this file.

**`GET /api/settings/zdr`** — `{ requirement, allowed, appliesTo: 'remote',
enforced: 'provider_selection' }`. `allowed` is the full enum
(`off` / `prefer` / `require`), so a settings screen can render the options without
duplicating the list. `appliesTo: 'remote'` is not decoration: a local provider is
always eligible, so turning `require` on never affects local work — which is the
fact that makes the setting safe to switch on before every provider has been
assessed. `enforced` names where the enforcement lives (provider candidate
selection in `providers/router.ts`), so a reader does not go looking for a
network-level control.

**`PUT /api/settings/zdr`** — body `{ requirement }`, response `{ requirement,
appliesTo }`. An unrecognised value is a `400` naming the field rather than a stored
one: a stored value the reader does not recognise falls back to `off`, so accepting
a typo here would silently switch the policy **off** while the settings screen
showed whatever was typed.

**`GET /api/settings/agent-profiles`** — `{ count, defaultProfile, profiles }`.
`?includeHidden=true` is how the settings panel shows a profile the user chose to
keep out of the run picker; hidden is a **listing** concern only — a hidden profile
stays resolvable by name — so an editor that could not see one would have no way to
un-hide it. `?project=` reads that project's `.hyperion` profiles.

**`GET|PUT /api/settings/agents`** — the stored default profile, plus
`resolvedFor: { ask, plan, act }` and the built-ins. `resolvedFor` spells out what
each mode actually resolves to, because the answer is not "the stored default" for
two of the three: Ask and Plan outrank it deliberately, and a settings panel that
implied otherwise would be showing the user a control that does not do what it
says. `PUT` validates the name against the **built-ins only** — a project profile
cannot be checked here without knowing which project the next run will use, and
rejecting a name this endpoint cannot see would make a perfectly valid default
impossible to set — so resolution rechecks it per run and a name that never
resolves falls back to `act` rather than breaking every task.

**`POST /api/settings/reload-config`** — `?project=` (or `{ project }` in the body,
defaulting to `.`) re-reads and validates the on-disk configuration, returning
`{ project, settings, defaultAgentProfile, permissions, profiles, validated: true }`.
It adds **no cache**, and that is the whole design: settings are deliberately
un-cached and project files are read per task, so there is nothing stale for a
reload to clear. Its real value is reporting a malformed `.hyperion/permissions.json`
or a profile with a broken front-matter block *here*, on demand, instead of halfway
through the next run.

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
| GET | `/api/design/assets/approved` | `{ assets, total }` — query `limit` (default 100, max 500) |
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

## 24. The attention queue — `GET /api/attention`  *(new in 1.39 A1)*

What is *waiting on you*, as opposed to what has happened (§16) or is broken
(§6's summary). A parked approval is not a fault — the permission engine is
working exactly as designed — so it does not belong in a health verdict, and a
finished task stays in the feed forever while its wait leaves the queue the moment
it is answered. Same task in both lists is correct: the feed has its completion,
the queue had its wait.

```ts
AttentionItem {
  id: string;                 // stable across polls: `approval:<id>`, `plan:<runId>`, …
  kind: 'approval_required' | 'plan_ready' | 'interrupted' | 'paused' | 'blocked'
      | 'ready_for_review' | 'scheduled_run_failed' | 'backup_failure'
      | 'spending_cap' | 'mcp_disconnected';
  tool: 'chat' | 'code' | 'cowork' | 'design' | 'system';
  title: string;              // a sentence, ready to render
  detail: string;             // why it is waiting, in the user's terms
  createdAt: number;          // when the wait started
  taskId?: string; runId?: string; chatId?: string;
  resolve?: {                 // the call that answers it — never a frontend route
    method: 'POST'; path: string; body?: Record<string, unknown>;
  };
}

AttentionSource {
  source: string;             // 'pending_approvals' | 'task_runs' | 'chat_runs' |
                              // 'scheduled_task_runs' | 'backup_failures' |
                              // 'spending' | 'mcp'
  status: 'ok' | 'empty' | 'unavailable';
  count: number;
  reason?: string;            // present when `unavailable` — and sometimes when `ok`
}
```

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/attention` | `{ generatedAt, total, counts, items, sources }` |

No query parameters: the queue is "everything waiting on you", and narrowing it is
the reader's business — `kind` and `tool` are there for that. Always **200**; an
empty queue and a hundred unanswered prompts are both answers.

**Ordering is part of the contract.** `items` is grouped by the rank in the source
(`approval_required`, `blocked`, `plan_ready`, `interrupted`, `paused`,
`ready_for_review`, `scheduled_run_failed`, `backup_failure`, `spending_cap`,
`mcp_disconnected`) and **oldest first inside a kind** — a queue that reordered by
recency would bury the prompt that has waited longest. `counts` is per kind and
`total` is `items.length`, so a badge cannot disagree with the list under it.

**What each source means here**, including the two that are detected rather than
recorded:

| kind | source | when it appears |
| --- | --- | --- |
| `approval_required` | `pending_approvals` | a call the engine parked, across every task |
| `paused`, `blocked`, `ready_for_review` | `task_runs` | live run states; a paused run is resumable, a blocked one needs something the run cannot supply. The item's `detail` is the sentence for the run's recorded `pauseReason` (see §12.6a), not the token itself |
| `plan_ready` | `task_runs` + `task_steps(kind='plan')` | a `ready_for_review` run that produced a plan — **one item, not two**, because the plan is why it wants review |
| `interrupted` | `task_runs`, `chat_runs` | a task run in the `interrupted` state (migration `020`: boot reconciliation demotes what a dead process left mid-flight) plus the pre-`020` shape of the same event (`error` with `error_code: internal_error`, which existing databases hold and which is still reported), and a paused chat run with that code — the one a user sees as "the reply stopped halfway" |
| `scheduled_run_failed` | `scheduled_tasks.last_status` | the scheduler's own verdict, so a later success clears it with no window to expire |
| `backup_failure` | `error_log` | **detected**: a backup has no run record, so a failed request in the last 24h is the only evidence, and `sources[].reason` says so |
| `spending_cap` | `usage` + the cap setting | warns at 80% of the daily cap and states the refusal at 100%; when any request today is unpriced the detail says the total is a floor |
| `mcp_disconnected` | the MCP supervisor | a server the supervisor reports as `error`. `stopped` is not listed — that is a user's choice, not a problem to fix |

**A failure the user already saw is not a queue item.** `error` runs are excluded
unless the code is the interruption, because a queue is not a history — that is
what the feed and the error console are for.

**`sources` is part of the response, not a debugging aid.** A category that cannot
be read (no cap configured, no MCP manager in this process) is reported
`unavailable` with the reason, because a silently omitted category is
indistinguishable from a category that is fine. `sources` also carries the count
that was found, which is what makes an "empty" trustworthy.

## 25. Plugins — `/api/plugins`  *(new in 1.34)*

A plugin is not a fifth kind of thing: it is an **MCP server**, a **skill**, or a
**built-in** (Memory) — the things a tool may or may not be allowed to use. The hub
composes the registries that already own those records and adds the two facts that
had nowhere to live: who may use a plugin, and what it is.

### 25.1 `GET /api/plugins`

| Field | Meaning |
| --- | --- |
| `plugins[]` | one entry per plugin (see below) |
| `tools` | the tool vocabulary an availability answer can be given for |
| `orphanedAvailability` | stored overrides whose plugin no longer exists |
| `disclaimer` | the scan caveat, repeated at the top level |

Each entry:

| Field | Meaning |
| --- | --- |
| `id` | `mcp:<server id>`, `skill:<skill id>`, `builtin:memory` |
| `kind` | `mcp`, `skill`, `builtin` |
| `name`, `description`, `source` | display facts, read from the owning registry |
| `enabled` | **the plugin's own switch**, not who may use it |
| `consumers` | the tools whose code reads this plugin *today* |
| `availability` | `{chat, code, cowork, design, playground}` → boolean |
| `availabilityUpdatedAt` | when an override was last changed, `null` when all are defaults |
| `scan` | `{grade, summary, findings, disclaimer}` |

Four rules, each of which a plausible implementation could get wrong:

- **Composition, not duplication.** A server's command is read from `mcp_servers`,
  a skill's flags from the row intake wrote. A hub with its own copy of either
  would eventually disagree with the screen next to it.
- **`enabled` and `availability` are different questions**, and both are reported.
  `enabled` is the plugin's own switch ("this server is configured and turned on");
  `availability` is per tool ("Chat may use it, Code may not"). Collapsing them
  would make "off everywhere" and "off for one tool" the same row.
- **Absence is not off.** No stored row for (plugin, tool) means available
  (migration `025` argues this). A default of unavailable would silently change
  what every existing install can do the moment the hub shipped.
- **`consumers` is a fact about the code, not a promise.** Cowork is the only tool
  that consumes an MCP server today, and only the one it names; the skills summary
  reaches the three agent loops; Memory is read by the conversation surfaces and
  by Cowork. A `code` task run does not read Memory. Saying so is the point — an
  availability switch that appears to gate something that does not exist would be
  worse than no switch.

### 25.2 `PATCH /api/plugins/:id/availability`

Body `{ tool, available }` where `available` is `true`, `false`, or **`null`**.
`null` **deletes** the override — "back to the default" is the absence of a
decision, not a decision that happens to agree with the default. The response is
`{ plugin, pruned }`, where `pruned` counts debris the write cleared: overrides
whose plugin no longer exists are reported by the read and deleted by the next
write, because a `GET` that deletes rows is a `GET` that can fail on a read-only
database.

Refusals name the half that was wrong: `404` for an unknown plugin id (the id is
echoed), `400` for a tool outside `tools`, and `400` with `details.field:
"available"` when the decision itself is missing — an absent field must not
silently mean "use the default".

**What honours it today** (each asserted by a test):

| Plugin kind | Consumer | Effect of `available: false` |
| --- | --- | --- |
| `builtin:memory` | `services/memory/index.ts` | recall returns `null`; a write returns the outcome `unavailable` |
| `skill:*` | `orchestrator/agentContext.ts` | the skill is not offered to that tool's model; the Settings library still lists it |
| `mcp:*` | `services/cowork/agent.ts` | Cowork does not list, start or call the server, and says the switch is why |

**Seeded defaults appear here too.** The four seeded MCP servers (filesystem —
enabled; wigolo, graphify and browser-use — disabled, each because it has a
one-time setup) are ordinary entries: the hub composes them, so a seeded
browser-use server is read as a browser-driving server with no special case, and
its availability is decided like anything else's.

### 25.3 What the scan is, and is not

The scan is **static, offline, and local**: it reads what the registries already
stored (a server's transport, command, argument count, whether it holds a
credential, how many environment variables it declares; a skill's flags from
intake). It never spawns a process, opens a socket, or reads a skill's files again.

`grade` is one of three, and it is the **worst thing the reading found**:

- `builtin` — Hyperion's own content. The heuristic scan is not run on it by
  policy (the same exemption `riskscan.ts` makes for hand-authored skills), so the
  grade is about provenance, not safety, and the summary says that in words.
- `inert` — files and instructions; nothing found that acts.
- `active` — it runs a command here, talks to an endpoint, or a scan flagged it.

`findings` names what was found (`mcp.local-command`, `mcp.remote-endpoint`,
`mcp.browser-automation`, `mcp.stored-credential`, `mcp.environment`,
`mcp.disabled-not-stopped`, `skill.<category>`). `mcp.browser-automation` is its own
finding rather than part of `mcp.local-command` because a browser-driving server is
not merely local: it acts *as the user*, in the user's network position, on the
pages that machine is signed in to. The finding names the marker it matched
(`browser-use`, `playwright`, `puppeteer`, `selenium`, `chromedriver`) — evidence
for the grade, not a verdict on a package. A stored credential is named as a **fact about the plugin**;
its value — plaintext or stored ciphertext — never appears in the catalogue, and
a URL with credentials is redacted to `//***@` before it is shown. `disclaimer`
travels with every scan, in the same spirit as the skill risk report: a quiet
grade means nothing obvious was found, never that the plugin is safe.

---

## 26. Where this differs from SPEC.md's suggested surface

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
   `type` now includes `opencodex`, `colibri` and `puter`, Colibrì adds
   `/colibri/advisory` and `/colibri/probe` plus an acknowledgement flag on
   enable (§3.3), and Puter adds `/puter/advisory` (§3.4).
4. **`/api/skills` intake is two-phase** (`upload`/`fetch` → preview →
   `confirm`) rather than a single POST, because the spec requires a parsed
   preview, a credential recommendation and a risk report *before* registration.
5. **`/api/mcp/servers` PUT and PATCH share one handler** and update by entry
   rather than delete-and-recreate. `/status` reports `managed: true` once boot
   has started the supervisor, which happens before any server has connected;
   `managed: false` means `HYPERION_MCP_DISABLED=1` or boot has not got there yet.
6. **`/api/storage` adds `/stats`, `/cleanup` and `/cleanup/log`** so the sweep
   is inspectable and rehearsable instead of being an invisible cron.
7. **`/api/usage` adds a price table** (`/prices`, CRUD). Without it every cost
   is zero; with it, unpriced models stay NULL and are surfaced via `hasUnpriced`.
8. **`/api/backup` adds `GET /` and `POST /inspect`**, and import supports
   `dryRun`, because restoring overwrites the live database.
9. **`/api/settings` and `/api/memory` are new routers** — the first was implied
   by the `settings` table, the second is the 1.5 Memory plugin.
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
