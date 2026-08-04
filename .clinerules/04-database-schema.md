# Database schema rules

## Migrations are immutable — this one bites

`src/db/migrate.ts` takes a **sha256 of the entire file text** of every migration
and compares it against the checksum recorded when that migration was applied. If
they differ it throws:

> Migration "..." was modified after being applied ... Migrations are immutable —
> add a new migration file instead of editing this one.

That hash covers **comments and whitespace**. Editing so much as a typo in a
comment inside an already-applied migration turns into a **fatal boot error on
every existing install**, including the user's own dev database.

So: **never edit a migration that has shipped.** Not the SQL, not a comment, not
formatting.

## To change the schema

Add the next numbered file in `src/db/migrations/`. Current state:

```
001_init.sql
002_opencodex_provider_type.sql
003_skill_dependencies.sql
004_chat_archive_index.sql
005_colibri_provider_type.sql
```

The next one is `006_*.sql`. Name it after what it does.

Widening a `CHECK` constraint — a new provider type, for instance — is its own
migration, and it ships with a test proving a row of the new type actually
survives the constraint. `002` and `005` are the pattern to copy.

## I have already nearly broken this

In an earlier session I offered to tidy two stale comments in `001_init.sql`,
claiming it was safe because "SQLite never re-reads a migration once applied".
That was wrong. I caught it only because I read `migrate.ts` before editing.

The general lesson, which applies well beyond migrations: **read the code that
consumes a file before assuming an edit to it is cosmetic.**