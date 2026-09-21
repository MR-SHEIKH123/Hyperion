# Cross-cutting contracts

Behaviour that more than one part of the system depends on. If you change
something described here, the other side breaks — so change both.

---

## Skill dependency status (added in 1.6)

**Who depends on this:** the agentic layer (skill-consumption) must
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
| `needs-user-approval` | Packages are fine; a system binary is missing and needs the user's go-ahead. **Not runnable**, but nothing has failed — see 1.8(a) below. |

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

## Code task parallelism (added in 1.9)

**Who depends on this:** the agentic layer when it drives the Code
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

## Subagent path reservation (added by Master Plan v4 §6.6)

**Who depends on this:** the Code agent's `delegate` tool and anything that
reads a file a delegated child wrote — and, the day batch delegation actually
parallelises, every child running in the shared worktree at once.

Each parent run carries a map from workspace path to the child task id that
has written it, living in the run's shared state and acquired automatically:
the first time a child's `write` targets a path, that path is reserved to
that child for the rest of its run. A `write` from anyone else — a sibling
child or the parent itself — fails with a coded `conflict` naming the holder,
before any bytes land. Reservations are released in `delegate`'s `finally`,
so a child that errors or is stopped leaves nothing behind.

The parent checks but never acquires. That asymmetry keeps the ordinary
handoff — parent writes a skeleton, then delegates "fill it in" — from being
a self-inflicted conflict, and it is why the map's values are only ever child
task ids.

Two accepted limitations, both deliberate:

- **Only the `write` tool participates.** A child can still reach the same
  file through `bash`, `command` or `restore`, whose side effects cannot be
  intercepted at a dispatch table. The reservation is a cooperation protocol
  between well-behaved writes, not a hard guarantee.
- **It detects at write time; it does not prevent at plan time.** The losing
  child stops with a coded error and the parent re-routes. Pre-declaring path
  sets up front — which would let the parent schedule around collisions — is
  the sequenced v2 and stays gated on observed collision frequency, not built
  on spec.

Scope, stated once and pre-registered so it is not re-litigated: the guard is
Code-only. Cowork is collision-safe by construction (its outputs are
append-version `artifact_versions` rows; there is no shared mutable
location). Design, when it lands, is excluded for the same reason doubled —
its artifacts are DB-backed (`design:file:{runId}:{path}`) and its toolset
contractually excludes `write`, `bash` and `command`. And the map arbitrates
within one parent run: lane-parallel top-level Code tasks are separated by
worktrees, with `direct` mode the documented degradation where they are not.

Under the loop's current serial tool dispatch the `conflict` cannot fire —
children run to completion one at a time and release before the next starts.
The guard is in place and tested anyway, so the confirmed parallel direction
of batch `delegate` cannot ship without it.

---


## Recommended skills (added in 1.7)

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

## Recommended MCP servers (added in 1.7)

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

Worth remembering while testing: this backend writes `mcp_config.json`, owns
the registry and, since *The MCP supervisor* below landed, spawns the
processes too. `managed: false` now means only `HYPERION_MCP_DISABLED=1` or a
boot that has not reached registration yet — never "spawning is someone
else's job". A correct, enabled entry is still not a *running* server: read
`servers[].state`, and for graphify the venv and the graph build above have
to exist first.

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

## Task step history (added in 6c)

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

## Resource link detection (added in 1.10)

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

## Legacy data directory (added in 1.11)

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

## Colibrì providers (added in 1.12)


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

## Project rules, agents and commands (added in 1.13)

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

## Error log and task state recovery (added in 1.15)

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

### `blocked` is reconciled, `ready_for_review` is not (added in 1.21)

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


## Project scoping (added in 1.16)

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


## Scheduled tasks and the knowledge library (added in 1.8)

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


## Browser push notifications (added in 1.14)

**Who depends on this:** the frontend's service worker, which receives `PushPayload` and
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

### What leaves in a notification, and how much of it *(S19)*

The payload carries a task's name and its run summary — model output about the
user's own data. Three facts make that acceptable, and each is a place a future
change could quietly stop being true:

* **It is encrypted to the browser, not to the push service.** `web-push` encrypts
  the payload with the subscription's own keys (`aes128gcm`), so the service
  relays ciphertext; VAPID is authentication, not the privacy layer.
* **Nothing logs it.** `sendPush` logs a reason and counts, never a body, and the
  endpoint appears truncated even in failure logs.
* **The device decides what to show.** The summary does reach a lock screen, which
  is a deliberate product choice — "tell me what happened while I was away" — and
  the place a user would most reasonably ask for a shorter form.

**Bound to the transport.** A push message is capped at 4,096 octets — the size a
push service must accept — and `buildPushBody` clamps each text field well under
that (title 240 bytes, body 600, url 512, tag 128, cut on a character boundary).
Before it existed, a summary longer than the cap produced a message the service
refused; the rejection is not 404/410, so the subscription was deliberately kept
and **no notification arrived, silently, for exactly the runs with the most to
report**. A notification is a pointer to the app, not the report: the tray
truncates anyway, and the clamp says so with an ellipsis rather than pretending
the text ended.

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

## Chat transcripts are cursor-paginated (added in 1.8, found missing by the 1.17 audit)

`GET /api/chat/:id/messages` takes `before=<message_id>`, never `?offset=`, and
returns `nextBefore` for the next page up.

This was specified in 1.8 and then not built; the 1.17 audit caught it
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

## Automatic backups can be mirrored off the machine (added in 1.8)

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

**How the test avoids proving nothing** (added in 1.18). All
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

## A backup exported without keys carries no plaintext credential *(S18)*

The export has always excluded `secret.key`, and the comment beside that decision
states the guarantee: *a leaked backup exposes conversations but not credentials*.
`mcp_config.json` was included unconditionally and broke it — `registry.ts::toEntry`
materialises a remote server's token into the file as a literal
`Authorization: Bearer ...` header, so the default archive contained a working
credential in the clear, in the artifact most likely to be copied to a sync
folder or a USB stick.

**Why the fix is structural rather than a redaction pass.** Nothing in the file's
format marks which value is a secret: the same slot holds a workspace path
(`args`) or a token (`headers.Authorization`), and `env` values are whatever the
user put there. A redaction pass would be a guess that reads as a guarantee —
the worst kind of control. The rule is instead: **the file travels only with
`includeKeys`**, the same switch that ships the key which makes its tokens
decryptable in the first place.

**Nothing is lost that a restore could use.** The registry's authority is the
database, not the file: `listServers()`, the process manager and
`GET /api/mcp/servers` all read the table, and `POST /api/mcp/sync` regenerates
the file from it. The servers therefore travel in the archive as rows. Their
`token_enc` travels as ciphertext and is useless without a key the default export
also leaves out — which is exactly why the plaintext header next to it must not
travel either. A restore that is given no `mcp_config.json` entry writes none,
leaving the file already on the machine untouched rather than downgrading it.

The manifest says so in words. `contents.mcpConfig` is `false`, and the
human-readable `warning` names the omitted file, since a user comparing two
archives should be able to see what a default export decided to leave behind
without reading this document. With `includeKeys: true` the file is included
verbatim and the warning is the key warning instead: full fidelity is available,
it is just opt-in.

Pinned by `test/backupsecrets.test.ts`, which asserts against the archive's own
bytes — a token that appears anywhere in the zip fails the test, whatever the
route it took to get there.

## Health summary and activity feed (added in 1.17)


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

`GET /api/errors` (1.15) already serves raw records with stack traces,
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

The 1.17 design named three sources for the feed. Only two exist: nothing in the
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

## System binaries and user approval (added in 1.8(a))

**Who depends on this:** the agentic layer, which must ask rather than retry when
a skill is waiting on a person; and the frontend, which needs to tell "this skill
is broken" apart from "this skill needs your permission". Extends the 1.6
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

## Per-item export (added in 1.18)

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

The original spec specified `/api/chats/:id/export`. The router has been mounted
at `/api/chat` since `001` and every endpoint in API.md §4 lives under it, so a
plural sibling for this one route would leave two spellings of the same resource
in the API. The mount won; the deviation is recorded in API.md §19 so the next
reader of the spec does not "fix" it back.

---

## Settings depth (added in 1.19 / 1.20)

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

## Temporary chats (added in 1.20)

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

### Memory is the seventh writer, and it is refused too *(S20)*

The rule above is enforced by a guard in the storage layer, and the reason given
for that placement is exact: *every writer must pass through it.* Memory was a
writer that did not. After a completed turn the orchestrator handed the exchange
to `rememberTurn`, which asked mem0 to extract facts and wrote them to
`~/Hyperion/memory/` — durable, retrievable, injected into later turns, and
carrying the private chat's id as metadata on each one.

Nothing about that path is the chat table, so the storage guard never saw it, and
nothing about it looks like a transcript, so it did not read as a write. The user
was told the conversation was not being recorded; the transcript was not, and the
*facts distilled from it* were — which is the same promise, kept in letter only.

The guard therefore lives in `rememberTurn`, before the backend is even loaded:

```ts
if (isTemporaryChat(meta.chatId)) return 'temporary';
```

**Returned, not void.** `rememberTurn` reports `'queued' | 'disabled' |
'temporary' | 'empty'`, so the decision is observable and a future caller cannot
re-open the hole by ignoring a `void`. `test/memoryincognito.test.ts` asserts the
temporary case and that the memory directory stays untouched, that a saved chat
is still queued (the guard is about the chat, not about everything), and that the
toggle and the emptiness check still come first.

**Recall is not skipped, deliberately.** An incognito turn may still be given
memories to read: reading records nothing new, and the promise is about what is
written. Spending is not skipped either — `usage_log` takes an anonymous row,
which is the one write whose absence would be a bypass.

**Checked while here, and clean:** the other stores a turn can reach either cannot
see a temporary id or refuse it — `usage_log` nulls it deliberately,
`task_runs`' `linkedChatId` stores NULL for an id with no row, and the only asset
write on a tool path (`design.brand_propose`) passes no chat id at all, so
`attachments.chat_id` stays NULL.

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

## Brand-approved design assets (added in 1.22)

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

## Outbound data safety (added in 1.23)

### `looksRedacted` is not a "contains a secret" predicate

The name reads as though it answers "does this text look like it has a secret in
it". It answers the opposite question: it is `true` when the text contains
**nothing** credential-shaped, and it exists so a *log line* can be asserted
clean.

Reaching for it as the outbound check would invert the gate — every payload
carrying a key would return `false` and be waved through, and the feature would
appear to work because clean payloads would still pass. The doc comment on it was
itself inverted until this change, so the trap was documented backwards as well
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

### "Local" is verified against the URL, not taken from the type's word for it

The gate accepts a *subject* — the provider's type **and** the base URL it will be
called at — and `egressClassFor` decides from both. `classifyProviderType` still
exists, but only for rows: it maps `local`/`colibri` to `local` and
`remote`/`opencodex` to `remote`, and it cannot see a URL, which is exactly the
half of the question that was missing.

**A type that claims locality is checked.** `normalizeBaseUrl` accepts any http(s)
host, so nothing stopped a Colibrì box — or an Ollama server — on another machine
from being registered, enabled and used. Until this was fixed, all four surfaces
that answer "did these bytes leave" said no:

  - `GET /api/providers/active` served `egress: "local"`, the value the UI renders
    as "stays on this machine"
  - the credential scan was skipped, because `isEgress(type)` was false, so a
    prompt carrying a key went out unremarked
  - `zdrStatusFor` answered `local_no_egress` — "retention by a third party is not
    a question that arises" — which is a value that *satisfies* a `require` policy
  - the exposure summary stamped the row `local`, understating egress permanently

One provider, one URL, four false statements. The rule now: **only a URL that
parses to a loopback host is this machine.** `localhost`, anything under
`.localhost` (RFC 6761), `::1`, and the whole 127/8 block. Deliberately no DNS — a
name that merely resolves to loopback (`127.0.0.1.nip.io`) is still a name handed
to a resolver, and the answer can change underfoot.

**A declared remote is never downgraded, and an unverifiable claim is not believed
either.** `opencodex` at 127.0.0.1 stays `remote` — it is a local proxy that
forwards to upstream vendors, and a `remote` provider may be anything at all;
calling either one local would skip the scan. A local-typed provider with an
absent or unparseable URL is `remote` too: an unreadable address is not evidence
of locality. Understating egress is the one direction this module refuses to fail
in. A type this build does not recognise stays `unknown`, whatever its URL —
not knowing what a provider *is* cannot be improved by looking at its address.

`unknown` is not gated, because warning about a provider we cannot classify would
train the user to dismiss the prompt. But `unknown` is never reported *as* local
either — see the exposure bucket below.

### The class is stamped, so history cannot be restated

`usage_log.provider_egress` (migration `019`) records the class **at write time**,
for the same reason `013` records the type: a provider can be re-pointed or
deleted, and the summary has to be a record of what happened rather than a
re-derivation from whatever `providers` says today.

Rows written before `019` have no stamp and fall back to the type mapping they
were written under. That is a **permanent, recorded understatement** for any
pre-`019` local-typed provider that pointed off this machine: the URL was never
stored, so there is nothing to re-decide it with, and a backfill would only
restate the old judgement in SQL. It is named here rather than hidden, and the
class it was lived under is what those rows keep.

No backfill, and no second copy of the mapping in SQL. `classifyProviderType`
stays the single definition of the type half; `rowEgressClass` is the one place
the stamped value is preferred over it, and a stamped value this build does not
recognise falls back rather than inventing a bucket.

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
`recordUsage` calls stamp the **egress class** of the provider that actually
served the turn, so the exposure summary reflects where the bytes really went even
in the case the gate could not intervene. A summary built from the *intended* provider would
quietly under-report exactly the situation the user most wants to know about.

**Narrowed, not closed, by 1.26.** Zero data retention set to `require` removes
ineligible providers from the candidate list before anything is probed, so for that
policy there is no ineligible provider available to fail over *to*. The gap remains
open for `prefer`, which sorts rather than filters, and remains open in full for the
credential scan above, which is about payload content and has no candidate-list
equivalent. See "Zero data retention" below.

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

## Zero data retention (added in 1.26)

1.23 answered "where did the bytes go". This answers "and does whoever received
them keep it". The two are deliberately separate features: one is a check on
payload *content*, the other a standing policy about the *recipient*.

### Enforcement is candidate selection, not a gate before dispatch

`isZdrEligible` is consulted while the router decides **which providers are
candidates at all**, mirroring how `cachedSupportsModel` already excludes a provider
that lacks the model. It is not a check run once against the provider chosen up
front.

The difference is the failover case, and it is the whole reason for the design. A
gate is silent about the provider a request is moved to after it has started: by then
the payload is in flight and there is nothing left to refuse. Removing an ineligible
provider from the candidate list means it is never a failover target in the first
place — a structural guarantee rather than a check that has to be remembered at every
future dispatch site.

Three paths carry it, and all three must, or the guarantee has a hole:
`selectProvider`, `findProviderWithModel`, and `pickHealthyAlternative`.

### `require` filters, `prefer` sorts

`orderByZdr` removes ineligible candidates under `require` and moves them to the back
under `prefer`, keeping the incoming order within each group.

The sort follows the rule already written into `listFailoverCandidates`, where an
unhealthy provider is ordered last rather than excluded because "it beats having no
option at all". A preference that silently became a prohibition the moment nothing
eligible was configured would be a different feature from the one the user switched
on. The stable partition matters for the same reason: the incoming order already
encodes health and priority, and a comparator-based sort would discard both.

Under `off` the list is returned unchanged, so nothing about routing on a default
install can shift because this code exists.

### `prefer` keeps the residual failover gap, and the record is the compensation

Sorting cannot prevent a mid-run failover from landing on an ineligible provider once
output has started. **Only `require` is structurally safe.** This is stated here
rather than implied because the compensating control is indirect: the usage row
stamps the `zdr_status` that actually applied plus the `zdr_requirement` in force, and
`zdrPreferenceUnmet` derives the shortfall from that pair. A user on `prefer` can see
every request that fell short; they cannot prevent it.

### `zdr_confirmed_at` is never machine-set

Only an explicit `confirmed: true` from the user writes it. Nothing observable about a
request may: a request that succeeded proves the flag was *accepted*, never that
anything was discarded — that is unobservable from this side of the wire.

So `zdr_requested` is the ceiling for anything Hyperion determines itself, and the
word "confirmed" appears in exactly one situation: the user said so. `confirmed:
false` clears the timestamp **and** the note together, because a note with no date
behind it is an unbacked claim that would still be displayed.

### `unknown` and `egress_unknown` fail closed

Both kinds of not-knowing are ineligible under `require`: a provider with nothing
recorded (`zdr_unknown`), and a provider type this build cannot classify at all
(`egress_unknown`) — the latter even when its recorded support is
`supported_default`, because a build that cannot say whether the bytes leave cannot
be trusted about what happens to them afterwards.

This follows the invariant already stated for 1.23: understating exposure is the one
error this layer must never make, and "we do not know" is not evidence of safety.

The consequence is stated plainly rather than smoothed over: with every provider
defaulting to `unknown`, switching `require` on blocks every remote provider until
support is recorded per provider. That is correct, and the
`zdr_requirement_unmet` message says so, because otherwise it reads as a bug.

### `requestFlag.value` is plaintext, and must never hold a credential

`toPublic()` returns it verbatim — the one exception to that function's no-secrets
rule. The reason is that the field is a *policy declaration* (`"none"`, `"true"`,
`"strict"`) maintained by hand, and a hand-maintained field the user cannot read back
is unverifiable: they would have no way to check what was saved.

The write path therefore refuses a value that `findSensitive()` flags, and the refusal
**does not echo the value** — only the rule names that matched, the same discipline
that keeps matched spans out of `redaction_flagged.details`. Without that check the
plaintext round-trip would be a credential leak waiting for one paste.

### The flag is gated on egress class, not on the adapter

`openAiAdapter` serves both the remote `remote` type and the local `colibri` type, so
keying the flag off the adapter would send a retention header to a local runtime that
has no retention policy. `zdrFlagFor` asks `egressClassFor` instead — as does
`zdrStatusFor`, which must not answer `local_no_egress` for a local-typed provider
pointing somewhere else — which keeps one definition of what leaves the machine.

Merge order is also load-bearing: the flag is spread **before** `Authorization`,
`Content-Type` and `Accept`, and before `model`/`messages`/`stream` in the body, so a
user-supplied key can never displace them. A flag named `Authorization` would
otherwise replace the credential with the string `"none"` and present as an auth
failure with no visible cause. Silently prevented rather than rejected on write,
because a header name is only knowably harmful in the context it is used.

### `usage_log.zdr_status` and `zdr_requirement` are nullable with no `CHECK`

Same reasoning as `provider_type` in `013`, and it applies with equal force.
`recordUsage` swallows every error it hits, so `NOT NULL` would convert a missing
value into a silently discarded spend row — the cap-bypass hole
`test/temporarychats.test.ts` exists to close. No `CHECK`, because the status enum will
widen the way provider types did in `002` and `005`, and a constraint would mean a
table rebuild each time. The TypeScript union is the definition.

**Nothing is backfilled.** Pre-1.26 rows keep NULL and report as their own
`unrecorded` bucket. No policy was in force when they were written, and inventing one
retroactively would put a claim in the log that nobody ever made. `?zdrStatus=
unrecorded` keeps them reachable, so an audit sees how much history predates the
policy instead of a suspiciously clean record.

### Facts are stored; conclusions are derived

The row keeps the status that applied *and* the requirement in force, not a verdict.
"Was that acceptable?" can only be answered later if both halves are present, and a
stored verdict would silently preserve today's definition of acceptable forever.
`zdrPreferenceUnmet` computes it on read.

### The type guards classify a stored value; they never discard it

`summarizeZdr` passes `zdr_status` and `zdr_requirement` through as they are, and
only a genuine NULL becomes `unrecorded`. This is a correction, and the failure it
replaces is worth recording because the instinct that produced it looks like
diligence.

The first revision used `isZdrStatus` / `isZdrRequirement` to decide whether to
*keep* a stored value. Since migration `016` deliberately omits a `CHECK` so the
status enum can widen, a downgrade leaves rows carrying a status this build cannot
name — and those rows were then reinterpreted as "nothing was stamped". One guard,
four untruths:

- the `unrecorded` bucket counted rows that *had* recorded a policy, asserting the
  opposite of what the row said;
- that bucket disagreed with its own `?zdrStatus=unrecorded` filter over the same
  rows — two views of one dataset contradicting each other, which is worse than
  either being wrong alone, because afterwards neither can be trusted;
- the rows were unreachable: absent from the `unrecorded` filter, and rejected by
  their own value, which the route validated against the compiled-in enum only;
- worst, `preferenceUnmet` **failed open**. The unrecognised status reached
  `zdrPreferenceUnmet` as `null`, which returns `false`, so a `prefer` shortfall
  reported the policy as satisfied.

`zdrPreferenceUnmet` therefore takes a plain `string`, not `ZdrStatus`, and treats
anything outside `SATISFYING` as unmet. This build cannot know that a status it
cannot name met the user's requirement, and "I do not recognise this" must never
resolve to "this was fine" — the same rule that makes `egress_unknown` fail closed.

Found by an independent aggregation pass over a seeded dataset, not by the feature's
own tests, which only ever wrote statuses the build already knew.

### `?zdrStatus=` validates against the enum and against the log

Two requirements pulling opposite ways. A typo must be a 400, because an empty
summary reads exactly like "you have no remote traffic". But a status a newer build
stamped is real history, and rejecting it would leave those rows visible in the
summary yet impossible to select. So the route checks the compiled-in enum first and
`recordedZdrStatuses()` second: unknown *and* absent is a mistake, unknown but
*present* is data.

### `zdr_requirement_unmet` is a 403, and is not retryable

Not 409, which is what `redaction_flagged` uses. That code is a conflict because the
user can resolve it by editing the body or acknowledging the finding; here they
cannot — no edit to the payload makes an ineligible provider eligible, and only a
settings change alters the answer. Same reasoning as `capability_disabled`.

Not 503 either. When failover finds candidates and the policy bars all of them, the
failure stays `zdr_requirement_unmet` rather than becoming `no_healthy_provider`:
both stop the run, but an outage lifts on its own and is worth waiting for, while a
privacy refusal never will. Reporting a hard privacy decision as an outage teaches
the user to wait for a recovery that cannot happen.

Absent from `DEFAULT_RETRYABLE`, because a retry loop would re-refuse forever.

### The pre-dispatch check in `chat.ts` is not redundant with the router

The router enforces the policy on every candidate it considers, which is what makes
`require` safe. But a refusal raised from inside `router.stream()` arrives *after* the
user turn and the assistant placeholder have been persisted, and this module's
contract is that a refusal leaves the transcript exactly as it was.

So `assertZdrDispatchable` answers the same question early, beside
`assertOutboundSafe`, before `appendMessage`. It reads only cached state — no model
list fetch, no network — because a decision to refuse must not depend on whether a
fetch happened to succeed.

Any future send path needs both halves, or it will pause mid-transcript.

### `parkOnRedaction` became `parkOnBlockedSend`

Two refusals now assume a user is present to answer them: `redaction_flagged` and
`zdr_requirement_unmet`. A name that enumerates its causes starts to lie the moment
the second one arrives, so the function is named for the condition instead.

The wording differs per reason and that is deliberate: `redaction_blocked` invites the
user to review and approve, while `zdr_blocked` must not — there is nothing to
approve, and the block lifts only when a setting or a recorded provider fact changes.

## Stopping a run is not the same as losing the client (groundwork for 1.24)

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

This was committed on its own, ahead of 1.24. An earlier claim that cancel
needed "only a registry and a route" was wrong — it rested on `ctx.signal`
already being a general-purpose stop signal, and it was not. Separating the
signal change from the endpoint keeps the part that touches every existing agent
call path in a commit whose whole diff can be read against the old behaviour.

## Task cancellation  *(added in 1.24)*

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

### Cancellation is checked between iterations, not only around the external request

`ctx.signal.aborted` is tested at the top of every iteration, before the turn is
requested. A loop that only checks the signal around the external request keeps executing
tools after the user has clicked stop, which is the visible-but-wrong behaviour:
the UI says stopped and the filesystem keeps changing.

---

## Production module composition (added by Phase 1/2 production composition)

Production module registration is one synchronous boundary after database
bootstrap and before either the HTTP listener or any scheduler starts. The exact
production set is **Cowork, Code and the local terminal executor**. Design
remains the only unregistered agent: `/api/design/run-task` keeps its coded 501
until a design module registers. (This paragraph predates the Code agent
landing; `test/composition.test.ts` pins the registered set so the code and
this record cannot drift apart again unnoticed.)

This ordering prevents partial-production states. A status request, an immediate
Cowork request and the first scheduled Cowork tick must all observe the same
registry. Registration only makes a module callable: request handlers and
schedulers still own agent runs, while the MCP supervisor owns the manager and
transport lifecycle it registers separately.

Every shell command enters through the orchestrator in this order: capability
gate, terminal lookup, cwd containment, execution. Keeping the sequence at the
shared entry point means neither an HTTP route nor a future agent can bypass a
policy by calling the executor directly.

The executor uses the platform shell (`cmd.exe` on Windows, the configured POSIX
shell or `/bin/sh` elsewhere), bounds stdout and stderr independently, and kills
the command's process tree on timeout or cancellation. A timeout is an ordinary
result (`exitCode: 124`, `timedOut: true`) because the command did run; an abort is
the coded `aborted` error because the caller cancelled the operation. Process
launch failures expose only a safe `internal_error`; the OS diagnostic remains
private so paths or command text are not reflected to a client.

---

## Cowork evidence and optional research boundary (added by Cowork Slice 4)

**Who depends on this:** Cowork's agent loop and any caller that presents its
knowledge or research state to a user. The loop is allowed to use the reference
library and a supervised Wigolo process, but neither source is trusted merely
because a database row or MCP entry exists.

### Invalid knowledge is status-only

Cowork resolves each source through the scoped knowledge path before reading it.
Only a bounded, supported, valid UTF-8 file whose hash still matches the stored
metadata becomes evidence. Missing, unreadable, binary, unsupported and
hash-mismatched sources remain diagnostics in the prompt and never contribute
bytes to the model's evidence.

This distinction matters because "the row exists" and "the file is safe to use"
are different facts. Treating a truncated, binary or changed file as evidence
would let stale or unvalidated bytes silently influence an answer. A containment
failure is preserved as the typed `scope_violation` error rather than being
flattened into `missing`: the latter would hide a boundary bug as an ordinary
library gap.

### Wigolo is callable only when it is live and supervised

Wigolo is optional. Cowork reports the exact setup command
`npx -y wigolo init` when it is unavailable, disabled or not running, and never
initializes, enables, starts or spawns it. The MCP registry and process manager
are consulted for tool schemas and calls only when configuration is present,
the entry is enabled, and its status is exactly `running`. An MCP response with
`isError: true` is still a tool result, not evidence that Cowork may start a
replacement process.

The live-state gate is deliberately stricter than "configured": configuration
describes intent, while `running` is the only state that proves a supervised
transport exists. Keeping that distinction prevents a research request from
turning into an implicit install or process launch.

### Completed output is retained through later failure

Cowork saves Markdown and CSV only through shared artifact versioning, and
returns every saved `{ key, version }` in `TaskResult.artifacts`. If a later
provider turn reaches cancellation, a spending cap or another failure, the
failure is reported without discarding the partial text or saved artifact
references already produced. Memory recall is allowed before the turn, but
remembering happens only after the shared loop completes, so a failed partial
attempt is not stored as completed knowledge.

---

## Context compaction  *(added by Slice 2, step 3)*

A long-running agent will eventually build a conversation larger than the model's
context window. The provider's answer to that is a hard error partway through a
run — usually after tools have already changed files. `src/services/agent/compaction.ts`
shortens the conversation before that happens, and every rule below exists because
the obvious implementation of "just drop old messages" produces a subtly broken
agent rather than a working one.

### Compaction is visible, never silent

Every compaction records a `compression` step against the run and emits a
`context_compacted` event carrying `droppedMessages`, `tokensBefore`,
`tokensAfter`, `windowTokens` and `windowAssumed`.

A silent compaction is indistinguishable from a model that forgot. The user asks
why the agent lost the plot halfway through a task, and without a step row there
is no answer — not in the logs, not in the run history, nowhere. The step row is
what makes "it dropped 14 messages here" a fact the UI can show rather than a
guess.

The step is written **before** the event fires, for the same reason parking a run
writes its state before announcing it: a client that reacts to the event by
fetching the run's steps must not find the history it was told about missing.
`writes the step before it announces it` pins the ordering.

Nothing is emitted when nothing was compacted. An event the user has to interpret
as "no change" is worse than silence.

### The digest is built from what was dropped, not written by a model

`describeDropped` counts roles and collects tool names — "3 user message(s),
4 assistant message(s), 2 tool result(s). Tools used in that span: grep_files,
read_file." That is a **receipt, not a substitute**.

The tempting alternative is to ask a model to summarise the dropped span. It was
rejected deliberately, and the reasons are all operational rather than aesthetic:

- It needs an extra provider request at exactly the moment the run is already in
  trouble, so the recovery path acquires its own failure mode.
- It can fail, and then compaction fails, and then the run dies for a reason that
  has nothing to do with what the user asked for.
- It can hallucinate. A summary that invents a file edit that never happened is
  worse than no summary, because the agent will act on it.

A deterministic digest cannot do any of those three things. It is a weaker summary
that is always correct and always cheap, which is the right trade for a mechanism
that only runs when things are going badly.

> **Implementation note — the digest is an owner-accepted deviation.**
> The v4 §4 spec wording asks for a "summarize" step in a four-step
> compression chain. The shipped digest *is* that step, implemented as a
> deterministic receipt rather than a model-written summary by explicit owner
> decision (2026-09-18, register AD-1 in `.hyperion/coordination/decisions.md`),
> for the reasons above. **Do not "fix" it into a model summary without an
> owner decision** — same standing as the 120-day retention note in SPEC.md.


### The digest never quotes what it dropped

`describeDropped` emits counts and tool names and nothing else. Quoting content
would defeat the purpose twice over: it costs the tokens compaction just
reclaimed, and the dropped span may contain anything the user pasted — an API
key, a customer record, a private file. `describes what it dropped without
quoting any of it` asserts on a planted secret specifically.

### The digest is a `system` message

Not `assistant`. Attributing "4 messages were dropped here" to the assistant puts
words in the model's mouth that it never produced, and on the next turn the model
reads its own alleged statement as something it decided. A `system` message is
what it actually is: a note from the harness about the state of the conversation.

`attributes the digest to the system, never to the assistant` exists because this
is a one-word change that nothing else would catch.

The digest is inserted **in place** where the dropped block was, not prepended, so
the conversation still reads in chronological order rather than opening with a
note about its own middle.

### A tool result is never separated from the call that asked for it

Messages are grouped before anything is dropped: a `tool` message joins the
preceding group when that group has an unanswered `toolCalls` entry with the
matching id. Groups are then dropped whole.

This is not tidiness. Providers validate that every `tool` message answers a
call present in the same request, and they reject **the entire conversation** when
one does not — so an orphan produced to save 200 tokens fails the whole run with
an error that points nowhere near compaction. Grouping is the only reason
`never leaves a tool result without the call that asked for it` can hold.

### What is pinned, and why each pin is load-bearing

Three things survive regardless of size:

- **Every `system` message.** Dropping the system prompt produces an agent that
  forgets its own instructions mid-task, with no visible cause and no way for the
  user to diagnose it.
- **The most recent tool result.** It is what the model is currently reasoning
  about; removing it to save space loses the agent's train of thought at exactly
  the moment the work got interesting.
- **The last `DEFAULT_KEEP_RECENT_GROUPS` (2) groups.** The recent exchange is the
  live part of the conversation.

The tool-result pin and the recency pin overlap in the common case, which makes
this easy to test wrongly: a fixture whose newest tool exchange sits inside the
recent window passes even with the tool-result pin deleted. Negative verification
caught exactly that — the test was rewritten to place the newest tool exchange
*outside* the recent window so the pin it names is the thing keeping it green.

### The trigger and the target are different numbers on purpose

Compaction fires at **80%** of the window (`COMPACTION_TRIGGER_RATIO`) and
compacts down to **50%** (`COMPACTION_TARGET_RATIO`).

If it compacted only until it cleared the trigger, the very next turn would push
it back over and compact again — the agent would spend a slice of every iteration
rewriting its own history, and the digest would accumulate digests. Overshooting
buys enough headroom that a normal run compacts once, not continuously.

The test asserts `tokensAfter <= target`, not merely that the trigger is clear.
Asserting the trigger passes at 64% too, which is exactly the bug the gap is meant
to prevent; that weakness was found by mutation, not by reading.

### Refusing to compact is a valid outcome

When everything remaining is pinned, `compactConversation` returns
`compacted: false` with `skippedBecause: 'nothing_droppable'` and the conversation
**unmodified**.

It does not buy space by dropping something it said it would keep. The caller —
the agent loop — parks the run instead, which is a state the user can see and act
on. Quietly dropping the system prompt to hit a number would produce an agent that
misbehaves for a reason nobody can trace, and the whole point of the pins is that
they are promises.

`not_needed` and `nothing_droppable` are distinct for this reason: one means "no
work required", the other means "work required and refused". A caller that treated
them alike would park healthy runs or, worse, ignore a real refusal.

### The context window is a ladder, and an assumed number says so

`resolveContextWindow` prefers an explicit override, then the model's reported
`contextLength`, then `DEFAULT_CONTEXT_TOKENS` (8192) with `assumed: true`.

A reported `0`, a negative number, or `NaN` all count as **no answer** rather than
as a window of that size. Gateways do report `context_length: 0` for models they
know nothing about, and taking it literally would mean every conversation is
instantly over its limit and compaction runs on every single turn.

The default is deliberately small. Guessing high and being wrong means the
provider rejects the request; guessing low and being wrong means some unnecessary
compaction. Only one of those is recoverable, so the conservative number wins —
and `assumed` travels into the step detail and the event so the UI can say the
number was a guess instead of presenting it as fact.

The ladder is only as good as what feeds it, and until the v4 window wiring the
agents fed it nothing: every run fell to the 8192 default, so every compaction
percentage was wrong for every real model. Now each agent resolves the
requested model against the provider model **cache** at run start
(`findCachedModel` — active provider first, then failover order), and the
lookup never fetches, because a run start must not wait on the network. A
model no cache knows keeps the honest `assumed` default; the request itself
validates the model when it goes out. A mid-run failover keeps the originally
resolved window: the model id is the same, and re-resolving per turn would put
a cache read on the hot path to re-answer a question that has one good answer
per run. (Master Plan v4, section 6.1.)

### Token counts are estimates, and the estimator matches the one already shipped

`estimateTokens` uses 4 characters per token, the same ratio
`src/providers/adapters.ts` already falls back to when a gateway reports no usage.
Two different estimates for the same conversation would make the usage figures and
the compaction figures disagree in the UI for no reason a user could understand.

`estimateMessageTokens` charges per-message overhead and counts `toolCalls`
arguments, `toolCallId` and `name` — not just `content`. Tool arguments are sent to
the provider and can be far larger than the message text around them; a count that
ignored them would under-read the conversation and compact too late, which is the
one failure mode compaction exists to prevent.

## Wiring compaction into the agent loop  *(added by Slice 2, step 4)*

The algorithm above shipped with tests and **no production call site** — nothing
under `src/` imported `agent/compaction.ts`, so every run still went to the
provider at full length and the sentence above about the agent loop parking the run
described behaviour no code implemented. The entries here are about the wiring, and
they exist because a documented promise with no caller is worse than a missing
feature: it reads as done.

### Compaction runs before the request, never in response to its rejection

`runAgentLoop` compacts at the **top of each iteration**, ahead of `input.turn`.

Handling it the other way — catch the provider's context-length error, shorten,
retry — looks more economical because it only compacts when strictly necessary.
It is wrong here for a reason that is not about efficiency: by the time a turn is
refused, the previous iterations have already run tools, and those have changed
files on disk. A retry cannot undo them, so the run has already half-happened.
Shrinking the request while it can still be sent is the only version where the
failure never occurs.

It also keeps the mechanism provider-independent. Gateways disagree about the
status, code and wording they use for an oversized request, so a reactive design
would need a matcher per provider and would silently stop working the day one of
them rephrased its error.

### The loop borrows access to the conversation; it does not own it

`runAgentLoop` advances through `turn(feedback)` and never sees a message array —
the agent assembles its own prompt, because only the agent knows what goes into
it. `LoopContextAccess` is the seam: `messages()` to read, `replace()` to write,
plus the resolved `window`.

**Accessors rather than an array.** Handing the loop a snapshot would let the two
copies drift: the loop would compact its copy, the agent would build the next
request from the one it still holds, and compaction would appear to run — step
recorded, event emitted — while changing nothing that was actually sent. That
failure is invisible in tests that only assert the event fired, which is exactly
why the shape is a getter.

**The seam is optional, and omitting it means no compaction rather than a
guess.** An agent that rebuilds its prompt from a database each turn, or manages
its own window, is a legitimate caller; rewriting a conversation whose structure
the loop cannot see would corrupt it. `input.context === undefined` therefore
skips the whole path, and there is a test asserting a loop with no seam behaves
exactly as before.

### `context_exhausted` is `blocked`, not `ready_for_review`

`nothing_droppable` means the conversation is over the window and everything left
is pinned. The run stops, and `PARK_STATE` maps the reason to **`blocked`**.

`ready_for_review` is an invitation: it says work is finished and wants the user's
eyes, and the UI offers approval next to it. There is nothing to approve here —
the run cannot proceed until something outside it changes, such as a model with a
larger window or a fresh task with less history. Routing it to review would put an
approve button on a run that cannot continue however the user answers.

This also means it survives a restart as an error rather than as a result: boot
demotes `blocked` to `error` because the thing it waits on cannot be delivered
into a loop that no longer exists, whereas `ready_for_review` is left alone. That
is the correct outcome for a run that never produced one.

### Parking beats throwing, for the same reason it does elsewhere

An over-long conversation could raise an `AppError` and let the route report a
502. Parking is chosen instead, consistent with `loop_detected` and
`iteration_ceiling`: the run has real work behind it — steps recorded, files
changed — and an exception discards the context that explains what happened. A
parked row keeps the history and names the reason in the step log, so the user
sees why it stopped rather than a provider error they cannot act on.

### A shortened memory is never silent

Every compaction writes a `compression` step **and** emits `context_compacted`,
and `compactIfNeeded` is only called where one of the two would be wrong to omit.

An agent that quietly forgets the middle of its conversation produces behaviour
nobody can explain later: it contradicts something the user said twenty turns ago,
and the transcript still shows the user saying it. The step is the durable record
for a client that was not connected at the time; the event is for one that is. The
step also lands before the event, matching the park ordering — the database is the
record, SSE is a notification about it.

`recordCompaction` returns early on an uncompacted result, so a conversation that
fits emits nothing at all. Silence means no compaction happened, not that
compaction is disabled.


## The permission engine (added in 1.27)

Ask, Plan and Act stopped being modes and became **profiles**. The three names still
work and still mean what they meant; what changed is that they are now the first
three entries in an open list rather than three hardcoded branches in the
dispatcher.

The reason is that a mode could not express anything. "Read anywhere, write only
under `src/`, ask before `bash`" had nowhere to live: `dispatchToolCall` asked
whether the mode was `ask`, whether it was `plan` and the tool mutated, and
otherwise ran the call. Every rule a user might want was a rule they could not
write.

### The gate did not move

`dispatchToolCall` is still the only function in the loop that invokes anything,
and the decision is still made inside it. One `evaluate()` call replaced the three
`if`s. A gate reachable from more than one place is a gate somebody eventually
forgets, and that has not changed.

### A caller with no resolver gets the original gate, byte for byte

`ModeGateInput.permissions` is optional. Omit it and the pre-1.27 mode branches
run unchanged, including the `ask_mode` / `plan_mode` refusal wording and the step
rows they write.

This is not backward-compatibility debt. It is what makes "the reframe is
behaviour-preserving" a checkable claim rather than an assertion:
`test/agentloop.test.ts` drives `dispatchToolCall` with nothing but a mode and
passes unedited, so the old semantics are pinned by a test that has no knowledge
of profiles at all.

### Four layers, later overriding earlier, with one that only tightens

```
builtin  ->  profile  ->  project  ->  session        (then: inherited)
```

* **`builtin`** — the baseline of the profile's *base mode*. Always present.
* **`profile`** — a project-authored `.hyperion/agents/*.md` front-matter block.
* **`project`** — `.hyperion/permissions.json`, applying to every profile there.
* **`session`** — what the user decided during this task, from an `allow_session`
  approval. It wins because it is the most recent and most specific statement of
  intent available.
* **`inherited`** — a subagent ceiling, evaluated last. Its denials **cannot** be
  overridden downward; an `allow` in this layer is ignored outright.

Any layer may omit a key and fall through. Silence is not an answer: a layer that
says nothing about `write` leaves the previous verdict standing, because otherwise
every narrow layer added later would erase the one before it.

There are deliberately **no hard floors** below `inherited`. Hyperion is a
single-user tool on the user's own machine, and a permission the user granted in
their own project file is not something this code should second-guess.

A delegated child runs this same engine, and its resolution starts from the
**parent's mode**: `delegate` passes the parent run's mode through rather than
substituting a hardcoded `act`. The hardcode meant a Plan run whose project
rules happened to allow `delegate` produced a fully unrestricted child — one
allowed call became an unrestricted agent. (D7, Master Plan v4.)

### The `builtin` layer is the base mode's baseline, not the profile's own

A project profile declaring `mode: plan` starts from Plan's read-only baseline and
opens exactly one hole in it. That is what makes a profile a *specialization*
rather than a fresh start — a profile that had to re-derive what Plan meant would
drift from it the first time Plan changed.

A built-in contributes nothing to the `profile` layer, because its rules *are* the
`builtin` layer. Contributing them twice would make every verdict's provenance
read `profile` when nothing but a built-in was in force.

### `*:read` and `*:mutate` exist because a built-in cannot name tools

Which tools only read is a fact about the *agent*: Code has `read`, Cowork has
`wigolo.search`, and an MCP server the user adds tomorrow has whatever it has. The
`plan` built-in therefore says `{"*:read": "allow", "*:mutate": "deny"}` and defers
to the agent's own `ToolPolicy.effect()`.

Enumerating names instead would have silently denied `wigolo.search` in Plan mode
the moment Cowork joined the engine — a behaviour regression disguised as a config
default. `ToolPolicy` is retained for exactly this reason and agents needed no
change to their policy objects.

Key precedence inside one layer is exact name, then the effect catch-all, then
`*`. Precedence is per-layer rather than global on purpose: a project file saying
`{"*": "deny"}` must be able to shut off a tool the profile allowed by name,
because the project layer is the later statement.

### The built-ins reproduce the old gate exactly, including where that is unhelpful

`ask` denies everything — **including reads**. `plan` allows reads and refuses
changes. `act` allows everything, still subject to the project and session layers.

Two places where the obvious improvement was rejected:

**`ask` does not grant a "read-only" `bash` allowlist.** A glob over a shell
command line is not a security boundary: `git status*` matches
`git status; rm -rf /`, and every `;`, `&&`, backtick and `$( )` is another way
through. Granting shell access from a profile whose entire promise is "runs
nothing" needs a command parser, not a pattern.

**`ask` does not grant `read` either.** Widening it is a defensible product change
and it is not a *refactor*; making it here would mean every user who never opens
this feature gets different behaviour from the same UI control. A user who wants a
question-answering profile that can read is now able to author one, which is the
capability being added.

### A verdict carries its provenance, and the provenance is persisted

`PermissionVerdict` names the `action`, the `layer`, the `pattern` that matched
(or `null` for a scalar rule) and the derived `key`. `describeVerdict()` renders
that as one line — `allow (project:src/**) for write` — which is written into
`task_steps.provenance`.

A refusal a user cannot locate is a refusal they route around by widening the
broadest rule they can find. Persisting it means "why was this refused?" stays
answerable from the database after the run, without re-running anything.

### An unknown tool is denied

The policy answers `undefined` for a name it has never heard of, and the loop
already folds that into `mutate`. This layer goes further and denies outright,
against the *running agent's* registered tool set rather than a global list. The
argument is the one the loop's header makes, with more force: this layer can grant
more than Plan mode ever could.

### MCP permission keys are derived, never renamed

Wire names stay dotted — `wigolo.search` is what the server answers to and what
`cowork/agent.ts` dispatches on. The permission *key* is `wigolo_search`, derived
by replacing dots. A key lives in a JSON object key and a front-matter scalar, so
it gets a spelling that survives both; renaming the wire name to match would break
dispatch for no benefit.

### A path rule matches the file, not the spelling the model chose

A rule governs a *file*, and a file can be named more than one way. The file tools
resolve their argument before touching disk — `ctx.resolvePath`, then the same
containment check the write itself performs — so `secrets/key.txt`,
`./secrets/key.txt`, `src/../secrets/key.txt` and the absolute path are one file.
A rule matched against the raw argument would govern the string instead:
`{"write":{"secrets/**":"deny","*":"allow"}}` would refuse the first spelling and
allow the rest, and the bytes would land in exactly the directory the user denied.

So a path subject is canonicalized before it is matched (`canonicalPathSubject`),
in two passes:

* **Lexical** — backslashes become separators, `.`/`..` collapse, duplicate
  separators fold, a trailing slash goes. No filesystem, and it closes every
  *relative* respelling.
* **The caller's resolver** — `EvaluateInput.pathResolver`, which the Code adapter
  supplies as `ctx.resolvePath` on both sides of a `path.relative`. Patterns are
  authored relative to the workspace and `resolvePath` answers absolutely, so the
  caller is the only one that can do the subtraction. This is what closes an
  absolute or symlinked spelling, because that is realpath work and only the caller
  knows which root the run is confined to.

Only path tools get this treatment — `read`, `write`, `restore`, derived from the
same table that says which argument is a glob subject. A `bash` subject is a command
line, and running one through a path normaliser would rewrite the command
(`cat a/../b` → `b`), which is a rule matching something its author did not write.

**An agent that adds a tool in that table also has to pass a resolver**, or its path
rules are matched lexically only — which is still better than the raw argument, and
still not enough for an absolute or symlinked spelling. Today that is Code and
nothing else: Cowork's tools are `cowork.*` and MCP wire names, Design's are
`design.*`, and none of them has a path subject. Tomorrow's tool has one job beyond
registering itself.

A resolver that *refuses* the path (it escapes the scope) is not an error here: the
tool refuses it with its own coded error moments later, so the lexical form stands
and a permission check never fails for a different reason than the tool would.

This is the same class as a permission **key** that silently fails to match the tool
it was written for (S12's territory): the rule is well-formed, the user believes it
applies, and the operation it was meant to stop proceeds. `test/permissions.test.ts`
pins the spellings; `test/codepermissionpaths.test.ts` pins the adapter wiring, since
a relative pattern cannot match an absolute argument without it — and an engine test
alone would stay green if that wiring were dropped.

### A path is not used through a symlink

`fsScope` answers by canonicalising: `resolveInScope` follows symlinks and returns the
real location, tolerating a missing tail so that a file which does not exist yet can
still be checked. That is the right answer to its own question, and it is a snapshot.
An agent that can create symlinks inside the directory it is allowed to write to can
change the answer afterwards — and because the answer was "inside the scope", the
change is invisible to every check that already ran.

Two checks now run at the point of use, from `src/security/toctou.ts`, on both seams an
agent reaches: the file tools (`files.ts::locate`, so `write`, `read` and `restore` all
get it) and the working directory handed to a command (`containAgentCwd`, which
`executeCommand` uses).

* **No traversal through a symlinked directory** — `assertNoSymlinkedTraversal` walks
  the components of the path *as spelled*, `lstat`ing each, and refuses a symlink even
  when it currently resolves back inside the boundary. It has to run **before** the
  resolver, because canonicalisation is what erases the evidence: once a resolver has
  answered, an inward link and a real directory are the same path, and the check would
  be dead code that reads like a defence.
* **Canonical boundary revalidation** — `assertStillInside` re-resolves the resolved
  path *now* (`pathContains`, which follows symlinks on both sides and tolerates a
  missing tail) against the **task's** boundary rather than the scope. Two parallel Code
  tasks share the `projects` (or `worktrees`) scope and are not each other's workspace;
  the scope-wide resolver cannot express that, and this check is what keeps the pair
  independent rather than merely both-contained.

Both refusals are **403 `scope_violation`** with `details.reason` — `intermediate_symlink`
(naming the offending `component`) or `resolves_outside` — because the user's next move
differs: "name the directory it points at instead" versus "that file is outside what
this task owns". The traversal refusal says the first half out loud in its message.

**Three policy decisions, all deliberate:**

1. **A symlink *at the target* is allowed.** The rule is about the components on the way
   to the file, and a symlinked *file* is an ordinary thing to write. If it points
   outside the boundary, check 2 refuses it anyway.
2. **An inward link is refused too.** That costs the project which intentionally
   symlinks `docs -> shared/docs`: a model that spells a path through the link is
   refused, and its retry is mechanical — the canonical spelling of the same file
   succeeds, and the refusal names the directory to use. Refusing the class is the
   point: whether a link is *about to be* re-pointed is not a decidable question at use
   time, and a check that allowed inward links would have to answer it.
3. **A refusal stops the task** instead of being handed back to the model as tool
   output. That matches what the file tools already do for `not_found` and for a stale
   `expectedSha256` (`writeCodeFile` throws, `runTool` rethrows, `runCodeTask` reports
   `ok: false` with the coded error), and a boundary that was just refused is the one
   error that must not read as a retry prompt.

**What this does not fix**, stated so it is not mistaken for a closed hole: the window
between the check and the syscall is irreducible from the pre-check side — they are two
operations. What is closed is the *unbounded* window, because a path is no longer
trusted from the moment the task context was built. An escape now needs a race won in
microseconds rather than a symlink planted minutes earlier, and the traversal refusal
removes the pre-planted hook that race would need.

`test/toctou.test.ts` (11 cases) drives real runs on a real filesystem — a scripted Code
run replaces a real directory with a symlink between turns and then writes through it,
which is what succeeded before this change — plus the primitives' edge cases: a missing
tail, `..`, a symlinked file, an outward *file* link, an inward *directory* link, and a
sibling whose name shares a prefix with the boundary. The outward-link case is a
regression guard rather than a fix: `locate`'s lexical prefix comparison already refused
it, as `bad_request`, and the claim pinned there is that it is now also refused as the
boundary violation it is.

### A write that looks like a credential is downgraded to `ask`

Before returning `allow` for `write` or `restore`, the target path and the content
go through `findSensitive()`. A hit downgrades to `ask` regardless of the glob that
matched, and the verdict keeps that glob — the user's rule was honoured and then
overridden by a finding, and reporting the rule as the failure would send them to
edit the wrong line.

This is deliberately **not** gated on `redaction_check_enabled`. That toggle
governs outbound egress, where the risk is a key leaving the machine and a false
positive interrupts a send, so it defaults off. Here the risk is a key being
written *into the user's source tree*, where a false positive costs one
confirmation and a false negative gets committed. Different trade-off, different
default.

`restore` counts as write-capable: it puts a previous snapshot back on disk, so a
credential captured in a snapshot can be re-materialised by it.

### `ask` parks the run; it is not a nicer denial

An `ask` verdict records the call verbatim in `pending_approvals`, parks the run as
`approval_required` -> `ready_for_review`, and emits an `approval_required` agent
frame. The model is told, in tool output, that the task is waiting and not to work
around it.

The loop stops the **whole run**, not just that call. Continuing through the rest
of the batch would run work the user has not agreed to, and would leave the
conversation in a state a continuation cannot reproduce — the approved call has to
be the next thing that happens.

`arguments` are stored exactly as the model emitted them. Continuation replays this
call, and a re-serialized approximation is a different call: the user approved a
specific write to a specific path, and anything else is a question they were never
asked. A call whose arguments exceed the cap is refused rather than stored
truncated, because truncated JSON is unreplayable and an approval that cannot be
replayed is worse than none.

### `allow_session` lives in the table, not in memory

1.27 requires a session allowance to be "cleared on task end", which means it must
outlive a park — and a park can outlive the process. An in-memory set would forget
every allowance on restart and re-ask for something already granted, which is how
a confirmation prompt becomes noise people click through.

An allowance is scoped to the pattern that matched, so approving a write to
`src/a.ts` under a `src/**` rule grants that rule rather than the whole tool.
`allow_once` is deliberately **not** projected into the session layer: it
authorises exactly the replay that follows it, and turning it into a rule would
make "just this time" mean "from now on".

### `pending_approvals` has no foreign key

Same reasoning as `015_subagent_runs.sql`. An unattended run may park with no
`task_runs` row, and `startTaskRun` is `INSERT OR REPLACE`, so a cascading relation
would delete the approval during exactly the retry it needs to survive. `run_id` is
correlation metadata.

### Reasoning effort is advisory, per profile, and degrades silently

`CompletionRequest.reasoningEffort` maps to `reasoning_effort` on
OpenAI-compatible gateways and `reasoning: { effort }` on the Responses API.
Ollama and Colibri omit it.

A profile is authored once and used against whichever provider is active, so "this
provider ignores it" has to be a silent no-op — the alternative is a profile that
fails on three providers out of four. Colibri shares `openAiAdapter` only because
it speaks the same protocol; it serves one local quantised model with no reasoning
control, and a strict server rejecting unknown body fields would turn an advisory
preference into a failed request.

It is carried per profile, so switching profiles mid-task switches the level with
it rather than leaving the previous one in force.

### `AgentProfile.tools` widened to `string[]`, and the check moved

The profile type moved from `services/code/projectContext.ts` to `types/core.ts`
and its `tools` widened from `CodeToolName[]`. That loses a compile-time check, and
the replacement is strictly better placed: `assertKnownTools` validates against the
tool set the running agent actually registered, which is the only check that could
ever have covered an MCP tool whose name is unknown until a server is configured.

A declared tool list is itself a permission statement — naming three tools means
the other tools are not for this profile — so it is expanded into rules. The
refusal then names the `profile` layer instead of surfacing as a bare "unknown
tool" from the runner.

### `visibility` and `hidden` are independent

`visibility` says who may select a profile (`primary`, `subagent`, `all`).
`hidden` says whether to put it in a menu. Neither implies the other: a personal
shortcut is a real reason to want a working profile that does not clutter the
picker, and a documented worker a parent delegates to is worth listing even though
nobody drives it directly.

`hidden` affects listings only and **never** resolution — a hidden profile stays
resolvable by name, or an editor could not see one in order to un-hide it.
`visibility: subagent` is rejected as a primary selection.

### Ask and Plan outrank the stored default

Resolution is: `input.options.profile`, then the mode's built-in for `ask`/`plan`,
then the `default_agent_profile` setting, then the `act` built-in.

Ask and Plan are explicit, per-run choices to restrict what happens. A stored
setting able to widen them would make a safety control advisory, so the setting
customizes what **Act** means — the case where the user has already said "go
ahead" and a stricter house default is useful rather than surprising.
`GET /api/settings/agents` returns `resolvedFor` spelling this out, because a panel
that implied otherwise would be showing a control that does not do what it says.

The setting reads back as `null` when unset rather than `'act'`, so "the user has
chosen nothing" stays distinguishable from "the user has chosen Act".

A named selector resolves against the project first and the built-ins second, so a
project can shadow `act` with its own house rules by naming a file `act.md`. An
unresolvable name is a `not_found`, never a silent fallback: running a task under
different permissions from the ones the caller asked for is the one outcome nobody
wants. A *malformed* profile is a `bad_request` for the same reason — swallowing it
would run the task under `act` because the user's profile did not parse.

### A profile's permission block is JSON in one front-matter scalar

`permissions: {"bash":"ask","write":{"src/**":"allow","*":"deny"}}`.

`parseSimpleYaml` handles flat scalars, inline `[a, b]` and `- item` blocks — no
nested maps — and a permission rule is a nested map. A `- tool:glob:action` list
form was rejected because globs and Windows paths contain `:`. JSON needs no parser
change, round-trips through an import endpoint, and is the same syntax
`.hyperion/permissions.json` already uses, so a user learns one thing rather than
two.

A malformed block is rejected rather than dropped. A silently dropped rule presents
as a permission the user believes they granted and did not.

### Two new error codes

* **`approval_required`** (409) — a call is waiting on a decision. 409 for the same
  reason `redaction_flagged` is: the request is not forbidden, it conflicts with
  current state, and the user resolves it by answering, which is a state change.
* **`permission_denied`** (403) — the engine refused outright. 403 for the reason
  `capability_disabled` gives: the request is well-formed, resending it unchanged
  is refused identically, and only editing a permission layer changes the answer.

### `Reload Config` adds no cache

`POST /api/settings/reload-config` re-reads, validates and returns the resolved
configuration. It caches nothing, because `db/settings.ts` keeps settings
deliberately un-cached and project files are read per task — there is nothing stale
for a reload to clear.

Its value is that a malformed `.hyperion/permissions.json`, or a profile with a
broken front-matter block, is reported on demand instead of surfacing halfway
through the next run.

### One glob engine, shared

`compileGlob` / `normalizeGlob` moved out of `services/code/projectContext.ts` into
`util/glob.ts`, and both a rule's `scope:` and a permission rule's path pattern now
compile through it.

A user who has learned that `src/**` covers `src/a/b.ts` in one place and finds it
does not in the other has been handed a security surprise, not a syntax quirk. The
supported syntax is unchanged and deliberately small: `*`, `**`, `**/`, `?`. No
brace expansion, no character classes, no negation — each is a place where a
pattern can mean something other than what its author read, and none is needed to
say "these files".

### `task_steps` lost its `kind` CHECK

017 rebuilt the table and dropped the constraint rather than widening it. Two kinds
arrived in that one migration (`approval`, `turn`) and more will follow; 016's
header already made the argument for a descriptive column — a CHECK "would mean a
table rebuild every time it does" widen. The `TaskStepKind` union is the definition
now, and `test/tasksteps.test.ts` asserts the *absence* so re-adding the constraint
fails there rather than in a migration six months later.

The `mode` CHECK stays. `mode` is not descriptive: a UI control maps onto its three
values, so a profile name gets its own `profile` column instead of being smuggled
in as free text.

That rebuild is also the one migration shape that can pass every automatic check
while losing a guarantee. `PRAGMA foreign_key_check` catches a dangling reference;
it cannot catch a *missing* `ON DELETE CASCADE`, because a table without one is
valid schema — and per `014`'s header that clause is what makes `startTaskRun`'s
`INSERT OR REPLACE` clear a superseded attempt's steps. `test/migration017.test.ts`
is the only guard, and it asserts both the clause and the end-to-end property.

## Task-run continuation (added in 1.27)

Before this, a parked task run was a dead end. `db/taskRuns.ts` said so outright —
*"unlike a chat run there is no resume path"* — and yet three park reasons already
existed and were shown to the user as pauses. `plan_ready` invited an approval that
could only be acted on by re-running the task from scratch. `redaction_blocked` and
`zdr_blocked` were unreachable in production for an unrelated reason, and would have
been dead ends if they had fired.

Continuation needs three things true at once, which is why they shipped together
rather than as separate features:

1. **The conversation is durable** (`task_messages`). Without it there is nothing to
   resume *from*.
2. **The worktree survives the park** (`holdWorktree`). Without it a Code
   continuation resumes into an empty checkout and silently redoes work.
3. **The decision becomes a rule** (the `session` permission layer). Without it the
   continuation re-parks on the same call, forever.

### Snapshots are taken at stopping points, never per turn

`snapshotConversation` is called immediately before each `parkRun`, and at a ceiling
warning. On the hot path it costs nothing.

**This moves a boundary `014_task_steps.sql` drew, deliberately.** That header said
"not deltas, not prompt text", and `007` rejected "persist every token". Both were
about *step history* — what did this run do, readable afterwards — and run
continuation did not exist as a requirement then. One row set replacing another at a
moment the run has already stopped is a different thing from streaming every token
into the database.

The call site is the **loop**, not `parkRun`. `parkRun` takes
`Pick<AgentContext, 'emit' | 'log'>`, is deliberately narrow, and is called from
agents directly; the conversation lives behind `AgentLoopInput.context`. Widening its
signature would hand every caller write access to something most of them have no
business touching.

Two absences produce no snapshot and both are legitimate: an agent that supplies no
`LoopContextAccess` (it rebuilds its prompt each turn), and a run with no `taskId`.
The continue route detects that and returns a coded 409 naming the reason, rather
than continuing from an empty conversation and re-running the task's first turn while
claiming to resume it.

### Snapshots are verbatim, and the retention window is the control

Continuation replays this conversation. Redacting it would have the agent resume
believing it read something it can no longer see — a `read` whose output was masked
becomes a file the model thinks it knows and does not. **Correct replay and redaction
are mutually exclusive**, and a continuation resuming from a corrupted memory is
worse than no continuation.

So the control is the window, not the content:

* A snapshot exists **only between a park and its continuation or terminal state**.
* Deleting it on the terminal transition happens **inline**, in `finishTaskRun`, and
  is a tested security property — not housekeeping. A timer-based sweep would widen
  the window to a day, which is a different guarantee from this one.
* `runCleanup` sweeps only what a crash orphaned. Its count is expected to be zero.
* Over a byte cap, the **pruned** conversation is stored instead. Prune already runs
  before every turn, so the pruned form is one the run could have been sent —
  unlike a truncated message, which is neither the conversation nor a valid request.

Be explicit about the size of this surface: tool results carry **full file contents
the agent read and raw command output**, so a live snapshot is effectively a partial
copy of the user's source tree. That is a materially larger exposure than
`messages.content`, and it is why the next section exists.

### Snapshots are stripped from backups

`exportBackup` runs one `DELETE FROM task_messages` against the temp copy
`snapshotDatabase()` produces, before zipping. Never against the live database.

A backup today contains **no** project source at all — the database, the MCP config,
the skills tree, optionally attachments (`backup/export.ts`). Carrying snapshots
would introduce a new *category* of content to an artifact `mirrorBackup` copies
off-machine, not merely more of an existing one.

Nothing real is lost, and that is an argument rather than a hope: **continuation
across a restore is impossible regardless.** The archive has never included the
projects directory or any worktree, so a restored backup has no worktree for a parked
Code task to continue into.

### Park no longer releases the worktree

`settleWorktree` gates on the run's **final state**: `complete`/`error`/`stopped`
release, `blocked`/`ready_for_review` hold.

The gate is the state, not the shape of the promise chain, because a parked run
arrives through the *success* tail — `runAgentLoop` returns a result for a park rather
than throwing, so "the promise resolved" says nothing about whether the task
finished.

Releasing a parked task's worktree is what made every pre-existing park a dead end,
and the failure was not a clean one. `freePath` deliberately suffixes past an existing
directory, and `create` always tries branch `hyperion-task-${taskId}` — so
re-submitting a parked task id got a *new* directory, failed `worktree add -b`
because the branch already existed, fell back to `--detach`, and restarted from
`baseCommit` with the prior edits orphaned on disk.

A held worktree costs **disk, not a lane slot**: `withCodeLane` completes when the
agent returns, so the slot is already free. `GET /api/code/tasks` reports `held`
separately from `active` for that reason — counting a park as running would misreport
capacity, and omitting it would make a deliberately retained directory
indistinguishable from a leaked one.

`reapHeldWorktrees` releases holds older than `parked_worktree_ttl_hours`
(default 168 — a week, because "someone answers" is a human timescale). It runs on
boot beside `reconcileOrphanedTaskRuns` and on the cleanup timer.
`releaseWorktree`'s own safety checks still apply, so a held tree with uncommitted
work is kept on disk and merely deregistered: **the reaper reclaims tracking, never a
diff.**

### The state transition is the mutex

`claimParkedRun` flips `blocked`/`ready_for_review` to `running` in one conditional
`UPDATE`. Zero rows changed means somebody else already continued it.

This is in SQL rather than a read-then-write because a read followed by a write is
precisely the race being prevented: two clients answering the same prompt — a phone
and a laptop showing one task — would both see the park and both proceed, and two
agents would run against one worktree.

The claim happens **before** the lane is awaited, so a queued continuation is already
marked `running`. That matches what `http/agents.ts` does for a fresh run and is what
keeps the mutex effective while queued. A `pending_approvals` state transition guards
the approval case as well, but a bare continue of `plan_ready` has no second guard,
so this one has to be sufficient alone.

### Continuation is its own route, and acquires the same lane

`POST /api/{tool}/tasks/:taskId/continue`, explicit rather than overloading
`run-task`. Re-running work and resuming an agent mid-thought with tools already
authorised are different operations with different failure modes, and the second must
never happen by accident.

It acquires the same concurrency primitive the original run used — `withCodeLane` for
Code, `withLock` otherwise, honouring `concurrencyMode()`. A continuation is a real
agent run: it edits files and spends tokens, so exempting it from the lane would let
it run alongside the work the lane exists to serialise.

It starts a **new** `runId` and a new `task_runs` row. Reusing the parked id would be
actively destructive: `startTaskRun` is `INSERT OR REPLACE`, and `task_steps`
cascades on delete, so writing the continuation under the old id would erase the step
history explaining why the run stopped. The parked row is closed out as
`continued_as:<newRunId>` — left `running` by the claim, it would otherwise look live
to `reconcileOrphanedTaskRuns` and be demoted to `error` on the next boot, reporting a
failure that never happened.

A fresh cancellable is registered, because the parked run's was disposed in its own
`finally`. A continuation is separately stoppable.

### The system prompt is rebuilt, not restored

A continuation replays the stored conversation minus its system messages, and prepends
a freshly built one.

This is correct rather than wasteful. The profile, project rules, project permission
file and session allowances may all have moved while the task was parked — and that
change is usually *the reason* the user continued it. Replaying a stale system message
would resume under exactly the rules that stopped the run.

The original prompt is not re-sent as a fresh user turn either: the snapshot already
holds it, and sending it again would have the model read its own task description
twice, once as history and once as a new instruction.

### All five park reasons continue through one route

| Reason | What continuation applies |
| --- | --- |
| `approval_required` | The recorded decision, as a session-layer rule |
| `doom_loop` | The same; a denial finalises as `loop_detected` |
| `plan_ready` | Planned actions authorised via a session allow — Plan→Act stops meaning "re-run from scratch" |
| `redaction_blocked` | Replay with the finding acknowledged. Only reachable at all once `unattended` moved to `TaskInput` |
| `zdr_blocked` | Replay; succeeds only if a setting or a recorded provider fact changed |

Two classes of park with no principled distinction between them would be the worse
outcome. The table, the route, the worktree lifecycle and the session layer are built
for `approval_required` regardless; these are additional `ParkReason` values routed
through the same machinery.

### The doom loop asks before it kills

`RepeatGuard` no longer parks `loop_detected` outright. On threshold it raises the
same `ask` an `approval_required` verdict does, with reason `doom_loop` and state
`ready_for_review`.

A stuck model is not always wrong — the common case is a tool that legitimately
returns the same answer twice — and terminating discards every turn before the
repetition. Asking costs one confirmation and keeps the work. `loop_detected` is
retained as the terminal reason a **denial** lands on, so the existing state
vocabulary and its test stay meaningful.

### `unattended` is a per-run fact, and was a no-op before this

It moved from a construction-time dependency to `TaskInput`.

It could not be fixed at construction time: one registered agent instance serves both
live HTTP runs and scheduled runs — `scheduler.ts` and `http/agents.ts` call the same
`requireAgent` — so "is anyone watching?" is not a property of the module.
`registerProductionModules` constructed both agents with no arguments, so
`deps.unattended` was `undefined` in production, and `parkOnBlockedSend` guards on
`if (!unattended || …) throw error`. **`redaction_blocked` and `zdr_blocked` were
therefore unreachable outside tests that injected the flag.**

Agents read `input.unattended ?? deps.unattended ?? false`. The deps path survives
only as a test override, which is why it loses.

`http/agents.ts` deliberately does **not** read it from the request body. It is a fact
about who is watching, not a client preference, and that route exists because somebody
is: they opened an SSE stream. A body flag would let a client silently opt out of the
refusals that exist to be answered — a flagged send would park instead of asking,
which defeats the check.

### Scheduled runs get a `task_runs` row

Two tables, two different questions. `scheduled_task_runs` records the **scheduling**
outcome: did the cron fire, was it skipped because the app was busy or the cap was
reached. `task_runs` records the **execution** state: running, parked, complete, error.

The scheduler wrote only the first, and the omission was not harmless:
`createAgentContext` was called with no `runId`, so `parkRun` skipped both the state
write and the step row. A scheduled park was invisible and had nothing to continue
from.

Consequences, all visible to existing users:

* Scheduled tasks now answer `GET /api/{tool}/tasks/:taskId/state`.
* They write the step history `014` exists to provide.
* They can **park** where they previously errored. That is the documented intent of
  1.23/1.26, so the new behaviour is the correct one — but it changes what users see,
  and with `push_enabled` off by default the park is silent until they open the task.
  It belongs in a release note.

The activity feed filters `task_runs` rows whose `task_id` is a known scheduled task,
so one execution yields one entry. Filtering against `scheduled_tasks` rather than
against the rows in the current page keeps the answer page-independent — a partner row
falling outside the window would otherwise reappear as a second entry on one page and
not the next. An interactive run cannot be caught by it, because its `task_id` is a
chat or Code task id and never a scheduled-task id.

### Approving and continuing are separate calls

`POST .../approve` records a decision and returns JSON. `POST .../continue` drives the
agent and returns an SSE stream.

Keeping them apart lets a client answer a prompt from a notification without
committing to drive the run from that connection. `approve` is idempotent: approving an
already-resolved approval returns the state it actually reached, matching
`cancelTaskRoute`'s posture on a run that has already ended. Answering a moment after
somebody else did is a race the user cannot avoid.

A **denial** finalises the run as `stopped` without starting an agent. The answer was
"do not do this", and running the loop again would immediately re-park on the same
call.
## Budget enforcement and the HTTP run tail *(added by Master Plan v4, §6.2)*

### The route tail never overwrites a state the run already recorded

`markTaskRun` at the end of every `/run-task` SSE lifecycle is guarded: it stamps the
terminal state only while the row still reads `running`. A run the agent parked —
waiting on an approval, blocked by a send refusal — has already chosen its state, and
the tail used to stamp `complete` over all of them as the stream closed. That made a
parked state unreachable over HTTP, and it lied to two downstream readers: the
resumption surface, which sorts parked runs into what they still need, and
`settleWorktree`'s hold, which reads the same row to decide whether a Code task's
worktree may be released. The unattended scheduler (`src/services/cowork/scheduler.ts`)
has always settled its runs with exactly this guard; the HTTP route now matches it.

### A run stops on the ceiling between turns, not inside one

`TaskBudget` is a passive accountant: `charge()` and `step()` record, `exceeded()`
answers. The agent loop asks the question at the one boundary where stopping is
graceful — after a model turn returns, before its tool calls are dispatched — because
a trip mid-turn would abandon partial work with no step written and no snapshot taken.
Two consequences follow and are deliberate:

* The same turn that trips the ceiling is never dispatched. Its tool calls are
  discarded. Anything else would mean honouring work the ceiling was there to refuse.
* A turn that ends the conversation still completes even if its own usage charged past
  the ceiling. The ceiling exists to stop the *next* spend; there is nothing to stop
  in a model that just said it was done.

A ceiling stop records `stopped` with `pauseReason: ceiling_reached` and emits a
`ceiling_reached` SSE event naming the `kind` — `token_budget`, `iteration_limit` or
`subagent_limit` — so the client can tell a configurable stop from a breakage without
parsing the detail string. It is **not** a park: nothing is awaiting an answer, and
continuing is exactly what the ceiling forbids.

### Both agents charge as usage arrives, against one shared budget

Code charges the shared runtime budget — the same object its subagents are handed —
while Cowork constructs one per run (`createBudget` is injectable for tests). Charging
inside the stream consumption, chunk by chunk, is what makes a subagent's spend land on
its parent's ceiling in real time rather than at child completion, by which point the
overrun would already be paid for.

---

## The Design agent (added in the Design slice)

**Who depends on this:** the frontend embedding the preview iframe, anyone
touching the permission engine's unknown-tool rule, and whoever is tempted to
give Design a filesystem or shell tool "just for convenience".

### The toolset is the security model

Design offers exactly nine tools and nothing else: no `bash`, no `command`,
no `write`, no `delegate`. A design draft never needs the shell or the
project tree, and the smaller surface is the point: the only things the model
can mutate are its own artifact lineage and brand proposals. Enforcement sits
in two places. The permission engine refuses any name outside the set as an
unknown tool — a deny at the builtin layer, before any rule is consulted —
and the dispatch table's default case is the drift insurance if the name list
and the switch ever diverge.

### Revisions are rows; undo is a new version

Every generate or revise writes a NEW `artifact_versions` row under
`design:file:{runId}:{name}`, never in place. The history is therefore the
undo substrate: `design.undo` writes the prior content as the next version,
so a bad undo is itself undoable and nothing is ever destroyed. The loop's
RepeatGuard ends degenerate identical-revision cycles the same way it ends
any other doom loop.

### The model proposes; only the user approves

`brand_propose` writes land in the gallery with `is_brand_approved = 0`, and
no agent-reachable surface flips that flag — approval lives in the `/api/design`
UI routes, which the model cannot call. The generation context only ever
injects the APPROVED set. An agent that could approve its own proposals would
be writing its own canon.

### The preview is served inert, not sanitized

`GET /api/design/preview/:versionId` serves draft bytes verbatim under
`default-src 'none'; style-src 'unsafe-inline'; img-src data:` plus `nosniff`
and `no-store`. A poisoned draft goes out byte-for-byte: the sandbox iframe
attribute, the CSP and the localhost bind are the three layers, and rewriting
the markup would be a fourth that lies about what the draft contains. Unknown
ids, other tools' artifacts and file-backed rows share one 404, so the
response never confirms which kind of miss it was.

### vision_verify is a stub by contract

It always answers `{ status: 'unverified', checks: [...] }`. Shipping the stub
means prompts and callers are already written against the real contract, so
the Playwright-based implementation lands without a call-site change. A draft
is never "visually checked" until that exists, and the system prompt says so.

### Model-correctable mistakes are guidance, not fatalities

Argument-shape errors still throw `bad_request`, as everywhere else. What
differs is state errors: revise-before-generate, undo-past-the-first-version
and double-generate return explanatory tool output and the run continues.
Design's core loop is long-running iteration, and one hallucinated call must
not cost twenty revisions of kept work.

---

## Golden-run regression tests (added by Master Plan v4, section 6.8)

**Who depends on this:** anyone editing an agent's system prompt, tool
schemas or message assembly — and anyone reviewing such an edit.

One real run per agent is recorded in `test/golden/*.json`: every request
sent to the provider, every event emitted, the result, and the artifact rows
written (run/task ids and generated UUIDs normalised out). Replaying the
recording drives the agent through the same scripted turns and asserts
byte-for-byte equality, so a prompt reword or a reordered tool list fails a
test instead of silently changing what the model sees. Unit tests cover
branches; goldens cover the assembled whole.

When a drift is intentional, re-record — `HYPERION_RECORD_GOLDEN=1
node --test test/goldenruns.test.ts` — and review the fixture diff like
any other change. Hand-editing a fixture to make a failing run pass defeats
the purpose: the diff review is the check.

## Per-task cost attribution *(added in 1.29, Master Plan v4 §6.2)*

Every provider request a task makes is recorded once, in
`orchestrator/agentContext.ts` — the one object every task run passes through,
whether a route, a continuation or the scheduler started it. Chat runs do not
build one, so they keep recording through `orchestrator/chat.ts` and nothing is
counted twice. The alternative considered and rejected was having each agent
record its own spend: three call sites that can drift, and a fourth agent would
have to remember to add one.

### Two keys, because "this task" and "this run" are different questions

`usage_log.task_id` and `usage_log.run_id` (migrations 017 and 018) both name an
execution and neither is redundant:

* **`task_id`** attributes spend to the *work*. A delegated child inherits its
  parent's task id (`loop.ts` omits `runId` at depth 1), so a task total includes
  what its subagents spent — which is the number that answers "what did this
  request cost me", and the number the daily spend cap is compared against.
* **`run_id`** names the *execution*. The activity feed renders one entry per
  `task_runs` row and the state route answers about one run, so this is what makes
  a per-entry cost possible.

So a task total is never the sum of its runs' totals: it is that sum plus the
child rows that carry no run id. `TaskUsage.runs` is a `COUNT(DISTINCT run_id)`
rather than a count of rows for the same reason.

`run_id` carries **no foreign key** to `task_runs`, deliberately: `startTaskRun`
uses `INSERT OR REPLACE` when an attempt restarts, so a cascading relation would
delete the spend of exactly the attempt being replaced. A spend row records
something a provider was actually asked, which must outlive the bookkeeping row
it is attributed to; a dangling id is the survivable error, and the honest one.
017 refuses a cascade on `task_messages` for the same reason.

### Absent usage is not zero usage, and unpriced is not free

A provider that reported no token counts leaves **no row**, rather than a row of
zeroes: "unknown tokens" and "no tokens" are different facts, and a zero in a
total is believed. A request that fails *after* reporting usage is recorded
`partial`, because the provider may well have billed it.

On the read side the rule `usage.ts` has always kept applies per task and per run:
`costUsd` is `null` unless a price matched, `priced` says whether the figure is
the whole bill, and `unpricedRequests` counts what could not be measured. A task
with nothing recorded reports `requests: 0` with `costUsd: null` — a client that
renders that as "$0.00" is wrong, and the field is shaped so the mistake is
visible rather than convenient.

### A global price is one row per model, enforced by the schema

`model_prices` is keyed `(model_id, provider_id)`, and SQLite treats NULLs as
distinct in a unique index — so the old `ON CONFLICT(model_id, provider_id)`
upsert never fired for the catch-all row (`provider_id IS NULL`, "all providers"),
and saving one twice inserted a duplicate while the lookup kept returning the
older. That is finding S15 in the register, and the repair is both a partial
unique index and a conflict target that names it. The general lesson is worth
keeping in view: a uniqueness claim that involves NULLs is not enforced by the
obvious constraint, and a silent duplicate read back as "the" value is a wrong
number rather than a failure.

## A row count is a whole number within a bound *(S17)*

`limit` is the only query value whose *type* SQLite refuses to coerce. Every
other number arrives in a comparison, where `2.5` compares perfectly well, so
`asNumber` is the right parser for it. A limit is different in both directions,
and neither failure is visible at the call site:

```
LIMIT 2.5  ->  SQLite raises "datatype mismatch"; the client gets a 500
               internal_error quoting the driver, and error_log gains a row
               that claims the server broke
LIMIT -1   ->  SQLite reads a negative limit as *no limit* and returns the
               whole table, so "-1 rows" silently means "everything"
```

So every list route takes its limit from `queryLimit(req, name, { fallback,
max })`, and an out-of-range value is a 400 naming the field — with the bound in
the message when the value is simply too large.

**Refused, not clamped.** `LIMIT` is captured in a service layer several of
these routes already clamped inside (`gallery.ts` caps at 1000, `cleanup.ts` at
500, `memory/index.ts` at 200), and clamping is the wrong answer at the
boundary: a caller handed 200 rows after asking for 5000 concludes the table
holds 200. The internal clamps stay — they also guard the agent-side callers
that never pass through HTTP — but they are a backstop, not the contract.

The consequence worth stating plainly: **the bound is part of the API**, so
raising one is a documented change rather than an implementation detail. Nine
routes carry one today (`chat` 500, `chat/:id` 500, `chat/:id/messages` 500,
`storage/assets` 1000, `storage/cleanup/log` 500, `errors` 500,
`design/assets/approved` 500, `cowork/.../history` 500, `memory` 200), and
`test/listlimits.test.ts` drives all nine — adding a list route that skips
`queryLimit` fails there.

## Point-of-action privacy *(added in Prompt 1.39, item B)*

The egress class, the retention story, the standing ZDR requirement and the
pre-send redaction-check flag are now rendered **where the send happens** — the
composer's own line — not only in Settings. Same data, different placement: the
decision the facts inform is made at the composer, and a fact disclosed three
screens away from its consequence is disclosed too late to be part of the
decision.

**The frontend derives no verdict.** `PrivacyIndicator` shows the recorded status
and the standing requirement side by side: "zero-data-retention not applied ·
zero-data-retention required". It does not say *met*, *unmet*, *satisfied* or
*eligible*, because that judgement is the backend's to make and it is made
server-side (`zdr.ts` reasons over its own status list, and its comment says why
the single definition lives there). A frontend that re-implemented the satisfying
rule would keep answering after the rule changed — and would be answering a
question the send path already answers, in the place where being wrong costs the
user their data rather than an error message.

**A status the UI cannot label is a contract failure, not a fallback.**
`activeProviderResponseSchema` enumerates `egress` (`local`/`remote`/`unknown`)
and `zdr.status` (the seven statuses in `types/core.ts`) and `zdr.requirement`
(`off`/`prefer`/`require`); `zdr` is required rather than optional, because the
route always sends it and a missing retention story must not be read as an absent
one. An unknown value makes the response an `invalid_response` instead of
rendering one badge for "we do not know this value" and "the provider retains
your data" — the same reasoning as the enumerated `healthStatus` and provider
type, now applied where the label has privacy semantics.

**What has no data source, and therefore no UI.** The same item lists proxy
profile, attachment/URL egress and Pulse source tier. None of the three exists in
this backend (`grep -r 'proxyProfile\|attachmentEgress\|pulse'` finds nothing),
so the composer shows no control for them: an unlabelled toggle or a permanently
"unknown" chip would read as a limitation of the provider rather than of the
feature. When any of them gets a backend field, it is rendered from that field or
not at all — never defaulted.

## The development state harness *(added in Prompt 1.39, item A4)*

`/__dev/states` renders the hard-to-trigger states with production components and
no provider or model calls (`HarnessRouter.test.tsx` asserts `fetch` is never
called). The rule that makes it useful is the one about honesty: **every fixture
either names the surface that produces it or says plainly that nothing does.**

- Real states carry their source: the Code-lane refusal is `busy` (409,
  retryable, `details.running/limit/queued`) or a queued waiter depending on
  concurrency mode; the spending cap is `spending_cap_reached` (429, autonomous
  work only); the backup diff is `POST /api/backup/inspect`; MCP disconnection is
  `GET /api/mcp/status`; "no provider active" is `/api/providers/active` returning
  `provider: null`.
- States the contract does not have say so in the card: **interrupted** is not a
  `TaskRun` state (a run is `stopped` or `error`, and the frontend derives
  "interrupted" from the transport — see the task machine), **provider cooldown**
  is not a state at all (an outage arrives as a run `paused` with a reason, then
  failover), and **design preview failure** has no preview to fail because the
  Design tool has no frontend yet.
- The dangerous-command confirmation renders the production `Dialog` as a
  primitive preview and is labelled as one — the Code approval surface does not
  exist yet, and a harness that faked the surrounding task view would hide that
  exactly as well as hiding the dialog would.

A fixture list that only contains implemented states lets "we never built it"
read as "nothing to render". The second kind of entry is the reason the file
exists.

## The attention queue is an inbox, not a report *(added in 1.39 A1)*

`GET /api/attention` exists because three surfaces were all answering a version of
"what is going on" and none of them answered "what is waiting on me". `GET
/api/health/summary` is a *capability* verdict — a request sent right now cannot
succeed — and a parked approval is not that: the permission engine is working
exactly as designed and the run is parked on purpose. `GET /api/activity` is
history, chronological and complete, and a finished task stays in it forever
because that is what history is for. The queue is the third thing, and its defining
rule is that **an item exists only while something is unfinished**.

Four decisions that follow from that, each of which a future change could undo
without noticing:

1. **Live state only.** A run in `error` is not an item — a failure the user
   already saw fail is not waiting on them, and putting it in the queue would
   rebuild the feed with worse ordering. The exception is an interruption: a run
   the server left mid-flight is a thing to restart, so it appears as
   `interrupted`. That is the `interrupted` state itself since migration `020`,
   and the pair that preceded it (`error` with `error_code: 'internal_error'`) is
   still reported, because every existing database holds rows in that shape and a
   queue that went quiet on them would drop the items that waited longest.
2. **One item per thing, not one per symptom.** A `ready_for_review` run that
   produced a plan becomes `plan_ready` and not both items, because the plan is
   *why* it wants review and the user has one decision to make.
3. **Ordering is data.** Items are grouped by kind in the order the source fixes
   (a decision outranks a notification) and oldest-first inside a kind, because a
   queue that reordered by recency would bury the prompt that waited longest.
   `counts` and `total` are derived from `items`, so a badge cannot disagree with
   the list under it.
4. **An unreadable source is reported, not omitted.** `sources` lists every
   category with `ok`/`empty`/`unavailable` and a reason when it is unavailable. A
   silently missing category is indistinguishable from a category that is fine,
   and this queue is read to decide what to do next rather than to admire a
   dashboard.

Two sources are honest about how they are detected. **Scheduled runs** need no
window: `scheduled_tasks.last_status` is the scheduler's own verdict and a later
success clears it. **Backups** do — a backup is a request, not a job, so there is
no run record at all and a failure is visible only in `error_log`; the item is
therefore a failed `/api/backup` request in the last 24h, and `sources[].reason`
says exactly that. If a backup run record is ever added, that source should become
the scheduled-run kind rather than keeping the window.

`resolve` is the *call* that answers an item (`POST
/api/{tool}/tasks/{taskId}/approve`, `POST /api/chat/resume` with the `runId`) and
never a frontend route: the shell owns its own URL space, and a backend that
invented paths for a UI it cannot see would have to be changed every time a route
moved. Items that can only be acted on in prose (a scheduled failure is re-run from
the Cowork tool; a cap is answered in Settings) carry no `resolve` rather than a
guessed one.

`test/attention.test.ts` (8 cases) drives the real app over a socket and writes
every row with the writer production uses — `recordApproval`, `createRun` /
`pauseRun` / `reconcileOrphanedRuns`, `startTaskRun` / `finishTaskRun` /
`recordStep`, `createScheduledTask` / `finishRun`, `logError` — including the two
assertions that are about absence: a plain failed run must not appear, and
resolving an approval must remove exactly one item.

## What the shell is allowed to remember *(added in Prompt 1.39, item A5)*

Workspace restoration is a promise about *presentation*, and it is worth stating
what that excludes, because the pressure to remember more will only grow. The
persisted state may hold: the last tool, which views were open and selected per
tool, the selected model per tool, panel layouts, the last version viewed per
artifact, unsent drafts, navigation hints, the onboarding draft, and where the
reader was in a scrolling surface. It may not hold credentials, keys, tokens,
passphrases or attachment content — not by convention but by construction:
`assertPersistenceSafe` walks the whole object recursively and throws on any key
whose normalized form names a secret (`apiKey`, `token`, `passphrase`, …), so the
write never happens, and the draft schema admits attachment **metadata** only, so
even a caller that tried could not store bytes. Both are pinned by tests, including
the case that matters most: a rejected write leaves the rest of the browser's
storage untouched.

Three rules the pieces share:

1. **A draft is text the user typed, and nothing else.** Losing an unsent prompt to
   a reload is the failure this exists to prevent, so the text is kept — debounced,
   because rewriting the whole state on every keystroke would put storage on the
   typing hot path, and flushed on unmount, because navigating away is exactly when
   the last characters would otherwise be lost. A draft that is empty or only
   whitespace is removed rather than stored: a saved blank is indistinguishable from
   a draft the user deliberately cleared, and it would come back as a phantom.
2. **A reading position is an anchor, not a number.** The remembered value is the id
   of the row at the top of the viewport plus how far above that row's top edge sits
   — a raw `scrollTop` means a different place after a resize, a font change or a
   streamed message that grew above it. Restoring happens before paint so a reopened
   conversation does not flash at the end and jump, and if the anchored row is no
   longer loaded the anchor is **dropped** rather than guessed at, with the view
   falling back to the end.
3. **Following the tail is conditional.** New content moves the view only while the
   viewport is already at the end. Anyone reading back through a transcript is not
   asking to be pulled to the bottom by the next streamed token, and following
   resumes only when they return to the end themselves.

Finally, a refused write is not an application failure. A browser in private mode,
a full quota or a blocked origin throws on `setItem`; the store catches it, keeps
the value in memory for the session and says nothing, because a feature that
remembers where you were should not be able to break where you are. What it must
not do is pretend: nothing is retried and nothing is reported as saved.

`frontend/src/state/persistence/` holds the store, the schema and the two hooks
(`usePersistedDraft`, `useScrollAnchor`); `frontend/src/tools/chat/drafts.ts` owns
the draft keys, so the key space is one place rather than a convention spread over
call sites.

## `interrupted` is its own state, not another flavour of error *(Prompt 1, item 1.31; migration `020`)*

Boot reconciliation has to demote a run that was mid-flight when the process died
— a row still saying `running` is a lie the state endpoint would repeat forever.
It used to write `error` with `error_code: 'internal_error'`, which was the
closest word the vocabulary had and the wrong one. Migration `012` made exactly
this argument for `stopped`, and it applies twice over here:

| candidate | why it is not the right word |
| --- | --- |
| `error` | nothing about the task failed. The process running it went away. And this state arrives on *every* unclean shutdown, so a vocabulary that calls it an error teaches users to ignore errors. |
| `paused` | promises a resume. A task run has none: the agent loop that could continue it is gone, and Chat's resume path does not exist for Code/Cowork/Design. `012` rejected `paused` for the same reason. |
| `interrupted` | says the third true thing: the run ended because something outside it stopped the process. Terminal, not resumable, and the cause still rides in `error_code` (`internal_error`), so a reader that only knows the old shape loses nothing. |

Three consequences worth keeping:

- **History is not rewritten.** Rows written before `020` keep `state = 'error'`
  with `error_code: 'internal_error'`, and readers that must keep showing them as
  interrupted (the attention queue does) recognise that pair explicitly. There is
  no data migration that rewrites the past into the new vocabulary.
- **The frontend has a case for it.** `interrupted` is in the wire enum, in
  `TaskViewState`, and in the state banner — a switch that met an unknown state
  would have returned `undefined`, so the mapping is asserted to be total.
- **The state is the constraint's, not the application's.** `task_runs.state` is
  a `CHECK`, so `020` rebuilds the table (the procedure `010` documents); a
  migration test applies it to a pre-`020` database and asserts both directions —
  the pre-`020` schema refuses `interrupted`, and after the migration an unknown
  word is still refused.

What is *not* here, and must not be read as covered by "1.31 landed": the
recovery UX (view the partial work, discard it), the unattended-run notification,
the `orphaned_worktree` check, the interactive-wait timeout and the Design
environment. Item 1.31 is a list, and only its state half is built.

## Provenance is two fields, and both are derived *(Prompt 1.39 A6)*

"What was this built on?" has exactly two answers worth storing, and the item that
asks for them also says not to store more. Both landed with that shape:

- **The version a version replaced.** `artifact_versions` has no `parent` column,
  and it does not need one: the parent of version *n* is *n-1*, and the table's own
  `UNIQUE (artifact_key, version)` is what makes that unambiguous. A column would be
  a second source of truth for a fact the key already holds, and the first thing to
  drift after a restore or a hand-edited row. `GET /api/artifacts/versions?key=…`
  derives it, so `parentVersion: null` means "this is where the artifact started"
  rather than "the parent is unknown" — which is only true for version 1.
- **The knowledge sources a run used.** Recorded where the sources are read, before
  the agent loop starts, and *used* keeps the meaning the prompt already gives it:
  only sources marked usable are evidence. A source that was consulted and turned
  out missing, binary or hash-mismatched is deliberately **absent** from the
  provenance list, because listing it would claim evidence the run never had — the
  prompt says so in as many words (`not used as evidence`), and the two must not
  disagree.

Four decisions underneath:

1. **A run's sources, not a task's.** A task can be restarted while its id stays,
   so the row is keyed `(run_id, source_id)` and cascades with the run. A retried run
   id replaces its set rather than accumulating — `startTaskRun`'s `INSERT OR
   REPLACE` clears this table by cascade exactly as it clears `task_steps` — and the
   writer deletes the run's rows first so the rule holds for any caller, not only
   the one that re-starts the run before reading.
2. **No foreign key to `knowledge_sources`.** Label, filename, byte count and
   digest are copied into the row, so deleting a source later cannot erase the fact
   that a run used it. That is the opposite of what a cascading reference would do,
   and it is the point: provenance is a claim about the past.
3. **The read reports what it read.** `readKnowledgeSource` now returns the digest
   and length of the bytes it decoded, not only when the source pins a digest.
   Without it a provenance row could say *which file* but never *which version of
   it*, which is the half that matters when a source is edited underneath a
   library that is not versioned.
4. **A missing digest stays missing.** `sha256: null` and `bytes: null` mean the
   read did not report them — never zero bytes, and never a hash of nothing.

Both fields are read back through the API and rendered by one component
(`frontend/src/components/Provenance/`), which the dev harness shows with fixture
data. What is still missing is a *tool* to host it: the Code/Design task surfaces
that would put a version timeline under a diff do not exist yet, so the panel is
reviewable in the harness and unwired in the app — stated here rather than implied
by a passing test suite.

### A cooldown is not a health verdict (and both are needed)

`health.ts` evicts a provider after two *retryable* failures in a window, and
excludes non-retryable ones on purpose: a wrong key must not evict a provider that
is plainly alive. That exclusion left the opposite hole — nothing bounded how
often a wrong key was retried, so every request in a chat hit the same 401 again,
and a 429 was answered by the router's own immediate second attempt, which is the
behaviour a rate limit exists to punish. Prompt 1 addendum 1.36 supplies the
missing mechanism as a table (401/403 60m, 402 30m, 429 5m + `Retry-After`, 404
2m, 5xx 1m, network 30s), and `src/providers/cooldowns.ts` is that table.

**The two mechanisms answer different questions, so neither replaces the other.**
Health is an availability judgement with a threshold, and it is what failover keys
off. A cooldown is a per-class back-off with no threshold at all: one 401 sets
one, because a wrong key is not a matter of degree. Conflating them would either
make a single typo evict a healthy provider (the argument `health.ts` already
makes) or leave the key being retried forever (the hole 1.36 closes).

Four decisions underneath:

1. **The HTTP status decides the class where there is one.** Classification falls
   back to the typed error for failures that never had a response — unreachable and
   timeout are the network class, and a raw throw out of `fetch` (DNS, TLS) is a
   network fault even though it never became an `AppError`. The status wins because
   it is what separates "rate limited" from "our request was malformed"; both
   arrive typed as `provider_error`.
2. **Other 4xx set no cooldown.** A 400 is this process's bug. Parking the
   provider for it would hide the bug behind a back-off that reads like the
   provider's fault. `aborted` never cools anything either: a user cancelling is
   not a provider event.
3. **`Retry-After` is honoured only on a 429, only when it asks for longer than
   the table, and never beyond an hour.** The header is a request, not a verdict:
   a provider saying "try again in 2s" is not a reason to come back sooner than
   this process would anyway, and a gateway answering `Retry-After: 86400` must
   not take a provider out of rotation for a day on the strength of one header.
   That clamp is what 1.36 calls capped backoff — the cap is the longest judgement
   this process makes on its own, so no header can outlast it.
4. **Cooling providers sort last, never out.** The candidate list is reordered, not
   filtered, for exactly the reason `listFailoverCandidates` gives for unhealthy
   providers: a provider serving an hour-long auth cooldown is still the right
   answer when it is the only one that can serve the model, and refusing outright
   would turn a key the user is about to fix into an outage. Ordering is what makes
   the choice prefer someone else *when there is someone else* — and the switch is
   reported as `cooldown` with the class named, so a paused run says "the
   credentials were rejected", not "401".

Expiry is applied on read (`cooldownFor`), so a stale entry can never be observed
and there is no janitor to forget to run; and every user action that re-evaluates
a provider goes through `resetHealth`, which is now the one place both the health
tracker and the cooldown are forgotten. That is the part of 1.36's "deadlock
reset" that has a mechanism behind it: nothing here can hold a provider out of
rotation permanently.

**What 1.36 names and this does not implement: `ModelSlot`.** The addendum lists
it with no mechanism, and nothing in this tree resembles a slot abstraction over
models, so inventing one would be a guess wearing the addendum's name. It is
recorded in the register as unavailable rather than approximated.

---

## A backup passphrase is not a stored key (1.29)

The archive this app writes is the artifact most likely to leave the machine —
emailed to yourself, copied to a cloud folder, left on a USB stick — and until
1.29 the only protection it had was the decision not to include `secret.key`.
That decision is still right (a leaked archive should expose conversations, not
credentials) but it is not encryption, and the requirement asked for the real
thing.

Four decisions underneath the container in `services/backup/crypto.ts`:

1. **Argon2id, because the secret is a human passphrase.** The defense that
   matters for a guessable input is cost per guess, in memory as well as time.
   The parameters (64 MiB, 3 iterations, 1 lane) live **in the container header**,
   not in the code's defaults, so raising the default later cannot make yesterday's
   archive unopenable and a user on slow hardware can still write something a
   faster machine reads.
2. **AES-256-GCM over the whole archive, with the header as additional data.**
   Authentication is the point: a flipped bit fails the tag and the archive is
   refused, rather than decrypting into garbage that then *restores* garbage. The
   header is authenticated so the recorded cost parameters cannot be edited — and
   the length field is checked before the key is derived, because a truncated
   upload should not cost a second of Argon2id to discover.
3. **The passphrase is never stored, anywhere, by design.** Not in the archive, the
   manifest, the settings table or a log line; there is no column in
   `restore_audit` it could be written into; and the routes take it in a **body**,
   never a query string, because a URL ends up in browser history, `Referer`
   headers and request logs. The consequence is stated where a user will meet it:
   there is no recovery, and losing the passphrase loses the archive.
4. **One message for two causes.** The tag covers ciphertext and header together,
   so "wrong passphrase" and "edited file" are indistinguishable by construction.
   The refusal says both rather than guessing — while the two cases that *can* be
   precise (a file that is not our container, a container that is truncated) say
   what they are.

Scheduled backups are deliberately **not** encrypted: a job that runs with nobody
present has nowhere to keep a passphrase except the settings table, and a key
stored beside the lock is not encryption. Protected exports are an explicit user
action, which is also why they are the only kind the `.hypbak` extension marks.
Destinations and retention are unchanged — the mirror directory
(`HYPERION_BACKUP_DEST`) and the automatic-backup retention count are what exist
today, and neither gained a passphrase setting in this pass.

## A restore is audited, and a restore's own record survives it (1.29)

`restore_audit` (migration `024`) records every attempt: dry runs, refusals and
real restores. Two properties are structural rather than conventional:

- **The row for a successful restore is written after the swap**, against the
  reopened handle, so the record lives *inside* the database that restore
  produced. Written before the swap it would be discarded along with the database
  it described — which is the one entry a user asks about a week later.
- **A refusal is recorded too.** The interesting entry is the near-miss: a stale
  archive someone reached for, or a protected file with no passphrase. It is
  written on the refusal path, where nothing has been touched, and it is
  best-effort there — the refusal's own error is the message the user needs, and a
  failed log write must not replace it.

`ArchiveInspection.diff` is a **count** diff, not a row diff, and that is the
honest shape: a restore replaces the database rather than merging it, so the
pre-confirmation question is "does this archive know more or less than I have, and
where". `onlyInArchive` and `onlyHere` name schema drift, which counts alone
cannot express — a table on one side only is not "zero rows".

## Plugins: compose, decide, and read (1.34)

The Plugins hub answers two questions that had no home — *who may use this*, and
*what is this* — and it deliberately owns no third: every fact about a plugin's
content is read from the registry that stores it (`mcp_servers`, `skills`, the
Memory plugin's switch). A hub with its own copy of a server's command would
eventually disagree with the MCP screen beside it.

1. **`enabled` and `availability` are different questions.** `enabled` is the
   plugin's own switch; `availability` is per tool. Both are reported, and
   migration `025` stores **deviations only**: no row for (plugin, tool) means
   available. A default of unavailable would silently change what every existing
   install can do the moment the hub shipped — and the user, whose tools had just
   gone quiet, would have nothing to look at.
2. **`null` deletes.** `PATCH .../availability` with `available: null` removes the
   row rather than storing a decision that agrees with the default. The two are
   identical to every reader and different to a user who later changes the
   default, which is why the API sentence that offers the reset is only true for
   the deletion. Clearing is asserted by reading the table, not the response.
3. **`consumers` is a fact about the code.** Cowork is the only tool whose code
   consumes an MCP server, and only the one it names (`wigolo`); the skills summary
   reaches the three agent loops; Memory is read by the conversation surfaces and
   Cowork. The hub states which tools a plugin reaches **today** rather than
   implying that every switch gates something — an availability toggle wired to
   nothing is worse than no toggle, because it moves the user's sense of control
   without moving any behaviour.
4. **The scan is a reading, not a verdict.** Offline, static, local: transport,
   command, argument count, whether a credential is stored, how many environment
   variables are declared, and the flags intake already recorded for a skill. The
   grade is the worst thing found — `active` (it runs something or was flagged),
   `inert` (files and instructions, nothing found that acts), `builtin` (Hyperion's
   own content, which is not scanned by policy, so the grade is about provenance).
   There is no numeric score, because a number would be precision the reading does
   not have. The caveat is part of every response, the same way the skill risk
   report's is.
5. **A credential is named, never quoted.** The scan says a credential is stored;
   the value does not appear in the catalogue in either form — the hub *does* hold
   the stored ciphertext, so "it is encrypted anyway" is not a reason for it to
   travel. A URL carrying credentials is redacted to `//***@` first.
6. **The authorisation side is a leaf module.** `services/plugins/availability.ts`
   imports the database and the tool vocabulary, nothing else, so the consumers
   (memory, the agent context, Cowork) can honour a decision without importing the
   catalogue — which imports all three of them. That cycle is not hypothetical;
   it is the shape that bit the MCP supervisor before.

Still open under 1.34: no frontend Plugins surface (the tool is a placeholder),
and an override can be recorded for a tool that cannot consume that plugin yet —
reported through `consumers` rather than hidden.

## browser-use is a seeded MCP server, not a new subsystem (1.35)

The item reads as one sentence and that is the whole point: browser-use is an MCP
server, and the hub built for 1.34 already hosts MCP servers. So this lands as a
**fourth seeded default** (`services/mcp/defaults.ts`), with the documented launch
from browser-use's own docs — `uvx --from 'browser-use[cli]' browser-use --mcp` —
and three deliberate properties:

1. **Seeded disabled.** Nothing auto-enables itself, and this server needs `uv` on
   PATH before it can start at all; an entry that fails on every start would sit
   permanently red and make the whole MCP list look broken. The other two
   setup-required defaults (wigolo, graphify) are seeded the same way.
2. **No invented credential.** The browser agent runs its own model loop, so it
   needs an API key of its own in its environment. A placeholder key would be a
   credential that cannot work — worse than none, because it looks configured. The
   seed writes no `env` and no token; the requirement is stated in the note, where
   the user meets it, and the hub reports the absence rather than a zero-count
   finding.
3. **Read as what it is.** The hub's scan gained one evidence-based reading:
   `mcp.browser-automation`, triggered by `browser-use`, `playwright`,
   `puppeteer`, `selenium` or `chromedriver` appearing in a local server's command
   or arguments. It is separate from `mcp.local-command` because the fact that
   matters is not "this runs here" but "this acts **as you**, on pages this machine
   is signed in to". The finding names the marker it matched.

Not done, and recorded rather than implied: **no tool consumes it yet.** Cowork
reads one MCP server by name (`wigolo`), so an availability override for
browser-use is a real stored decision that no code path consults today — which is
exactly what `consumers: []` on its hub entry says. Wiring a second server into a
tool's context is per-tool MCP selection, and that is Prompt-2 work.

