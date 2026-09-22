# Hyperion frontend

React/TypeScript frontend package. The development setup uses Vite's
development proxy and does not change the backend to serve static files.

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
npm run contracts   # the static snapshot: routes, contracts, SSE, gaps
npm run wire        # the same boundary, live: real responses against the real schemas
npm run typecheck
npm run test
npm run lint
npm run build
```

`npm run wire` boots the backend in-process and parses every response the frontend
has a schema for, **and** streams it drives for real (chat turns, a provider failover,
a run that fails), through the frontend's own schemas and its own SSE decoders. A
schema or a decoder that disagrees with the backend fails here instead of in whichever
surface is built on it first. It has found two of that class: a required `updatedAt`
the backend has never sent, and the agent protocol's `error` frame being decoded with
the HTTP envelope schema — which swallowed the terminal event of every failed task
run. Details in `contracts/README.md` and `docs/CONTRACTS.md`.

## Architecture

- `contracts/` is the checked route, frontend-contract, SSE, and known-gap
  snapshot. Known gaps stay visible without failing development; regressions to
  supported contracts fail `npm run contracts`.
- `src/contracts/wire/` contains Zod schemas at the network boundary only.
  Domain and view state remain ordinary TypeScript.
- `src/api/` owns relative requests, safe error normalization, upload/download,
  feature modules, and SSE parsing/session control. A dropped mutation stream is
  reconciled through task state and is never replayed automatically.
- `src/state/persistence/` stores only classified presentation state, safe drafts,
  reading positions, and navigation hints. Credential fields, tokens, passphrases,
  approval secrets, attachment bytes, and lifecycle state are rejected — the
  classification walks the whole object on every write, so a rejected draft never
  reaches storage at all. It is mounted once (`PersistenceProvider`, one store per
  tab, in-memory fallback when the browser refuses storage): `usePersistedDraft`
  keeps an unsent prompt (debounced, flushed on unmount, blank drafts removed) and
  `useScrollAnchor` keeps where the reader was as a row id plus a pixel offset
  rather than a `scrollTop`, so a resize does not move it.
- `src/state/task-machine/` maps the implemented backend TaskRun states into the
  frontend lifecycle. `connecting` and `reconnecting` are transport states;
  pending cancellation and approval-dialog visibility are metadata/UI state.
- `src/design-system/` provides the dark semantic tokens, reduced-motion rules,
  aperture identity, and accessible primitives.
- `src/workspaces/` is the shared Code/Design/Cowork frame. It owns composition,
  resize/restoration, focus regions, and deep-link panel targets, not tool logic.
- `src/components/Provenance/` is the provenance view (Prompt 1.39 A6): a version
  timeline where each row names the version it replaced (derived by the backend,
  so "no parent" reads as a beginning and never as an unknown) and the knowledge
  sources a Cowork run used *as evidence* — the usable ones, because a source that
  was consulted and found missing is not evidence and saying otherwise would
  overclaim. Both reads render their own failure; the panel is shown in the dev
  harness, and since 2026-09-21 the Code surface hosts the timeline at
  `/code?file=<artifact key>`.
- `src/tools/code/` is the first tool to populate the workspace frame (Prompt 1.39
  A3): a read view of the Code lane (running slots, queue depth, capacity, and
  parked worktrees listed apart because they hold disk rather than a slot), the
  selected task's state through the task machine and its recorded spend, and the
  version timeline for a named file. It refuses three lies by construction — it
  does not start tasks (the composer says the work is unbuilt), it does not invent
  a task history the backend cannot serve (the rail is the live lane), and it never
  renders an absence as a figure: `requests: 0` reads "nothing was recorded, which
  is not the same as free", a null total reads "unpriced", and a partly priced
  total is labelled a floor. The Attention Center's Code items deep-link here with
  no caveat; Cowork and Design still open placeholders, and those keep theirs.
- `src/components/PrivacyIndicator/` is the point-of-action privacy line
  (Prompt 1.39 B): egress class, retention status, standing requirement and the
  redaction-check flag, rendered by the composer from
  `GET /api/providers/active`. It states facts and derives no verdict — whether a
  status satisfies a requirement is decided server-side. The wire contract
  enumerates `egress` and the ZDR status/requirement values, so a value this
  frontend cannot label is refused as a contract mismatch rather than rendered as
  an ambiguous badge. Since 1.37 it also names the egress proxy, in both
  registers — `via proxy host:port (off this machine)` in the short line and the
  redacted URL in the sentence — because a proxy the user has forgotten they
  configured is exactly the fact that can make a "local" provider not be local;
  the backend hands over a redacted URL, so there is no credential here to leak.
- `src/dev-harness/` renders deterministic hard-to-reach states with production
  components. `/__dev/states` exists only under Vite development and is removed
  from production output. Every fixture names the surface that produces it, or
  says plainly that no surface does — interrupted tasks, provider cooldown and
  design-preview failure are recorded as **not exposed** rather than faked. The Code
  surface's parts are fixtures too (a busy lane, an idle lane, and spend in every
  shape), because those components take their data as props and never fetch — which
  is why the harness still makes no network call. The
  dangerous-command confirmation is rendered with the production `Dialog` and
  labelled a primitive preview, because the Code approval surface does not exist
  yet.

## Operational shell + Chat tool (in progress)

- `src/shell/` — `AppShell`: the eight-tool sidebar rail (Chat, Code, Cowork,
  Design, Playground, Plugins, Skills, Settings), brand mark, and the polling
  health indicator (worst-of-three verdict from `GET /api/health/summary`).
  Tools without a frontend yet resolve to an honest placeholder
  (`ToolPlaceholder`), never a fake panel.
- `src/tools/chat/` — the Chat tool, end-to-end (the composer carries the
  point-of-action privacy line next to the send control):
  - conversation list: pin, archive/unarchive (archived is a separate view;
    archiving is never a step toward deletion), delete with confirmation;
  - transcript rendered from persisted truth; the stream hook contributes only
    the live rows (optimistic user prompt, rAF-batched assistant text);
  - pause banner with the run's pause reason and a Resume action (a fresh
    prompt on a paused run is a switch-and-resume);
  - pre-stream refusals (`busy` 409, no provider) keep the composer's draft —
    a refused send never swallows the user's text; and the draft itself outlives
    the tab: the new-conversation box and every conversation remember what was
    typed until it is sent (Prompt 1.39 A5);
  - the transcript reopens where it was left, and stops following the tail as
    soon as the reader scrolls back — streamed tokens no longer pull the page
    away from someone reading;
  - model picker against the active provider's live model list
    (`GET /api/providers/active/models`); a switched model persists to the
    chat;
  - fork (1.27): branches the open conversation (`POST /api/chat/:id/fork`) and
    opens the branch, saying how many messages came across and how many of them
    were mid-stream and landed paused — the branch has no writer, so `streaming`
    there would be a claim nothing can keep. The source is deliberately left
    alone *and* not refetched: the copy does not touch it, and a refetch would
    only risk dropping the page someone is reading. A refused fork (a temporary
    chat, a `409`) says so and leaves the user in the conversation they were in.
- A conversation is addressed by `/chat/<chatId>` — the id is the splat
  remainder of the `chat/*` route, and `/chat` is the new-conversation state.
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

The current backend TaskRun union does not contain `interrupted`. The frontend
therefore does not invent that lifecycle state. The development harness shows it
as an unavailable contract fixture until backend support exists.
