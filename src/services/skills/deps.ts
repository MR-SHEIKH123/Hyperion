/**
 * Skill dependency *detection* — facts only, no installing.
 *
 * Intake already parses `SKILL.md` and risk-scans the files, but neither answers
 * the question that decides whether a skill actually works: do its scripts have
 * what they need to run? This module answers it by reading the manifests a skill
 * author would already have written, using existing conventions rather than
 * inventing an Hyperion-specific one:
 *
 *   - `requirements.txt`            (Python)
 *   - `pyproject.toml`              (Python — `[project] dependencies` and
 *                                    `[tool.poetry.dependencies]`)
 *   - `package.json`                (Node — `dependencies`, never `devDependencies`)
 *   - `SKILL.md` front matter       (an explicit list, when the author added one)
 *
 * A skill may use more than one, so every convention is checked and the results
 * are merged. Finding none is a perfectly normal outcome — plenty of skills are
 * pure instructions with no code to run — and produces `none-declared` rather
 * than an error.
 *
 * Two deliberate limits:
 *
 *   1. **We install what a skill *declares*, never what it *scripts*.** Entries
 *      that would make an installer fetch and execute arbitrary code (`git+…`,
 *      a URL, a local path, `-e .`, an `--index-url` override) are recorded as
 *      *rejected* with a reason instead of being passed through. That keeps
 *      automatic provisioning to `pip install` / `npm install` of named packages,
 *      which is the same risk posture the rest of the skills system takes.
 *   2. **The TOML/YAML reading here is a tiny purpose-built subset**, matching
 *      the precedent set by `skillmd.ts`. A manifest is a flat list of package
 *      names; pulling in a general TOML parser to read one would add a
 *      dependency and a parser attack surface for no benefit. Anything we don't
 *      recognise is ignored, not fatal.
 *
 * This module holds no state that matters except the in-flight set at the
 * bottom, which lives here because it is the one place both the registry (for
 * reads) and the provisioner (for writes) can import without a cycle.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseSkillMd } from './skillmd.ts';

export type DepEcosystem = 'python' | 'node';

/**
 * The per-skill provisioning outcome.
 *
 * Exactly these four values are stored and returned; "currently installing" and
 * "the manifest changed since we installed" are *derived* at read time rather
 * than being extra statuses, so this contract stays small for the agentic layer
 * that branches on it.
 */
export type DepsStatus = 'none-declared' | 'ready' | 'partial' | 'failed';

export type ManifestKind = 'requirements.txt' | 'pyproject.toml' | 'package.json' | 'skill.md';

export interface DetectedManifest {
  kind: ManifestKind;
  ecosystem: DepEcosystem;
  /** POSIX path relative to the skill root. */
  file: string;
  /**
   * Directory the installer must run in, relative to the skill root ('' = root).
   * A `package.json` in a subdirectory gets its `node_modules` beside it, which
   * is still inside the skill's own directory.
   */
  dir: string;
}

export interface DeclaredDep {
  ecosystem: DepEcosystem;
  /** Package name alone, for user-facing messages ("pandas failed to install"). */
  name: string;
  /** The full spec handed to pip/npm, e.g. `pandas>=2.0` or `left-pad@1.3.0`. */
  spec: string;
  /** Which manifest declared it. */
  manifest: string;
  /** Non-null when we refuse to install it, carrying the reason verbatim. */
  rejected: string | null;
}

export interface DependencyDetection {
  /** True when no manifest declared anything at all. */
  noneDeclared: boolean;
  ecosystems: DepEcosystem[];
  manifests: DetectedManifest[];
  deps: DeclaredDep[];
  /**
   * `package.json` lifecycle scripts we will not run. Recorded so the user can
   * see *why* a package that relies on one may still be unusable.
   */
  lifecycleScripts: string[];
  /**
   * sha256 over the manifest paths and their contents. Provisioning is cached
   * against this, so a skill is re-provisioned when — and only when — what it
   * declares actually changes.
   */
  fingerprint: string;
  warnings: string[];
}

/** Depth limit for the manifest search: root, plus a wrapper or two. */
const MAX_DEPTH = 3;
/** Sanity cap. A skill declaring more than this is not a skill. */
const MAX_DEPS = 200;
const MAX_MANIFEST_BYTES = 512 * 1024;

/** Directories that never contain a skill's *own* manifest. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.venv',
  'venv',
  'env',
  '.git',
  '.hg',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'site-packages',
]);

/**
 * Front-matter keys that carry an explicit dependency list. The ecosystem is
 * taken from the key where the key says so; the generic keys default to Python,
 * because that is what a skill script overwhelmingly is. An author who means npm
 * can say so with `node_dependencies`, or per-entry with an `npm:` prefix.
 */
const FRONTMATTER_KEYS: { key: string; ecosystem: DepEcosystem | 'either' }[] = [
  { key: 'dependencies', ecosystem: 'either' },
  { key: 'requirements', ecosystem: 'either' },
  { key: 'python_dependencies', ecosystem: 'python' },
  { key: 'pythondependencies', ecosystem: 'python' },
  { key: 'pip', ecosystem: 'python' },
  { key: 'pip_dependencies', ecosystem: 'python' },
  { key: 'node_dependencies', ecosystem: 'node' },
  { key: 'nodedependencies', ecosystem: 'node' },
  { key: 'npm', ecosystem: 'node' },
  { key: 'npm_dependencies', ecosystem: 'node' },
];

// --- entry point ------------------------------------------------------------

/** Reads a skill directory and reports what it declares. Never throws. */
export function detectDependencies(root: string): DependencyDetection {
  const detection: DependencyDetection = {
    noneDeclared: true,
    ecosystems: [],
    manifests: [],
    deps: [],
    lifecycleScripts: [],
    fingerprint: '',
    warnings: [],
  };

  let found: { file: string; dir: string; base: string }[];
  try {
    found = findManifests(root);
  } catch {
    detection.fingerprint = fingerprintOf([]);
    return detection;
  }

  const hashed: { file: string; text: string }[] = [];

  for (const entry of found) {
    const absolute = path.join(root, entry.file.split('/').join(path.sep));
    const text = readTextFile(absolute);
    if (text === null) {
      detection.warnings.push(`${entry.file} could not be read, so it was ignored.`);
      continue;
    }
    hashed.push({ file: entry.file, text });

    switch (entry.base) {
      case 'requirements.txt':
        collect(detection, entry, 'requirements.txt', 'python', parseRequirements(text));
        break;
      case 'pyproject.toml':
        collect(detection, entry, 'pyproject.toml', 'python', parsePyproject(text));
        break;
      case 'package.json': {
        const parsed = parsePackageJson(text);
        if (parsed === null) {
          detection.warnings.push(`${entry.file} is not valid JSON, so it was ignored.`);
          break;
        }
        for (const script of parsed.lifecycleScripts) {
          if (!detection.lifecycleScripts.includes(script)) detection.lifecycleScripts.push(script);
        }
        collect(detection, entry, 'package.json', 'node', parsed.deps);
        break;
      }
      default:
        // A SKILL.md-declared list. Both ecosystems can appear in one file, so
        // each entry carries its own.
        for (const [ecosystem, raws] of parseFrontMatterDeps(text)) {
          collect(detection, entry, 'skill.md', ecosystem, raws);
        }
        break;
    }
  }

  if (detection.deps.length > MAX_DEPS) {
    detection.warnings.push(
      `Only the first ${MAX_DEPS} of ${detection.deps.length} declared dependencies were kept.`,
    );
    detection.deps = detection.deps.slice(0, MAX_DEPS);
  }

  detection.noneDeclared = detection.deps.length === 0;
  detection.fingerprint = fingerprintOf(hashed);
  return detection;
}

/** Adds parsed raw entries to the detection, validating each one. */
function collect(
  detection: DependencyDetection,
  entry: { file: string; dir: string },
  kind: ManifestKind,
  ecosystem: DepEcosystem,
  raws: RawDep[],
): void {
  if (raws.length === 0) return;

  if (!detection.manifests.some((m) => m.file === entry.file && m.ecosystem === ecosystem)) {
    detection.manifests.push({ kind, ecosystem, file: entry.file, dir: entry.dir });
  }
  if (!detection.ecosystems.includes(ecosystem)) detection.ecosystems.push(ecosystem);

  for (const raw of raws) {
    const rejected =
      raw.rejected ?? (ecosystem === 'python' ? rejectPython(raw.spec) : rejectNode(raw.spec));
    const dep: DeclaredDep = {
      ecosystem,
      name: raw.name,
      spec: raw.spec,
      manifest: entry.file,
      rejected,
    };
    // The same package declared twice (say requirements.txt and front matter) is
    // one dependency, not two failures.
    const duplicate = detection.deps.find(
      (existing) => existing.ecosystem === ecosystem && existing.spec === dep.spec,
    );
    if (!duplicate) detection.deps.push(dep);
  }
}

// --- manifest discovery -----------------------------------------------------

const MANIFEST_NAMES = new Set(['requirements.txt', 'pyproject.toml', 'package.json']);

/**
 * Breadth-first search for manifests, shallowest first, plus the skill's own
 * `SKILL.md`. Breadth-first matters: a root `requirements.txt` should be found
 * before one bundled inside an example subdirectory.
 */
function findManifests(root: string): { file: string; dir: string; base: string }[] {
  const out: { file: string; dir: string; base: string }[] = [];
  const skillMds: { file: string; dir: string; base: string }[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: '', depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;

    const absolute =
      current.dir === '' ? root : path.join(root, current.dir.split('/').join(path.sep));
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const relative = current.dir === '' ? entry.name : `${current.dir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        if (entry.name.endsWith('.egg-info') || entry.name.endsWith('.dist-info')) continue;
        if (current.depth + 1 < MAX_DEPTH) queue.push({ dir: relative, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;

      const lower = entry.name.toLowerCase();
      if (MANIFEST_NAMES.has(lower)) {
        out.push({ file: relative, dir: current.dir, base: lower });
      } else if (lower === 'skill.md') {
        skillMds.push({ file: relative, dir: current.dir, base: 'skill.md' });
      }
    }
  }

  // Only the shallowest SKILL.md is the skill's manifest; a nested one belongs to
  // bundled material.
  const primary = skillMds[0];
  if (primary) out.push(primary);
  return out;
}

function readTextFile(absolute: string): string | null {
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

function fingerprintOf(files: { file: string; text: string }[]): string {
  const hash = crypto.createHash('sha256');
  for (const entry of [...files].sort((a, b) => a.file.localeCompare(b.file))) {
    hash.update(entry.file, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(entry.text, 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

// --- parsers ----------------------------------------------------------------

interface RawDep {
  name: string;
  spec: string;
  /** Set when the parser itself already knows the entry is unusable. */
  rejected?: string | null;
}

function lines(text: string): string[] {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
}

/** `requirements.txt`: one requirement per line, `#` comments, blank lines. */
function parseRequirements(text: string): RawDep[] {
  const out: RawDep[] = [];
  for (const line of lines(text)) {
    // A `#` only starts a comment at the start or after whitespace, so a URL
    // fragment like `...#egg=foo` survives to be rejected as a URL.
    const stripped = line.replace(/(^|\s)#.*$/, '$1').trim();
    if (stripped === '') continue;
    out.push({ name: pythonName(stripped), spec: stripped });
  }
  return out;
}

/**
 * `pyproject.toml`, read as a flat sectioned file.
 *
 * Only two places declare runtime dependencies: PEP 621's `[project]
 * dependencies` array and Poetry's `[tool.poetry.dependencies]` table.
 * `optional-dependencies`/extras are skipped — they are opt-in by definition, so
 * installing them automatically would be the wrong default.
 */
function parsePyproject(text: string): RawDep[] {
  const out: RawDep[] = [];
  let section = '';
  let arrayBuffer: string | null = null;

  for (const line of lines(text)) {
    const trimmed = line.trim();

    if (arrayBuffer !== null) {
      arrayBuffer += `\n${trimmed}`;
      if (trimmed.includes(']')) {
        for (const spec of quotedStrings(arrayBuffer)) {
          out.push({ name: pythonName(spec), spec });
        }
        arrayBuffer = null;
      }
      continue;
    }

    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      section = (header[1] ?? '').trim().toLowerCase();
      continue;
    }

    if (section === 'project' && /^dependencies\s*=/.test(trimmed)) {
      const value = trimmed.slice(trimmed.indexOf('=') + 1).trim();
      if (value.includes(']')) {
        for (const spec of quotedStrings(value)) out.push({ name: pythonName(spec), spec });
      } else {
        arrayBuffer = value; // multi-line array
      }
      continue;
    }

    if (section === 'tool.poetry.dependencies' || section === 'tool.poetry.group.main.dependencies') {
      const pair = /^([A-Za-z0-9._-]+)\s*=\s*(.*)$/.exec(trimmed);
      if (!pair) continue;
      const name = (pair[1] ?? '').trim();
      const value = (pair[2] ?? '').trim();
      if (name.toLowerCase() === 'python') continue; // the interpreter, not a package

      // Poetry's `^1.2` / `~1.2` ranges are not pip syntax, and an inline table
      // may point at a git repo or a path. Install the plain name in the first
      // case; refuse in the second.
      if (value.startsWith('{') && /\b(git|path|url)\s*=/.test(value)) {
        out.push({
          name,
          spec: name,
          rejected:
            'it is declared as a git/path/url dependency, which is not installed automatically',
        });
        continue;
      }
      out.push({ name, spec: name });
    }
  }

  return out;
}

function quotedStrings(value: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'/g;
  for (;;) {
    const match = pattern.exec(value);
    if (match === null) break;
    const found = (match[1] ?? match[2] ?? '').trim();
    if (found !== '') out.push(found);
  }
  return out;
}

/**
 * `package.json`: runtime `dependencies` only.
 *
 * `devDependencies` are the skill author's tooling, not what the skill needs to
 * run, and installing them would multiply the install for no benefit.
 */
function parsePackageJson(text: string): { deps: RawDep[]; lifecycleScripts: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;

  const record = parsed as { dependencies?: unknown; scripts?: unknown };
  const deps: RawDep[] = [];
  if (record.dependencies !== null && typeof record.dependencies === 'object') {
    for (const [name, range] of Object.entries(record.dependencies as Record<string, unknown>)) {
      const version = typeof range === 'string' ? range.trim() : '';
      deps.push({ name, spec: version === '' || version === '*' ? name : `${name}@${version}` });
    }
  }

  const lifecycleScripts: string[] = [];
  if (record.scripts !== null && typeof record.scripts === 'object') {
    for (const key of Object.keys(record.scripts as Record<string, unknown>)) {
      if (/^(pre|post)?(install|prepare|prepublish)$/i.test(key)) lifecycleScripts.push(key);
    }
  }

  return { deps, lifecycleScripts };
}

/** An explicit list in the SKILL.md front matter. */
function parseFrontMatterDeps(text: string): Map<DepEcosystem, RawDep[]> {
  const out = new Map<DepEcosystem, RawDep[]>();
  let manifest: ReturnType<typeof parseSkillMd>;
  try {
    manifest = parseSkillMd(text);
  } catch {
    return out;
  }

  for (const { key, ecosystem } of FRONTMATTER_KEYS) {
    const value = manifest.raw[key];
    if (value === undefined) continue;
    const entries = Array.isArray(value) ? value : value.split(',').map((part) => part.trim());

    for (const entry of entries) {
      const cleaned = entry.trim();
      if (cleaned === '') continue;

      // A per-entry `pip:`/`npm:` prefix wins over the key's own default.
      const prefixed = /^(pip|python|npm|node)\s*:\s*(.+)$/i.exec(cleaned);
      const spec = prefixed ? (prefixed[2] ?? '').trim() : cleaned;
      const resolved: DepEcosystem = prefixed
        ? /^(npm|node)$/i.test(prefixed[1] ?? '')
          ? 'node'
          : 'python'
        : ecosystem === 'either'
          ? 'python'
          : ecosystem;

      const bucket = out.get(resolved) ?? [];
      bucket.push({
        name: resolved === 'python' ? pythonName(spec) : nodeName(spec),
        spec,
      });
      out.set(resolved, bucket);
    }
  }
  return out;
}

// --- validation -------------------------------------------------------------

/**
 * Validation is a positive allowlist, not a denylist of bad characters.
 *
 * A denylist gets this wrong in both directions. Blocking `<` and `>` as shell
 * redirections also rejects `requests>=2.31`, which is the single most common
 * line in any `requirements.txt`. Meanwhile a denylist can only ever exclude the
 * metacharacters somebody thought of.
 *
 * So each ecosystem gets a pattern describing what a real package spec looks
 * like, and anything else is refused with a reason. Nothing that matches these
 * can carry a shell metacharacter, which matters because npm has to be spawned
 * through a shell on Windows (Node refuses to exec a `.cmd` otherwise).
 */

/**
 * PEP 508, minus the parts we deliberately don't automate: a name, optional
 * extras, and a comma-separated version specifier. Environment markers (`;
 * python_version < "3.11"`) are excluded — the `;` is a shell separator, and a
 * marker is a conditional install rather than a declared one.
 */
const PYTHON_SPEC =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]*\])?(\s*(===|==|>=|<=|!=|~=|<|>)\s*[A-Za-z0-9][A-Za-z0-9._*+!-]*)*$/;

/**
 * An npm name (optionally scoped) and an optional semver range. Ranges may use
 * `^ ~ > < = x *` and spaces for `>=1 <2`, but not `||`: the pipe is a shell
 * metacharacter, and an alternation in a skill's runtime `dependencies` is rare
 * enough that refusing it with a clear reason beats quoting it correctly on
 * three platforms.
 */
const NODE_SPEC = /^@?[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?(@[A-Za-z0-9^~><=.\-+*x\s]*)?$/;



function pythonName(spec: string): string {
  const match = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(spec.trim());
  return match ? match[0] : spec.trim();
}

function nodeName(spec: string): string {
  const trimmed = spec.trim();
  // Scoped packages keep their leading @; the version separator is the *later* @.
  const at = trimmed.indexOf('@', trimmed.startsWith('@') ? 1 : 0);
  return at === -1 ? trimmed : trimmed.slice(0, at);
}

/** Returns the refusal reason for a Python requirement, or null to install it. */
export function rejectPython(raw: string): string | null {
  const spec = raw.trim();
  if (spec === '') return 'the entry is empty';
  if (spec.startsWith('-')) {
    const option = spec.split(/\s+/)[0] ?? spec;
    return `pip options such as "${option}" are not applied automatically`;
  }
  if (/^(git|hg|svn|bzr)\+/i.test(spec) || /^https?:\/\//i.test(spec) || /^file:/i.test(spec)) {
    return 'installing straight from a URL or a version-control checkout is not done automatically';
  }
  if (/@\s*(https?:|git|file:)/i.test(spec)) {
    return 'a direct-reference requirement (name @ url) is not installed automatically';
  }
  if (/^\.{1,2}[\\/]/.test(spec) || /^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith('/')) {
    return 'installing from a local path is not done automatically';
  }
  if (/\.(whl|tar\.gz|tgz|zip)$/i.test(spec)) {
    return 'installing from an archive file is not done automatically';
  }
  if (/;/.test(spec)) {
    return 'an environment marker (the part after ";") is not applied automatically';
  }
  if (!/^[A-Za-z0-9]/.test(spec)) return 'the entry does not start with a package name';
  if (!PYTHON_SPEC.test(spec)) {
    return 'it is not a plain "name" or "name>=version" requirement, so it is not installed automatically';
  }
  return null;
}


/** Returns the refusal reason for an npm spec, or null to install it. */
export function rejectNode(raw: string): string | null {
  const spec = raw.trim();
  if (spec === '') return 'the entry is empty';
  if (spec.startsWith('-')) {
    const option = spec.split(/\s+/)[0] ?? spec;
    return `npm options such as "${option}" are not applied automatically`;
  }
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  const range = at === -1 ? '' : spec.slice(at + 1);
  if (
    /^(git|git\+|github:|gitlab:|bitbucket:|gist:|https?:|file:|link:|portal:|workspace:)/i.test(range)
  ) {
    return `the version "${range}" points at a repository, path or workspace rather than a published package`;
  }
  if (/^(\.|\/|~\/)/.test(range)) return `the version "${range}" points at a local path`;
  if (!/^@?[A-Za-z0-9]/.test(spec)) return 'the entry does not start with a package name';
  if (spec.includes('||')) {
    return 'an alternation range ("||") is not installed automatically; pin a single range instead';
  }
  if (!NODE_SPEC.test(spec)) {
    return 'it is not a plain "name" or "name@range" specifier, so it is not installed automatically';
  }
  return null;
}


// --- in-flight tracking -----------------------------------------------------

/**
 * Skills currently being provisioned.
 *
 * Lives in this module rather than in the provisioner because both the registry
 * (which reports `installing` on every read) and the provisioner (which sets it)
 * need it, and the registry must not import the provisioner — the provisioner
 * already imports the registry to record its results.
 */
const inFlight = new Set<string>();

export function markProvisioning(skillId: string): void {
  inFlight.add(skillId);
}

export function clearProvisioning(skillId: string): void {
  inFlight.delete(skillId);
}

export function isProvisioning(skillId: string): boolean {
  return inFlight.has(skillId);
}
