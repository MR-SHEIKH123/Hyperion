/**
 * What governs a terminal command that is *not* from a live human session (S17).
 *
 * The exemption S17 protects is narrow: a person typing into a terminal they
 * opened is exempt from the permission engine's `ask`/`deny` evaluation. Everything
 * else that claims to be a terminal command is an automated execution like any
 * other, and this module is the "like any other" part — it puts the command in
 * front of the same engine the agents use, over the same project rules.
 *
 * Three decisions:
 *
 *   - **The command is evaluated as the `bash` tool.** That is what it is, and it
 *     is the key an author has already written rules against (`bash: deny` in
 *     `.hyperion/permissions`). Inventing a `terminal` key would mean the rules the
 *     user wrote for shell access silently did not apply to shell access.
 *   - **The baseline is the `act` built-in.** The terminal has no Ask/Plan/Act mode
 *     to inherit, so a mode-based choice would be an invention; `act` is the honest
 *     statement of the pre-existing authority of this route (it ran anything the
 *     capability gate allowed), with the project layer able to narrow it. That also
 *     keeps the change honest in the direction that matters: this can only refuse
 *     more than before, never less.
 *   - **`ask` is reported as `approval_required` and nothing runs.** There is no run
 *     to park — a route-level command has no task and no conversation to continue —
 *     so the only truthful answer is a refusal that names the rule. The caller can
 *     change the rule, or run the command from a live human session, which is the
 *     exemption's whole point.
 */
import { evaluate } from '../agent/permissions.ts';
import { builtinProfile, permissionLayers } from '../agent/profiles.ts';
import { loadProjectPermissions } from '../code/projectContext.ts';
import { AppError } from '../../util/errors.ts';

import type { PermissionVerdict } from '../../types/core.ts';

/** The tool key a terminal command is evaluated under. */
export const TERMINAL_TOOL = 'bash';

export async function terminalCommandVerdict(input: {
  command: string;
  project: string;
}): Promise<PermissionVerdict> {
  // `null` is unreachable — the built-ins are a frozen list containing `act` — and
  // is still handled rather than asserted, because an evaluation that silently
  // fell back to "no rules" would be a gate that opens when the data moves.
  const profile = builtinProfile('act');
  if (profile === null) {
    throw new AppError('internal_error', 'The act baseline profile is missing, so no command can be evaluated.');
  }
  const project = await loadProjectPermissions(input.project);
  const layers = permissionLayers({
    profile,
    ...(Object.keys(project).length === 0 ? {} : { project }),
  });

  return evaluate({
    call: { id: 'terminal-command', name: TERMINAL_TOOL, arguments: JSON.stringify({ command: input.command }) },
    // The terminal runs shell commands: mutating, always. A command that only
    // reads is not distinguishable from one that does not without parsing it, and
    // a parser that guessed wrong would downgrade a write to a read.
    effect: 'mutate',
    layers,
    knownTools: new Set([TERMINAL_TOOL]),
  });
}
