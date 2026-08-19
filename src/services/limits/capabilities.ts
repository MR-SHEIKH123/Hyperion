/**
 * Capability gates — Part 1.20 §2 and Part 1.21 §5.
 *
 * A toggle that is off must **refuse**, not quietly do nothing. A silent no-op
 * is the worst of the three options: the user sees a task that appears to run
 * and produces nothing, with no way to connect that to a switch they flipped in
 * Settings weeks ago. So every gate throws a coded `AppError` naming the
 * capability, and the UI can link straight to the toggle.
 *
 * Gates live here rather than inside each feature so the vocabulary stays in
 * one place and so a new call site cannot invent its own error shape for the
 * same refusal.
 */

import { isCapabilityOn, type Capability } from '../../db/settings.ts';
import { AppError } from '../../util/errors.ts';

/** Human-readable label per capability, used in the refusal message. */
const LABELS: Record<Capability, string> = {
  cowork_research: 'Cowork research',
  code_execution: 'Code execution',
  network_egress: 'Network access from executed commands',
  web_research: 'Web research',
  artifacts: 'Artifacts',
  chat_search: 'Chat search',
  memory_generation: 'Memory generation',
};

/**
 * Throw `capability_disabled` unless the capability is switched on.
 *
 * `details.capability` is the settings key the UI needs to offer "turn this back
 * on", which is the only useful action at this point.
 */
export function assertCapability(capability: Capability): void {
  if (isCapabilityOn(capability)) return;
  throw new AppError(
    'capability_disabled',
    `${LABELS[capability]} is switched off in Settings.`,
    { details: { capability }, retryable: false },
  );
}

/**
 * Commands that reach the network.
 *
 * This is a **deliberately shallow** check and it is important not to oversell
 * it: it recognises the package managers and download tools that make up the
 * ordinary case, and it will not catch a script that opens a socket itself. It
 * is a guard against the accidental `npm install`, not a sandbox — the actual
 * containment boundary is the worktree scope in `fsScope`/`worktree.ts`.
 *
 * Anchored to the start of the command or to a shell separator so a path
 * containing the word "curl" is not mistaken for the tool, and matched
 * case-insensitively because Windows does not care about case in a command name.
 */
const NETWORK_COMMANDS = [
  // fetchers
  'curl',
  'wget',
  'scp',
  'sftp',
  'rsync',
  'ftp',
  // package managers, in their network-touching modes
  'npm\\s+(i|install|ci|update|add|publish|exec|pack)',
  'npx',
  'pnpm\\s+(i|install|add|update|dlx)',
  'yarn\\s+(add|install|up|upgrade)',
  'bun\\s+(add|install|x)',
  'pip3?\\s+(install|download|wheel)',
  'python3?\\s+-m\\s+pip\\s+(install|download)',
  'poetry\\s+(add|install|update)',
  'uv\\s+(add|pip|sync)',
  'gem\\s+install',
  'cargo\\s+(add|install|fetch|publish)',
  'go\\s+(get|install|mod\\s+download)',
  'apt(-get)?\\s+(install|update|upgrade)',
  'brew\\s+(install|update|upgrade|tap)',
  'choco\\s+install',
  'winget\\s+install',
  'docker\\s+(pull|push|run)',
  // source fetches
  'git\\s+(clone|fetch|pull|push|remote\\s+add|submodule)',
  'nix(-env)?\\s',
];

/**
 * A separator that starts a new command: the beginning of the string, a shell
 * operator, or a subshell. Without this anchor, `echo "see curl docs"` reads as
 * a network call.
 */
const NETWORK_PATTERN = new RegExp(
  String.raw`(?:^|[;&|(]|&&|\|\||\n)\s*(?:sudo\s+|env\s+\S+=\S+\s+)*(?:${NETWORK_COMMANDS.join('|')})\b`,
  'i',
);

/** True when the command looks like it would reach the network. */
export function looksLikeNetworkCommand(command: string): boolean {
  return NETWORK_PATTERN.test(command);
}

/**
 * Gate a shell command against the execution and egress toggles.
 *
 * Two distinct refusals, because they are two distinct things to fix:
 * `capability_disabled` means shell execution is off entirely, while
 * `network_egress_disabled` means local commands are fine and this particular
 * one reaches out. Collapsing them into one code would send the user to the
 * wrong switch.
 *
 * The matched fragment is reported in `details.matched` — a refusal the user
 * cannot explain is a refusal they will work around, and the command is their
 * own input, so echoing part of it back exposes nothing new.
 */
export function assertCommandAllowed(command: string): void {
  assertCapability('code_execution');

  if (!looksLikeNetworkCommand(command)) return;
  if (isCapabilityOn('network_egress')) return;

  const matched = NETWORK_PATTERN.exec(command)?.[0]?.trim() ?? '';
  throw new AppError(
    'network_egress_disabled',
    'Network access from executed commands is switched off in Settings, and this command appears to download something.',
    { details: { capability: 'network_egress', ...(matched === '' ? {} : { matched }) }, retryable: false },
  );
}
