/**
 * Resource link detection: given a URL, classify it as a skill, an MCP server,
 * both, or invalid — without registering anything.
 *
 * The classifier (`classify`) is pure: it takes in-memory file entries and
 * returns a result. `detectResource` wraps it with the network fetch. Keeping
 * them separate means the classifier can be tested against fixtures with no
 * network, and the HTTP handler can call `detectResource` without knowing how
 * the bytes arrived.
 *
 * SKILL detection: strict SKILL.md-only check. The intake path falls back to
 * README.md for a best-effort name, which is correct there. Here it would make
 * nearly every repo look like a skill. Do not change this to match intake.
 *
 * MCP detection: heuristic. One strong signal is enough to classify as
 * mcp-server with confidence "strong"; naming and prose hints alone give
 * "weak". The distinction is surfaced so the frontend can phrase its message
 * with appropriate certainty, and every signal carries the reason it fired so
 * the user is told *why* rather than just being handed a verdict.
 *
 * Nothing here decides anything on the user's behalf. Detection only proposes;
 * registration stays an explicit second step through the skills or MCP routes.
 */
import type { McpServerType } from '../mcp/registry.ts';
import { parseSkillMd } from '../skills/skillmd.ts';
import { fetchArchive, parseUrl } from './archive.ts';
import type { ArchiveEntry } from './archive.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ResourceType = 'skill' | 'mcp-server' | 'both' | 'invalid';
export type Confidence = 'strong' | 'weak' | null;

export interface SkillPreview {
  name: string | null;
  description: string | null;
}

export interface McpPreview {
  /** Best-effort guess at the server name, from package.json or the URL. */
  suggestedName: string | null;
  /** `local` = has a runnable entry point; `remote` = documents a hosted URL. */
  type: McpServerType;
}

export interface DetectResult {
  type: ResourceType;
  /**
   * `strong` when the classification rests on a fixed manifest check or a
   * declared SDK dependency. `weak` when it rests only on naming or prose
   * hints. `null` for `invalid`.
   */
  confidence: Confidence;
  /** Short human-readable explanation of what was found. */
  reason: string;
  /** Present when `type` is `skill` or `both`. */
  skillPreview?: SkillPreview;
  /** Present when `type` is `mcp-server` or `both`. */
  mcpPreview?: McpPreview;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetches `rawUrl` and classifies what it contains.
 *
 * A URL that cannot be fetched is a *classification outcome*, not a request
 * error: 404s, dead hosts, oversized responses and unreadable zips all come
 * back as `{ type: 'invalid' }` with the reason in the message, so the handler
 * can answer 200 and the UI can say "that link doesn't look like anything I can
 * install" instead of surfacing a raw HTTP failure.
 *
 * The one genuine client mistake — a malformed or non-http(s) URL — still
 * throws `AppError('bad_request')`. That is why the URL is validated *before*
 * the fetch: `fetchArchive` reports every failure as `bad_request`, so catching
 * around the whole call and re-throwing on that code would turn every 404 into
 * a 400 and leave the `invalid` branch unreachable.
 */
export async function detectResource(rawUrl: string): Promise<DetectResult> {
  // Throws bad_request for a malformed or non-http(s) URL.
  const url = parseUrl(rawUrl);

  let entries: ArchiveEntry[];
  try {
    ({ entries } = await fetchArchive(url.href));
  } catch (error) {
    // Every fetch/unpack failure is a classification outcome. The messages
    // `fetchArchive` produces already read as explanations.
    return {
      type: 'invalid',
      confidence: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  // Classify against the URL the user gave us, not the resolved codeload URL:
  // `https://codeload.github.com/owner/repo/zip/HEAD` ends in `HEAD`, so naming
  // hints read from it would never see the repository name.
  return classify(entries, url.href);
}

/**
 * Pure classifier: given a flat list of in-memory file entries, return a
 * `DetectResult`. Exported so the detection rules can be tested against
 * fixtures without a network round-trip.
 *
 * `sourceUrl` should be the URL the user supplied; it is only used for naming
 * hints and the suggested server name.
 */
export function classify(entries: ArchiveEntry[], sourceUrl = ''): DetectResult {
  if (entries.length === 0) {
    return { type: 'invalid', confidence: null, reason: 'There were no files at that URL.' };
  }

  const ctx = buildContext(entries, sourceUrl);
  const skillEntry = ctx.skillMd;
  const mcp = detectMcp(ctx);

  if (mcp === null) {
    if (skillEntry === null) {
      return {
        type: 'invalid',
        confidence: null,
        reason:
          'Reachable, but nothing recognisable was found there — no SKILL.md, and no MCP-server indicators.',
      };
    }
    return {
      type: 'skill',
      // SKILL.md is a fixed manifest check, not a heuristic.
      confidence: 'strong',
      reason: 'Contains a SKILL.md.',
      skillPreview: buildSkillPreview(skillEntry),
    };
  }

  if (skillEntry === null) {
    return {
      type: 'mcp-server',
      confidence: mcp.confidence,
      reason: mcp.reason,
      mcpPreview: buildMcpPreview(ctx),
    };
  }

  return {
    type: 'both',
    // The skill half is certain, the MCP half may not be. The combined claim is
    // only as good as its weaker part, so the MCP signal sets the confidence.
    confidence: mcp.confidence,
    reason: `Contains a SKILL.md. ${mcp.reason}`,
    skillPreview: buildSkillPreview(skillEntry),
    mcpPreview: buildMcpPreview(ctx),
  };
}

// ---------------------------------------------------------------------------
// Manifest context
// ---------------------------------------------------------------------------

/**
 * Everything the rules need, decoded and parsed exactly once.
 *
 * Built up front rather than re-read per rule: when each helper found its own
 * files, they drifted apart — some matched only a root-level `package.json`
 * while others matched at any depth — and the same buffer was decoded four
 * times over. One context keeps every rule looking at the same evidence.
 */
interface ManifestContext {
  sourceUrl: string;
  /** Shallowest SKILL.md, or null. */
  skillMd: ArchiveEntry | null;
  /** Text of the shallowest README.md; empty string when there is none. */
  readme: string;
  /** Parsed package.json objects, shallowest first. */
  packages: Record<string, unknown>[];
  /** Text of every requirements*.txt found. */
  requirements: string[];
  /** Text of every pyproject.toml found. */
  pyprojects: string[];
}

const SKILL_MD = /(^|\/)skill\.md$/i;
const README_MD = /(^|\/)readme\.md$/i;
const PACKAGE_JSON = /(^|\/)package\.json$/i;
const REQUIREMENTS_TXT = /(^|\/)requirements[\w.-]*\.txt$/i;
const PYPROJECT_TOML = /(^|\/)pyproject\.toml$/i;

/**
 * Directories whose contents describe someone else's code.
 *
 * A repository that vendors an MCP client into `node_modules/` is not itself an
 * MCP server, and a checked-in `dist/` copy would count the same manifest
 * twice.
 */
const VENDOR_DIR = /(^|\/)(?:node_modules|bower_components|vendor|dist|build|out|\.git|\.venv|venv|site-packages|__pycache__)\//i;

function buildContext(entries: ArchiveEntry[], sourceUrl: string): ManifestContext {
  const readmeEntry = findFiles(entries, README_MD)[0];
  const packages: Record<string, unknown>[] = [];
  for (const entry of findFiles(entries, PACKAGE_JSON)) {
    const parsed = parseJsonObject(entry.data);
    if (parsed !== null) packages.push(parsed);
  }

  return {
    sourceUrl,
    skillMd: findFiles(entries, SKILL_MD)[0] ?? null,
    readme: readmeEntry ? decode(readmeEntry.data) : '',
    packages,
    requirements: findFiles(entries, REQUIREMENTS_TXT).map((e) => decode(e.data)),
    pyprojects: findFiles(entries, PYPROJECT_TOML).map((e) => decode(e.data)),
  };
}

/** Entries matching `pattern`, vendored copies dropped, shallowest first. */
function findFiles(entries: ArchiveEntry[], pattern: RegExp): ArchiveEntry[] {
  return entries
    .filter((entry) => !VENDOR_DIR.test(entry.name) && pattern.test(entry.name))
    .sort((a, b) => {
      const depthA = a.name.split('/').length;
      const depthB = b.name.split('/').length;
      return depthA !== depthB ? depthA - depthB : a.name.length - b.name.length;
    });
}

function decode(data: Buffer): string {
  return data.toString('utf8');
}

function parseJsonObject(data: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(decode(data));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Skill helpers
// ---------------------------------------------------------------------------

function buildSkillPreview(entry: ArchiveEntry): SkillPreview {
  try {
    const manifest = parseSkillMd(decode(entry.data));
    return { name: manifest.name, description: manifest.description };
  } catch {
    // A SKILL.md that won't parse is still a SKILL.md; the user can name it by
    // hand at intake. Losing the preview must not lose the classification.
    return { name: null, description: null };
  }
}

// ---------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------

interface McpSignal {
  confidence: 'strong' | 'weak';
  reason: string;
}

/** Node MCP SDKs. The whole `@modelcontextprotocol` scope counts. */
const NPM_MCP_DEP = /^@modelcontextprotocol\/|^fastmcp$/;

/**
 * An `mcpServers` JSON key, as it appears in a config block a README is telling
 * you to paste. Matching the bare word would fire on any prose that mentions
 * the key in passing, which is a weak hint at best.
 */
const MCP_SERVERS_BLOCK = /["']mcpServers["']\s*:/;

const MCP_MENTION = /\bMCP\b|\bModel Context Protocol\b/i;

/** `mcp` as a whole word inside a hyphen/underscore-separated name. */
const MCP_IN_NAME = /(^|[-_])mcp([-_]|$)/;

/**
 * Strong signals (any one is enough):
 *   - a package.json depending on `@modelcontextprotocol/*` or `fastmcp`
 *   - a requirements.txt / pyproject.toml naming `mcp` or `fastmcp`
 *   - a README documenting an `mcpServers` config block
 *
 * Weak signals (only consulted when no strong signal fired):
 *   - a repository or package name containing `mcp`
 *   - a README that mentions MCP without declaring a dependency
 */
function detectMcp(ctx: ManifestContext): McpSignal | null {
  const npmDep = findNpmMcpDependency(ctx.packages);
  if (npmDep !== null) {
    return { confidence: 'strong', reason: `Depends on the MCP SDK package "${npmDep}".` };
  }

  if (ctx.requirements.some(hasPythonMcpDep) || ctx.pyprojects.some(hasPythonMcpDep)) {
    return { confidence: 'strong', reason: 'Declares the Python MCP SDK as a dependency.' };
  }

  if (MCP_SERVERS_BLOCK.test(ctx.readme)) {
    return {
      confidence: 'strong',
      reason: 'The README documents an "mcpServers" configuration block.',
    };
  }

  if (hasMcpNamingHint(ctx)) {
    return {
      confidence: 'weak',
      reason: 'The name looks like an MCP server, but no SDK dependency was found.',
    };
  }

  if (MCP_MENTION.test(ctx.readme)) {
    return {
      confidence: 'weak',
      reason: 'The README mentions MCP, but no SDK dependency was found.',
    };
  }

  return null;
}

/** The first MCP SDK dependency across every package.json, or null. */
function findNpmMcpDependency(packages: Record<string, unknown>[]): string | null {
  const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  for (const pkg of packages) {
    for (const field of fields) {
      const deps = pkg[field];
      if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) continue;
      for (const name of Object.keys(deps as Record<string, unknown>)) {
        if (NPM_MCP_DEP.test(name)) return name;
      }
    }
  }
  return null;
}

/**
 * Both layouts a Python project declares dependencies in:
 *
 *   requirements.txt   mcp>=1.0            (bare, at the start of a line)
 *   pyproject.toml     dependencies = ["mcp>=1.0"]   (quoted, mid-line)
 *
 * Only matching the first form missed every modern pyproject.
 */
function hasPythonMcpDep(text: string): boolean {
  if (/^\s*(?:mcp|fastmcp)\s*(?:[[<>=!~;,]|$)/im.test(text)) return true;
  return /["'](?:mcp|fastmcp)\s*(?:[[<>=!~;,][^"']*)?["']/i.test(text);
}

/** True when the repository name or a package name reads like an MCP server. */
function hasMcpNamingHint(ctx: ManifestContext): boolean {
  for (const name of nameCandidates(ctx)) {
    if (MCP_IN_NAME.test(name.toLowerCase())) return true;
  }
  return false;
}

/** Repository name from the URL, then every declared package name. */
function nameCandidates(ctx: ManifestContext): string[] {
  const candidates: string[] = [];
  const repo = repoNameFromUrl(ctx.sourceUrl);
  if (repo !== null) candidates.push(repo);
  for (const pkg of ctx.packages) {
    if (typeof pkg.name === 'string' && pkg.name.trim() !== '') {
      candidates.push(stripScope(pkg.name.trim()));
    }
  }
  return candidates;
}

function stripScope(name: string): string {
  return name.replace(/^@[^/]+\//, '');
}

/**
 * The repository (or file) name a URL points at.
 *
 * GitHub is special-cased because the repository is the *second* path segment:
 * taking the last one would read `tree`, a branch name, or the `HEAD` that a
 * rewritten codeload URL ends with.
 */
function repoNameFromUrl(sourceUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }

  const parts = url.pathname.split('/').filter((part) => part !== '');
  if (parts.length === 0) return null;

  const host = url.hostname.toLowerCase();
  if (host === 'github.com' || host === 'codeload.github.com' || host === 'raw.githubusercontent.com') {
    const repo = parts[1];
    return repo ? repo.replace(/\.git$/, '') : null;
  }

  const last = parts[parts.length - 1] ?? '';
  const trimmed = last.replace(/\.(?:git|zip|tar|gz|tgz)$/i, '');
  return trimmed === '' ? null : trimmed;
}

function buildMcpPreview(ctx: ManifestContext): McpPreview {
  return { suggestedName: guessMcpName(ctx), type: guessMcpType(ctx) };
}

function guessMcpName(ctx: ManifestContext): string | null {
  const pkg = ctx.packages[0];
  if (pkg && typeof pkg.name === 'string' && pkg.name.trim() !== '') {
    return stripScope(pkg.name.trim());
  }
  return repoNameFromUrl(ctx.sourceUrl);
}

/**
 * `remote` when the README documents a hosted endpoint to connect to, otherwise
 * `local`.
 *
 * `local` is the default because a repository you can clone is something you
 * run yourself, and the two wrong guesses do not cost the same: a wrong `local`
 * shows the user a command field they can correct, while a wrong `remote` asks
 * them for a URL that does not exist.
 *
 * An entry point (a `bin` in package.json, a `[project.scripts]` block) is
 * deliberately *not* consulted. It would only ever confirm `local`, which is
 * already the fallback, so checking it could not change any answer.
 */
function guessMcpType(ctx: ManifestContext): McpServerType {
  return documentsRemoteEndpoint(ctx.readme) ? 'remote' : 'local';
}


/**
 * Hosts that appear in a README as documentation or badge links rather than as
 * the server's own endpoint. Without this, a link to the MCP spec — which ends
 * in `/mcp` — turned every local server into a remote one.
 */
const DOC_HOSTS = new Set([
  'modelcontextprotocol.io',
  'spec.modelcontextprotocol.io',
  'github.com',
  'raw.githubusercontent.com',
  'gist.github.com',
  'npmjs.com',
  'pypi.org',
  'shields.io',
  'img.shields.io',
  'localhost',
  '127.0.0.1',
]);

/** True when the README shows an `https://…/sse` or `…/mcp` endpoint to connect to. */
function documentsRemoteEndpoint(readme: string): boolean {
  const matches = readme.match(/https?:\/\/[^\s"'`)\]<>]+/gi) ?? [];
  for (const raw of matches) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (DOC_HOSTS.has(url.hostname.toLowerCase().replace(/^www\./, ''))) continue;
    if (/\/(?:sse|mcp)\/?$/i.test(url.pathname)) return true;
  }
  return false;
}
