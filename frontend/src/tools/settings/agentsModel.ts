import type { ProjectAgentWire, PublicProfileWire } from '../../contracts/wire/agents';

/**
 * Pure helpers for the Agents and permissions section (Settings 2.5,
 * slice 4): labels and the collision arithmetic the overwrite
 * confirmation is built from. No fetching.
 */

/** Mirrors `PROFILE_IMPORT_MAX_FILES` in the import service. */
export const PROFILE_IMPORT_MAX_FILES = 50;

/** Mode glosses taken from the built-in profiles' own descriptions. */
export const MODE_LINES: Record<'ask' | 'plan' | 'act', string> = {
  ask: 'Answers questions and runs nothing.',
  plan: 'Reads freely, changes nothing, and collects a plan for approval.',
  act: 'Full access, still subject to project and session rules.',
};

export const LAYER_LINES: Record<string, string> = {
  builtin: 'The base mode’s built-in baseline. Every profile starts here.',
  profile: 'What the selected profile adds or narrows.',
  project: 'Rules from the project’s own files.',
  session: 'Granted for one task or session only.',
  inherited: 'A parent run’s ceiling for its subagents. Evaluated last; a deny here cannot be overridden downward.',
};

export const IMPORT_STATUS_LABELS: Record<string, string> = {
  imported: 'Imported',
  overwritten: 'Overwritten',
  renamed: 'Renamed',
  skipped: 'Skipped',
  invalid: 'Invalid',
};

/**
 * Picked files whose filename already exists among the listed project
 * agents. The import files by filename (collision is `existsSync` on the
 * destination), so this is the same comparison — and it is what the
 * overwrite confirmation names before anything is sent.
 */
export function collidingFiles(
  picked: readonly File[],
  existing: readonly ProjectAgentWire[],
): { file: File; existingName: string }[] {
  const byBasename = new Map(existing.map((agent) => [basename(agent.path), agent.name]));
  const collisions: { file: File; existingName: string }[] = [];
  for (const file of picked) {
    const existingName = byBasename.get(file.name);
    if (existingName !== undefined) collisions.push({ file, existingName });
  }
  return collisions;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/** Built-in or project file, for the profile list badges. */
export function profileOrigin(profile: PublicProfileWire): 'Built-in' | 'Project' {
  return profile.builtin ? 'Built-in' : 'Project';
}
