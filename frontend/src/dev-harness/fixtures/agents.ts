import type {
  PermissionsWire,
  ProfileImportWire,
  ProjectAgentWire,
  ProjectCommandWire,
  PublicProfileWire,
} from '../../contracts/wire/agents';

/**
 * Agents and permissions fixtures for the dev harness (Settings 2.5,
 * slice 4), typed against the wire schemas. A hidden profile and a
 * subagent-only one are included because a listing that only showed the
 * tidy profiles would hide what "include hidden" is for.
 */

export const builtinProfilesFixture: PublicProfileWire[] = [
  {
    name: 'ask',
    description: 'Answers questions and runs nothing.',
    path: null,
    builtin: true,
    mode: 'ask',
    visibility: 'all',
    hidden: false,
    variant: null,
    model: null,
    tools: null,
    permissions: { '*': 'deny' },
  },
  {
    name: 'plan',
    description: 'Reads freely, changes nothing, and collects a plan for approval.',
    path: null,
    builtin: true,
    mode: 'plan',
    visibility: 'all',
    hidden: false,
    variant: null,
    model: null,
    tools: null,
    permissions: null,
  },
  {
    name: 'act',
    description: 'Full access, still subject to project and session rules.',
    path: null,
    builtin: true,
    mode: 'act',
    visibility: 'all',
    hidden: false,
    variant: null,
    model: null,
    tools: null,
    permissions: { '*': 'allow' },
  },
];

export const profilesFixture: PublicProfileWire[] = [
  ...builtinProfilesFixture,
  {
    name: 'reviewer',
    description: 'Reviews diffs and leaves comments, never edits.',
    path: '.hyperion/agents/reviewer.md',
    builtin: false,
    mode: 'plan',
    visibility: 'primary',
    hidden: false,
    variant: 'high',
    model: null,
    tools: ['read', 'bash'],
    permissions: { write: 'deny' },
  },
  {
    name: 'night-owl',
    description: 'Personal shortcut profile.',
    path: '.hyperion/agents/night-owl.md',
    builtin: false,
    mode: 'act',
    visibility: 'all',
    hidden: true,
    variant: null,
    model: 'wire-model',
    tools: null,
    permissions: null,
  },
  {
    name: 'fetcher',
    description: 'Worker that gathers sources for a parent run.',
    path: '.hyperion/agents/fetcher.md',
    builtin: false,
    mode: 'act',
    visibility: 'subagent',
    hidden: false,
    variant: null,
    model: null,
    tools: ['read'],
    permissions: null,
  },
];

export const permissionsFixture: PermissionsWire = {
  project: '.',
  mode: 'act',
  profile: { name: 'reviewer', builtin: false, mode: 'plan' },
  layers: [
    { layer: 'builtin', rules: { '*read*': 'allow', '*mutate*': 'deny' } },
    { layer: 'profile', rules: { bash: { 'git *': 'allow', '*': 'ask' }, write: 'deny' } },
    { layer: 'project', rules: { bash: { 'rm -rf *': 'deny' } } },
  ],
};

export const projectAgentsFixture: ProjectAgentWire[] = [
  { name: 'reviewer', description: 'Reviews diffs.', path: '.hyperion/agents/reviewer.md', tools: ['read', 'bash'], model: null },
  { name: 'fetcher', description: null, path: '.hyperion/agents/fetcher.md', tools: ['read'], model: null },
];

export const projectCommandsFixture: ProjectCommandWire[] = [
  { name: 'ship-check', description: 'Runs the release checklist.', path: '.hyperion/commands/ship-check.md' },
];

export const importOutcomeFixture: ProfileImportWire = {
  project: { id: 'proj-1', name: 'Wire project' },
  imported: 2,
  count: 4,
  results: [
    { filename: 'new-helper.md', name: 'new-helper', status: 'imported', path: '.hyperion/agents/new-helper.md' },
    { filename: 'reviewer.md', name: 'reviewer', status: 'renamed', path: '.hyperion/agents/reviewer-2.md' },
    {
      filename: 'fetcher.md',
      name: 'fetcher',
      status: 'skipped',
      error: '"fetcher.md" already exists; re-send with onConflict rename or overwrite to file it anyway.',
    },
    { filename: 'notes.txt', name: null, status: 'invalid', error: 'Only .md files can be imported as agent profiles.' },
  ],
};
