# Coding principles

## Errors are values with meaning

Every failure becomes an `AppError` carrying a code the frontend can branch on
(`bad_request`, `not_found`, `scope_violation`, `internal_error`, ...). Do not
invent ad-hoc error shapes, and do not throw bare strings or plain `Error` across
a layer boundary.

`internal_error` means *we* are broken. If the caller could fix the problem by
changing what they sent, it is a 4xx — not a 500.

## A result is not a failure

`detectResource` answering `invalid` is a **200**. An unreachable host or an
archive full of nothing recognisable is an *answer*, and the reason belongs in
the payload for the UI to display.

Reserve 4xx for the cases the user can fix by retyping — a malformed URL, a
missing required field, a non-http scheme.

## Do not guess on the user's behalf

When input is genuinely ambiguous — a repository that is both a skill and an MCP
server — report both and let the user choose. Silently picking one installs the
wrong thing with no way for them to notice.

## No silent fallbacks

A fallback that hides a broken dependency turns a loud failure into a confusing
one. If something required is missing, say so. Fall back only where the fallback
is itself a correct, intended behaviour (for example, working directly in a
project that is not a git repository), and comment why.

## Scope

Do not add features, abstractions, or error handling beyond what the task needs.
Three similar lines beat a premature abstraction. Do not build for hypothetical
future requirements, and do not leave half-finished implementations behind.