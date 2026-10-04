/**
 * One question about a finished child process: did it fail because its binary is
 * not installed?
 *
 * Two services ask it about different programs — the Code worktree probe about
 * `git`, the skills provisioner about an installer — and both used to answer with
 * their own copy of the same three-line predicate. The copies also carried the
 * same bug risk: the answer decides whether a user is told "git was not found on
 * PATH" or "this project is not a git repository", which are different problems
 * with different fixes, so the two call sites must not drift.
 *
 * `spawnError` is the honest signal and is checked first: the process never
 * started, whatever it was. The pattern is the fallback for the shells that
 * report the absence inside the captured output and exit non-zero instead —
 * `ENOENT` from a POSIX shell, "not recognized as an internal or external
 * command" from cmd.exe, "command not found" from a shell that spells it out.
 */

/** The parts of a spawn result this question needs. Structurally, not nominally. */
export interface SpawnOutcome {
  /** True when the child could not be started at all. */
  spawnError: boolean;
  /** Merged stdout and stderr; the fallback signal lives here. */
  output: string;
}

const MISSING_BINARY = /ENOENT|not recognized as an internal or external command|command not found/i;

export function isMissingExecutable(result: SpawnOutcome): boolean {
  return result.spawnError || MISSING_BINARY.test(result.output);
}
