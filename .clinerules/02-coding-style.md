# Coding style

## Module system

- Node 22 native TypeScript, ESM, `"type": "module"`.
- **Every intra-project import carries an explicit `.ts` extension**
  (`allowImportingTsExtensions` is on). `from './errors.ts'`, not `'./errors'`.
- `verbatimModuleSyntax` and `erasableSyntaxOnly` are on. Use `import type` for
  type-only imports. No enums, no parameter properties, no namespaces, no
  decorators — nothing that needs a transform to erase.

## Type strictness

`strict` and `noUncheckedIndexedAccess` are both on. Index access yields
`T | undefined` — narrow it with a check, do not cast it away. If a cast seems
necessary, the shape is probably wrong one level up.

`src/http/params.ts` collapses awkward unions once (see `pathParam`, which folds
Express 5's `string | string[] | undefined`) so call sites stay clean. Prefer
adding a helper there to sprinkling casts at use sites.

## Validation lives at the boundary

Everything from the frontend arrives as `unknown`. Narrow it with the helpers in
`src/http/params.ts` — `body`, `asString`, `asOptionalString`, `asNullableString`,
`asNumber`, `requireNumber`, `asBool`, `asStringArray`, `asStringRecord`,
`asEnum`, `asTool`, `pathParam`, `queryString`, `queryNumber`, `queryBool`.

Never hand-roll `typeof` checks in a route. The helpers name the offending field
in `details.field`, which the UI shows next to the form control.

Required values throw; optional ones return `undefined` so a PATCH route can pass
the result straight to an `update*()` call, where `undefined` already means
"leave this column alone". `null` counts as omitted, except in
`asNullableString`, where it means "explicitly clear this".

## Comments

Explain **why**, not what. A comment earns its place when it records a hidden
constraint, a subtle invariant, a workaround for a specific bug, or behaviour
that would otherwise surprise the reader.

The existing files are the reference standard: module-level block comments state
the purpose and the reasoning; inline comments mark the non-obvious. Do not
narrate the current task, the fix, or who calls the function — that belongs in
the commit message and rots as the code moves.