/**
 * Agent profiles: the built-in three, and the ones a project authors.
 *
 * 1.27 reframes Ask/Plan/Act as *profiles* rather than modes. The point is not
 * cosmetic: a mode was a fixed branch in the dispatcher, so "read anywhere, write
 * only under `src/`, ask before `bash`" was unsayable. A profile is a named set
 * of permission rules plus a model, a reasoning level and a prompt, so the three
 * familiar names become the first three entries in an open list.
 *
 * ## The built-ins reproduce today's gate exactly
 *
 * This is the load-bearing constraint, not a nicety. `test/agentloop.test.ts` is
 * the safety net for the whole reframe: if Ask/Plan/Act stop meaning what they
 * meant, the change is not a refactor, and every user who never opens this
 * feature silently gets different behaviour from the same UI control.
 *
 * So `ask` denies everything, `plan` allows reads and refuses changes, and `act`
 * allows everything — subject, as always, to the project and session layers.
 *
 * Two consequences of that are worth stating, because both are places where the
 * obvious "improvement" is a regression:
 *
 * **`plan` cannot enumerate tool names.** Which tools only read is a fact about
 * the agent, not about the profile: Code has `read`, Cowork has `wigolo.search`,
 * and an MCP server the user adds tomorrow has whatever it has. A built-in that
 * listed names would have denied `wigolo.search` in Plan mode the moment Cowork
 * joined the engine. Hence `*:read` / `*:mutate`, which defer to the agent's own
 * `ToolPolicy` — see `permissions.ts`.
 *
 * **`ask` does not allow a "read-only" `bash` allowlist.** A glob over a shell
 * command line is not a security boundary: `git status*` matches
 * `git status; rm -rf /`, and every `;`, `&&`, backtick and `$( )` is another way
 * through. Granting shell access from a profile whose entire promise is "runs
 * nothing" needs a command parser, not a pattern, and that is not what this
 * feature is. A user who wants read-only shell in a question-answering profile can
 * author one — which is precisely the capability being added here.
 *
 * ## How a profile is chosen
 *
 * `input.options.profile` → the mode's built-in for `ask`/`plan` → the
 * `default_agent_profile` setting → the `act` built-in.
 *
 * `ask` and `plan` deliberately outrank the stored default. They are explicit,
 * per-run choices to restrict what happens, and a stored setting that could widen
 * them would make a safety control advisory. The setting therefore customizes
 * what *Act* means, which is the case where the user has already said "go ahead"
 * and a stricter house default is useful rather than surprising.
 */

import { getSetting } from '../../db/settings.ts';
import { AppError } from '../../util/errors.ts';
import { firstString, stringList } from '../../util/frontmatter.ts';
import { ANY_MUTATE, ANY_READ, ANY_TOOL, parsePermissionScalar } from './permissions.ts';

import type {
  AgentMode,
  AgentProfile,
  PermissionRule,
  ProfileVisibility,
  ReasoningVariant,
  TaskInput,
} from '../../types/core.ts';
import { DESIGN_TOOL_NAMES } from '../design/tools.ts';
import type { PermissionLayerInput, PermissionRules } from './permissions.ts';

export const DEFAULT_AGENT_PROFILE_KEY = 'default_agent_profile';

/** How many project profiles a listing will return. */
export const PROFILE_LIST_MAX = 200;

function builtin(
  name: AgentMode,
  description: string,
  permissions: PermissionRules,
  body: string,
): AgentProfile {
  return Object.freeze({
    name,
    description,
    path: '',
    tools: null,
    model: null,
    mode: name,
    visibility: 'all' as ProfileVisibility,
    hidden: false,
    variant: null,
    permissions,
    builtin: true,
    body,
  });
}

/**
 * The three in-code profiles.
 *
 * Frozen and non-deletable. A user can shadow one by authoring a project profile
 * under a different name, but not edit these — a permission baseline that can be
 * rewritten in place is a baseline that can be quietly removed, and every
 * verdict's provenance is meaningless if `builtin` does not mean a known thing.
 */
export const BUILTIN_PROFILES: readonly AgentProfile[] = Object.freeze([
  builtin(
    'ask',
    'Answers questions and runs nothing.',
    { [ANY_TOOL]: 'deny' },
    'You are in Ask mode. You answer questions and run no tools. Describe what you would do; ' +
      'if the user needs work performed, tell them to switch to Plan or Act.',
  ),
  builtin(
    'plan',
    'Reads freely, changes nothing, and collects a plan for approval.',
    { [ANY_READ]: 'allow', [ANY_MUTATE]: 'deny' },
    'You are in Plan mode. Read whatever you need. Anything that would change something is ' +
      'recorded as a planned action for the user to approve rather than performed.',
  ),
  builtin(
    'act',
    'Full access, still subject to project and session rules.',
    { [ANY_TOOL]: 'allow' },
    'You are in Act mode and may use every tool offered to you.',
  ),
  /** Design is not a mode: its base mode is Act and its tools list is the
   * closed design toolset. The profile exists so a design run is identifiable
   * in provenance and the allow-list is data rather than convention — and the
   * list doubles as a guard: selected for any other agent, `assertKnownTools`
   * rejects it, because no design tool exists there. */
  Object.freeze({
    name: 'design',
    description: 'Iterative HTML/CSS and SVG design with brand memory; no shell, filesystem or delegation reach.',
    path: '',
    tools: [...DESIGN_TOOL_NAMES],
    model: null,
    mode: 'act',
    visibility: 'all' as ProfileVisibility,
    hidden: false,
    variant: null,
    permissions: {},
    builtin: true,
    body: 'You are working through the Design agent: iterative HTML/CSS and SVG, a closed toolset, and brand assets that are canonical only once the user has approved them.',
  }),
]);

export function builtinProfile(name: string): AgentProfile | null {
  return BUILTIN_PROFILES.find((profile) => profile.name === name) ?? null;
}

/**
 * Loads the project profiles for one project directory.
 *
 * Supplied by the caller rather than imported, because a live Code task must read
 * its profiles through that task's worktree resolver and not through the active
 * checkout — the same reason `ProjectContextResolver` exists.
 */
export interface ProfileSource {
  load(selector: string): Promise<AgentProfile>;
  list(): Promise<AgentProfile[]>;
}

/**
 * The stored default, or null when unset.
 *
 * Null rather than `'act'` so "the user has chosen nothing" stays distinguishable
 * from "the user has chosen Act". The two behave identically today and would stop
 * doing so the moment the `act` built-in's baseline changed.
 */
export function defaultAgentProfileName(): string | null {
  const raw = getSetting(DEFAULT_AGENT_PROFILE_KEY);
  return raw !== null && raw.trim() !== '' ? raw.trim() : null;
}

export interface ResolveProfileInput {
  mode: AgentMode;
  /** `input.options.profile`, when the request named one. */
  selector?: string | undefined;
  /** Absent for an agent with no project directory; only built-ins resolve then. */
  source?: ProfileSource | undefined;
  /** True for a delegated child, which may select a `subagent`-only profile. */
  forSubagent?: boolean;
}

/**
 * Pick the profile this run will use.
 *
 * A named selector is resolved against the project first and the built-ins
 * second, so a project can shadow `act` with its own house rules by naming a file
 * `act.md`. An unresolvable name is a `not_found` rather than a silent fallback:
 * running a task under different permissions from the ones the caller asked for
 * is the one outcome nobody wants.
 */
export async function resolveProfile(input: ResolveProfileInput): Promise<AgentProfile> {
  if (input.selector !== undefined) {
    const profile = await selectByName(input.selector, input.source);
    if (profile.visibility === 'subagent' && input.forSubagent !== true) {
      throw new AppError('bad_request', `The profile "${profile.name}" may only be used by a subagent.`, {
        details: { field: 'options.profile', value: input.selector },
      });
    }
    return profile;
  }

  // Ask and Plan are explicit restrictions. See the header: a stored default that
  // could widen them would make them advisory.
  if (input.mode !== 'act') return requireBuiltin(input.mode);

  const stored = defaultAgentProfileName();
  if (stored !== null) {
    const profile = await selectByName(stored, input.source);
    // A stored default naming a subagent-only profile is a misconfiguration, not
    // a request error, and must not break every run until it is noticed.
    if (profile.visibility !== 'subagent') return profile;
  }
  return requireBuiltin('act');
}

async function selectByName(selector: string, source: ProfileSource | undefined): Promise<AgentProfile> {
  if (source !== undefined) {
    try {
      return await source.load(selector);
    } catch (error) {
      // Only "there is no such project profile" falls through to the built-ins.
      // A malformed file is a real failure the user has to see, and swallowing it
      // would run the task under `act` because their profile did not parse.
      if (!(error instanceof AppError) || error.code !== 'not_found') throw error;
    }
  }
  const fallback = builtinProfile(selector);
  if (fallback !== null) return fallback;
  throw new AppError('not_found', `No agent profile named "${selector}" was found.`, {
    details: { field: 'options.profile', value: selector },
  });
}

function requireBuiltin(name: AgentMode): AgentProfile {
  const profile = builtinProfile(name);
  if (profile === null) throw new AppError('internal_error', `Built-in profile "${name}" is missing.`);
  return profile;
}

/** The profile selector a task input names, if any. */
export function profileSelector(input: TaskInput): string | undefined {
  const value = input.options?.profile;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('bad_request', 'options.profile must be a non-empty string.', {
      details: { field: 'options.profile' },
    });
  }
  return value.trim();
}

/**
 * Built-ins plus a project's own, for `GET /api/settings/agent-profiles`.
 *
 * `hidden` filters the listing and nothing else — it never affects resolution, so
 * a hidden profile stays usable by name. The two flags are independent by design
 * (1.28 §3): `visibility` says who may select a profile, `hidden` says whether to
 * put it in a menu, and a personal shortcut is a real reason to want the second
 * without the first.
 */
export async function listProfiles(
  source: ProfileSource | undefined,
  options: { includeHidden?: boolean } = {},
): Promise<AgentProfile[]> {
  const project = source === undefined ? [] : await source.list();
  const all = [...BUILTIN_PROFILES, ...project.slice(0, PROFILE_LIST_MAX)];
  return options.includeHidden === true ? all : all.filter((profile) => !profile.hidden);
}

// --- front-matter parsing ----------------------------------------------------

const AGENT_MODES: readonly AgentMode[] = ['ask', 'plan', 'act'];
const VISIBILITIES: readonly ProfileVisibility[] = ['primary', 'subagent', 'all'];
const VARIANTS: readonly ReasoningVariant[] = ['low', 'medium', 'high'];

/**
 * Read the profile-specific keys out of an already-parsed front-matter block.
 *
 * Lives here rather than in `projectContext.ts` so the shape of a profile is
 * defined in one place, and is called from there so the file scanning stays where
 * every other `.hyperion/` file kind is read.
 *
 * A boolean is read leniently (`true`/`yes`/`1`) because front matter is
 * hand-written; an unknown enum value is rejected, because silently ignoring
 * `visibility: subagnet` grants a profile to the primary picker that its author
 * meant to withhold.
 */
export function profileFields(
  raw: Record<string, string | string[]>,
  name: string,
): Pick<AgentProfile, 'mode' | 'visibility' | 'hidden' | 'variant' | 'permissions' | 'tools'> {
  const rawPermissions = firstString(raw, ['permissions', 'permission']);
  return {
    mode: enumField(raw, ['mode', 'base_mode'], AGENT_MODES, 'act', name, 'mode'),
    visibility: enumField(raw, ['visibility'], VISIBILITIES, 'primary', name, 'visibility'),
    hidden: boolField(raw, ['hidden']),
    variant: enumField(raw, ['variant', 'reasoning', 'reasoning_effort'], VARIANTS, null, name, 'variant'),
    permissions:
      rawPermissions === null ? null : parsePermissionScalar(rawPermissions, `${name}.permissions`),
    tools: stringList(raw, ['tools', 'tool', 'allowed_tools']),
  };
}

function enumField<T extends string, F extends T | null>(
  raw: Record<string, string | string[]>,
  keys: string[],
  allowed: readonly T[],
  fallback: F,
  profileName: string,
  field: string,
): T | F {
  const value = firstString(raw, keys);
  if (value === null) return fallback;
  const normalized = value.toLowerCase();
  const match = allowed.find((candidate) => candidate === normalized);
  if (match === undefined) {
    throw new AppError('bad_request', `Agent profile "${profileName}" declares an unknown ${field}.`, {
      details: { field, value, allowed },
    });
  }
  return match;
}

function boolField(raw: Record<string, string | string[]>, keys: string[]): boolean {
  const value = firstString(raw, keys);
  if (value === null) return false;
  const normalized = value.toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === '1';
}

/**
 * Reject a profile that names a tool the agent does not register.
 *
 * This is the runtime check that replaces the compile-time `CodeToolName[]` the
 * profile's `tools` used to carry. It is strictly better placed: the old check
 * could never have validated an MCP tool name, because those are not known until
 * a server is configured.
 */
export function assertKnownTools(profile: AgentProfile, knownTools: ReadonlySet<string>): void {
  if (profile.tools === null) return;
  for (const tool of profile.tools) {
    if (!knownTools.has(tool)) {
      throw new AppError('bad_request', `Agent profile "${profile.name}" declares an unknown tool.`, {
        details: { field: 'tools', value: tool, known: [...knownTools] },
      });
    }
  }
}

/** The rules a profile contributes to the `profile` layer. */
export function profileRules(profile: AgentProfile): PermissionRules {
  // A built-in's rules *are* the builtin layer; contributing them twice would
  // make the provenance of every verdict read `profile` when nothing but a
  // built-in was in force.
  if (profile.builtin) return {};

  const declared: PermissionRules = { ...(profile.permissions ?? {}) };
  if (profile.tools === null) return declared;

  // A declared tool list is itself a permission statement: naming three tools
  // means the other tools are not for this profile. Expressing it as rules keeps
  // the refusal legible — the verdict names the `profile` layer rather than
  // surfacing as a bare "unknown tool" from the runner.
  const rules: PermissionRules = {};
  for (const tool of profile.tools) if (declared[tool] === undefined) rules[tool] = 'allow';
  const catchAll: PermissionRule = 'deny';
  return { ...rules, [ANY_TOOL]: catchAll, ...declared };
}

/**
 * The layer stack for one run, in evaluation order.
 *
 * The `builtin` layer is always the baseline of the profile's *base mode*, not of
 * the profile itself. That is what makes a project profile a specialization: one
 * declaring `mode: plan` and `permissions: {"write": {"docs/**": "allow"}}` starts
 * from Plan's read-only baseline and opens exactly one hole in it, rather than
 * starting from nothing and having to re-derive what Plan meant.
 */
export function permissionLayers(input: {
  profile: AgentProfile;
  project?: PermissionRules | undefined;
  session?: PermissionRules | undefined;
  inherited?: PermissionRules | undefined;
}): PermissionLayerInput[] {
  const base = requireBuiltin(input.profile.mode);
  const layers: PermissionLayerInput[] = [{ layer: 'builtin', rules: base.permissions ?? {} }];

  const own = profileRules(input.profile);
  if (Object.keys(own).length > 0) layers.push({ layer: 'profile', rules: own });
  if (input.project !== undefined) layers.push({ layer: 'project', rules: input.project });
  if (input.session !== undefined) layers.push({ layer: 'session', rules: input.session });
  // Last, always. `evaluate` relies on the inherited ceiling being evaluated
  // after every layer that might have widened something.
  if (input.inherited !== undefined) layers.push({ layer: 'inherited', rules: input.inherited });
  return layers;
}
