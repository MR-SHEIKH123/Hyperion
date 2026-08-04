# Security practice

## Localhost-only, no auth — by design

The app binds `127.0.0.1` and has no authentication layer. That is a deliberate
decision, not an oversight.

- Do not add an auth layer, tokens, or sessions "for safety".
- Do not bind `0.0.0.0` or any public interface, and do not weaken the bind guard
  to make something convenient.

Because there is no auth, the localhost boundary *is* the security boundary. Every
other rule here follows from that.

## Secrets never leave the server

- Public serializers expose a short hint (4 characters), never key material.
  There is a test asserting exactly this — keep it passing.
- **Upstream provider error bodies never reach the client.** Real gateways echo
  the rejected credential in the body of a 401. Redact before logging, and keep
  the redacted copy server-side so the failure is still diagnosable.
- The same applies to *any* text that quotes the request. body-parser's parse
  error includes the offending body, so a request whose body was a pasted secret
  would have that secret reflected back. Put such text in `privateDetails`, which
  `toJSON()` omits and which `errorHandler` logs only when `status >= 500`.
- Use `redactSecrets` rather than writing a new masking routine.

## Filesystem access is contained

All filesystem access goes through the containment checks in
`src/security/fsScope.ts`.

- Resolve and verify before touching a path; never trust a caller-supplied path.
- Reject NUL bytes — they can truncate a path inside a syscall.
- A sibling directory whose name merely starts the same is **outside** the scope.
- Never widen a scope to make a call succeed. If a legitimate operation is being
  refused, the boundary is the wrong shape and that is the thing to fix.

## Never commit

`*.key`, `secret.key`, `.env`, `*.db`, `*.db-wal`, `*.db-shm`, `*.sqlite`, and
anything under the runtime data root. `.gitignore` already guards these — do not
loosen those patterns.

Note the anchoring comment in `.gitignore`: unanchored patterns like `skills/`
match at every depth and once silently swallowed the whole
`src/services/skills/` source tree. Keep runtime-data patterns anchored with a
leading slash.

**If key material is ever committed, every stored provider key must be considered
compromised and rotated.** Say so immediately rather than quietly removing the
file.