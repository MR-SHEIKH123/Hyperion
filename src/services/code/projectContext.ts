/**
 * Per-project rules, agents and commands — listing only.
 *
 * These back three read-only endpoints that exist for the *frontend's*
 * discoverability needs: enough to populate a dropdown or an "N rules active"
 * indicator. The agent's own loading logic reads these files directly through its
 * filesystem access and does not go through here, which is why nothing below
 * returns a file body.
 *
 * All three kinds are the same shape on disk — a directory of Markdown files that
 * describe themselves in front matter — so there is one scanner and one parser,
 * and each kind only declares which extra front-matter keys it cares about.
 *
 * Rules additionally follow a fallback chain, because a project that predates
 * this convention already carries its instructions somewhere:
 *
 *     .hyperion/rules/  →  CLAUDE.md  →  .claude/rules/
 *
 * The first location that exists wins, and the winner is reported in `source` so
 * the UI can say *where* the active rules came from rather than implying an empty
 * project. Falling through on absence is the specified behaviour; falling through
 * on a permission error is not, so only ENOENT/ENOTDIR is treated as "absent".
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveInScope } from '../../security/fsScope.ts';
import {
  clamp,
  firstString,
  parseMarkdownHead,
  parseSimpleYaml,
  splitFrontMatter,
  stringList,
} from '../../util/frontmatter.ts';

/** Where a project's rules were actually found. */
export type RulesSource = 'hyperion' | 'claude-md' | 'claude-dir' | 'none';

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

const NAME_MAX = 80;
const DESCRIPTION_MAX = 200;

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

  const hyperion = await scanDirectory(join(root, '.hyperion', 'rules'), '.hyperion/rules');
  if (hyperion) return { source: 'hyperion', rules: hyperion.map(toRule) };

  const claudeMd = await readIfPresent(join(root, 'CLAUDE.md'));
  if (claudeMd !== null) {
    return { source: 'claude-md', rules: [toRule(parseContextFile('CLAUDE.md', 'CLAUDE.md', claudeMd))] };
  }

  const claudeDir = await scanDirectory(join(root, '.claude', 'rules'), '.claude/rules');
  if (claudeDir) return { source: 'claude-dir', rules: claudeDir.map(toRule) };

  return { source: 'none', rules: [] };
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

// --- the one shared scan ---------------------------------------------------

interface ParsedFile extends ContextEntry {
  /** Every front-matter key, so each kind can pull the ones it cares about. */
  raw: Record<string, string | string[]>;
}

function toRule(parsed: ParsedFile): RuleEntry {
  return {
    name: parsed.name,
    description: parsed.description,
    path: parsed.path,
    scope: firstString(parsed.raw, ['scope', 'applies_to', 'appliesto', 'paths', 'glob']),
  };
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

function parseContextFile(filename: string, relativePath: string, text: string): ParsedFile {
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
    path: relativePath,
    raw,
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
