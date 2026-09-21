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
edit `src/http/*` above a route, regenerate the file's pointers instead of leaving
them to rot. `node frontend/scripts/check-contracts.mjs --fix` does that — it
rewrites `source` from the same discovery pass the check uses and prints every
pointer it changed, while everything else it checks still fails the run. It cannot
make a wrong pointer pass; it can only make a stale one current.

## The statuses are claims too (2026-09-22)

`frontend-contracts.json` is hand-curated, and until this pass the check verified
its **shape** and the route snapshot beside it, but never asked whether a row's
`status` was still true. Two rows had drifted while the gate stayed green:

- `artifacts.lineage` recorded `/api/artifacts/:id/versions` as both the specified
  and the implemented path — a mismatch against itself — while its own `reason`
  documented the real, key-based route. The name it pointed at does not exist.
- `settings.reload` was the only mismatch row with no `reason` for the mismatch.

Four facts are decidable from the two snapshots, so they are checked now:

| rule | why |
| --- | --- |
| `implemented` ⇒ the route exists | a client calls a real route; if the route is gone, "implemented" is a claim about nothing. `{tool}` is expanded to `code`/`cowork`/`design` first, the same way the API-coverage check expands it. |
| `implemented` ⇒ a frontend module mentions the path | the other half of the same sentence, checked since 2026-09-22. Four rows were wrong about it: `providers.zdr`, `plugins.unified`, `plugins.availability` and `design.preview` each named a real route and no frontend module calls it. Test files do not count — a row must not pass on the strength of its own assertion. |
| `route-mismatch` ⇒ its own `expectedPath` exists | a mismatch needs an implementation to be mismatched with. This is the rule that catches a row naming a path that was never built. |
| `route-mismatch` ⇒ a non-empty `specifiedPath` **different** from `expectedPath`, plus a `reason` | "the spec asked for something else" is only useful with the something else named, and a row whose two paths are equal is not describing a mismatch. |
| no other status carries `specifiedPath` | that field answers "which path is this?" for a mismatch, and two answers on an `implemented` row is one too many. |

These are not derivable data, so `--fix` does **not** rewrite them: a status is a
review decision, and silently re-statusing a contract is exactly the kind of
change this directory exists to prevent. The check reports them and exits
non-zero, naming the row, its status and the fact that contradicts it.

`partial` and `missing` are deliberately **not** constrained this way. `partial`
can point at a route that does not exist yet (`projects.active-tasks`,
`search.global`) because it describes how far the frontend has got with a
requirement, not what the backend serves; `missing` is a gap by definition.

`route-mismatch` is not constrained by the client half either, and that is a
statement about what the status means rather than a hole: a mismatch records that
the specification's path and the implemented path differ, which is a fact about
paths and stays true whether or not a client has been written. Two mismatches have
no client — `tasks.continue` and `settings.reload` — and they are recorded in
`gaps.md`, which is the file that carries frontend progress. The client check is
deliberately one-directional: it can prove that *no* client mentions a path, which is
what makes a row's status false, and it cannot prove the right client calls it, since
the method is not compared.

The matcher is looser than a string comparison in two ways, both because of how the
clients are written: a parameter matches anything inside one path segment (the
clients use `${encodeURIComponent(id)}`), and the segment after `/api/` may be an
interpolated tool (`api/tasks.ts` writes `/api/${tool}/tasks/...`, while the ledger
spells each tool out because that is what the backend mounts). Anything else has to
match literally.
