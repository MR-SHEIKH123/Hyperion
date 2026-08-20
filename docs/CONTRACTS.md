# Cross-prompt contracts

Behaviour that more than one part of the system depends on. If you change
something described here, the other side breaks — so change both.

---

## Skill dependency status (added by Prompt 1.6)

**Who depends on this:** Kimi's agentic layer (Prompt 3, skill-consumption) must
check a skill's dependency status *before* running any of that skill's scripts.
The frontend depends on it to explain a failure the user can act on.

### The gap this closes

Skill intake validates that a skill *looks* fine — `SKILL.md` parses, the risk
scan finds nothing alarming. It never established that the skill can actually
**run**. A skill whose `analyse.py` imports `pandas` passes intake perfectly and
then fails the first time an agent tries to use it, halfway through a task.

Provisioning happens once, at intake, so that failure surfaces at install time
when the user is present and can fix it.

### Where dependencies come from

After the risk scan, intake looks for any of these — more than one may be present
and all are read:

| Ecosystem | Manifest |
|---|---|
| Python | `requirements.txt`, `pyproject.toml` (PEP 621 `project.dependencies` and Poetry) |
| Node | `package.json` (`dependencies`; `devDependencies` ignored) |
| Either | a `dependencies:` list in the `SKILL.md` front-matter |

No manifest anywhere means status `none-declared`. Instruction-only skills are
the common case and are never blocked by this.

### Where things get installed

Per skill, never shared:

```
~/Hyperion/skills/<skill>/.venv/          Python
~/Hyperion/skills/<skill>/node_modules/   Node
```

Nothing is installed into the app's own environment or into the app's root
`node_modules`. One skill pinning an old version of a library cannot affect
another skill, or Hyperion itself.

### The status field

Exposed as `dependencies` on every skill object from `GET|POST|PATCH|DELETE
/api/skills` and, in short form, on `/api/skills/summary`.

| `status` | Meaning |
|---|---|
| `none-declared` | Nothing to install. Runnable. |
| `ready` | Everything declared is installed. Runnable. |
| `partial` | Some installed, some failed. **Not runnable** — `failed[]` says which and why. |
| `failed` | Nothing installed. **Not runnable** — `error` says why. |
| `needs-user-approval` | Packages are fine; a system binary is missing and needs the user's go-ahead. **Not runnable**, but nothing has failed — see Prompt 1.8(a) below. |

**Read `dependencies.runnable`, not `status`.** It is the single boolean the
agentic layer should branch on, and it folds in three things `status` alone
misses:

- `installing` — provisioning is in flight right now.
- `stale` — the manifests changed since we installed, or the installed files are
  gone (a restored backup: `.venv/` and `node_modules/` are deliberately not
  included in a backup archive, so they are re-provisioned rather than restored).
- `partial` counts as not runnable, deliberately. A skill missing one of the
  packages it asked for will fail *somewhere in the middle of a task*, which is
  the exact failure this feature exists to prevent. Better to decline up front
  and say which package is missing.

### What the agentic layer should do

```
if (!skill.dependencies.runnable) {
  // Don't run the skill's scripts. Tell the user what's missing:
  //   dependencies.failed[]        → { name, spec, error }
  //   dependencies.missingBinaries → system commands not on PATH
  //   dependencies.error           → overall reason
  // POST /api/skills/:id/provision retries after they've fixed it.
  // status === 'needs-user-approval' means ask, don't retry: nothing failed.
}
```

When running a skill's scripts, use the interpreter the skill was provisioned
with, not the system one:

- `dependencies.pythonPath` — absolute path to that skill's venv interpreter.
- `dependencies.nodeModulesPath` — absolute path to that skill's `node_modules`.

Both are `null` when not applicable. Using the system `python` instead would
find none of the packages that were just installed.

### Risk posture

Provisioning **installs what a skill declares**; it does not **execute what a
skill provides**. Concretely:

- `pip install -r requirements.txt` and `npm install` only.
- npm runs with `--ignore-scripts`, so a `postinstall` hook cannot execute during
  intake. Any lifecycle scripts found are reported in
  `dependencies.lifecycleScriptsSkipped` rather than run.
- Non-registry Python requirements (a VCS URL, a local path, `-e`, `-r`
  includes) are refused and listed in `dependencies.rejected` with the reason.
  They are installs that fetch and execute arbitrary code from somewhere the
  risk scan never looked.

This is the same posture as the risk scan: surface it, let the user decide, don't
silently run it.

### When provisioning re-runs

On intake, and when a manifest's fingerprint changes on update — not on every
run. `POST /api/skills/:id/provision` forces a retry, which is the path for
"install failed, user fixed the cause, try again".

---

## Code task parallelism (added by Prompt 1.9)

**Who depends on this:** Kimi's agentic layer (Prompt 3) when it drives the Code
tool, and the frontend, which has to explain a refusal the user can act on. Two
things changed that any caller must know about: **Code no longer shares the
app-wide job lock**, and **a Code task no longer runs where you told it to run**.

### The gap this closes

Every long job in this app — a chat turn, a backup, a skill intake — takes one
app-wide lock, so exactly one runs at a time. That is right for everything whose
work lands in the database. It is wrong for Code, where the whole point is to
leave a long task running and start another.

Simply removing the lock would not work: two agents editing the same repository
at the same time see each other's half-written files, and `git checkout` under
one of them moves the ground under the other. So concurrency and isolation had to
arrive together.

### Two independent limits

| | Holds | Applies to |
|---|---|---|
| App-wide job lock | one job, total | chat, cowork, design, backup, intake |
| Code lane | `HYPERION_CODE_LANE_LIMIT` tasks (default 2) | `POST /api/code/run-task` only |

They do not interact. A running Code task does not block a chat turn, and a chat
turn does not block a Code task. Two Code tasks at the default limit run at once;
a third is **refused immediately**, not queued:

```
409 { "error": { "code": "busy",
                 "details": { "running": 2, "limit": 2, "queued": 0 } } }
```

Branch on `code === 'busy'` and read `details` — never on the status or the
message text. The refusal is deliberate: queueing behind work the caller cannot
see turns "start a task" into an unbounded wait.

`GET /api/code/tasks` returns the same numbers plus what is currently running, so
the caller can decide before it asks.

### `taskId` is required, and it is not free-form

`POST /api/code/run-task` now requires a `taskId` in the body. It becomes a
**directory name and a git branch name**, so it is validated:
`^[A-Za-z0-9][A-Za-z0-9._-]*$`, at most 100 characters, no `..`. Anything else is
refused before any work starts.

The refusal is `bad_request`, never `internal_error` (found by the rules audit).
The id arrives in the request body, so a rejected one is the caller's own
mistake and fixable by retyping — while the frontend branches on `error.code`
and reads `internal_error` as "the backend is broken". It threw a plain `Error`
until the audit sent `../escape` over HTTP and got `internal_error` back, so the
validation was right and only the reporting was wrong. Anything else validating
a client-supplied value must throw `AppError`, not `Error`: `toAppError()`
cannot tell an untagged `Error` from a genuine server fault, and turns it into a
500.

Use one stable id for the life of a task. Reusing an id that is still running
returns **the same worktree**, by design — a retry inside a task should land in
the same checkout, not a second one.

### Where the task actually runs

```
~/Hyperion/worktrees/<taskId>/        the checkout
hyperion-task-<taskId>                the branch
```

A git worktree, not a clone: it shares the repository's object store, so it is
cheap. `worktrees/` is a **sibling** of `projects/`, not a directory inside it,
so worktrees never appear as content in the project being worked on.

**Filesystem containment narrows to that one worktree.** When a `taskId` is
present, both the agent's `resolvePath` and the cwd of `executeCommand` resolve
inside `worktrees/<taskId>/` and nowhere else. A task cannot reach another task's
worktree, and cannot reach the original project directory — attempts fail with
`scope_violation`. Without a `taskId` the old behaviour stands: the whole
`projects` scope.

The consequence for the agentic layer: **do not assume the path you passed as
`cwd` is the path the agent got.** Read `dir` from the `started` event.

### The `started` event

`run-task` streams SSE as before; there is one new event at the top of the
stream, on the existing `agent` channel:

```
event: agent
data: {"channel":"started","tool":"code","chatId":"…","taskId":"refactor-auth",
       "mode":"worktree","dir":"C:\\Users\\you\\Hyperion\\worktrees\\refactor-auth"}
```

`mode` is the field to branch on:

| `mode` | Meaning |
|---|---|
| `worktree` | Isolated. `dir` is the worktree. Commits land on `hyperion-task-<taskId>`. |
| `direct` | **Not isolated.** `dir` is the project directory itself. `reason` says why. |

`direct` is a deliberate degradation, not an error — git is missing, or the
target is not a repository, or the repository has no commits yet. The task still
runs, and is still contained to the `projects` scope. It is worth surfacing to
the user, because concurrent tasks in `direct` mode against the same directory
**can** collide.

### What survives, and what does not

When the task ends the worktree is removed — but only when there is nothing in it
anyone would miss. It is **kept** when:

- the working tree is dirty (uncommitted changes),
- the branch has commits that are not on the base commit,
- `HYPERION_CODE_KEEP_WORKTREES=1`,
- or git declines to remove it.

The branch is deleted only when its tip is still the base commit — i.e. the task
committed nothing. So: **commits survive, scratch does not.** In `direct` mode
nothing is ever removed; the project directory is not ours to delete.

To make a task's work permanent, merge `hyperion-task-<taskId>` — the branch is
the deliverable. Nothing in this app merges for you.

### What not to do

- **Do not `git worktree remove` or delete `worktrees/<taskId>/` by hand** while a
  task is running. Release goes through `releaseWorktree`, which deregisters
  first and applies the keep rules above.
- **Do not derive the working directory yourself** from the repo path and the
  task id. It may carry a `-2`…`-5` suffix if a stale directory was in the way.
  The `started` event's `dir` is authoritative.
- **Do not treat `busy` as fatal.** It is a capacity signal; the task was never
  started and can be retried as-is.

---

## Recommended skills (added by Prompt 1.7)

**Not installed by anything.** This section is documentation: two third-party
skills worth having. Nothing in the codebase fetches, installs, or enables them,
and no code path assumes they are present. The app-wide rule stands — nothing
auto-installs itself.

ponytail goes through the normal Skills intake flow: paste its repository URL
into the Skills panel, or upload it. A repository URL is enough — intake rewrites
a `github.com/<owner>/<repo>` URL to the codeload zip itself, so there is no need
to download an archive by hand. Intake then parses `SKILL.md`, risk-scans it, and
provisions its dependencies exactly as described above.

graphify is the exception: it installs its own skill from its own CLI, so it does
not go through intake at all. See its entry below.


### ponytail

| | |
|---|---|
| Licence | MIT |
| Source | `https://github.com/DietrichGebert/ponytail` |
| npm package | `@dietrichgebert/ponytail` |
| Dependency status after intake | `none-declared` |
| Most relevant to | the Code and Design tools |

A coding-discipline skill. It stops an agent from over-building — reaching for a
new dependency or a wrapper component when a one-liner or a native language
feature would do the same job. It works as a seven-rung ladder applied *after*
the problem is understood, not instead of understanding it: does this need to
exist at all, is it already in the codebase, is it in the stdlib, is it a native
platform feature, is it in a dependency we already have, is it one line — and
only then, the minimum that works.

What makes it worth naming here rather than leaving in a wiki page: the quality
of what the Code and Design tools emit is a product surface, and this skill
changes it directly.

**The measured effect, stated accurately.** On the published agentic benchmark
(headless Claude Code, 12 tickets against a real FastAPI template, n=4, Haiku
4.5, versus the same model with no skill) it produced **54% less code, 22% fewer
tokens, 20% lower cost, and 27% less wall-clock time, at 100% safety**. The
larger "80–94% less code" figures that circulate are *per-task ceilings* on
over-build traps — one ticket that a bare model answered with a 404-line date
picker came back at 23 lines — not an average; treat 54% as the number.

The safety column is the part that matters for us. A plain "YAGNI, prefer
one-liners" system prompt reached 33% less code in the same harness but only 95%
safety, because it dropped a path-traversal guard. ponytail is explicit that
trust-boundary validation, data-loss handling, security, and accessibility are
never on the chopping block, and it was the only arm that improved every metric
while staying safe on every ticket.

Two practical notes for intake:

- The repository ships **six** skills — `/ponytail`, `/ponytail-review`,
  `/ponytail-audit`, `/ponytail-debt`, `/ponytail-gain`, `/ponytail-help` — each
  at `skills/<name>/SKILL.md`, with **none at the repository root**. Our
  `findSkillMd` (`src/services/skills/intake.ts`) picks the shallowest match and
  breaks ties on path length, which selects `skills/ponytail/SKILL.md`, the main
  ruleset. That is the right one; it is documented here so nobody "fixes" the
  tie-break later.
- Its `package.json` declares **no dependencies at all**, so provisioning
  correctly records `none-declared` rather than creating an empty `node_modules`.
  A `ready` status here would be the surprising outcome, not this one.

Configuration is entirely optional: `PONYTAIL_DEFAULT_MODE`
(`lite` | `full` | `ultra` | `off`, default `full`), or a config file at
`%APPDATA%\ponytail\config.json`. One caveat worth knowing — the lifecycle hooks
that announce activation need Node on `PATH`; without it the skill still works,
activation is just silent.

### graphify — a skill *and* an MCP server

Graphify is both, and the two halves do different jobs: **the skill builds
graphs, the MCP server queries them.** The skill half is covered here; the server
half, its venv, and its one-time setup are in the next section. You can use
either alone — the skill is useful without the server, and the server only needs
a graph file, however it was produced.

| | |
|---|---|
| Licence | Apache 2.0 |
| Source | `https://github.com/Graphify-Labs/graphify` |
| Installed by | its own CLI, not the Skills panel |

The skill half is not fetched through Skills intake. Graphify writes it itself,
from the same venv the next section sets up. On Windows:

```
%USERPROFILE%\Hyperion\mcp\graphify\.venv\Scripts\graphify install --platform agents
```

macOS / Linux:

```
~/Hyperion/mcp/graphify/.venv/bin/graphify install --platform agents
```

That writes `~/.agents/skills/graphify/SKILL.md`, the platform-neutral location,
which is the right target here — this app is not one of the editor platforms
graphify knows by name, and `--platform agents` avoids registering the skill into
some other tool's configuration. Add `--project` to scope it to a single
repository instead of the user profile.

**Note where that lands.** `~/.agents/skills/` is *not* Hyperion's skills root
(`~/Hyperion/skills/`, i.e. `env.paths.skills`), so a skill installed this way is
invisible to this app's Skills panel, does not get a row in the `skills` table,
and is not covered by the dependency provisioning described above. That is the
correct outcome if you want the skill for an agent CLI that reads `~/.agents`. To
make **Hyperion itself** aware of it, add it separately through normal Skills
intake using the repository URL above; the two copies are independent.



Once installed, `/graphify` builds or refreshes a graph and `/graphify --update`
re-extracts only changed files.


---

## Recommended MCP servers (added by Prompt 1.7)

### graphify

The query half of the tool documented under Recommended skills above. The skill
**builds** a graph; this server **serves** it, so an agent can traverse it over
repeated tool calls instead of re-reading files.

| | |
|---|---|
| Licence | Apache 2.0 |
| Source | `https://github.com/Graphify-Labs/graphify` |
| PyPI package | **`graphifyy`** — two y's |
| Install extra | **`[mcp]`** — see below, do not use `[all]` here |
| Launched as | a module: `python -m graphify.serve <graph.json>` |
| Seeded | yes, **disabled** |
| Most relevant to | long-horizon work in the Code tool |

Graphify maps a codebase into a local, traversable knowledge graph using
tree-sitter. No LLM is involved in reading the code itself, so it is fast,
offline, and deterministic. The payoff is navigation: finding every caller of a
function becomes a graph traversal instead of a grep across a large repository
and hoping the string was distinctive enough. That is precisely the bottleneck in
long-horizon, large-repo work.

Over MCP it exposes seven tools: `query_graph`, `get_node`, `get_neighbors`,
`shortest_path`, `list_prs`, `get_pr_impact`, `triage_prs`.

**It is seeded into the MCP list disabled**, like `wigolo`, and for two reasons
rather than one: the interpreter in its command does not exist until the venv
below is created, *and* the graph it serves does not exist until it has been
built. Enable it in the MCP panel once both are done.

Worth remembering while testing: this backend writes `mcp_config.json` and owns
the registry but **never spawns MCP processes** (`managed: false`). Even a
correct, enabled entry does not start a server today — that is Kimi's
`McpProcessManager` in Prompt 3.

#### One-time setup

Graphify is a Python package, so it gets its own isolated venv under
`~/Hyperion/mcp/graphify/.venv/` — the same isolation rule the per-skill venvs
follow, for the same reason: an MCP server's dependencies must never land in the
app's environment or the system Python. Graphify's own README recommends exactly
this.

Windows:

```
python -m venv %USERPROFILE%\Hyperion\mcp\graphify\.venv
%USERPROFILE%\Hyperion\mcp\graphify\.venv\Scripts\pip install "graphifyy[mcp]"
cd %USERPROFILE%\Hyperion\mcp\graphify
.venv\Scripts\graphify extract C:\path\to\your\repo --code-only
```

macOS / Linux:

```
python3 -m venv ~/Hyperion/mcp/graphify/.venv
~/Hyperion/mcp/graphify/.venv/bin/pip install "graphifyy[mcp]"
cd ~/Hyperion/mcp/graphify
.venv/bin/graphify extract /path/to/your/repo --code-only
```

Then enable `graphify` in the MCP panel.

**Why the `cd` matters.** The build always writes `graphify-out/graph.json`
**relative to the working directory it is run from**, and there is no flag or
environment variable that redirects it — the directory being scanned is an
argument, not the destination. Running the build from `<mcp>/graphify/` is what
puts the graph where the seeded entry expects it
(`<mcp>/graphify/graphify-out/graph.json`), and keeps the app from writing into
the user's repository. If you would rather keep the graph beside your code,
build it there and edit the seeded entry's last argument to match; `serve` takes
any path it is given.

`--code-only` keeps the build local-AST and offline: no API key, no LLM, docs and
PDFs skipped. Drop it for richer semantic extraction, which does call a model.

The seeded command is the venv's own `python.exe` by absolute path, with
`['-m', 'graphify.serve', '<graph.json>']`. Absolute because an MCP entry has no
working directory and that venv is deliberately never on `PATH` — that isolation
is the point.

#### Three traps

Each of these will waste your time exactly once:

1. The PyPI distribution is **`graphifyy`** with a double y. Other `graphify*`
   packages on PyPI are unaffiliated.
2. **There is no `graphify-mcp` console script.** The server runs as a module —
   `python -m graphify.serve graphify-out/graph.json`, or equivalently with an
   explicit `--graph graphify-out/graph.json`. The bare `graphify` command is the
   CLI (though `graphify ./repo --mcp` also starts the stdio server, which is
   handy for a quick check by hand).
3. **A graph must exist before serving.** It is a positional argument to `serve`,
   not something the server discovers or builds on demand.

If you use `uv`, two more: `uvx graphify …` fails because `uv tool run` reads the
first word as a *package name*, so it must be `uvx --from graphifyy graphify …`.
And `uv run --with graphifyy python -m graphify` can silently run an older
install with no error at all. Note also that `uv` is not necessarily on `PATH`
even when it is installed, which is why nothing seeded here invokes it.

#### Why `[mcp]` and not `[all]`

Graphify keeps its capability surface in `[project.optional-dependencies]`. A
plain `pip install graphifyy` installs the core and **none** of it — including
the MCP server itself — so an extra is required. `[all]` does exist and pulls
everything: MCP, PDF, Office and video ingestion, filesystem watching, Leiden
clustering, the Neo4j / FalkorDB / Postgres backends, SVG output, and LLM
backends.

`[mcp]` is the right choice here for three independent reasons, all of which
argue against `[all]`:

1. **Python version.** The Leiden clustering extra is `Python < 3.13` only. On a
   newer Python — 3.14 is current on this machine — the resolver fails, and pip
   installs **nothing at all** rather than skipping that one package.
2. **Build tools.** One of the tree-sitter extras may need a C compiler and
   `python3-dev` when no matching wheel is published. That is a hard stop on a
   machine without a toolchain, for a capability the MCP server never touches.
3. **`[all]` includes LLM backend extras**, among them a `kimi` one. Nothing in
   this app wants a third-party LLM client installed as a side effect of adding
   an MCP server, and the graph build above (`--code-only`) does not use one.

If you later want PDF or Office ingestion, add that specific extra. Do not
"simplify" this back to `[all]` — the reasons above are why it changed.

---

## The MCP supervisor (found by auditing what boot actually starts)

**Who depends on this:** every tool call that routes through an MCP server, and
`GET /api/mcp/status` / `GET /api/health/summary`, which report whether anything
is being supervised at all.

Slice 1 built the whole process manager — `ProcessManager` in
`src/services/mcp/processManager.ts`, config sync, `mcp_config.json` rewriting,
per-server test connections — and then **nothing ever instantiated it**.
`registerMcpProcessManager()` existed and was never called, so
`getMcpProcessManager()` returned `null` on every boot and `mcpStatus()`
answered `managed: false` forever. The config was read, the servers were
listed, and not one of them was ever spawned. `src/services/mcp/supervisor.ts`
is the missing owner; these are the properties it must keep.

### Registration is synchronous; spawning is not

`startMcpSupervisor()` calls `registerMcpProcessManager()` **before** awaiting
`startAll()`, and deliberately does not await it at all — boot continues while
servers come up.

The reason is that a cold `npx` download can take tens of seconds. If
registration waited for spawning, then for that whole window
`/api/mcp/status` would answer `managed: false` — indistinguishable from "no
supervisor exists", which is exactly the bug this file is about. Registering
first means the honest answer during a slow start is `managed: true` with
servers in `starting`, and a tool call arriving mid-spawn finds a manager to
ask rather than a null.

So `managed: true` is **not** a promise that any server is running. Read
`servers[].state` for that. Do not "fix" a `managed: true` with zero running
servers by moving the registration after `startAll()`.

### The stop budget is bounded, and shutdown continues regardless

`stopMcpSupervisor()` races `stopAll()` against a 3-second timer and logs a
warning if the timer wins, rather than awaiting `stopAll()` indefinitely.

It has to, because of what runs after it: `reconcileOrphanedRuns()` and
`closeDb()`. A wedged child process must not be able to prevent the database
from closing — that leaves a hot WAL behind, and on Windows an open handle
also blocks the next boot from cleaning up. A leaked child is recoverable; a
database that never closed is the worse failure. The timer is cleared in a
`finally` on every path so a fast, clean stop does not hold the event loop
open for the remainder of the budget.

It also runs **after** `stopTaskScheduler()`: stopping the servers first would
pull tools out from under a task the scheduler is still willing to start.

### Disabled means honestly unmanaged

`HYPERION_MCP_DISABLED=1` makes `startMcpSupervisor()` return without creating
a manager, so `mcpStatus()` reports `managed: false` and nothing is registered.
It does **not** register a manager that refuses to spawn — a status endpoint
that claimed supervision while supervising nothing would be a lie, and the
health summary keys its wording off exactly this flag.

`test/helpers.ts` sets it for the whole suite. Without it, importing anything
that boots the supervisor would have unit tests reaching the network through
`npx` and leaving child processes behind after the run.

`mcpComponent()` in `src/services/health/summary.ts` therefore treats
`!managed` as `ok`, not `degraded`: a deliberately MCP-less install is a
supported configuration, and reporting `degraded` would paint every test run
and every such install as broken.

### The registration does not outlive the servers

`stopMcpSupervisor()` calls `unregisterMcpProcessManager()` in its `finally`,
so `mcpStatus()` goes back to `managed: false` as the servers go away.

This was missing at first, and a real shutdown found it. The probe reaped all
five processes of the filesystem server — `cmd.exe` → `node` (npx) →
`cmd.exe` → `node` (the server itself), plus a `conhost` — and then
`mcpStatus()` still answered `managed: true`. Registration is a pointer, not
a lease: nothing was clearing it, so status kept advertising a manager whose
every transport was closed, and a tool call arriving late would have failed
inside a dead client instead of getting the honest "nothing is supervised".

It runs on the timeout path too, and that is the deliberate part. A wedged
server is the *least* able to serve a call, so it is the worst possible thing
to keep advertising.

Note what this is not: it is not an `unref`-style teardown of the manager
object, and `stopAll()` is still what closes the clients. The unregister only
governs what `/api/mcp/status` and `/api/health/summary` are willing to claim.

### A test that parks a fake mid-spawn must release it in `finally`

The tests that assert "registered before spawning finished" hold `startAll()`
open on a promise the test resolves by hand. That release **must** happen in a
`finally`, not after the assertions.

`afterEach` calls `stopMcpSupervisor()`, which waits for the in-flight
`startAll()` before stopping. A failing assertion that skipped the release
would therefore strand the fake mid-spawn and **hang the entire test file**
instead of reporting the one failure. This was found by deliberately deleting
the `registerMcpProcessManager()` call to confirm the tests catch it: they
caught it, and then hung. A test whose failure mode is a hang tells you
nothing about what broke.

---

## Task step history (added by Prompt 6c)

**Who depends on this:** the agent loop, which records a row per decision, and
anything that later explains what a run did — a run summary, the debug console,
a post-mortem on a run that stopped at a ceiling.

`task_runs` (007) is deliberately coarse and its own comment defends that: one
row per run, because "a reconnecting client learns whether to wait, retry, or
show a result — which is the question it actually has". `task_steps` (014) exists
because that is not the only question. Once a run ends, the user wants to know
what it *did*, and the stream that carried those details is gone. The table sits
between "one row per run" and "persist every token", which 007 rejected and this
does not attempt either.

### A step is a decision, not a delta

One row per tool call, plan, compression, or note the loop chose to record. Not
individual tokens, not prompt text, not tool payloads. `detail` is a summary
line capped at 2000 characters, and truncation is marked with
`… (truncated)` — a reader who cannot tell a clipped line from a complete one
reads the clipped one as the whole story.

`note` exists so a retry, a refusal or an approaching ceiling can be recorded
without inventing a fake `tool_call` with a made-up name, which would corrupt
any count of what the run actually invoked.

### Recording never breaks the run

`recordStep` swallows every failure to a warning. That is the opposite of this
project's usual "errors are values with meaning" stance, so the reason has to be
explicit: it is called mid-run to describe work that has *already happened*. A
duplicate ordinal from a loop bug, a `run_id` that a restart reconciled away, a
full disk — none is a reason to abort work the user is waiting on, and none is
recoverable by the caller. The write is a side effect and fails like one.

It still logs, because a silently absent history looks exactly like a run that
did nothing.

### Null means "not applicable", never "unknown"

`ok` is `null` for a step that had no outcome to report — a plan, a note. The
mapper is `row.ok === null ? null : row.ok === 1` and specifically **not**
`Boolean(row.ok)`, which would fold "no outcome" into `false` and draw a failure
marker on a plan that never failed.

`tokens_in`/`tokens_out` are `null` when the provider reported no count, which
is why `summarizeSteps` returns `complete`. A partial sum that presents itself as
authoritative silently understates what the run cost, so the flag says the total
is a floor. A run with no steps at all is vacuously `complete: true` — the flag
is about unreported counts, not emptiness.

### The ordinal is the sequence, and the clock is not

`listSteps` orders by `step`, never `created_at`. Two steps can land inside one
millisecond, and a clock can move backwards under a running process; either way
a timestamp ordering hands back a sequence the run never took.

The primary key is `(run_id, step)` rather than a surrogate id: the ordinal *is*
the identity, nothing will ever reference a global step id, duplicate ordinals
become impossible instead of merely unlikely, and the key's own index already
serves the only read pattern there is. `nextStepNumber` uses `MAX(step) + 1`
rather than `COUNT(*) + 1` so a gap left by a refused insert cannot hand out an
ordinal that is already taken.

**This one nearly shipped untested.** The first version of the ordering test
wrote three steps out of order in the same millisecond and asserted they came
back sorted — and it passed just as happily with `ORDER BY created_at`, because
the tie resolved in insert order anyway. Negative verification caught it. The
test now writes `created_at` values deliberately inverted against the ordinal,
which is the only way the assertion means anything.

### Restarting a run discards the attempt it supersedes

`task_steps.run_id` is `ON DELETE CASCADE`. The obvious half is that no step
outlives its run. The load-bearing half is `startTaskRun`, which is
`INSERT OR REPLACE` because "a retried run id is the same run being restarted" —
and with foreign keys on, the delete that REPLACE performs fires the cascade, so
retrying a run clears the previous attempt's steps.

That is the wanted behaviour: the steps of a superseded attempt must not read
back as though the current attempt had taken them. It is also a property of two
separate pieces of code agreeing, with nothing in `startTaskRun` mentioning it,
so it is asserted by a test rather than assumed. Verified directly against
node:sqlite before being relied on.

### Steps outlive the end of the run

`finishTaskRun` does not touch them. The history exists to be read *after* a run
ends; dropping it at completion would delete the only remaining explanation of
what the run did.

---

## Resource link detection (added by Prompt 1.10)

**Who depends on this:** the frontend paste-a-link flow, and the agentic layer if
it ever offers to install something a user mentioned. Both must treat the result
as a **suggestion**, never as an installed thing.

### The gap this closes

A user finds a GitHub link and has no way to know which of the two install paths
it belongs to. Skills and MCP servers are different subsystems with different
routes, different storage, and different failure modes, but they look identical
from the outside: both are usually a repo URL.

`POST /api/resources/detect` fetches the thing, looks at it, and says what it
appears to be. That is all it does.

### Detection never registers

The route is a `POST` because it fetches, not because it writes. It touches no
table, nothing under `~/Hyperion/`, and no MCP config file. Nothing is installed
until the user calls one of:


| Detected `type` | Follow-up route |
|---|---|
| `skill` | `POST /api/skills/fetch` |
| `mcp-server` | `POST /api/mcp/servers` |
| `both` | either, or both — they are independent installs |
| `invalid` | nothing; show `reason` |

Do not chain detection into installation automatically. The whole point is that
the user sees the guess and decides. A `strong` confidence is not consent.

### `invalid` is a result, not an error

This is the part most likely to be got wrong by a caller. The endpoint returns
**200 with `type: 'invalid'`** for every fetch-time problem: a 404, a dead host,
a timeout, an oversized download, a zip that will not open, a repo with nothing
recognisable in it. The `reason` field carries the human-readable explanation.

The **only** 400 is a URL that is not a parseable `http`/`https` URL — the one
case where the user typed something wrong rather than pointed at something
unsuitable. So:

- Branch on `type === 'invalid'`, not on the HTTP status.
- Do not show a fetch failure as an app error. It is a finding about the link.

### `strong` vs `weak`

`confidence` is `'strong'`, `'weak'`, or `null` (only when `type` is `invalid`).

| Confidence | What it rests on |
|---|---|
| `strong` | A declaration inside the repo: a parsed `SKILL.md`, an MCP SDK dependency in a manifest, or an `mcpServers` block in the README |
| `weak` | Circumstantial evidence only: `mcp` in the repo or package name, or the README merely mentioning MCP |

Surface `weak` differently in the UI. A `weak` MCP guess is often a *client* of
MCP, a tutorial, or a list of servers — not a server. Treat it as "this might
be", and expect the user to correct it.

For `type: 'both'`, `confidence` describes the **weaker** of the two halves. A
repo with a valid `SKILL.md` and only an `mcp` in its name reports `both` /
`weak`, because the combined claim is only as good as its shakiest part.

### Skill detection requires SKILL.md

Detection classifies something as a skill **only** if a `SKILL.md` exists. A
README alone is never a skill, even a well-written one that describes a workflow.

This is deliberately stricter than intake, which will fall back to the first `#`
heading and paragraph when front matter is missing. Intake has already been told
"this is a skill" by the user, so a fallback is helpful there. Detection is
guessing, and a README fallback would make every repo on GitHub a skill.

An unparseable `SKILL.md` still counts as a skill — the file's presence is the
signal. `skillPreview` then holds whatever `parseSkillMd` recovered.

### Vendored files do not count

`node_modules/`, `vendor/`, `.venv/`, `site-packages/`, `dist/`, `build/` and
friends are skipped when looking for manifests. A project that merely *depends*
on an MCP client ships that SDK inside `node_modules`, and reading it would make
every such project an MCP server. Manifests are otherwise found at any depth —
`server/package.json` counts — with the shallowest match preferred.

### `local` vs `remote` is a starting guess

`mcpPreview.type` is `remote` when the README documents a hosted endpoint — a
URL ending in `/sse` or `/mcp` — and `local` otherwise. Documentation hosts are
ignored, so a README linking `modelcontextprotocol.io/docs/mcp` does not make a
local server look remote.

`local` is the fallback because a repository you can clone is normally something
you run yourself, and the two wrong guesses do not cost the same: a wrong `local`
shows a command field the user can correct, while a wrong `remote` asks them for
a URL that does not exist.


`suggestedName` and `type` are pre-fill values for the add-server form. The user
can change both, and `POST /api/mcp/servers` re-validates independently.

---

## Legacy data directory (added by Prompt 1.11)

**Who depends on this:** anyone who ran the app when it was called AIStudio.
Nothing in the running system reads the old location — this is a one-time
startup step whose only job is to make the rename invisible.

At boot, **before** the data directories are created, `migrateLegacyHome()`
moves `~/AIStudio` to `~/Hyperion` and renames `aistudio.db` (plus its `-wal`
and `-shm` siblings) to `hyperion.db`. It logs what it did and carries on.

Three rules that matter if you touch this:

- **It must run before `ensureDirectories()`.** That function creates
  `~/Hyperion`, and the migration only fires when the target does *not* exist.
  Reverse the order and the migration silently never runs again — the ordering
  is load-bearing, not stylistic.
- **Both directories existing is a refusal, not a merge.** If `~/AIStudio` and
  `~/Hyperion` are both present the migration touches neither and logs a
  warning. Two data directories mean two databases, and picking one — or
  interleaving them — would destroy whichever the user actually cared about.
  Resolving that is a human decision.
- **It is idempotent and safe on a clean install.** No legacy directory is the
  normal case and is a silent no-op; in particular it does not create the
  target as a side effect of looking for it.

Cross-device moves fall back to copy-then-delete, because `~/AIStudio` and
`~/Hyperion` can legitimately sit on different volumes.

---

## Malformed requests are client errors (found by HTTP smoke testing)

**Who depends on this:** the frontend's error handling, which branches on
`error.code` and treats `internal_error` as "the backend is broken".

Express and body-parser reject some requests *before* any route handler runs: a
bad percent-escape in the path (`/api/providers/%ZZ`) throws `URIError`, and an
unparseable JSON body throws `SyntaxError`. Both arrive at the error middleware
already tagged with a 4xx `status`.

`toAppError()` reads that tag. Anything tagged 4xx becomes `bad_request`;
untagged errors still become `internal_error`. Three details are load-bearing:

- **The parser's message stays server-side.** body-parser quotes the offending
  input, so echoing it would put a pasted secret in a response body. The public
  message is generic and the parser text goes in `privateDetails`.
- **413 survives normalization.** "Too large" is normalized to the
  `bad_request` *code* so the frontend has one validation branch, but the
  *status* is restored in `errorHandler` — from multer's `LIMIT_FILE_SIZE` or
  body-parser's `entity.too.large`.
- **Handler-level validation is untouched.** A body that parses but is missing a
  field still 400s from `asString()`, with `details.field` intact.

These paths are unreachable from module-level tests, which is why they shipped
returning 500. `test/httperrors.test.ts` boots the real app on an ephemeral port
and drives it with `fetch` — the only way to make Express throw these itself.

## Colibrì providers (added by Prompt 1.12)


**Who depends on this:** the frontend's provider settings screen, which must
show the performance caveat before enabling one; and anything that calls
`enableProvider()` directly, which deliberately does *not* inherit the gate.

Colibrì is the fourth `ProviderType`, alongside `remote`, `local` and
`opencodex`. It runs a very large quantised model on ordinary hardware by
streaming expert tensors from disk instead of keeping them in VRAM.

### It needs no new adapter

Colibrì serves a genuine OpenAI-compatible surface — `GET /v1/models` and
`POST /v1/chat/completions` — so `adapterFor()` routes it to the same
`openAiAdapter` as `remote`. This is the opposite of `opencodex`, which needed
its own adapter because it speaks the Responses API inbound and rejects
`/chat/completions`. Do not add a Colibrì adapter "for symmetry"; it would be
duplicated code with its own drift.

No API key is expected. `authHeaders()` already omits the header when no key is
stored, so a local Colibrì works with nothing configured.

### There is no `port` field

Colibrì's port is a CLI flag (`coli serve --port 8000`), not a fixed constant.
The stored `baseUrl` is the single source of truth, exactly as for every other
provider type. `GET /api/providers/colibri/advisory` returns
`defaultBaseUrl: 'http://localhost:8000/v1'` purely so a form can be pre-filled.

Adding a separate `port` column would create two places that disagree the moment
someone edits one of them.

### The acknowledgement is enforced by the backend

`POST /api/providers/:id/enable` refuses a `colibri` provider unless the request
body carries `acknowledgeSlow: true`, returning **400 `bad_request`** with the
full caveat text in `details.caveat`.

This lives in the backend rather than being left to the UI because this repo has
no frontend: a caveat that exists only as advisory metadata is one that any
future client can forget to render. Returning the text in the refusal means the
warning travels with the error and cannot be skipped by accident.

The caveat is deliberately blunt about prefill latency and roughly one token per
second. Softening it into "may be slower than cloud models" would mean the first
long silence gets reported as a bug — and the user would be right to report it.

### The gate is on the route, never on `enableProvider()`

This is the part that is easy to "fix" into a bug.

`enableProvider()` is called by automatic failover to promote a standby provider
when the active one dies. Putting the acknowledgement check inside that function
would make a Colibrì provider unusable as a fallback — stranding the user with
no working provider at exactly the moment a slow-but-working one is most wanted.
There is no human present during failover to acknowledge anything.

So the gate sits in the HTTP layer, on the user-initiated enable route only.
`requireSlowAcknowledgement()` is exported separately from the repository
function for this reason. If you add another user-facing path that enables a
provider, call it there too.

It also gates *enabling*, not *creating*: `POST /api/providers` with
`type: 'colibri'` needs no flag, because a configured-but-disabled provider
cannot surprise anyone.

### The probe is advisory and registers nothing

`POST /api/providers/colibri/probe` answers "is something Colibrì-shaped
listening at this URL?" and nothing more. A miss returns `detected: false` with
a `reason` rather than throwing, matching the `/detect-local` contract so a
client never has to special-case a failed probe.

It makes a **single** attempt, unlike Ollama detection's three. The URL was
typed by hand moments earlier, so a failure is far more likely a wrong port than
a cold start, and retrying it three times only delays telling the user so.

---

## Project rules, agents and commands (added by Prompt 1.13)

**Who depends on this:** the frontend, and only the frontend. `GET
/api/code/rules`, `/api/code/agents` and `/api/code/commands` exist so the UI can
populate a dropdown or an "N rules active" indicator. The agentic layer reads
these files directly through its own filesystem access and must not be routed
through here.

### They list, they do not fetch

No response contains a file body — only `name`, `description`, `path`, and the
one or two extra fields each kind declares. That is not an oversight to be
"completed" later by adding a `content` field. A listing endpoint that returns
bodies turns a sidebar render into reading every rule file in the project, and
the caller that actually needs the text already has a better way to get it.

If a full-content route is ever genuinely needed, it should be a separate one
that fetches a single named file, so the cost is paid deliberately.

### Rules follow a fallback chain; the others do not

```
.hyperion/rules/  →  HYPERION.md
```

First location that exists wins, and `source` reports which one did —
`hyperion`, `hyperion-md`, or `none`. The distinction is the whole point of the
field: a project whose rules arrive through the fallback path has **active
rules**, and returning a bare empty list there would tell the user the exact
opposite of the truth.

The fallback exists for shape, not for lineage: a project that keeps its
instructions in one root file should not have to grow a directory to be read.

Agents and commands have no fallback, because a single root file is not a
sensible way to declare several of them.

### Hyperion never reads another tool's instruction files (added by the rules-chain cleanup)

The chain used to end `→ CLAUDE.md → .claude/rules/`. Those two locations were
scaffolding left over from reverse-engineering a different agent tool for
inspiration, and they were never a convention Hyperion asked anyone to adopt.
They are now gone, and `RulesSource` no longer has values for them.

This is a behaviour guarantee, not tidying. Reading `CLAUDE.md` means silently
handing a *different* tool's instructions to an agent the user never pointed at
that file — with no indicator distinguishing rules they wrote for Hyperion from
rules they wrote for something else. A project carrying only those files
therefore reports `source: 'none'`, and there is a test asserting exactly that,
because the tempting "harmless compatibility shim" is precisely how the
behaviour would come back.

`HYPERION.md` is the supported root file. Anything else a repository happens to
contain is that repository's business.

### An absent directory is an answer, not a failure

A project with no `.hyperion/agents/` returns **200** with an empty list. Nothing
is wrong — that project simply has no agents, and the UI needs to render that
state, not an error dialog.

The only 4xx here is `scope_violation` (**403**) from `resolveInScope`, when the
`project` query parameter tries to escape the projects root.

### Only ENOENT and ENOTDIR mean "absent"

This one is load-bearing and easy to undo. The scan treats **only** `ENOENT` and
`ENOTDIR` as a missing directory; every other error propagates.

Catching all errors would be shorter and would be wrong: a `.hyperion/rules/`
that exists but cannot be read would fall silently through to `HYPERION.md`, and
the response would confidently report `source: 'hyperion-md'` — or `'none'` when
that file does not exist either. The user would then be looking at a UI insisting
their real rules are somewhere they are not, with no error anywhere to explain it.

### One scanner, not three

All three kinds are the same thing on disk — a directory of Markdown files that
describe themselves in front matter — so `projectContext.ts` has a single
`scanDirectory` and a single `parseContextFile`, and each kind only names the
extra front-matter keys it wants. Three parallel implementations would drift, and
the drift would show up as one kind quietly not supporting a front-matter spelling
the other two do.

For the same reason the front-matter parser itself lives in `src/util/frontmatter.ts`
and is shared with skill intake, rather than being copied.

### Name and description degrade rather than disappear

Front matter first, then the first Markdown heading and paragraph, then the
filename. A file that declares nothing still has to appear in the list as
something the user recognises — dropping it, or showing it as `(untitled)`, would
hide a rule that is genuinely in effect.

---

## Settings are not all public (found by HTTP smoke testing)

**Who depends on this:** every route in `src/http/settings.ts`, and the backup
writer, which needs the opposite thing from the same table. The split between
`allSettings()` and `publicSettings()` is what lets both be right.

### The leak

`settings` is a generic key/value table, so it accumulates whatever a feature
needs to persist. Browser push put two credential values in it —
`push_vapid_private`, the key that signs every notification, and
`push_subscriptions`, the endpoint list — and all four settings routes answered
with `allSettings()`. A plain `GET /api/settings` returned the VAPID private key
in full, to any caller.

`src/services/notify/push.ts` states in its own header comment that the private
key never leaves the server. Nothing enforced it. That is the shape of this class
of bug: the promise lived in a comment next to the code that generated the
secret, while the leak was in a different file that had no idea the value was
sensitive.

### The rule

**`allSettings()` may not be serialized to a client.** `publicSettings()` is the
only form that crosses the HTTP boundary, and `SECRET_SETTING_KEYS` is the list
it removes. A feature that stores a credential in this table adds its key there
in the same commit — otherwise the next `GET` publishes it.

Both accessors exist because the two callers genuinely disagree. A backup must
round-trip the private key and the subscription list, or every browser
subscription breaks on restore; `allSettings()` therefore still returns them, and
the omission belongs at the boundary rather than in the table accessor.

### Omitted, not `[redacted]`

Secret keys are dropped from the object rather than replaced with a placeholder,
and that detail is load-bearing. The bulk update route writes back every key it
is handed, so a client doing read-modify-write on a response containing
`"push_vapid_private": "[redacted]"` would overwrite the real key with the string
`[redacted]` — destroying it, and silently breaking every existing subscription.
A masking marker is the more obvious design and is the wrong one here.

## Clearing a setting deletes the row (found by HTTP smoke testing)

`settings.value` is `NOT NULL`. `setSetting(key, null)` used to run the same
`INSERT ... ON CONFLICT` as any other write, with a literal NULL, which SQLite
rejected with `NOT NULL constraint failed`. That surfaced as a **500** from
`DELETE /api/settings/:key`, meaning that route had never once succeeded on any
install.

Clearing therefore issues a `DELETE`. This is not a workaround: absence and NULL
are indistinguishable to every reader, because `getSetting()` maps a missing row
to `null`, so removing the row is exactly what "restore the built-in default"
already meant. `getBoolSetting`/`getNumberSetting` return their fallback either
way.

The consequence for callers: a cleared key is **absent** from the next
`GET /api/settings` response, not present with a null value. Do not write UI that
expects the key to still be there.

### Why both survived a passing test suite

Neither is visible from module-level tests. The leak needed something to *ask*
for the settings over HTTP after a keypair existed; the 500 needed a real
`DELETE` request against a real migrated database. The suite was green
throughout. `test/settings.test.ts` now boots the app on an ephemeral port and
drives all four routes with `fetch` — asserting on the raw response text for the
secret, so a future serializer that nests it somewhere new still fails the test.

---

## Error log and task state recovery (added by Prompt 1.15)

**Who depends on this:** the debug console, which is the user's only view of what
went wrong an hour ago; and any client driving a Code, Cowork or Design task,
which must survive losing its SSE stream.

### The error log stores keys, never body values

`error_log` is written by `errorHandler` for every response with `status >= 500`,
and read back through `GET /api/errors`. That round trip is the whole constraint:
**anything stored in this table should be assumed to reach a screen eventually**,
so it is subject to the same rule as any other response body — no secrets.

`sanitizeRequestContext()` therefore keeps request headers *by name filter* but
records the body as **`bodyKeys` only, never values**. A request body is exactly
where a pasted API key lives. Knowing the body had a `key` field is what makes a
failure diagnosable; knowing what the key was adds nothing and creates a second
copy of the credential in a queryable table.

The result is passed through `redactSecrets` regardless, because a URL can carry
a token in its query string and a header-name denylist is not an exhaustive
defence. Do not "improve" this by storing the body for better diagnostics — that
is the bug this shape exists to prevent, and it would undo
[the settings leak fix](#settings-are-not-all-public-found-by-http-smoke-testing)
in a new location.

Stack traces are stored but **never returned in an error response**. The client
gets the `AppError` envelope; the trace lives server-side and reaches a human
only through the debug console.

### Logging must never replace the response

The `logError()` call inside `errorHandler` is wrapped in its own try/catch. It
runs inside the *terminal* error handler, so a throw there — a closed database, a
full disk — would leave the request hanging with the real error never reported.
Bookkeeping loses to answering the client, always. The same reasoning applies to
`recordProcessError()` in `src/index.ts`, which is silent on failure because
`log.error` has already put the original on stderr before it is called.

### Process-level handlers do not exit

`unhandledRejection` and `uncaughtException` log, persist, and **carry on**. They
deliberately do not call `process.exit`.

A background bug — a scheduled task, a worktree cleanup — should not take the
whole process down and with it every in-flight Code task's lane slot and open SSE
connection. PM2's restart-on-crash stays the true last resort rather than the
first thing a stray rejection reaches. Persisting to `error_log` is what makes
this safe rather than negligent: the failure is still visible after the fact,
which is the thing swallowing an exception normally destroys. stderr alone is
lost to log rotation and invisible from the app itself.

### `task_runs` is deliberately coarse

State, the reason it stopped, and timestamps. **No progress detail, no partial
output, no tool-call transcript.**

Persisting those would make every token a database write and still not reproduce
the stream faithfully. A reconnecting client has exactly one question — do I
wait, retry, or show a result — and state alone answers it. The stream remains
the only channel for progress.

The vocabulary reuses `RunState` (`running`, `paused`, `complete`, `error`)
rather than inventing a parallel one, so a frontend that already branches on chat
run state needs no second mapping. `idle` never reaches the table.

### A retried task id replaces its previous run

`startTaskRun` is `INSERT OR REPLACE` on the run id, and
`latestRunForTask` orders by `started_at DESC LIMIT 1`.

Task ids are reused — the user retries, the frontend sends the same id — so the
state endpoint answers "what is happening with this task **now**", not "what once
happened to it". Leaving the old terminal row to win would tell a client that a
task running right this second had already finished.

`completed_at` is stamped only for `complete` and `error`, and cleared for
`running` and `paused`, so a resumed run never carries a completion time it has
not reached.

### Orphaned runs are demoted to `error`, not `paused`

`reconcileOrphanedTaskRuns()` runs at boot and rewrites every row still saying
`running` **or `blocked`** to `error`. A row claiming either after a restart is a
lie the state endpoint would otherwise repeat forever, leaving a client waiting on
a stream nothing will ever write to.

**`error` rather than `paused`** is the load-bearing choice. Unlike a chat run
there is no resume path for a task whose agent process is gone — the worktree
state, the agent's own progress and the lane slot all died with it. Marking it
`paused` would advertise a recovery that does not exist, which is the same lie in
a different shape.

### `blocked` is reconciled, `ready_for_review` is not (added by Prompt 1.21)

These two arrived together and are both non-terminal, so the tempting reading is
that reconciliation should treat them alike. It must not, and the dividing line is
**whether the state still needs a process that no longer exists.**

A `blocked` run is waiting for an answer only its own live process can consume — a
confirmation is delivered into the agent loop, not written into `task_runs`. Once
that process dies nothing can unblock the row, so leaving it `blocked` strands the
task forever behind a prompt whose answer now goes nowhere, and
`GET /api/notifications` keeps advertising a decision the user is no longer able to
give. It is therefore demoted, with a message naming the real loss ("waiting for
you, so it can no longer receive an answer") rather than the generic restart text,
because "still running" and "waiting on you" are different things to have lost.

A `ready_for_review` run is the opposite case: the work is already **finished** and
only wants a human to look at it. No live process is needed to show a result that
already exists on disk, so demoting it would report completed work as failed and
throw away something real. It survives untouched, and the test asserts
`updatedAt` is unchanged so a future widening of the `WHERE` clause cannot quietly
rewrite the row.

The plan for 1.21 flagged this as needing revisiting and it was initially missed —
the states were added to the vocabulary while reconciliation still filtered on
`state = 'running'` alone. Anything added to `TaskRunState` from here on has to
answer the same question explicitly: does it depend on a live process, or is its
value already durable?


### The chat FK is stored as NULL when the chat does not exist

`task_runs.chat_id` is a foreign key to `chats(id)`. Tasks are legitimately
started with a chat id that has no row behind it, and with `PRAGMA foreign_keys =
ON` that insert fails outright — which would mean a task refusing to run because
of bookkeeping. `linkedChatId()` checks first and stores NULL when there is no
chat, so the link is recorded when it is real and omitted when it is not.

Marking the run is also guarded on the task having actually been provisioned. A
Code task refused by the lane never reached `startTaskRun`, and writing a
terminal state for a run that was never recorded would create a phantom row.


## Project scoping (added by Prompt 1.16)

**Who depends on this:** every path the app resolves. `fsScope`, worktree
provisioning, `.hyperion/rules|agents|commands/` discovery and the default
filesystem MCP server all resolve against whichever project is active, so the
rules below are what stop "switch project" from becoming "read the wrong tree".

### `projects` is the only mutable scope root

`ROOTS` in `src/security/fsScope.ts` is otherwise fixed at boot from
`env.paths.*`. `projects` alone can be reassigned, through `setProjectRoot`.

That asymmetry is deliberate. The other scopes — the database, logs, skills,
artifacts — are *Hyperion's own* storage and have no reason to move while the
process runs. The project root is the only one that names the **user's** work,
and the whole point of a project registry is that there is more than one of them.
Keeping the mutability confined to a single named root means every other
containment guarantee is still a compile-time-shaped constant, and a bug in
project switching cannot widen access to the app's own data.

`setProjectRoot(null)` restores `defaultProjectRoot()` rather than disabling
containment. "No project selected" has to still be a *contained* state, because
`resolveInScope('projects', …)` is reachable before the user has ever created a
project — an agent asking for `.` at that moment must land somewhere safe rather
than at the filesystem root.

### One module owns both the durable setting and the cached root

`src/services/projects/active.ts` is the only place that writes both
`active_project_id` and the `fsScope` root. Route handlers call
`switchActiveProject`, `clearActive` or `restoreActiveProject`; they never call
`setProjectRoot` or `openProject` directly.

The two pieces of state answer the same question in two places — one durable, one
in memory — and any path that updates one without the other leaves the app
resolving files under a project the registry says is not open. Funnelling them
through one function is what makes that divergence impossible to introduce from a
new caller. The order inside `switchActiveProject` matters for the same reason:
the setting is written first, so a crash between the two leaves the *durable*
state ahead of the cache, which the next boot reconciles by reading the setting.
The reverse order would leave a live process resolving paths for a project that
was never recorded as open.

Switching also calls `resetWorktrees()` and `rescopeFilesystemServer()`, because
a clean boundary was the requirement: worktree assignments and filesystem scope
belong to the project they were made under, and carrying them across a switch
would blend two projects' state. `resetWorktrees` only clears the in-memory map —
it deliberately does no filesystem work, so switching away never destroys a
worktree the user may return to.

### Deleting a project never deletes files

`DELETE /api/projects/:id` removes the row and returns `filesRemoved: false`.
`deleteProject` in the registry touches no filesystem path at all.

A project usually points at a checkout that existed long before Hyperion saw it,
and even a managed one holds the user's work. If "remove from my list" and
"destroy my code" were the same gesture, the destructive reading is the one that
cannot be undone. `filesRemoved` is stated explicitly in the response so a
frontend can tell the user where the directory still is instead of implying it is
gone.

### A missing project directory does not clear the selection

`restoreActiveProject()` sets the scope root from the stored project without
checking that the directory exists. A project on an unmounted drive, or one
temporarily renamed, still reads as active.

Unselecting it would silently discard a choice the user made, and the failure is
better reported at the moment a path is actually resolved — where the error names
the real problem — than as an unexplained "no project open" at boot. A *dangling
id*, where the row itself is gone, is different and does degrade to null: there is
no project to point at, so there is nothing to preserve.

### The `~/Hyperion` overlap check runs in both directions

Registering an existing directory rejects it when it overlaps `env.paths.home`,
tested as `pathContains(home, resolved) || pathContains(resolved, home)`.

Both directions are failures, for different reasons. A project *inside*
`~/Hyperion` would put the user's source tree in the same subtree as the database,
provider keys and logs, and any agent given project scope would reach them. A
project *containing* `~/Hyperion` — pointing at the home directory itself — is the
same exposure with the nesting inverted. Checking one direction only leaves the
other wide open, which is why the test suite asserts `testHome` and
`path.dirname(testHome)` are both refused.

The check compares realpaths, so a symlink into the app home is caught too.

### Registration never creates an arbitrary directory

`POST /api/projects` creates a directory only when no `path` was supplied, and
only under `defaultProjectRoot()`. When the caller names a path, that directory
must **already exist** or the request is a 400.

A request body that could bring a directory into being anywhere on disk is a
write primitive dressed as a registration, and the containment rules elsewhere
assume no such primitive exists. Requiring the directory up front also makes the
common mistake — a typo in a path — fail loudly instead of quietly registering an
empty tree that looks like the wrong project.

Managed directories are named with `safeFilename(name)`, not the UUID, so the
folder is recognisable in a file manager; a name like `../../escape` flattens
rather than escaping.

### Active-project identity comes from the registry, not the root

Both `GET /api/projects` and `DELETE /api/projects/:id` decide "is this the
active one?" by comparing `activeProject()?.id`, never by comparing a path
against `activeProjectRoot()`.

`setProjectRoot` runs `path.resolve` and containment resolves symlinks, so the
cached root is a *normalised* form of the stored path — different casing, a
different separator or a symlinked parent all produce a string that no longer
equals the registry value. An id comparison has no such failure mode. Both
values are still reported in `GET /api/projects` (`activeId` from the registry,
`activeRoot` from the containment layer) precisely because they come from
different sources and seeing them disagree is diagnostic.

### Rescoping the filesystem MCP server yields to the user

`rescopeFilesystemServer()` rewrites the seeded `filesystem` server's last
argument to the new project root, but only when the entry still matches the shape
it was seeded with — `npx`, the expected argv prefix, exactly one extra argument —
**and** its current root is one the app itself would have set: the default root
or some registered project's path. Otherwise it returns `false` and changes
nothing.

`false` is a normal outcome, not an error. Once the user has edited that server
definition it is theirs, and having project switching silently overwrite a
hand-tuned allow-list would be worse than leaving the scope where they put it.
The seeded-shape check is what distinguishes "we wrote this" from "they did".

For the same reason `restoreActiveProject()` runs **before** `seedDefaultServers()`
at boot: seeding happens once, so a fresh install that seeded first would freeze
the default root into the argv of a server that then never follows the active
project again.


## Scheduled tasks and the knowledge library (added by Prompt 1.8)

**Who depends on this:** the Cowork UI, which has to explain a run that did not
happen; the storage cleanup sweep, which must leave knowledge sources alone; and
the activity feed, which reads `scheduled_task_runs` as one of its sources.

### `skipped` is a row, not an absence

`scheduled_task_runs` records **one row per attempt, including the attempts that
never ran**. A task that came due while the app-wide job lock was held, waited
`HYPERION_SCHEDULED_TASK_WAIT_MS` (default 15 minutes) and gave up writes a row
with `status = 'skipped'`.

Writing nothing would have been simpler and is the bug this shape prevents:
**silence is indistinguishable from the scheduler never having fired at all.** The
user looking at a task that produced no output needs to know whether it ran and
failed, ran and produced nothing, or never got a turn — and only the third case is
their scheduling problem to solve rather than ours.

Fifteen minutes is chosen against the collision this actually guards: a user
mid-chat, which clears in minutes. A task still blocked after that is competing
with something long-running, and starting it an hour late silently is worse than
reporting that it did not start.

Two mechanics in `src/services/cowork/scheduler.ts` make that work:

- The lock is taken with **`mode: 'queue'`, not `'reject'`**, regardless of the
  user's concurrency preference. Rejecting is a reasonable answer to a person who
  can retry; there is nobody here to retry, so waiting is the only behaviour that
  is not simply a silent loss. Only after `waitMs` expires does the attempt become
  `skipped`.
- **`runDueTasks` runs due tasks one after another, never in parallel.** They all
  contend for the same single job lock anyway, so firing them concurrently would
  make all but one wait out its timeout and record a `skipped` it did not deserve.

A lost queue race is caught specifically — `error.code === 'busy'` — and is the
only thing that becomes `skipped`. Every other throw is `failed`, so "the machine
was busy" never masks a real error.


### The schedule vocabulary is deliberately not cron

Two forms only, and both are **local time**:

```
daily:HH:MM        every day at that local time
weekly:D:HH:MM     every week on day D (0 = Sunday) at that local time
```

Full cron buys generality nobody asked for and costs a parser plus a whole class
of schedules that cannot be rendered in a form. Local rather than UTC because
"every morning at nine" means the user's morning; storing UTC would make the same
schedule drift across a daylight-saving boundary.

Do not "upgrade" this to cron expressions. A new form should be a third named
shape, not an escape hatch into arbitrary syntax.

### `model_id` is NOT NULL because nobody is watching

A scheduled run happens while the user is away, so there is no one present to
correct a bad guess about which model to use. The model is therefore chosen when
the schedule is created, or the schedule is not created at all. Falling back to
"whatever is active at run time" would mean the same task silently changing
behaviour because the user switched providers for an unrelated chat.

`chat_id` is the opposite case and is optional: a schedule that exists on its own
gets a stable synthetic id derived from the task, so its runs still group into a
conversation without requiring one up front.

### Knowledge sources have no cleanup columns, on purpose

`knowledge_sources` follows the `attachments` convention exactly — the row is
metadata plus a path, the bytes live on disk under the scoped knowledge root. What
it deliberately does **not** copy is the retention machinery: there is no
`last_accessed_at` and no `pinned` column.

Both would be dead weight, because a reference library is not a transient upload:
these rows expire only when the user deletes them. Omitting the columns makes that
exemption **structural** rather than a rule someone has to remember to check in the
cleanup sweep. A future sweep cannot accidentally include this table, because there
is nothing in it to sweep on.

`rel_path` is stored relative to the knowledge root with POSIX separators, for the
same reason attachments are: an absolute path would not survive a restore on
another machine, which is exactly when a backup matters.

### Background jobs never take the process down

All three recurring jobs — cleanup, the daily backup, and the scheduled-task
runner — go through `createIntervalJob` in `src/util/intervalJob.ts`. Four of its
properties are load-bearing and were preserved deliberately when the shape was
lifted out of `startCleanupScheduler`:

- **Both timers are `unref`'d**, so a pending job is never the reason the process
  stays alive during shutdown.
- **It runs shortly after boot, not only on the interval.** A machine rebooted
  daily would never reach a 24-hour tick, so the job would appear to work and in
  fact never run.
- **A thrown tick is logged, not propagated.** These run detached from any
  request, so an unhandled rejection would take the server down over a failure
  that only needed retrying on the next tick.
- **Starting twice is a no-op**, because two intervals running the same sweep is
  a bug that hides for a long time.

Ticks are also serialised per job through the `inFlight` promise: a run that
overruns its own interval **delays** the next one rather than overlapping itself.
For a database backup or an agent run that is the difference between slow and
corrupt.

`runNow()` exists as the test seam — nothing else can observe a job whose real
interval is measured in hours — and it respects the same one-at-a-time rule as a
timed tick.


## Browser push notifications (added by Prompt 1.14)

**Who depends on this:** Sol's service worker, which receives `PushPayload` and
must keep treating its shape as stable; and every background job that might want
to tell the user something while the tab is closed.

### Why push exists at all here

The backend outlives the browser tab. It runs under PM2, so a scheduled Cowork
run finishes at 3am whether or not anything is open, and a task that needs a
confirmation can sit blocked indefinitely with nobody watching. An in-page toast
cannot reach either situation.

It uses the **standard Web Push API and no custom encryption layer**. A bespoke
scheme was reviewed for this and deliberately not adopted — re-implementing the
transport crypto here would be strictly worse than the one browsers already
implement and audit.

### Off by default, and only two things may interrupt

`pushEnabled()` gates every send, and the default is off. Ordinary foreground
activity never pushes.

The reasons are a closed set of two:

```ts
export type PushReason = 'scheduled-task' | 'attention-needed';
```

A scheduled task finished while the user was away, or something is blocked
waiting for them to confirm it. That is the whole list, and it should stay short:
a notification channel that fires for routine events gets muted at the OS level,
and then the two cases that genuinely mattered are lost with it.

### A failed notification must never fail the work

`web-push` is an **optional dependency**, loaded lazily through `createRequire`
— the same pattern `storage/images.ts` uses for `sharp`. If it is not installed,
push reports itself unavailable rather than breaking the boot.

`sendPush` **resolves with an outcome instead of throwing.** The caller is always
some piece of work that has already succeeded — a finished task, a blocked
prompt — and a notification is the least important thing in that sequence.
Letting a dead push service turn a completed scheduled run into a failed one
would invert the priority exactly backwards.

For the same reason the VAPID key is read with `tryDecrypt` rather than
`decrypt`: an unreadable key degrades to "push unavailable", not to an exception
on a path that had nothing to do with notifications.

### The VAPID private key is credential material

`push_vapid_private` is encrypted at rest with the **same keystore as provider
API keys**, and `publicKey()` is the only half that is ever exposed. This is not
a lesser secret because it is not an API key: it signs every notification sent as
this server.

That promise lived only in this module's header comment until a settings route
published the whole table — see
[Settings are not all public](#settings-are-not-all-public-found-by-http-smoke-testing).
Both `push_vapid_private` and `push_subscriptions` are now in
`SECRET_SETTING_KEYS`. **Any new credential stored in `settings` must be added
there in the same commit.**

Subscription endpoint URLs are truncated in logs, because an endpoint is itself a
capability: anyone holding it can push to that device.

### 404 and 410 delete the subscription; nothing else does

A `404` or `410` from the push service means the browser threw the subscription
away — it is gone, permanently, and retrying it forever would be pure noise. That
subscription is deleted.

**Every other failure is treated as transient and the subscription is kept.** A
timeout, a 500 from the push service, a network blip: none of those are evidence
the user unsubscribed, and deleting on them would silently unsubscribe someone
because their wifi dropped at the wrong moment. The asymmetry is deliberate —
only an explicit "this is gone" from the service is allowed to be destructive.

---

## Chat transcripts are cursor-paginated (added by Prompt 1.8, found missing by the 1.17 audit)

`GET /api/chat/:id/messages` takes `before=<message_id>`, never `?offset=`, and
returns `nextBefore` for the next page up.

This was specified in Prompt 1.8 and then not built; the 1.17 audit caught it
because 1.17 asked whether the activity feed's cursor convention matched the
chat endpoint's. It did not — the feed paginated and the transcript did not.
Recording it here so the reasoning does not have to be rediscovered a third time.

**Why a cursor and not an offset.** A chat grows at its end while it is being
scrolled. Every message appended shifts every offset by one, so a client paging
upward with `?offset=` silently re-reads a message it already has, or skips one
it never saw. Neither failure raises an error anywhere — the transcript just
quietly becomes wrong. A message's identity does not move, so a cursor naming a
message is stable under concurrent appends.

**Why the cursor resolves to `seq` and not a timestamp.** Two messages can be
written in the same millisecond, which makes `created_at` non-unique and
therefore useless as an ordering key — a page boundary landing between two
same-millisecond rows drops or repeats one. `seq` is assigned per chat by
`nextSeq()` as `MAX(seq) + 1`, is unique within the chat, and is never rewritten
after insert. The public cursor stays a message id because that is what a client
already holds; the id is resolved to its `seq` internally.

**Why an unknown cursor is a 400 rather than a silent reset.** Ignoring an
unrecognised `before` would serve the newest page again, which a scrolling client
renders as the conversation duplicating itself — a confusing failure in place of
a clear one. A cursor belonging to a different chat is refused for the same
reason.

**Why `listMessages` was left alone.** `src/orchestrator/chat.ts` rebuilds LLM
history with it. Changing that function's default ordering or windowing would
change what the model is sent, which is a much larger blast radius than a UI
pagination change. `listMessagePage` is additive, and `GET /api/chat/:id` and
`POST /api/chat/:id/open` still return the oldest-first whole-chat shape.

## Automatic backups can be mirrored off the machine (added by Prompt 1.8)

`HYPERION_BACKUP_DEST` names an extra directory each automatic backup is
**copied** into — typically a Drive or OneDrive sync folder.

**Why a copy and not a move.** The backups root is what `listBackups()`,
`GET /api/backup`, `POST /api/backup/inspect`, import and the retention pruner
all read. Redirecting the primary write would break all five at once and leave
the archive invisible to the app that made it.

**Why it is env-only, with no settings key and no HTTP write path.** This is the
one filesystem location in the app that is deliberately *outside* every fsScope
root. Accepting it from a request body would convert "take a backup" into an
arbitrary file-write primitive aimed anywhere the process can reach — precisely
what `src/security/fsScope.ts` exists to prevent. An environment variable is set
by whoever controls the machine, which is a different trust level from a request.
Do not add a route or a setting for this later without re-reading this paragraph.

**Why a failed mirror is a warning, not an error.** The archive is already
written and pruned by the time the copy runs. An unmounted network drive or a
full sync folder makes the *mirror* unavailable, not the backup, so the run
reports `mirrored: null` and logs a warning rather than failing a backup that
actually succeeded.

**How the test avoids proving nothing** (added by Prompt 1.18's session). All
three properties above are now covered by `test/backupmirror.test.ts`, driven
through the exported `runAutoBackup` because `mirrorBackup` is module-private.

The trap worth knowing about: `env.backupDest` is resolved once, when
`config/env.ts` is first imported. A test that sets `HYPERION_BACKUP_DEST`
inside `before()` sets it too late, so `backupDest` stays `''`, and
`mirrorBackup` returns `null` on its first line without ever attempting a copy.
The failure-path assertion (`mirrored === null`) would then pass for entirely
the wrong reason, and the suite would report the mirror as covered while never
having exercised it. The variable is therefore assigned in the test module's
body — after `helpers.ts` has created the throwaway home, before the first
`await import()` of anything under `src/` — and the happy-path test asserting a
copy really appears is what keeps the failure-path test honest.

The unwritable destination is simulated by replacing the directory with a
*file*, so `mkdirSync` fails. Permission bits are not usable here: Windows
largely ignores them on directories, so a chmod-based test would pass on CI and
silently do nothing locally.

## Health summary and activity feed (added by Prompt 1.17)


### `enabled` is a single active flag, not a set — and the health verdict is built on that

`providers.enabled` is guarded by a partial unique index, so **at most one
provider is enabled at any moment**. `enableProvider` clears the previous one and
sets the new one inside a single transaction, in that order, because the reverse
order trips the index. `createProvider` defaults `enabled` to false.

The plural in `listProviders()` hides this, and I got it wrong the first time:
the original `providerComponent()` counted "how many enabled providers are
unhealthy" and escalated to `error` when all of them were. That question has no
meaning when the answer is always zero or one. The typecheck was clean and the
logic read plausibly; only running the tests exposed it.

So the verdict is built on two real questions instead:

1. Is the **active** provider working? — `getActiveProvider()`
2. If not, is there anywhere else to go? — `listFailoverCandidates()`

`listFailoverCandidates` **deliberately ignores `enabled`** and merely sorts
known-unhealthy providers last rather than excluding them, on the reasoning that
a provider marked unhealthy an hour ago may well be fine now. A *disabled*
standby is therefore still a route out, and the summary counts it as one. Any
future change that filters that function by `enabled` would silently turn every
single-standby install from `degraded` into `error`.

### Only providers can take the app red, and only in one case

`error` in the summary means "a request sent right now cannot succeed". That is a
claim about present capability, so exactly one condition earns it: the active
provider is unhealthy **and** there is no other candidate.

Everything else caps at `degraded`, each for its own reason:

- **MCP** is auxiliary. Servers in an error state are worth showing, but the app
  answers chat requests without any of them, and no supervisor being registered
  at all is a supported configuration rather than a fault.
- **The error count** is history. Five 500s in the last hour say something
  happened; they say nothing about whether the next request works. Letting a past
  failure claim the app is down now would leave a red light nobody can clear.
- **No provider configured**, and **providers configured but none active**, are
  both `degraded`. Nothing is broken — the user has not finished setting up, and
  `requireActiveProvider()` already refuses those requests with a
  `no_active_provider` message that says so.

`unknown` is never counted as failing. Every provider is `unknown` until
something is actually sent to it, so counting it as a fault would show red on a
fresh install before the user had done anything — which trains them to ignore the
indicator permanently.

### A degraded verdict is a 200

`GET /api/health/summary` always returns 200 when it can compute an answer.
`status: "error"` is the *answer*, not a failure to answer, and returning 503 for
it would make a client's transport-error path fire on a request that succeeded
perfectly. The same reasoning as `detectResource` returning `invalid` on a 200.

`GET /api/health` stays a separate, dependency-free route in the same router. A
liveness probe that consults the thing it reports on can fail for reasons that
have nothing to do with whether the process is alive, so the probe reads only
`process.uptime()` and the bind flag. It moved out of `app.ts` into
`src/http/health.ts` when `/summary` was added, and `test/activity.test.ts`
asserts its exact response shape for that reason — a supervisor polling it would
not survive a silent change during a refactor.

### The activity feed is not the debug console

`GET /api/errors` (Prompt 1.15) already serves raw records with stack traces,
error codes and sanitized request context. The feed answers a different question
— "what has this thing been doing while I was away?" — so every entry is a whole
sentence with a status and a link, and **no entry carries a stack frame or an
internal error code**. `test/activity.test.ts` asserts on the raw response text
for exactly this: the human-readable reason `no provider could be reached` is
present, the machine code `provider_unavailable` is not.

Nothing in the feed is meant to be branched on by error code. If a client needs
that, it needs `/api/errors`, and the two should not converge.

### Ordering is by start time because a cursor needs a key that holds still

Both `task_runs` and `scheduled_task_runs` order by `started_at`, never by an
updated time, and `nextBefore` is a timestamp from that same column.

`started_at` is the only column in either table that cannot change after the row
is written. Ordering by "last updated" would let a long-running task jump forward
past a cursor a client is already holding, taking rows with it — which the user
sees as entries silently disappearing from the middle of the feed while they
scroll. `before` is exclusive so a page never repeats the entry it ended on, and
`nextBefore: null` marks the last page so a client can stop without a count query.

Each source is queried for its own full `limit` and the merged list is sliced.
That is correct rather than merely convenient: the true newest `limit` entries of
the union cannot contain a row that was not among the newest `limit` of its own
table.

### The scheduled-run join is LEFT, deliberately

`scheduled_task_runs.task_id` is `NOT NULL REFERENCES scheduled_tasks(id) ON
DELETE CASCADE`, and **this database enforces foreign keys**, so a run whose task
is gone should be unreachable. The join is still `LEFT`, with the task id
standing in for a missing name.

An `INNER JOIN` would respond to that impossible state by dropping the row, which
reads as history quietly rewriting itself. A degraded title fails visibly
instead. (An earlier version of this comment claimed the `LEFT` was there because
foreign keys might not be enforced. That was simply wrong, and it is recorded
here because the wrong reason would have justified changing the join.)

### Subagent delegation is absent because there is no writer

Prompt 1.17 named three sources for the feed. Only two exist: nothing in the
backend records a delegation event — no table, no writer, and a search for
`subagent` / `delegat` across `src/` turns up only project configuration and two
unrelated comments.

The feed reports the two real sources and says nothing about the third. Deriving
delegation entries from something adjacent would put events in a history log that
never happened, which is worse than an incomplete feed. When a producer exists it
joins the merge in `activityFeed()` and needs no change to the response shape.

### `skipped` is an entry, not an absence

A scheduled task that came due while the app was busy and gave up waiting for the
lock is recorded as a `skipped` run and appears in the feed as one. This is the
same reasoning that made `skipped` a stored status back in migration 006: silence
would look identical to the scheduler never having fired, and the user cannot act
on a difference they cannot see.

---

## System binaries and user approval (added by Prompt 1.8(a))

**Who depends on this:** the agentic layer, which must ask rather than retry when
a skill is waiting on a person; and the frontend, which needs to tell "this skill
is broken" apart from "this skill needs your permission". Extends the Prompt 1.6
dependency contract at the top of this file.

### Waiting on a person is not a failure

A skill can need something no package manager inside its own venv can supply —
`ffmpeg` on `PATH`. Before this, such a skill provisioned to `failed`, which told
the user something had gone wrong and told an agent to retry. Both were false:
every declared package installed correctly, and retrying changes nothing until a
human acts.

`needs-user-approval` exists for exactly that state. `failed` stays empty,
`error` carries the sentence naming what is missing and what Hyperion can do
about it, and `provisionedAt` is stamped because provisioning did run to
completion. **A retry is not the remedy; asking is.**

`runnable` is still `false`, and `dependencies.runnable` remains the single
boolean to branch on. The allow-list in `computeRunnable` is deliberately
positive — only `none-declared` and `ready` are runnable — so a status added later
is not runnable by accident. An exclusion list would have made every future status
runnable by default, which is the wrong direction to fail in.

### `DEPS_STATUSES` and the migration CHECK move together

The status is persisted, and migration `009_skill_binary_approval.sql` widened the
`CHECK` constraint on that column to admit it. `DEPS_STATUSES` in
`registry.ts` is the runtime half of the same constraint: a stored value not in
that array is **not** an error, it falls back to `none-declared` — which is
*runnable*.

So a status that exists in the database but not in the array turns a skill waiting
for permission into one the agent believes is ready, silently. Adding a status
means editing both, in one commit, with a test that writes a row of the new status
and reads it back. `002` and `005` are the pattern for widening a CHECK;
`test/skilldeps.test.ts` has the round-trip test for this one.

### A binary-only skill must not read as "nothing declared"

`detection.noneDeclared` is recomputed as
`deps.length === 0 && binaries.length === 0`. Before the second clause existed, a
skill declaring only `requires_binaries` looked like an instruction-only skill:
`provisionSkill` takes an early exit on `noneDeclared` and records
`status: 'none-declared'`, which is runnable. The missing binary would then have
surfaced as a crash mid-task — the exact failure the whole dependency feature
exists to prevent.

This is why the redefinition sits after `collectBinaries()` rather than where
`deps` is first assembled. Anything that adds a new *kind* of dependency has to
extend that expression too.

### An inferred binary is visibly a guess

Binaries come from front matter (`requires_binaries`, or the aliases
`system_dependencies` / `binaries`) or, **only when the author declared none**,
from a scan of the skill's own files for known command names. `declared: false`
marks the inferred ones and `source` names the file the guess came from.

The distinction has to survive to the API, because acting on a guess installs a
machine-wide program the author never asked for. Inference is also suppressed
entirely once anything is declared: an author who listed their requirements has
told us the list is complete, and adding to it from a mention in a comment would
override them.

Version constraints are stripped (`ffmpeg >= 6` records as `ffmpeg`) because a
constraint we cannot enforce through `where`/`which` is noise in a probe. An entry
that is a path rather than a command name is dropped and warned about rather than
run — a front-matter string is not a trustworthy thing to hand to a shell.

### The install is confirmation-gated because it leaves the sandbox

Everything else in provisioning installs into `~/Hyperion/skills/<id>/`, a
directory that skill alone owns. `POST /api/skills/:id/binaries` is the one place
the skills system changes **the whole computer**, and that difference is the
entire reason for the gate:

- `confirm: true` is required and **never defaulted**. `installBinary` refuses
  without it and the route does not supply it.
- A refusal is a **200**. "We do not install that" and "you have not confirmed
  yet" are facts about this machine, not malformed requests — the same principle
  as `detectResource` returning `invalid` on a 200. Only a missing `name` is a
  400.
- The allow-list is **`ffmpeg` only** to start. An entry must be packaged under
  the same name by winget, choco, brew and apt, and must install without
  prompting; a manager that stops to ask a question mid-install is a hang, and
  `HYPERION_SKILL_DEPS_TIMEOUT_MS` would report it as a failed skill.
- Success is confirmed by **re-probing `PATH`**, not by the installer's exit code.
  Package managers report success for work that did not put a command on `PATH` in
  this process's environment.

`installable` is returned alongside the refusal so a UI can distinguish "we can
do this, just confirm" from "install it yourself" without a second endpoint.

The route is registered **before** `/:id` in `src/http/skills.ts`, or Express
matches `binaries` as a skill id. The skill is also resolved before the binary is
checked, so a typo in the path reports as a 404 rather than as a refusal to
install.

### The prompt block says which kind of unavailable

`/api/skills/summary?prompt=true` renders
`[needs ffmpeg installed — ask the user before using it]` for this status instead
of the generic dependency-failure note, and `missingBinaries` is on the JSON
summary entry for the same reason. An agent that reads only the prompt block still
has to be able to tell the two apart — otherwise the distinction this status
exists to draw dies at the last step before it reaches the user.

## Per-item export (added by Prompt 1.18)

**Who depends on this:** the frontend's save/share buttons, which receive a file
rather than an envelope; and anyone adding a fourth export later, who will copy
whichever of these three they read first.

### An artifact's `content` column is not the artifact

`001_init.sql` stores small artifact versions inline in `content` and large ones
by reference in `rel_path`, with a `CHECK (content IS NOT NULL OR rel_path IS NOT
NULL)` enforcing that one of them is set. The column is therefore **nullable**,
and the first draft of `exportArtifact` typed it `string` and returned it
directly.

That draft typechecked, passed review by eye, and would have returned an **empty
file for every large artifact** — a 200, with a plausible filename, containing
nothing. Of all the ways this feature could break, that is the one least likely
to be reported as a bug: it looks like the export worked and the artifact was
empty.

So a null `content` is resolved from disk, and a missing backing file is a `404`
naming the artifact rather than an empty download. The general rule this is an
instance of: **read the schema, not the TypeScript interface, when deciding
whether a value can be absent.** The interface is an assertion; the DDL is the
constraint.

### Stored data lands in a header, so it is sanitised like a filename

`Content-Disposition: attachment; filename="..."` is assembled from a chat title
or an artifact's `rel_path` — both user-controlled and long-lived. Both the stem
and the **extension** go through `safeStem`, which reduces to `[A-Za-z0-9._-]`.

The extension is the easy one to forget, because it looks like it came from the
system rather than from the row. It did not: a `rel_path` ending in `.ts"` or
carrying a newline would terminate the quoted string and inject a header. There
is no separate escaping step to skip — the sanitiser *is* the escaping.

### The path check is made at read time, never inherited from write time

A file-backed artifact goes back through `resolveInScope('projects', relPath)`
when it is exported, even though the path was scope-checked when the row was
written. The row outlives the working tree, and `POST /api/projects/:id/open`
repoints the projects root underneath it, so the only check that describes the
present is the one made now. A `scope_violation` from that call is a real answer
and is left to propagate as a 403.

The resolved absolute path is `privateDetails` on the 404, never `details`: the
user needs to know their artifact's file is gone, not the server's directory
layout. `test/exports.test.ts` asserts the response text does not contain the
home directory, so a later refactor that "helpfully" moves it into `details`
fails.

### `direct` mode is a 400, not an empty patch

A Code task whose worktree fell back to `direct` mode — no git, not a repository,
no commits yet — has no base commit to diff against. Returning an empty patch
would be indistinguishable from a task that genuinely changed nothing, so it is a
`400` carrying `mode` and `reason`.

This is the one place in the export surface where a 4xx describes something the
user cannot fix by retyping, and it is deliberate: the alternative is a
successful-looking download that misreports the task's work as empty. The
`reason` is the same string `provisionWorktree` recorded, so the explanation the
user gets matches the one in the `started` event.

### `/api/chat`, singular

The prompt specified `/api/chats/:id/export`. The router has been mounted at
`/api/chat` since `001` and every endpoint in API.md §4 lives under it, so a
plural sibling for this one route would leave two spellings of the same resource
in the API. The mount won; the deviation is recorded in API.md §19 so the next
reader of the prompt does not "fix" it back.

---

## Settings depth (added by Prompt 1.19 / 1.20)

### The spend cap exempts live work structurally, not with a branch

`assertWithinSpendCap(origin, label, now)` returns on its first line when
`origin === 'live'` — before it reads the usage table, before it computes a total,
before it can throw. The exemption is therefore a property of the function's
shape rather than a condition inside the check.

That is deliberate. The cap exists to stop *unattended* spending: a scheduled task
firing at 3am, or a subagent spawning more subagents, with nobody watching the
meter. Work the user typed themselves is the opposite situation — they are present,
they can see the cost, and refusing it would break the app while they are looking
at it. A cap that locks the user out of their own chat window has stopped being a
safety feature.

Written as `if (origin === 'autonomous' && overCap) throw`, a later edit that
reordered the clauses or added a third origin could silently start blocking live
turns, and no test of the autonomous path would notice. With the early return, a
change that blocks live work has to *delete a line that exists for that purpose*.
Keep it first, and do not move a read of the usage table above it.

### A ceiling stops a task; it does not fail it

Tripping a token budget, an iteration limit or a subagent limit records the run as
`stopped` with `pause_reason: 'ceiling_reached'` — never `error`, and never
`paused`.

All three words already mean something here. `error` means something broke and
retrying might work; a ceiling means the run did exactly what it was told and hit
the number the user chose. `paused` means the run is waiting to be resumed, and
these are not resumable: the point of a ceiling is that the work stops. Reporting
a ceiling as an error would also put a red entry in the activity feed for a
correctly functioning limit, training the user to ignore red entries.

### Ceilings are read once, when the budget is constructed

`TaskBudget` snapshots `tokenCeiling`, `iterationCeiling` and `subagentLimit` at
construction and never re-reads them. A run therefore keeps the limits it started
under for its whole life.

The alternative — reading the setting at each check — sounds more responsive and is
worse: raising a ceiling while a run is stopping would un-stop it halfway through
its own shutdown, and a run could cross and re-cross its limit as the value moved
under it. A budget has to be a fixed quantity for "exceeded" to mean anything. A
new limit applies to the next run, which is when the user expects a setting to
take effect anyway.

### `command_prefix_match` is named for exactly what it does

The `enforced` field on `GET /api/settings/network-egress` reports
`command_prefix_match`, and that string is a warning, not a feature name. The
check looks at the start of a command for known network tools. It is not a
sandbox, not a firewall rule, not a namespace, and a determined command defeats it
trivially — a pipe, a shell variable, an interpreter one-liner.

It is surfaced under an honest name so that nobody builds a security claim on top
of it, and so a future reader does not assume egress is *contained* because a
setting says it is off. The real containment boundary in this app is the localhost
bind and `fsScope`. If genuine network containment is ever needed, it needs a
different mechanism and a different label; do not quietly upgrade this one's
description.

### `network_egress` is the only derived capability (added by the Slice 2 groundwork)

`isCapabilityOn` special-cases exactly one name. `network_egress` is ANDed with
`code_execution`, because egress happens *by way of* a shell command: with command
execution off there is no request for the setting to permit, so reporting it as
effective would be a lie the UI would repeat.

Every other capability — including `web_research` — falls straight through to its
own stored value. **`web_research` is a peer, not a second name for
`network_egress` and not a sub-toggle of `code_execution`.** The two govern
different mechanisms: `network_egress` covers a command *the agent chose to run*,
an `npm install` reaching the registry from inside a worktree, while
`web_research` covers the agent fetching pages through a supervised MCP server —
no arbitrary binary, and traffic the user can see in the transcript.

Folding it under `code_execution` the way egress is folded would break a
research-only install, which is a configuration a user can reasonably want: they
switch code execution off, and web research silently stops working while its own
toggle still reads "on". That is precisely the silent no-op these gates exist to
prevent, and it is why the AND lives in one branch naming one capability instead
of a general "derived from `code_execution`" rule that a third capability could be
swept into by accident.

Adding a capability needs no migration — `CAPABILITIES` is a `const` array in
`src/db/settings.ts` and the rows are created on demand, defaulting to on. What it
*does* need is a label in `LABELS` in `src/services/limits/capabilities.ts`, since
`assertCapability` refuses by name and an unlabelled capability would refuse as
`undefined`.

### Response preferences are stored and returned, never injected

`/api/settings/preferences` persists the user's text and reads it back. **No code
path in the backend puts it into a prompt.** Assembling it into a system prompt is
the caller's job, exactly as with the skills summary.

This is recorded because the gap is invisible from the API: a user can save
preferences, see them echoed, and reasonably conclude they are in effect. Anyone
adding a system-prompt assembly step should wire this in; anyone debugging "my
preferences are ignored" should look here first rather than at the setting.

Note also that unset reads back as `""`, not `null` — `responsePreferences()`
returns an empty string so callers can concatenate without a guard — while
*cleared* means no row at all. "Has the user ever configured this?" is answered by
the presence of the key in `GET /api/settings`, not by the emptiness of this
value.

### Blank clears a preference, which is why it cannot use `asString`

The preferences route uses `asClearableString`, not `asString`.

`asString` rejects an empty or whitespace-only value as a missing field, which is
right nearly everywhere — a blank provider name is a mistake. It is wrong here,
and this was a real bug: the textarea is the user's only control, so emptying it
and saving is the *only* gesture available for "I no longer want preferences", and
`asString` turned that gesture into `400 preferences must not be empty`. The
setting could be created and edited but never removed.

`asClearableString` exists for this shape — a field where blank is a legitimate
instruction rather than an omission. Reach for it only where clearing is genuinely
what blank means; the strictness of `asString` is the correct default and should
not be relaxed to make a validation error go away.

---

## Temporary chats (added by Prompt 1.20)

### A temporary chat is never inserted, not even briefly

An incognito chat lives in an in-memory registry. It is not written and then
deleted, and not written with a flag that hides it. No `INSERT` ever names it.

Anything else leaks. A row written and deleted survives in the WAL, in the daily
backup that runs on a timer, and in a `.db` file the user might hand to someone
else. A row with an `is_temporary` flag is one forgotten `WHERE` clause away from
appearing in the sidebar, an export or a bulk delete. The only implementation of
"this conversation is not being recorded" that is true tomorrow is the one where
the write does not exist.

The session ends when it is deleted, when its idle timer expires, or when the
process exits — and process exit is a real, intended ending, not a leak of state.

### Incognito usage is recorded anonymously, and this is load-bearing

A temporary turn writes a real `usage_log` row: real tokens, real cost, with
`chat_id` and `message_id` NULL.

Both halves matter. The row must exist, because a private conversation still spends
the user's money and must count toward the daily cap. The identifiers must be
absent, because the id of a chat that was never saved has no business on disk.

**This is a fix, not a design note.** The first version passed the temporary chat's
id straight through. `usage_log.chat_id` carries a real foreign key to `chats`,
that row does not exist by construction, so SQLite rejected every insert — and
`recordUsage` swallows its errors on purpose, so that accounting can never break a
user's chat turn. The two behaviours combined into a silent hole: every incognito
token was free as far as the spend cap could tell, with no error anywhere to
suggest it.

What made it possible was a *comment* asserting the opposite — that the write was
safe because the id was "just a label". Nothing enforced that claim and nothing
tested it. Hence the invariant, and the general lesson: when a swallowed error sits
downstream of a foreign key, a comment is not evidence that the row lands. The
regression test asserts the row exists **and** that its `chat_id` is NULL, because
either half alone passes for the wrong reason.

### Pin and archive are refused for a temporary chat

Both return `400` naming `id`.

Pinning and archiving exist to exempt a chat from the cleanup sweep — they are
instructions about how long something is *kept*. Neither has a meaning for a chat
that is not stored, so accepting one would return success for an operation that
did nothing. A refusal that names the field is how the UI knows to hide those
controls in an incognito session.

### `deleteChats` is deliberately not transactional

Bulk delete loops, deleting each id independently, and returns
`{ deleted, missing }`. It is not wrapped in a transaction, and `missing` is not an
error.

This is a considered exception to the usual rule of making a multi-row write
atomic, and it is recorded so it is not "fixed" later. Atomicity is valuable when
partial application leaves inconsistent state. Here the rows are unrelated, and
the user's intent is not one indivisible act but forty independent ones. Rolling
all of them back because the thirty-ninth id was already gone would discard
thirty-eight deletions the user asked for and watched succeed — the transaction
would be the defect.

For the same reason a missing id is reported rather than raised: the end state the
caller asked for has been reached. `missing` exists so a client can tell "already
gone" from "just now deleted" if it cares, and most will not.

---

## Brand-approved design assets (added by Prompt 1.22)

### Approval is a second cleanup exemption, independent of `pinned`

`is_brand_approved` and `is_pinned` are separate columns (migration `011`) and
either one exempts an asset from the TTL sweep.

They answer different questions. A pin says "do not delete this yet" — a disk
housekeeping decision. Approval says "this is the brand" — a statement about
canonical identity that happens to imply keeping the file. Collapsing them into
one flag would mean unpinning the logo to tidy the gallery quietly un-brands it,
and that the approved-assets list could not be ordered by when the decision was
made.

The consequence to keep in mind is that the cleanup sweep must test **both**
exemptions. A sweep that checks only `is_pinned` would delete the approved brand
assets, which is the most expensive thing in the gallery to lose. Any new
exemption belongs in the same place, next to these two.

### `brand_approved_at` is cleared on revocation

Unapproving writes `is_brand_approved = 0` **and** `brand_approved_at = NULL`,
rather than leaving the old timestamp in place.

`listApprovedAssets` orders by `brand_approved_at DESC`, so a stale timestamp
would sort a re-approved asset by a decision the user has since reversed — the
newest approval appearing in the middle of the list. The timestamp records a
standing decision, not the history of decisions; when the decision is withdrawn
there is nothing left for it to describe. If an audit trail is ever wanted, it
needs its own table and must not be reconstructed from this column.

### Toggle and revoke are separate routes

`POST /assets/:id/approve` toggles when `approved` is omitted, because one gallery
button wants exactly that. `POST /assets/:id/unapprove` always revokes.

The second route is not redundant. "Remove from brand" clicked twice must not
re-approve the asset, which is precisely what a toggle would do on the second
click — and a double-tap on a phone is not a rare event. Idempotent intent gets an
idempotent endpoint.

---

## Outbound data safety (added by Prompt 1.23)

### `looksRedacted` is not a "contains a secret" predicate

The name reads as though it answers "does this text look like it has a secret in
it". It answers the opposite question: it is `true` when the text contains
**nothing** credential-shaped, and it exists so a *log line* can be asserted
clean.

Reaching for it as the outbound check would invert the gate — every payload
carrying a key would return `false` and be waved through, and the feature would
appear to work because clean payloads would still pass. The doc comment on it was
itself inverted until this prompt, so the trap was documented backwards as well
as named badly.

The detector is `containsSensitive` / `findSensitive`. There is a test asserting
both polarities side by side (`looksRedacted is not a "contains a secret"
predicate`) specifically so the next person to reach for the wrong one has it in
front of them.

### Detection and masking are separate functions

`redactSecrets` rewrites text. `findSensitive` only *locates* — it returns
`{ kind, index, length }` and never the matched substring.

They are deliberately not merged. Masking is for text that is about to be written
somewhere we control (a log, `privateDetails`), where losing the original is the
point. Detection is for text the user still owns and may want to send anyway, so
it must not alter the payload — and a finding that carried the matched text would
put the secret into the very error envelope the check exists to prevent leaking.

Consequently **the gate never rewrites a message.** A rewritten prompt would
change what the user asked without their knowing, and a partially masked key is
still a leak if the mask is wrong. The only outcomes are "sent as written" and
"refused".

### The scan never quotes what it found

`SensitiveHit` is offsets plus a rule name. The span locates the secret in text
the client already has, so a UI can highlight it without the server echoing it
back.

This is the same rule as the upstream-provider bodies in `03-security.md`: an
error travels much further than a response. It reaches the error log (§13 of
`docs/API.md`), the process-level handlers, and any crash reporter. A hit
carrying `text: "sk-…"` would persist the credential in the one table designed to
survive restarts. `test/outbound.test.ts` asserts on
`JSON.stringify(error.toJSON())` for exactly this.

### The check is off by default, unlike every capability

Capabilities (§20.2) default to **on** — they describe what the app may do, and
the user switches them off. `redaction_check_enabled` defaults to **off**, and it
is deliberately *not* in the `Capability` union.

The asymmetry is the false-positive cost. A capability being on is invisible until
something uses it; this check being on can refuse a message the user is actively
trying to send, on a pattern match that may be wrong. That belongs behind an
opt-in, not something discovered by being interrupted mid-sentence.

`enforced: 'pattern_match'` is named in the same spirit as
`command_prefix_match`: it recognises credential *shapes*, and a secret that
looks like prose passes straight through. Nothing may be built on this as though
it were a guarantee.

### Only a positively-identified remote provider is gated

`classifyProviderType` maps `local` and `colibri` to `local`, `remote` and
`opencodex` to `remote`, and everything absent to `unknown`. The gate fires on
`remote` only.

Both surprising cases are surprising in a way that matters. **`opencodex` is
remote**: it is a local *proxy* that routes to upstream vendors, so a payload
handed to it leaves the machine (proven from `002_opencodex_provider_type.sql`
and its adapter, which speaks the OpenAI Responses API to a gateway).
**`colibri` is local**: it sounds like a hosted service but serves a model on
this machine. A frontend inferring egress from the type string would get both
backwards, which is why `GET /api/providers/active` serves `egress` rather than
letting the client compute it.

`unknown` is not gated, because warning about a provider we cannot classify would
train the user to dismiss the prompt. But `unknown` is never reported *as* local
either — see the exposure bucket below.

### The gate runs before the user turn is persisted

In `sendMessage` the order is: build the request → **gate** → append the user
message → create the assistant message → create the run. The gate sits at the
last point where nothing has been written and nothing has been sent.

This ordering is load-bearing, not incidental. The acknowledged retry is the same
request with one flag added, so persisting the user turn first would store it
once per attempt and the transcript would show the prompt twice. A refusal has to
leave the chat exactly as it was.

**Moving the append below `buildRequest` had a consequence that typecheck cannot
see**: `history` no longer contains the new turn, so the model would have received
the conversation *without* the question. `buildRequest` therefore pushes the
pending prompt itself, mirroring the `content.trim().length > 0` filter in
`toProviderMessages` so that a whitespace-only prompt is still stored and still
not sent, whether it comes from the database or from the argument. If either side
of that mirror changes, both must.

### The residual failover gap is recorded rather than hidden

The gate classifies the provider the turn is *about to* be sent to. A mid-run
failover can move the turn to a provider of a different egress class, and the
gate does not re-run — by then the request is already in flight and there is no
user present to acknowledge anything.

This is a known limit, not an oversight. What compensates is the usage row: both
`recordUsage` calls stamp the provider type that **actually served** the turn, so
the exposure summary reflects where the bytes really went even in the case the
gate could not intervene. A summary built from the *intended* provider would
quietly under-report exactly the situation the user most wants to know about.

### `usage_log.provider_type` is nullable on purpose

Migration `013` adds the column without `NOT NULL` and without a `CHECK`.

`recordUsage` swallows every error it hits — that is itself deliberate (a failed
accounting write must never break a working chat turn). A `NOT NULL` column would
therefore turn any path that omits the type into a **silently discarded spend
row**, reopening precisely the cap-bypass hole that `test/temporarychats.test.ts`
was written to close. Nullable is the safe direction: the row survives and lands
in the `unknown` bucket where it is visible.

No `CHECK` either, because provider types are a widening set — `002` and `005`
each added one, and a constraint here would mean a third migration every time.

### The type is stamped at write time, never joined

The class comes from the column on the usage row, not from a join against
`providers`. So deleting a provider does not erase the record of what it sent, and
re-pointing one cannot rewrite history retroactively. There is a test that deletes
the provider and asserts its spend is still attributed to `remote`.

### `unknown` exposure is surfaced, never folded into `local`

`summarizeExposure` reports `hasUnclassified` and keeps an `unknown` bucket
rather than distributing those rows. Understating exposure is the one error this
feature must not make: folding unclassifiable rows into `local` would tell the
user nothing left the machine, which is the opposite of "we do not know". Rows
written before `013` are exactly this case.

### `redaction_flagged` is a 409, and is not retryable

Not a 403: nothing is forbidden. The request conflicts with the current state of
the message, and the user can resolve it — which is what 409 means everywhere
else in this API.

It is deliberately absent from `DEFAULT_RETRYABLE`. Resending the identical body
cannot succeed, so an automatic retry would burn attempts on a refusal that will
never change, and a retry loop would re-refuse forever.

### On a stream the refusal loses its details (found by HTTP smoke testing)

`AppError` carries `details.kinds` and `details.hits` so a UI can highlight the
offending span. On `POST /api/chat/stream` **the client never receives them.**
`SseSink.sendError` puts exactly four fields on the wire — `runId`, `code`,
`message`, `retryable` — and the stream is opened before `sendMessage` runs, so
the refusal arrives as an `error` frame under HTTP 200 rather than as a 409
envelope.

This was found by sending a real flagged prompt to a booted server, not by the
32 module-level tests, which assert on the thrown `AppError` and so see fields
the socket drops. It is recorded because the honest reading of the code is easy
to get wrong in both directions: the gate *does* attach the hits, and the status
*is* 409 in `STATUS` — neither fact reaches a streaming caller.

Do not "fix" this by widening `sendError` to spread `details`. That changes the
wire format of every existing event type, and one of the fields it would start
forwarding is `privateDetails`' neighbour on the same object — the exact shape
`03-security.md` keeps off the client. If a streaming client needs the spans, the
right change is a purpose-built event, decided deliberately.

### `acknowledgeSensitive` is per request, never stored

Consent to send one key is not consent to send the next one. The flag lives on
`SendMessageInput` and dies with the request; there is no setting that means
"stop asking me". If there were, the check would decay into permanently off while
still appearing enabled.

### `GET /api/providers/active` must stay above `/:id`

Express matches in registration order, so declared after `/:id` this route
returns `404 not_found` — `No provider with id "active"`. The same trap as
`/bulk-delete` and `/assets/approved`. There is an HTTP-level test asserting the
200, because no module-level call can reach a route-ordering bug.

## Stopping a run is not the same as losing the client (groundwork for Prompt 1.24)

### `ctx.signal` combines disconnect with cancellation

`AgentContext.signal` used to be `sse.signal` verbatim. That signal fires on one
event only: the browser going away. It is the right thing to abort an in-flight
provider request with, and it was never a cancellation channel.

Cancelling through it would have meant calling `sse` abort on a live stream — the
same stream that still has to deliver the terminal `stopped` frame and whatever
partial work the agent completed. The user would press stop and lose the output
they were stopping *to keep*.

So `createAgentContext` takes an optional `cancelSignal` and derives
`stopSignal = AbortSignal.any([sse.signal, cancelSignal])`. Every place that
previously read `sse.signal` — `llm.stream`, `llm.complete`, `executeCommand`, and
the `signal` getter — now reads the composite. A disconnect therefore still aborts
exactly as it always did; cancellation is simply a second reason to stop.

### With no `cancelSignal`, the identity of the signal is preserved

`AbortSignal.any` is deliberately skipped when no cancel signal is supplied, so
`ctx.signal === sse.signal` remains literally true for every existing caller.
That is asserted by identity rather than by behaviour, because it is the cheapest
proof that this refactor changed nothing for a run that cannot be cancelled.

### The composite is derived once, not per read

`sse.signal` is backed by a single `AbortController` created with the stream, so
reading it once at construction is equivalent to the old getter. The getter must
keep returning that one derived object: any long-running agent loop will store
`ctx.signal` in a local, and a getter that built a fresh `AbortSignal.any` per
call would leave the stored copy permanently unaborted. There is a test that
captures the signal first and aborts afterwards for exactly this reason.

### Why this landed before the cancel endpoint

This was committed on its own, ahead of Prompt 1.24. An earlier claim that cancel
needed "only a registry and a route" was wrong — it rested on `ctx.signal`
already being a general-purpose stop signal, and it was not. Separating the
signal change from the endpoint keeps the part that touches every existing agent
call path in a commit whose whole diff can be read against the old behaviour.

## Task cancellation  *(added by Prompt 1.24)*

### Every cancel outcome is a 200, including "there was nothing to signal"

`POST /api/{tool}/tasks/:taskId/cancel` answers the question "is this task
stopped?", and three different situations all answer it with yes: a live run was
signalled, the run had already finished, or a row was stranded in a non-terminal
state by a process that died. Only a task id that was **never** seen is a 404.

The temptation is to 404 when the registry has no controller, since that is the
one case where nothing was aborted. That would be wrong twice over. A run that
completed a moment before the click is not missing — it is finished, which is the
outcome the user wanted — and a stranded `running` row is precisely the case where
cancelling matters most, because nothing else will ever clear it. Returning 404
for either would make a working stop button look broken.

For the same reason it is not a 409 either. There is no conflict to report: the
end state the caller asked for is the end state they get.

### `stopping` is not `stopped`

A live cancel replies `state: 'stopping'` with `wasRunning: true`. The signal has
been delivered; the work has not necessarily ended. An agent may be mid-tool-call
and unwinds asynchronously, so claiming `stopped` in that reply would be a lie the
client could observe — it would poll `/state` and still see `running`.

The two remaining cases reply with a state that is already true, and
`wasRunning: false` distinguishes "we interrupted something" from "nothing was
running". A client that wants the terminal state watches the SSE stream or polls
§12.4 rather than trusting the cancel response to be final.

### A cancelled run is `stopped`/`cancelled`, never `error`

An abort raised by a user's cancel and an abort raised by a crash arrive at the
same `catch`. The `cancelled` flag on the registry entry is the only thing that
tells them apart, which is why the flag lives beside the signal rather than being
inferred from `signal.aborted`.

Recording `error` would be wrong in a way that compounds: the run would earn a
retry prompt in the UI and a row in the error log (§13 of `API.md`), so stopping
a task on purpose would look like a fault and pollute the very view used to find
real ones. `pause_reason: 'cancelled'` is what separates a user stop from a
ceiling stop, which also lands on `stopped`.

### Registration happens before the lock, not inside it

`registerCancellable` is called before `withLock`/the Code lane, so a task parked
in a queue is cancellable. Registering inside the lock would mean a task waiting
behind a full lane had no controller yet, and the endpoint would report it as a
task it had never heard of — a 404 for the run the user can most plainly see
sitting in the queue.

The cancellable's signal is therefore also passed to the lock itself
(`AbortSignal.any([sse.signal, cancellable.signal])`), so a cancelled queued task
leaves the queue instead of waiting for its turn only to stop immediately.

### The registry is in-process and keyed two ways

Cancellation is not persisted, exactly like the job lock: it applies to work this
process is running, and a registry that survived a restart would offer to stop
runs that no longer exist. Boot-time reconciliation already handles rows a dead
process left behind.

`byRunId` and `byTask` exist for different questions. "Cancel this task" resolves
through `(tool, taskId)`, where the **newest** registration wins, because a retry
reuses the task id and the run the user is looking at is the current one.
"Was *this attempt* cancelled?" resolves through `runId`, so a retry cannot make
the previous attempt look cancelled. `dispose()` clears the task index only when
the entry there is still its own — a keyed check, mirroring the lock's release —
so a late dispose cannot unregister the retry that succeeded it.

### A cancelled scheduled run is `skipped`, and its `last_run_at` is stamped

Scheduled Cowork runs land on `skipped` rather than a new status. Migration `006`
constrains `scheduled_task_runs.status` to
`('running','success','failed','skipped')`, and widening a CHECK constraint is its
own migration — but `skipped` is also the honest word: `failed` against a task
that did exactly what it was told is a lie the history keeps repeating.

The stamped `last_run_at` is load-bearing rather than incidental. Due-ness is
computed from it, so a cancelled run that left it untouched would come due again
on the very next tick and restart the work the user just stopped.

### The cancel routes are declared after the `/state` routes

Express matches in registration order. Both live under
`/api/{tool}/tasks/:taskId/...`, so the literal suffixes must not be able to
shadow one another — the same ordering rule that made `/api/providers/active`
resolve as a provider id when it was declared too late.

---

## The tool-call protocol  *(added by Slice 2, step 1)*

**Who depends on this:** every agent loop. Until this landed the provider path
was text-only — no `tools`, no `tool_calls`, no `tool_call_id` anywhere in the
repo — so an agent could describe an action but never request one. This is the
foundation the Code, Cowork and Design loops all sit on, which is why it shipped
as its own change ahead of them.

### Argument fragments are reassembled by index, not by id

A provider streams one tool call across many SSE frames. The first frame carries
the `id` and the function `name`; every later frame carries only a **slice of the
argument JSON** and the `index` it belongs to. Those slices are not individually
valid JSON — `{"pa` parses as nothing.

So accumulation is keyed on `index`, which every fragment carries, and **not** on
`id`, which later fragments omit. Getting this wrong produces a call whose
arguments are only the final fragment, which then fails to parse or, worse,
parses into something plausible but incomplete.

`ToolCallAccumulator` in `src/providers/adapters.ts` owns this. The mock provider
deliberately splits arguments into two-character slices so the reassembly is
actually exercised; a single-frame mock would assert none of it.

### A tool call is emitted only once it is complete

`StreamChunk` gains `{ type: 'tool_call'; call: ToolCall }`, yielded when
`finish_reason` arrives — not per frame. A half-built `arguments` string is
useless to a consumer, so partial calls are never surfaced.

The corollary matters for anything reading the stream: **`tool_call` chunks are
emitted before `done`**, never after. A consumer that stops reading at `done`
would silently lose the call, so there is a test asserting the ordering.

### `arguments` stays a string

`ToolCall.arguments` is the raw JSON text, not a parsed object. That is how it
arrives, and a model can emit malformed JSON — parsing at the boundary would turn
"the model made a mistake" into "the adapter threw". The dispatcher parses it and
gets to decide what a parse failure means, which is a decision the protocol layer
should not make on its behalf.

### An empty `tools` array is not the same as no tools

`tools` and `tool_choice` are omitted from the request body entirely when no
tools are offered. Several OpenAI-compatible gateways **reject** `tools: []`
rather than treating it as "no tools available", so sending an empty array would
break plain chat on those gateways. Likewise `tool_choice` is never sent without
`tools`. Both are asserted against the real request body the mock received.

### A `tool` message must carry the id of the call it answers

`ChatMessage` gains `toolCalls` (on the assistant turn that requested them) and
`toolCallId` (on the `tool` message answering one). Without that pairing the
provider cannot match a result to its request and rejects **the whole
conversation**, not just the offending message.

`MessageRole` already included `'tool'` before this change, but nothing could
populate it usefully because there was nowhere to put the id — which is why the
role existing was not evidence that tool calling worked.

### Failover treats a tool call as output

In `src/providers/router.ts` a `tool_call` sets `emitted = true`, exactly as a
token does. A provider that has already decided to call a tool cannot be swapped
out mid-decision: retrying on another provider would re-issue the call and
duplicate whatever side effect it has.

---

## The shared agent loop  *(added by Slice 2, step 2)*

**Who depends on this:** the Code, Cowork and Design agents. All three run the
same cycle — ask the model what to do, do it, feed the outcome back — so the
cycle lives in `src/services/agent/loop.ts` and the agents differ only in their
prompts and their tool sets. An agent that writes its own loop also writes its
own version of the mode gate, the iteration ceiling and the parked-state
bookkeeping, and the second copy is where they drift apart.

Worth recording plainly, because the plan for this step assumed otherwise:
**there was no tool dispatch point in the codebase before this.** Tool calls were
parsed and transported only — `src/orchestrator/chat.ts` drops `tool_call`
chunks, and no `callTool` existed anywhere in `src/`. So the mode gate was not
added to an existing dispatcher; the dispatcher is new, and the gate is the
reason it exists.

### The mode gate sits at exactly one place

`dispatchToolCall` is the only function in the module that invokes anything, and
the Ask/Plan/Act decision is made inside it. Checking the mode where the loop
*builds* a request would leave every future call site free to skip the check, and
the entire value of a read-only mode is that it cannot be bypassed by a path
nobody remembered to guard.

The corollary for anything added later: a new agent must reach its tools
*through* `dispatchToolCall`. Calling a tool runner directly compiles, runs, and
silently ignores the mode the user selected.

### An unclassified tool is treated as mutating

`ToolPolicy.effect` returns `ToolEffect | undefined`, and `undefined` means "not
classified" — never "harmless". The loop folds it into `mutate`.

Defaulting the other way would mean any tool added without a matching policy
entry becomes runnable in Plan mode, which is precisely the failure Plan mode
exists to prevent. The safe default is the inconvenient one: a newly added tool
is refused in Plan mode until somebody classifies it, and that refusal is
visible, whereas the opposite mistake is silent.

### A refusal is output, not an exception

A gated call returns `{ ran: false, output }` with the refusal written as ordinary
tool output. The model is mid-conversation and needs to hear *why* it cannot act
so it can answer in prose or add the action to a plan; throwing would abort the
run and lose the turn the user was waiting on.

For the same reason a refusal records `ok: true` in the step history. It is not a
failure — the gate did exactly what it was asked to do. A refused mutating call
in Plan mode is recorded with `kind: 'plan'`, so the plan can be reconstructed
from the step rows alone; Ask mode records `kind: 'note'`, because nothing about
an Ask-mode run is a proposal.

### A parked run is written before it is announced

`updateTaskRunState` runs before `ctx.emit`. Reversed, a client that acted on the
event and then reloaded would find a run still marked `running`, because nothing
guarantees this process survives from one statement to the next. The database is
the record; SSE is a notification about it. There is a test that reads the run
state from inside the `emit` callback for exactly this ordering.

### A parked run is not a finished run

Parking goes through `updateTaskRunState`, **not** `finishTaskRun`. This is not a
stylistic preference: `finishTaskRun` always rewrites the pause and error
columns, so routing a park through it would overwrite the provider failure a run
may already be carrying and replace it with a park reason — destroying the
diagnosis the user needs to understand what happened. `updateTaskRunState`
touches the state column alone and leaves `completed_at` unset, which is the
truth: the run is waiting on the user and will continue.

The reason for parking therefore lives in the step history instead of in a run
column, recorded as a `note` step with `ok: false` and a `reason: detail` body.

Only `plan_ready` maps to `ready_for_review`. `loop_detected`,
`iteration_ceiling` and `redaction_blocked` all map to `blocked`, because
`ready_for_review` is an invitation to look at finished work and the other three
are requests for help.

### The repeat guard counts identical calls, not iterations

An iteration ceiling alone does not catch the common failure, which is a model
making what it believes is progress: calling the same tool with the same
arguments, getting the same answer, and doing it again until the budget runs out
and the run dies with a confusing ceiling error rather than the true reason.

The signature is the tool name plus the **verbatim** argument string. Comparing
parsed arguments semantically would be more thorough and is not worth it — a
model stuck in a loop re-emits a byte-identical call, because it is regenerating
from the same context. Keying on the name alone would be wrong in the other
direction: reading ten different files is ten pieces of real work, not a loop.

The limit is 3 by default: two identical calls is a legitimate retry, three is a
pattern.

### An unattended redaction finding parks the run instead of failing it

`assertOutboundSafe` throws `redaction_flagged` on the assumption that a user is
present to read the finding and decide. A scheduled task, or a queued task the
user has navigated away from, has nobody to ask — and both obvious answers are
worse than parking. Sending anyway defeats the check. Failing the run as an error
tells the user their task broke, when in fact it is waiting on them.

So `parkOnRedaction` parks the run as `blocked` and throws a **fresh**
`AppError`, deliberately not quoting the original. The original message describes
what was found in the outbound text, and that description can contain the
credential itself; the replacement says a credential-shaped string was found and
where to go to review it. A test asserts the secret appears in neither
`error.message` nor `toJSON()`.

When a user *is* present the error is re-thrown untouched, so the 409 reaches the
UI that knows how to offer acknowledgement. Anything that is not a
`redaction_flagged` `AppError` is re-thrown untouched in both cases — this
function must never become a general-purpose catch that turns unrelated bugs into
parked runs.

### Cancellation is checked between iterations, not only around the model call

`ctx.signal.aborted` is tested at the top of every iteration, before the turn is
requested. A loop that only checks the signal around the LLM call keeps executing
tools after the user has clicked stop, which is the visible-but-wrong behaviour:
the UI says stopped and the filesystem keeps changing.

