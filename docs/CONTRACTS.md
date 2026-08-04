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
  //   dependencies.failed[] → { name, spec, error }
  //   dependencies.error    → overall reason
  // POST /api/skills/:id/provision retries after they've fixed it.
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



