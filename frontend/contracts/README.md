# Frontend contract snapshot

This directory is the checked boundary between Hyperion's existing backend and
its frontend. It is deliberately not generated into an API client:
the Express handlers do not carry enough schema metadata for trustworthy client
generation.

- `backend-routes.json` records every route mounted by `src/http/app.ts`.
- `frontend-contracts.json` records frontend-relevant implemented, partial,
  mismatched, missing, and intentionally unsupported contracts.
- `sse-events.json` records the two real streaming protocols. Chat uses named
  SSE events; agent tools use an `agent` event with a `channel` discriminator.
- `gaps.md` records gaps without hiding them behind client workarounds.

Run `node frontend/scripts/check-contracts.mjs` after changing an HTTP route.
Removing or changing a snapshotted route fails. Known missing contracts stay
visible and do not fail the check.

Each route's `source` is `file:line`, and it points at that route's own
`router.verb(` registration so a reader can jump from the contract to the
handler. Since 2026-09-21 the check compares every `source` against the
registration it found, not just the set of routes: by then **92 of 180** entries
had drifted to the wrong line (any file that gained lines above a route moved it),
which no gate noticed because only the route *set* was ever compared. A stale
pointer is a claim the snapshot cannot support, so it now fails the check.

This is also why the line numbers here are honest rather than decorative: if you
edit `src/http/*` above a route, regenerate the file's pointers (the check names
the expected line for each one) instead of leaving them to rot.
