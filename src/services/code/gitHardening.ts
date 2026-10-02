/**
 * Arguments that stop git configuration from being an execution primitive.
 *
 * Hyperion runs git against repositories an agent has been editing. Several
 * git features are *configured commands*: git reads a value out of a config
 * file and executes it, as Hyperion, with Hyperion's privileges, at a moment
 * nobody is being asked to approve anything.
 *
 *   - `diff.<driver>.textconv` and `diff.<driver>.command` — run on
 *     `git diff` for any path matched by a `diff=<driver>` line in
 *     `.gitattributes`.
 *   - `filter.<driver>.clean` / `.smudge` / `.process` — run wherever git
 *     *converts* content for a path matched by a `filter=<driver>` line:
 *     `clean` on `git diff` when the working tree differs from the index,
 *     `smudge` on the checkout that `git worktree add` performs.
 *   - `core.fsmonitor` — a path, run on essentially every command that reads
 *     the index, including `git status` and `git diff`.
 *   - `core.hooksPath` / `.git/hooks/*` — `post-checkout` fires on
 *     `git worktree add`.
 *
 * **This is reachable without an approved shell command.** `files.ts::locate`
 * enforces containment and nothing else, and in `direct` mode the task root
 * *is* the project directory — so `<project>/.git/config` is inside the root
 * and an ordinary file write puts any of the above in place. The payload then
 * fires the next time Hyperion itself runs git: the patch export
 * (`git diff <base>`), a worktree release (`git status --porcelain`), or the
 * orphan scan, which runs **at boot, unattended**. That second write path is
 * closed separately, in `files.ts`; this module closes the execution itself,
 * because defence that depends on one check never being bypassed is not
 * defence.
 *
 * Measured on git 2.39.5, each lever given its own marker so the readings
 * cannot be confused with one another (`test/gitexec.test.ts` automates the
 * same experiment):
 *
 *   git diff <base>                             -> ext-diff RAN, clean RAN
 *   git diff --no-ext-diff --no-textconv <base> -> ext-diff and textconv
 *                                                  blocked, clean filter
 *                                                  STILL RAN
 *   ... plus -c filter.<d>.clean=               -> nothing ran, diff intact
 *   git status --porcelain                      -> fsmonitor RAN; the clean
 *                                                  filter does not run (git
 *                                                  reads stat data, not
 *                                                  content)
 *   git worktree add                            -> post-checkout RAN and the
 *                                                  smudge filter RAN
 *   ... plus -c filter.<d>.smudge=              -> nothing ran, content intact
 *
 * Two corrections worth keeping, because both cost a round of wrong answers:
 *
 *   - `git --no-ext-diff diff …` — the flag *before* the subcommand — exits
 *     129. It is not a top-level option. A canary that does not check the exit
 *     status reads that failure as "blocked" and reports a guard that is not
 *     there.
 *   - Once a dirty file has been staged, git's stat cache means the clean
 *     filter no longer runs at all, so any measurement has to re-dirty the
 *     file immediately before each command.
 *
 * An empty `-c` override works for filter drivers but **not** for
 * `diff.<driver>.textconv` / `.command`: git fails the whole command (exit
 * 128). Hence two mechanisms — flags for the diff drivers, name-by-name
 * overrides for the filters.
 */

/**
 * Global `-c` overrides, valid before any subcommand.
 *
 * Applied to **every** git invocation rather than only the read-only ones: the
 * cost is nil and the alternative is a per-call-site judgement about whether
 * that command touches the index, which is exactly the kind of judgement that
 * goes stale when someone adds the next call site.
 *
 * Known consequence: `core.hooksPath` also suppresses a *legitimate*
 * `post-checkout`, which is how git-lfs materializes its files. An LFS
 * repository will show pointer files in a task worktree. That is the accepted
 * trade — a hook in a repository the agent has write access to is the exact
 * thing being closed — and it is recorded in CONTRACTS.md rather than left for
 * someone to rediscover.
 */
export const GIT_SAFE_CONFIG: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
];

/**
 * Config read that lists every filter driver the repository defines.
 *
 * Reading config executes nothing, so this call needs no protection of its
 * own beyond `GIT_SAFE_CONFIG`. It exits non-zero when there are no matches,
 * which is the ordinary case and not an error.
 */
export const GIT_FILTER_QUERY: readonly string[] = [
  'config',
  '--name-only',
  '--get-regexp',
  '^filter\\..*\\.(smudge|clean|process)$',
];

/**
 * `-c` overrides that disable every filter driver named in the output of
 * `GIT_FILTER_QUERY`.
 *
 * Needed because a **checkout** converts content, and conversion is where
 * `filter.<driver>.smudge` runs — `git worktree add` therefore executes it,
 * and neither `core.hooksPath` nor the diff flags touch that. Measured on git
 * 2.39.5: a smudge filter fires on `worktree add`, an empty override blocks it,
 * and the checked-out content is still correct.
 *
 * `git diff` needs the same treatment for `clean`: no diff flag suppresses
 * filters, despite `--no-ext-diff` appearing to at first measurement.
 *
 * There is no global "no filters" switch in git, so the drivers have to be
 * enumerated and overridden by name. That enumeration costs a config read, so
 * it is applied at the two call sites that convert content — the checkout in
 * `worktree.ts` and the diff in `export/index.ts` — rather than folded into
 * `GIT_SAFE_CONFIG`. Everything else Hyperion runs (`status`, `rev-parse`,
 * `worktree remove`, `worktree prune`) converts no content.
 *
 * A subsection name may itself contain dots (`filter.a.b.smudge` is driver
 * `a.b`), which is why the pattern is greedy up to the final key.
 */
export function filterOverrides(configNames: string): string[] {
  const drivers = new Set<string>();
  for (const line of configNames.split('\n')) {
    const match = /^filter\.(.+)\.(?:smudge|clean|process)$/.exec(line.trim());
    if (match?.[1] !== undefined) drivers.add(match[1]);
  }
  return [...drivers].flatMap((driver) => [
    '-c',
    `filter.${driver}.smudge=`,
    '-c',
    `filter.${driver}.clean=`,
    '-c',
    `filter.${driver}.process=`,
  ]);
}

/**
 * Diff-only flags, appended after the subcommand.
 *
 * `--no-ext-diff` disallows external diff drivers and `--no-textconv` the
 * textconv conversion. They do **not** cover filter drivers — see
 * `filterOverrides`. Both are diff options, invalid on `status` or
 * `rev-parse`, which is why they are separate from `GIT_SAFE_CONFIG`.
 */
export const GIT_SAFE_DIFF_FLAGS: readonly string[] = ['--no-ext-diff', '--no-textconv'];
