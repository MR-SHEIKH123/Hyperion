# Hyperion frontend

React/TypeScript frontend package. Milestone A uses Vite's development proxy and
does not change the backend to serve static files.

## Development

Start the backend from the repository root, then Vite in a second terminal:

```bash
npm start

cd frontend
npm install
npm run dev       # http://localhost:4318, proxies /api to http://127.0.0.1:4317
```

Set `HYPERION_BACKEND_URL` when the backend is not on port 4317. Browser code
must use relative `/api` URLs; only the Vite server communicates with the backend
target.

## Gates

```bash
npm run contracts
npm run typecheck
npm run test
npm run lint
npm run build
```

## Milestone A architecture

- `contracts/` is the checked route, frontend-contract, SSE, and known-gap
  snapshot. Known gaps stay visible without failing development; regressions to
  supported contracts fail `npm run contracts`.
- `src/contracts/wire/` contains Zod schemas at the network boundary only.
  Domain and view state remain ordinary TypeScript.
- `src/api/` owns relative requests, safe error normalization, upload/download,
  feature modules, and SSE parsing/session control. A dropped mutation stream is
  reconciled through task state and is never replayed automatically.
- `src/state/persistence/` stores only classified presentation state, safe drafts,
  and navigation hints. Credential fields, tokens, passphrases, approval secrets,
  attachment bytes, and lifecycle state are rejected.
- `src/state/task-machine/` maps the implemented backend TaskRun states into the
  frontend lifecycle. `connecting` and `reconnecting` are transport states;
  pending cancellation and approval-dialog visibility are metadata/UI state.
- `src/design-system/` provides the dark semantic tokens, reduced-motion rules,
  aperture identity, and accessible primitives.
- `src/workspaces/` is the shared Code/Design/Cowork frame. It owns composition,
  resize/restoration, focus regions, and deep-link panel targets, not tool logic.
- `src/dev-harness/` renders deterministic hard-to-reach states with production
  components. `/__dev/states` exists only under Vite development and is removed
  from production output.

## Milestone B — operational shell + Chat tool (in progress)

- `src/shell/` — `AppShell`: the eight-tool sidebar rail (Chat, Code, Cowork,
  Design, Playground, Plugins, Skills, Settings), brand mark, and the polling
  health indicator (worst-of-three verdict from `GET /api/health/summary`).
  Tools without a frontend yet resolve to an honest placeholder
  (`ToolPlaceholder`), never a fake panel.
- `src/tools/chat/` — the Chat tool, end-to-end:
  - conversation list: pin, archive/unarchive (archived is a separate view;
    archiving is never a step toward deletion), delete with confirmation;
  - transcript rendered from persisted truth; the stream hook contributes only
    the live rows (optimistic user prompt, rAF-batched assistant text);
  - pause banner with the run's pause reason and a Resume action (a fresh
    prompt on a paused run is a switch-and-resume);
  - pre-stream refusals (`busy` 409, no provider) keep the composer's draft —
    a refused send never swallows the user's text;
  - model picker against the active provider's live model list
    (`GET /api/providers/active/models`); a switched model persists to the
    chat.
- New-chat fast path: `/chat` accepts a prompt and creates the chat on first
  send; the pending prompt rides on location state into the created
  conversation and is cleared on consumption, so a reload cannot double-send.
- `src/contracts/wire/chat.ts` — Chat wire contracts: records, run snapshots,
  the cursor-paginated transcript page, and the stream payloads. The SSE
  decoders (`src/api/sse/events.ts`) validate the full documented payloads;
  note the chat `error` event carries the run error shape, not the HTTP error
  envelope.
- Stream settlement (`useChatStream`): a terminal frame settles by refetch;
  a non-terminal close settles from the reconciliation the api layer fetched
  (applied to the cache when it is a single page, refetch when the transcript
  is longer). A dropped stream is never replayed.

Remaining increments: the Code, Cowork, and Design tool workflows, then
Playground, Plugins, Skills, and Settings.

## Confirmed contract limitation

The current backend TaskRun union does not contain `interrupted`. Milestone A
therefore does not invent that lifecycle state. The development harness shows it
as an unavailable contract fixture until backend support exists.
