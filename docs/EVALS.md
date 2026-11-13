# Live evaluation (`npm run eval:live`)

The live-eval harness measures the agent against golden-shaped scenarios with
a **real provider**. It changes no product behavior and tunes nothing: it
drives the same production path an HTTP request would (`createAgentContext` →
`agent.runTask`) against a throwaway world, records what the loop already
records, and writes a report.

It is **opt-in only**. It is not part of `npm test`, not part of CI, and it
refuses to start unless you ask for it in full.

```bash
npm run eval:live -- --plan                          # what would run; spends nothing
npm run eval:live -- --confirm                       # run it (needs the env below)
npm run eval:live -- --confirm --repeats 5           # more repeats per scenario
npm run eval:live -- compare A/eval-results B/...    # two profiles, side by side
```

## Starting (the refusal)

A run starts only when **all** of these are present:

| Requirement | Why |
| --- | --- |
| `HYPERION_EVAL_LIVE=1` | the explicit opt-in; nothing runs without it |
| `HYPERION_EVAL_BASE_URL` | the endpoint the profile describes |
| `HYPERION_EVAL_MODEL` | the model to run |
| `--confirm` | the human in the room; a plan or a compare never needs it |

Missing anything → the command lists **every** missing requirement and exits
`2` without contacting anything. `HYPERION_EVAL_API_KEY` is optional: a
provider that needs one and does not get one fails as an error run, loudly,
not silently.

A `--plan` run needs the profile (it describes what it would do) but never
`--confirm`, and never spends: it prints the scenarios, the repeats, the
per-run ceilings and the worst-case whole-eval ceiling, then exits `0`.

### Choosing a profile

The env describes one *profile* — endpoint, model, key — and the same suite
is runnable against any number of profiles by running it again with
different env. `--plan` shows how the profile was read; `compare` puts two
result sets side by side.

`HYPERION_EVAL_PROVIDER_TYPE` may be set explicitly (`remote`, `local`, and the other
types the product supports). When it is not, the harness reads it from the
URL once, at startup: a URL that names a provider API family (`/v1`,
`/api/v1`, `/v3`, `openai`, `anthropic`) is read as `remote`
(chat-completions protocol); otherwise an API key present means `remote` and
no key means `local` (Ollama protocol, `POST /api/chat`). If you point a
`local` profile at a keyless OpenAI-compatible server, the server will 404
on `/api/chat` — include `/v1` in the URL or set
`HYPERION_EVAL_PROVIDER_TYPE=remote`. The choice is only about which protocol to
speak; it never changes what is measured.

## Isolation

Every invocation builds its own world and deletes it on the way out:

- **`HYPERION_HOME`** points at a fresh throwaway directory (the entry
  script sets it before any product module is imported — `config/env.ts`
  resolves paths once, at import). Database, projects, knowledge and
  worktrees all live there. `--keep` preserves the directory for debugging.
- **Project fixture**: the code scenario builds a temporary git repository
  (committed seed file, so "did the agent change something" has a baseline)
  and registers it through the same `provisionWorktree` path the product
  uses. The cowork and design scenarios write into the throwaway projects
  root.
- **Egress**: nothing leaves the machine except the requests to
  `HYPERION_EVAL_BASE_URL`. Background machinery is disabled for the run
  (scheduler, MCP supervisor, cleanup timer); outbound pulses are off by
  default in any case.
- **Approvals are never auto-approved.** A scenario that parks on an
  approval records the outcome `blocked` and stops — the harness does not
  push the product past its own gate.

## Budgets

Two layers, both enforced, both reported:

**Per run** — the existing task budget, nothing new: the same token ceiling
and step ceiling the product applies to any task (`ceilingLimits()`), plus a
wall-clock timeout (default `600000` ms, `HYPERION_EVAL_RUN_TIMEOUT_MS`).
A run that exceeds the wall clock is aborted through the run's own cancel
signal and records the outcome `timeout`. A provider that ignores the abort
is cut off by a backstop; the ceiling exists either way.

**Whole eval** — checked *between* runs, so an aborted run never starts:

- **Tokens**: defaults to the existing per-task token ceiling × the planned
  number of runs. `HYPERION_EVAL_TOTAL_TOKENS` tightens it (it can only make
  the ceiling smaller than the derivation, never larger).
- **Dollars**: `HYPERION_EVAL_TOTAL_USD`, and only when set. A price is a
  fact, not a guess — if the model has no price on record, cost is reported
  as **unpriced**, never as `$0.00`.

When a whole-eval ceiling trips, the remaining runs are skipped, and the
report says so in one line (`aborted: token ceiling N reached after K
run(s)`) plus an observation. Skipped runs are listed by scenario and repeat.

## What pass means

Pass is the golden test's **structural** expectation, never exact text:

| Scenario | Passes when |
| --- | --- |
| `code-edit` | the seeded note file changed (on disk, or in the run's `changedFiles`) |
| `cowork-knowledge` | the run produced an artifact *and* the knowledge it was asked about was in force |
| `design-draft` | the run produced an artifact |

Anything else — refused, parked, timed out — is not a pass, and the report
shows the outcome beside it.

## What each run records

Reported for every run, asserted only where noted above (the structural
pass): outcome (`complete | ready_for_review | paused | blocked | error |
stopped | timeout`), steps, tool calls by name, malformed / repaired tool
arguments, permission refusals, repeat-guard and doom-loop trips,
compactions, approval events, knowledge sources consulted, tokens
in / out / cached / reasoning, time to first token, total wall time, and
cost when priced. TTFT and malformed counts are measured by the harness
around the loop; everything else is read back from what the loop already
records (`task_steps`, `usage_log`, run knowledge, captured SSE events) —
the harness keeps no counters of its own.

## Reading a report

```
eval-results/<timestamp>/
  results.json     # the full machine-readable result set
  summary.md       # the same, as markdown
  transcripts.json # only with --include-transcripts
```

- **Totals** first: runs, pass rate, tokens, cost (or `unpriced`), the
  wall-clock and abort state.
- **Per scenario**: pass rate, outcome histogram, and medians — medians, not
  single runs. A report from one run is an anecdote; `--repeats` defaults to
  3 for that reason, and medians are what the summary quotes.
- **Per run**: the details listed above, one row each.
- **Observations last**, always: cache-hit rate below 50% of prompt tokens,
  permission parks, TTFT above 5000 ms, unpriced requests, context-window
  assumptions, aborted evals. Observations are what to look at first after
  the pass rate.

### Results are local and time-bound

Result sets describe **one run against one endpoint at one moment**. They
are written under `eval-results/`, which is gitignored on purpose: a number
from last week against a different model is not a fact about today. Commit
them only when you mean to — the default is not to.

Keys never appear in a result: the profile is recorded as
`hasApiKey: true/false`. Prompts and transcripts are stripped from
`results.json` unconditionally; with `--include-transcripts` they are written
to `transcripts.json` through the existing `redactSecrets` redaction — the
same scrubber the HTTP layer uses — so a transcript cannot carry an API key
or bearer token.

## Comparing two profiles

```bash
HYPERION_EVAL_BASE_URL=… HYPERION_EVAL_MODEL=… npm run eval:live -- --confirm
# …again with a different profile…
npm run eval:live -- compare eval-results/A eval-results/B
```

`compare` prints the two result sets side by side — pass rates, medians,
totals, aborts — and adds nothing of its own: no verdict, no winner. The
numbers are the comparison.

## Testing

The harness's own logic — config validation, the refusal to start, budget
aborts, aggregation, outcome mapping, report writing, redaction — is
unit-tested in `test/eval.test.ts`, which **does** run in `npm test`,
including two runs against the mock provider (one that completes, one that
hangs past its wall clock). The only part excluded from `npm test` is
execution against a real endpoint, because that spends real tokens.

The budget-abort and refusal assertions are mutation-checked: gutting either
piece of logic fails the suite.

## Cost model

- Per-run cost comes from `usage_log` as the product records it, priced
  through the model's price on record. No price → the run is *unpriced*;
  unpriced runs are counted and named, never valued at zero.
- The whole-eval dollar ceiling exists only if `HYPERION_EVAL_TOTAL_USD` is
  set, because only you know what this session is worth.
- `--plan` prints the worst-case token ceiling before anything runs; the
  dollar worst case is only meaningful once a price exists, and the plan
  says so rather than inventing a number.

## Environment reference

| Variable | Meaning | Default |
| --- | --- | --- |
| `HYPERION_EVAL_LIVE` | opt-in, must be `1` for a run | unset (refuses) |
| `HYPERION_EVAL_BASE_URL` | profile endpoint | unset (refuses) |
| `HYPERION_EVAL_MODEL` | profile model | unset (refuses) |
| `HYPERION_EVAL_API_KEY` | profile key, if the endpoint needs one | unset |
| `HYPERION_EVAL_PROVIDER_TYPE` | `remote` \| `local` | inferred from the URL |
| `HYPERION_EVAL_REPEATS` | repeats per scenario | `3` |
| `HYPERION_EVAL_RUN_TIMEOUT_MS` | per-run wall clock | `600000` |
| `HYPERION_EVAL_TOTAL_TOKENS` | whole-eval token ceiling | per-run budget × runs |
| `HYPERION_EVAL_TOTAL_USD` | whole-eval dollar ceiling | unset (no dollar abort) |
