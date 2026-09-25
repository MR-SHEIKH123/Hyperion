/**
 * Per-project rules, agent profiles and declared commands.
 *
 * The public listing functions return metadata for frontend discoverability. The
 * runtime resolvers use the same parser but retain Markdown bodies, so the agent
 * cannot apply a different interpretation of a project file than the UI shows.
 *
 * All three kinds are the same shape on disk — a directory of Markdown files that
 * describe themselves in front matter — so there is one scanner and one parser,
 * and each kind only declares which extra front-matter keys it cares about.
 *
 * Rules additionally follow a fallback chain, because a project that keeps its
 * instructions in one root file should not have to grow a directory to be read:
 *
 *     .hyperion/rules/  →  HYPERION.md
 *
 * The first location that exists wins, and the winner is reported in `source` so
 * the UI can say *where* the active rules came from rather than implying an empty
 * project. Falling through on absence is the specified behaviour; falling through
 * on a permission error is not, so only ENOENT/ENOTDIR is treated as "absent".
 */

import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveInScope } from '../../security/fsScope.ts';
import { parsePermissionRules } from '../agent/permissions.ts';
import { profileFields } from '../agent/profiles.ts';
import { AppError } from '../../util/errors.ts';
import { compileGlob, normalizeGlob } from '../../util/glob.ts';
import {
  clamp,
  firstString,
  parseMarkdownHead,
  parseSimpleYaml,
  splitFrontMatter,
  stringList,
} from '../../util/frontmatter.ts';

import type { AgentProfile } from '../../types/core.ts';
import type { PermissionRule } from '../../types/core.ts';

/** Where a project's rules were actually found. */
export type RulesSource = 'hyperion' | 'hyperion-md' | 'none';

export interface ContextEntry {
  /** Front-matter `name`, else the first Markdown heading, else the filename. */
  name: string;
  description: string | null;
  /** Path relative to the project directory, for the UI to show on hover. */
  path: string;
}

export interface RuleEntry extends ContextEntry {
  /** A `scope:`/`applies_to:` glob, when the rule declares one. */
  scope: string | null;
}

export interface MatchedRuleEntry extends RuleEntry {
  /** Whether this rule applies to at least one supplied project-relative path. */
  matched: boolean;
}

export interface AgentEntry extends ContextEntry {
  /** Declared tool preference — `tools: [read, bash]` or `tool: bash`. */
  tools: string[] | null;
  /** Declared model preference, verbatim. */
  model: string | null;
}

export interface RulesListing {
  source: RulesSource;
  rules: RuleEntry[];
}

export interface MatchedRulesListing {
  source: RulesSource;
  /** True only when at least one path was supplied and matching was performed. */
  scopeEnforced: boolean;
  rules: MatchedRuleEntry[];
}

export interface RuntimeRule extends MatchedRuleEntry {
  body: string;
}

export interface RuntimeRules {
  source: RulesSource;
  scopeEnforced: boolean;
  rules: RuntimeRule[];
}

/**
 * The Code agent's own tool set.
 *
 * Still a closed union, and still useful — Code's dispatcher switches on it and
 * its schemas are keyed by it. What changed in 1.27 is that a *profile's* declared
 * `tools` is no longer typed as this: the permission engine is cross-tool, so a
 * profile may name a Cowork tool or an MCP tool, and neither is knowable here.
 * Validation moved to `assertKnownTools`, against the tool set the running agent
 * actually registered.
 */
export type CodeToolName =
  | 'read'
  | 'write'
  | 'restore'
  | 'bash'
  | 'command'
  | 'delegate';

export type { AgentProfile } from '../../types/core.ts';

export interface DeclaredCommand extends ContextEntry {
  /** The only text that may be passed to the terminal executor. */
  run: string;
  timeoutMs: number | null;
}

/**
 * Resolves a project path inside the caller's already-established boundary.
 *
 * HTTP discovery always uses the active `projects` scope. A live Code task is
 * different: it is deliberately contained in one task worktree, so its runtime
 * prompt must read project context through that narrower resolver rather than
 * accidentally falling back to the active checkout.
 */
export type ProjectContextResolver = (candidate: string) => string;

const NAME_MAX = 80;
const DESCRIPTION_MAX = 200;
const RELEVANT_PATH_LIMIT = 128;
const COMMAND_TIMEOUT_MIN_MS = 100;
const COMMAND_TIMEOUT_MAX_MS = 10 * 60 * 1000;

/**
 * Rules for a project, following the fallback chain described above.
 *
 * `source` is `'none'` only when no location exists at all; a directory that
 * exists but holds no Markdown still reports its own source, because "you have a
 * rules directory and it is empty" and "you have no rules directory" are
 * different things to show the user.
 */
export async function listProjectRules(projectDir: string): Promise<RulesListing> {
  const root = resolveInScope('projects', projectDir);
  const listing = await readRules(root);
  return { source: listing.source, rules: listing.rules.map(toRule) };
}

/** Return rule metadata annotated with whether each rule applies to the task. */
export async function matchProjectRules(
  projectDir: string,
  relevantPaths: string[] = [],
): Promise<MatchedRulesListing> {
  const root = resolveInScope('projects', projectDir);
  const paths = normalizeRelevantPaths(root, relevantPaths);
  const scopeEnforced = paths.length > 0;
  const listing = await readRules(root);
  return {
    source: listing.source,
    scopeEnforced,
    rules: listing.rules.map((parsed) => {
      const rule = toRule(parsed);
      return { ...rule, matched: rule.scope === null || (scopeEnforced && matchesScope(rule.scope, paths)) };
    }),
  };
}

/** Load only the active rule bodies, retaining the same matching semantics as the UI. */
export async function loadProjectRules(
  projectDir: string,
  relevantPaths: string[] = [],
  resolveProjectPath?: ProjectContextResolver,
): Promise<RuntimeRules> {
  const root = projectRoot(projectDir, resolveProjectPath);
  const paths = normalizeRelevantPaths(root, relevantPaths, resolveProjectPath);
  const scopeEnforced = paths.length > 0;
  const listing = await readRules(root);
  return {
    source: listing.source,
    scopeEnforced,
    rules: listing.rules
      .map((parsed) => {
        const rule = toRule(parsed);
        return {
          ...rule,
          matched: rule.scope === null || (scopeEnforced && matchesScope(rule.scope, paths)),
          body: parsed.body,
        };
      })
      .filter((rule) => rule.matched),
  };
}

/** Agents declared in `.hyperion/agents/`. Absent directory lists as empty. */
export async function listProjectAgents(projectDir: string): Promise<AgentEntry[]> {
  const root = resolveInScope('projects', projectDir);
  const found = await scanDirectory(join(root, '.hyperion', 'agents'), '.hyperion/agents');
  return (found ?? []).map((parsed) => ({
    name: parsed.name,
    description: parsed.description,
    path: parsed.path,
    tools: stringList(parsed.raw, ['tools', 'tool', 'allowed_tools']),
    model: firstString(parsed.raw, ['model', 'preferred_model']),
  }));
}

/** Commands declared in `.hyperion/commands/`. Absent directory lists as empty. */
export async function listProjectCommands(projectDir: string): Promise<ContextEntry[]> {
  const root = resolveInScope('projects', projectDir);
  const found = await scanDirectory(join(root, '.hyperion', 'commands'), '.hyperion/commands');
  return (found ?? []).map((parsed) => ({
    name: parsed.name,
    description: parsed.description,
    path: parsed.path,
  }));
}

/** Resolve one declared agent by name, path, filename or filename stem. */
export async function loadAgentProfile(
  projectDir: string,
  selector: string,
  resolveProjectPath?: ProjectContextResolver,
): Promise<AgentProfile> {
  const root = projectRoot(projectDir, resolveProjectPath);
  const parsed = selectContextFile(await scanDirectory(join(root, '.hyperion', 'agents'), '.hyperion/agents'), selector, 'agent');
  return toProfile(parsed);
}

/** Every declared agent, parsed as a full profile. Absent directory lists as empty. */
export async function loadProjectProfiles(
  projectDir: string,
  resolveProjectPath?: ProjectContextResolver,
): Promise<AgentProfile[]> {
  const root = projectRoot(projectDir, resolveProjectPath);
  const found = await scanDirectory(join(root, '.hyperion', 'agents'), '.hyperion/agents');
  return (found ?? []).map(toProfile);
}

/**
 * A parsed `.hyperion/agents/*.md` as a profile.
 *
 * The permission-relevant keys are read by `profiles.ts` so a profile's shape is
 * defined once; the file scanning stays here, where every other `.hyperion/` file
 * kind is read.
 */
function toProfile(parsed: ParsedFile): AgentProfile {
  return {
    name: parsed.name,
    description: parsed.description,
    path: parsed.path,
    model: firstString(parsed.raw, ['model', 'preferred_model']),
    builtin: false,
    body: parsed.body,
    ...profileFields(parsed.raw, parsed.name),
  };
}

/**
 * Project-wide permission rules from `.hyperion/permissions.json`.
 *
 * Real JSON rather than front matter, unlike every other `.hyperion/` file kind,
 * and the difference is not inconsistency for its own sake: a permission block is
 * a nested map (`{"write": {"src/**": "allow"}}`) and `parseSimpleYaml` handles
 * only flat scalars. A profile embeds the same JSON in one front-matter scalar for
 * the same reason — see `D15` — so a user learns one syntax, not two.
 *
 * An absent file is `{}`, not an error: most projects declare nothing and fall
 * through to the profile's own rules. A *malformed* file is a hard failure,
 * because the alternative is running with permissions the user believes they
 * configured and did not.
 */
export async function loadProjectPermissions(
  projectDir: string,
  resolveProjectPath?: ProjectContextResolver,
): Promise<Record<string, PermissionRule>> {
  const root = projectRoot(projectDir, resolveProjectPath);
  const text = await readIfPresent(join(root, '.hyperion', 'permissions.json'));
  if (text === null) return {};

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AppError('bad_request', '.hyperion/permissions.json is not valid JSON.', {
      details: { field: 'permissions', path: '.hyperion/permissions.json' },
    });
  }
  return parsePermissionRules(value, '.hyperion/permissions.json');
}

/** Resolve a command without ever treating its Markdown body as executable text. */
export async function resolveDeclaredCommand(
  projectDir: string,
  selector: string,
  resolveProjectPath?: ProjectContextResolver,
): Promise<DeclaredCommand> {
  const root = projectRoot(projectDir, resolveProjectPath);
  const parsed = selectContextFile(await scanDirectory(join(root, '.hyperion', 'commands'), '.hyperion/commands'), selector, 'command');
  const run = firstString(parsed.raw, ['run']);
  if (run === null) {
    throw new AppError('bad_request', `Command "${parsed.name}" does not declare run:.`, {
      details: { field: 'run', path: parsed.path },
    });
  }
  const timeoutRaw = firstString(parsed.raw, ['timeout', 'timeout_ms']);
  let timeoutMs: number | null = null;
  if (timeoutRaw !== null) {
    const parsedTimeout = Number(timeoutRaw);
    if (!Number.isInteger(parsedTimeout) || parsedTimeout < COMMAND_TIMEOUT_MIN_MS || parsedTimeout > COMMAND_TIMEOUT_MAX_MS) {
      throw new AppError('bad_request', 'Command timeout must be an integer between 100 and 600000 milliseconds.', {
        details: { field: 'timeout_ms', path: parsed.path },
      });
    }
    timeoutMs = parsedTimeout;
  }
  return {
    name: parsed.name,
    description: parsed.description,
    path: parsed.path,
    run,
    timeoutMs,
  };
}

// --- the one shared scan ---------------------------------------------------

interface ParsedFile extends ContextEntry {
  /** Every front-matter key, so each kind can pull the ones it cares about. */
  raw: Record<string, string | string[]>;
  /** Markdown after front matter, retained for runtime prompt injection only. */
  body: string;
}

function toRule(parsed: ParsedFile): RuleEntry {
  return {
    name: parsed.name,
    description: parsed.description,
    path: parsed.path,
    scope: firstString(parsed.raw, ['scope', 'applies_to', 'appliesto', 'paths', 'glob']),
  };
}

async function readRules(root: string): Promise<{ source: RulesSource; rules: ParsedFile[] }> {
  const hyperion = await scanDirectory(join(root, '.hyperion', 'rules'), '.hyperion/rules');
  if (hyperion !== null) return { source: 'hyperion', rules: hyperion };
  const rootFile = await readIfPresent(join(root, 'HYPERION.md'));
  if (rootFile !== null) {
    return { source: 'hyperion-md', rules: [parseContextFile('HYPERION.md', 'HYPERION.md', rootFile)] };
  }
  return { source: 'none', rules: [] };
}

function projectRoot(projectDir: string, resolveProjectPath?: ProjectContextResolver): string {
  return resolveProjectPath ? resolveProjectPath(projectDir) : resolveInScope('projects', projectDir);
}

function normalizeRelevantPaths(
  root: string,
  relevantPaths: string[],
  resolveProjectPath?: ProjectContextResolver,
): string[] {
  if (relevantPaths.length > RELEVANT_PATH_LIMIT) {
    throw new AppError('bad_request', `At most ${RELEVANT_PATH_LIMIT} relevant paths may be supplied.`, {
      details: { field: 'path' },
    });
  }
  return relevantPaths.map((candidate) => {
    if (candidate.includes('\0') || candidate.trim() === '') {
      throw new AppError('bad_request', 'Relevant paths must be non-empty and NUL-free.', {
        details: { field: 'path' },
      });
    }
    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
    const contained = resolveProjectPath
      ? resolveProjectPath(absolute)
      : resolveInScope('projects', absolute);
    const relativePath = relative(root, contained).split(sep).join('/');
    if (relativePath === '' || relativePath === '..' || relativePath.startsWith('../')) {
      throw new AppError('scope_violation', `Relevant path escapes the project: ${candidate}.`);
    }
    return relativePath;
  });
}

/**
 * The glob engine is shared with the permission engine (`util/glob.ts`) rather
 * than duplicated here. A rule's `scope:` and a permission rule's path pattern
 * are the same syntax as far as the user is concerned, and two engines would
 * eventually disagree about what `src/**` covers.
 */
function matchesScope(scope: string, paths: string[]): boolean {
  const matcher = compileGlob(normalizeGlob(scope, 'scope'));
  return paths.some((path) => matcher.test(path));
}

function selectContextFile(
  files: ParsedFile[] | null,
  selector: string,
  kind: 'agent' | 'command',
): ParsedFile {
  const normalized = selector.trim().replace(/\\/g, '/');
  if (normalized === '') {
    throw new AppError('bad_request', `${kind} selector must not be empty.`, { details: { field: 'selector' } });
  }
  const matches = (files ?? []).filter((file) => {
    const filename = file.path.slice(file.path.lastIndexOf('/') + 1);
    const stem = filename.replace(/\.md$/i, '');
    return file.name === normalized || file.path === normalized || filename === normalized || stem === normalized;
  });
  if (matches.length === 0) {
    throw new AppError('not_found', `No ${kind} named "${selector}" was found.`, {
      details: { field: 'selector', value: selector },
    });
  }
  if (matches.length > 1) {
    throw new AppError('bad_request', `The ${kind} selector "${selector}" is ambiguous.`, {
      details: { field: 'selector', matches: matches.map((match) => match.path) },
    });
  }
  const match = matches[0];
  if (!match) throw new AppError('internal_error', `Resolved ${kind} selector disappeared.`);
  return match;
}

/**
 * Read every Markdown file in a directory, sorted by filename so the UI order is
 * stable across calls. Returns `null` — distinct from `[]` — when the directory
 * does not exist, which is what lets the rules fallback chain tell "absent" from
 * "present but empty".
 */
async function scanDirectory(dir: string, relativeDir: string): Promise<ParsedFile[] | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }

  const names = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const parsed: ParsedFile[] = [];
  for (const name of names) {
    const text = await readIfPresent(join(dir, name));
    // A file listed a moment ago can be gone by the time it is read; that is a
    // race, not a failure worth turning the whole listing into an error.
    if (text === null) continue;
    parsed.push(parseContextFile(name, `${relativeDir}/${name}`, text));
  }
  return parsed;
}

/**
 * One profile document's bytes, parsed the way the directory scan parses them.
 *
 * Exported so the import route validates uploads through the identical parser
 * that will read them back: an import the scanner cannot read is a file the
 * user filed and the app cannot see. `parseContextFile` below is this plus the
 * relative path, and the two cannot drift because one calls the other.
 */
export interface ParsedProfileDocument {
  name: string;
  description: string | null;
  raw: Record<string, string | string[]>;
  body: string;
}

export function parseProfileDocument(filename: string, text: string): ParsedProfileDocument {
  const { front, body } = splitFrontMatter(text);
  const raw = front ? parseSimpleYaml(front) : {};

  let name = firstString(raw, ['name', 'title', 'rule', 'agent', 'command', 'id']);
  let description = firstString(raw, ['description', 'summary', 'about']);

  if (!name || !description) {
    const head = parseMarkdownHead(body);
    if (!name) name = head.name;
    if (!description) description = head.description;
  }

  return {
    // A file that declares nothing still has to list as *something* the user can
    // recognise, and its filename is what they named it.
    name: clamp(name ?? filenameToName(filename), NAME_MAX),
    description: description === null ? null : clamp(description, DESCRIPTION_MAX),
    raw,
    body,
  };
}

function parseContextFile(filename: string, relativePath: string, text: string): ParsedFile {
  const doc = parseProfileDocument(filename, text);
  return {
    name: doc.name,
    description: doc.description,
    path: relativePath,
    raw: doc.raw,
    body: doc.body,
  };
}

function filenameToName(filename: string): string {
  return filename.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim() || filename;
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * Absence, specifically — not "any error". A directory we are forbidden to read
 * is a real problem the user should hear about, not something to quietly skip
 * past into the next fallback.
 */
function isMissing(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
