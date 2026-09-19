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
