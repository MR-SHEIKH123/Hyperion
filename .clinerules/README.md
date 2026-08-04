# `.clinerules/`

Working rules for Cline on this project. **Documentation only** — plain markdown,
read by Cline and nobody else.

Nothing here is part of the application:

- No `src/` file imports it.
- `tsconfig.json` has `"include": ["src/**/*.ts", "test/**/*.ts"]`, so `tsc`
  never looks at it.
- `npm test` runs `node --test test/*.test.ts`, which does not glob outside
  `test/`.

Deleting this directory would change nothing about how Hyperion builds or runs.

## The files

| File | Covers |
| --- | --- |
| `00-verification.md` | Verify on a real environment — the core rule |
| `01-coding-principles.md` | Error semantics, results vs failures, scope |
| `02-coding-style.md` | Module system, type strictness, boundary validation, comments |
| `03-security.md` | Localhost-only design, secret handling, filesystem containment |
| `04-database-schema.md` | Migrations are sha256-immutable |
| `05-testing.md` | The `helpers.ts` import-order trap, real servers over stubs |
| `06-docs.md` | Which document records what |
| `07-environment.md` | Windows/cmd.exe traps, killing processes safely |
| `08-interrogation.md` | Auditing my own claims before reporting done |

Most of these record a mistake that was actually made, and the reason the rule
exists. Keep the reasons when editing — a rule without its "why" gets
rationalised away later.