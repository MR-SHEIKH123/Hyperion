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

## Confirmed contract limitation

The current backend TaskRun union does not contain `interrupted`. Milestone A
therefore does not invent that lifecycle state. The development harness shows it
as an unavailable contract fixture until backend support exists.
