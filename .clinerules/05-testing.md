# Testing rules

## The import-order trap in `test/helpers.ts`

`test/helpers.ts` sets `HYPERION_HOME` (and the bind guard, log level, timeouts)
**as a side effect of being imported**, because `src/config/env.ts` resolves every
path once at import time.

So every test file must:

```ts
import './helpers.ts';                       // static, first
const { createApp } = await import('../src/http/app.ts');   // dynamic, after
```

A *static* `import` of anything under `src/` would be hoisted above the helper and
run against the user's real `~/Hyperion` — reading, writing and deleting their
actual data. Every `src/` import in a test is therefore `await import()`.

Use `freshDb()` for an isolated migrated database per file, and `cleanupHome()`
in `after`. `cleanupHome` closes the database first because Windows will not
unlink a file that still has an open handle, and SQLite holds `.db`, `-wal` and
`-shm` open until closed.

## Prefer real servers to stubs

`startMockProvider()` is a real HTTP server speaking the OpenAI-compatible
protocol, deliberately rather than a stubbed adapter: SSE framing, chunk-boundary
buffering and mid-stream truncation are exactly the parts most likely to be
wrong, and a stub asserts none of them.

Follow that instinct for new tests. `test/httperrors.test.ts` is the pattern for
HTTP-level coverage — boot `createApp()` on port `0`, read the assigned port from
`server.address()`, drive it with `fetch`, close it in `after`.

## Test names are sentences

Names state the guarantee in prose, from the caller's point of view:

> `a dead provider with no alternative pauses the run instead of throwing`
> `a rejected API key never counts toward the eviction threshold`

Not `test_provider_failover_2`. Group related cases in a `describe` block whose
name reads as the subject of those sentences.

## Every fix ships with a test that would have caught it

A bug fix without a regression test is unfinished. The test must fail without the
fix — if it passes either way, it is not testing the fix.

Assert the *whole* observable result: status, envelope shape, and the absence of
anything that should not have leaked. `the parser message never reaches the
client` asserts on the raw response text for exactly that reason.