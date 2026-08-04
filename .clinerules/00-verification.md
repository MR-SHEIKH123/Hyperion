# Verify on a real environment — do not just read code

A green typecheck and a green test suite are **not** evidence that a feature
works. Before reporting anything as working or complete, exercise it the way a
user would: start it, send it real input, and read the real response.

## The rule

- Never claim a feature works on the strength of code reading alone.
- Never mark a checklist item complete without on-disk or on-the-wire evidence.
- If something was not actually run, say so plainly instead of implying it was.

## The order to verify in

1. `npm run typecheck` — must exit clean.
2. `npm test` — the full suite, not just the file just edited.
3. **Boot the server and send real requests** for anything HTTP-facing.

## Why this rule exists

On 2026-08-04 the user asked whether the APIs had ever actually been tested on a
running environment. The honest answer was no — every prior claim rested on
module-level tests. Booting the server and sending real requests for the first
time immediately found two genuine bugs:

- `GET /api/providers/%ZZ` returned **500 internal_error** instead of 400.
- A malformed JSON body returned **500** *and echoed the request body back to
  the client* — so a pasted secret would have been reflected in the error.

179 tests were passing the whole time and caught neither, because neither path is
reachable without a real socket. That is the entire justification for this file:
the test suite cannot see what it never connects to.

## Running a smoke pass by hand

There is deliberately no `npm run smoke` script — `.clinerules/` must not add
runnable code to the project. Do it manually:

- Start the server with `HYPERION_HOME` pointed at a **throwaway** directory, a
  spare port, and `HYPERION_CLEANUP_DISABLED=1`. Never smoke-test against the
  user's real `~/Hyperion`.
- Check at minimum: `/api/health`, every mounted router answering rather than
  404ing, the 404 envelope shape, a malformed-JSON request returning 400, and
  any acknowledgement or refusal gate relevant to the change.
- Afterwards: stop the server by **PID** (see `07-environment.md`), delete the
  scratch home and any log files, and confirm with `git status --short` that no
  scratch artifact is about to be committed.