# Documentation rules

Three documents, three jobs:

- **`docs/API.md`** — the endpoint reference. Numbered sections, one per router
  (e.g. `## 13. Resources — /api/resources`). A new or changed endpoint updates
  this: method, path, request shape, response shape, and the error codes it can
  return.
- **`docs/CONTRACTS.md`** — invariants and **why** they exist. This is the file
  that stops a future change from silently undoing a deliberate decision. Entries
  are written as prose explaining the reasoning, and are tagged with what
  introduced them (`(added by Prompt 1.12)`, `(found by HTTP smoke testing)`).
- **`docs/SPEC.md`** — the overall design and intent.

## Rules

- A behaviour change updates the relevant document **in the same commit**. Docs
  that lag behind the code are worse than no docs, because they are believed.
- When a bug turns out to have been possible because an invariant was never
  written down, write it down in `CONTRACTS.md` as part of the fix.
- Record the *reason*, not just the rule. "413 is preserved rather than flattened
  to 400" is a rule; "because the frontend branches on the code, so the code is
  normalized and the status restored" is the reason, and that is what prevents
  someone re-flattening it later.
- Do not create new planning, analysis, or summary documents unless asked. The
  three files above plus commit messages are the record.