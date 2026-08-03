/**
 * Skill intake: upload or URL-fetch → staging → preview → confirm.
 *
 * Intake is deliberately **two-phase**. Phase one stages the files, parses
 * `SKILL.md`, runs the heuristic scan and returns a preview; phase two registers
 * it. The reason is that both of the things we discover in phase one are things
 * the user must see *before* committing:
 *
 *   - the risk flags (they may simply not want this skill), and
 *   - the credential recommendation (the token field should be filled in during
 *     intake, not discovered as a failure the first time the skill runs).
 *
 * Staged intakes live under `skills/.staging/<id>/` and are moved into
 * `skills/<slug>/` on confirmation, so an abandoned preview never becomes a
 * half-registered skill. Everything is written through `resolveInScope('skills')`,
 * so an archive containing `../../.ssh/authorized_keys` cannot escape.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { env } from '../../config/env.ts';
import { ensureDirInScope, resolveInScope, safeFilename, toRelative } from '../../security/fsScope.ts';
import { AppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';
import type { SkillManifest } from './skillmd.ts';
import { parseSkillMd } from './skillmd.ts';
import type { RiskReport } from './riskscan.ts';
import { DISCLAIMER, scanSkillDirectory } from './riskscan.ts';
import type { SkillRecord, SkillSourceType } from './registry.ts';
import { findSkillByName, insertSkill } from './registry.ts';
import type { DependencyDetection, DepEcosystem } from './deps.ts';
import { detectDependencies } from './deps.ts';
import { provisionSkill } from './provision.ts';



const log = createLogger('skills:intake');

const STAGING_DIR = '.staging';
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export interface StagedFile {
  /** Original client-supplied name. */
  name: string;
  /** Either raw bytes or a path to an already-written temp file. */
  buffer?: Buffer;
  tempPath?: string;
  /** Relative destination inside the skill, for folder uploads. */
  relativePath?: string;
}

export interface IntakePreview {
  /** Staging id; pass this back to `confirmIntake`. */
  stagingId: string;
  name: string | null;
  description: string | null;
  sourceType: SkillSourceType;
  sourceRef: string | null;
  /** True when SKILL.md was found and parsed. */
  hasSkillMd: boolean;
  manifestSource: SkillManifest['source'];
  /** The recommendation check: does this skill expect its own credential? */
  needsCredential: boolean;
  credentialHint: string | null;
  files: string[];
  fileCount: number;
  risk: RiskReport;
  /** Repeated at the top level so a UI cannot render findings without the caveat. */
  riskDisclaimer: string;
  /** Present when the parsed name collides with an existing skill. */
  nameConflict: boolean;
  warnings: string[];
  /**
   * What this skill will need installed, shown *before* the user commits.
   *
   * Detection runs at preview time as well as on confirm because "this skill
   * wants to install 14 packages" is information that belongs next to the risk
   * flags, in the same decision.
   */
  dependencies: IntakeDependencyPreview;
}

export interface IntakeDependencyPreview {
  /** True when there is nothing to install. */
  noneDeclared: boolean;
  ecosystems: DepEcosystem[];
  /** Manifest files found, relative to the skill root. */
  manifests: string[];
  /** Specs we will attempt to install. */
  declared: string[];
  /** Declared entries we will not install automatically, with the reason. */
  rejected: { spec: string; reason: string }[];
  /** `package.json` lifecycle scripts that exist but will not be run. */
  lifecycleScriptsSkipped: string[];
}


// --- staging ---------------------------------------------------------------

function stagingRoot(stagingId: string): string {
  return resolveInScope('skills', path.posix.join(STAGING_DIR, stagingId));
}

/** Intake from an upload: one or more files, or a whole folder. */
export async function stageUpload(
  files: StagedFile[],
  options: { sourceRef?: string | null } = {},
): Promise<IntakePreview> {
  if (files.length === 0) throw new AppError('bad_request', 'No files were uploaded.');

  const stagingId = randomUUID();
  const root = stagingRoot(stagingId);
  fs.mkdirSync(root, { recursive: true });
  const warnings: string[] = [];

  try {
    let written = 0;
    for (const file of files) {
      const relative = normalizeEntryPath(file.relativePath ?? file.name);
      if (relative === null) {
        warnings.push(`Skipped "${file.name}": its path pointed outside the skill folder.`);
        continue;
      }

      const data = file.buffer ?? fs.readFileSync(file.tempPath ?? '');

      // A single archive is unpacked rather than stored, so a zipped skill and a
      // folder upload produce identical results.
      if (files.length === 1 && /\.zip$/i.test(relative)) {
        warnings.push(...unzipInto(data, root));
        written += 1;
        continue;
      }

      const destination = resolveInScope('skills', path.posix.join(STAGING_DIR, stagingId, relative));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, data);
      written += 1;
    }

    if (written === 0) throw new AppError('bad_request', 'None of the uploaded files could be stored.');
    return buildPreview(stagingId, root, 'upload', options.sourceRef ?? files[0]?.name ?? null, warnings);
  } catch (error) {
    discardStaging(stagingId);
    throw error;
  }
}

/**
 * Intake from a URL. A GitHub repo link is rewritten to its zip archive so the
 * common case ("here's the repo") works without asking the user to find the
 * download link.
 */
export async function stageUrl(rawUrl: string): Promise<IntakePreview> {
  const url = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError('bad_request', `"${rawUrl}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AppError('bad_request', 'Only http(s) URLs can be fetched.');
  }

  const target = githubArchiveUrl(parsed) ?? parsed;
  const stagingId = randomUUID();
  const root = stagingRoot(stagingId);
  fs.mkdirSync(root, { recursive: true });
  const warnings: string[] = [];

  try {
    let response: Response;
    try {
      response = await fetch(target, {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'Hyperion-skill-intake' },
      });
    } catch (error) {
      throw new AppError('bad_request', `Could not fetch ${target.href}.`, { cause: error });
    }
    if (!response.ok) {
      throw new AppError('bad_request', `Fetching ${target.href} returned HTTP ${response.status}.`);
    }

    const data = Buffer.from(await response.arrayBuffer());
    const looksZip = data.subarray(0, 2).toString('latin1') === 'PK';

    if (looksZip) {
      warnings.push(...unzipInto(data, root));
    } else {
      // A bare file: keep its name, defaulting to SKILL.md so a raw gist of
      // instructions is recognised as the manifest.
      const base = safeFilename(path.posix.basename(target.pathname) || 'SKILL.md', 'SKILL.md');
      const name = /\.[A-Za-z0-9]+$/.test(base) ? base : `${base}.md`;
      fs.writeFileSync(path.join(root, name), data);
    }

    return buildPreview(stagingId, root, 'url', url, warnings);
  } catch (error) {
    discardStaging(stagingId);
    throw error;
  }
}

/** `github.com/o/r` and `github.com/o/r/tree/branch` → the codeload zip. */
function githubArchiveUrl(url: URL): URL | null {
  if (url.hostname !== 'github.com') return null;
  const parts = url.pathname.split('/').filter((part) => part !== '');
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/, '');
  if (!owner || !repo) return null;
  if (parts[2] === 'archive') return null; // already an archive link
  const branch = parts[2] === 'tree' && parts[3] ? parts.slice(3).join('/') : 'HEAD';
  return new URL(`https://codeload.github.com/${owner}/${repo}/zip/${branch}`);
}

/**
 * Unpacks a zip into `root`, refusing traversal entries.
 *
 * GitHub archives wrap everything in a single top-level directory; that wrapper
 * is stripped so `SKILL.md` ends up at the skill root rather than one level down.
 */
function unzipInto(data: Buffer, root: string): string[] {
  const warnings: string[] = [];
  let zip: AdmZip;
  try {
    zip = new AdmZip(data);
  } catch (error) {
    throw new AppError('bad_request', 'The archive could not be read.', { cause: error });
  }

  const entries = zip.getEntries();
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new AppError(
      'bad_request',
      `The archive has ${entries.length} entries, more than the ${MAX_ARCHIVE_ENTRIES} allowed.`,
    );
  }

  const prefix = commonPrefix(entries.filter((entry) => !entry.isDirectory).map((e) => e.entryName));
  let total = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    let name = entry.entryName;
    if (prefix && name.startsWith(prefix)) name = name.slice(prefix.length);

    const relative = normalizeEntryPath(name);
    if (relative === null) {
      warnings.push(`Skipped "${entry.entryName}": its path pointed outside the skill folder.`);
      continue;
    }

    total += entry.header.size;
    if (total > MAX_UNPACKED_BYTES) {
      throw new AppError(
        'bad_request',
        `The archive expands to more than ${Math.round(MAX_UNPACKED_BYTES / 1024 / 1024)} MB.`,
      );
    }

    const destination = path.join(root, relative);
    // Belt and braces: the entry name was normalized, but confirm the resolved
    // path is still under the staging root before writing.
    const resolved = path.resolve(destination);
    if (path.relative(path.resolve(root), resolved).startsWith('..')) {
      warnings.push(`Skipped "${entry.entryName}": it resolved outside the skill folder.`);
      continue;
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, entry.getData());
  }
  return warnings;
}

/** The single wrapper directory shared by every entry, if there is one. */
function commonPrefix(names: string[]): string | null {
  if (names.length === 0) return null;
  const first = names[0] ?? '';
  const slash = first.indexOf('/');
  if (slash === -1) return null;
  const candidate = first.slice(0, slash + 1);
  return names.every((name) => name.startsWith(candidate)) ? candidate : null;
}

/**
 * Reduces an archive/upload entry name to a safe relative POSIX path, or null if
 * it tries to escape (absolute paths, `..`, drive letters, NUL bytes).
 */
function normalizeEntryPath(raw: string): string | null {
  const unified = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (unified === '' || unified.includes('\0')) return null;
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) return null;
  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(safeFilename(segment, 'file'));
  }
  return segments.length > 0 ? segments.join('/') : null;
}

// --- preview ---------------------------------------------------------------

function buildPreview(
  stagingId: string,
  root: string,
  sourceType: SkillSourceType,
  sourceRef: string | null,
  warnings: string[],
): IntakePreview {
  const files = listFiles(root);
  const skillMdPath = findSkillMd(root, files);

  let manifest: SkillManifest = {
    name: null,
    description: null,
    needsCredential: false,
    credentialHint: null,
    version: null,
    license: null,
    raw: {},
    source: 'none',
  };

  if (skillMdPath) {
    try {
      manifest = parseSkillMd(fs.readFileSync(path.join(root, skillMdPath), 'utf8'));
    } catch (error) {
      warnings.push('SKILL.md could not be read; the name and description need to be entered manually.');
      log.warn('could not read SKILL.md', error);
    }
  } else {
    warnings.push(
      'No SKILL.md was found, so the name and description could not be detected automatically.',
    );
  }

  // Last resort for a name: the source itself. Better than an empty field.
  const fallbackName =
    manifest.name ??
    (sourceType === 'url' && sourceRef ? guessNameFromUrl(sourceRef) : null) ??
    (sourceRef ? path.parse(sourceRef).name : null);

  const risk = scanSkillDirectory(root, { trusted: false });
  const detection = detectDependencies(root);

  return {
    stagingId,
    name: fallbackName,
    description: manifest.description,
    sourceType,
    sourceRef,
    hasSkillMd: skillMdPath !== null,
    manifestSource: manifest.source,
    needsCredential: manifest.needsCredential,
    credentialHint: manifest.credentialHint,
    files: files.slice(0, 100),
    fileCount: files.length,
    risk,
    riskDisclaimer: DISCLAIMER,
    nameConflict: fallbackName !== null && findSkillByName(fallbackName) !== null,
    warnings,
    dependencies: {
      noneDeclared: detection.noneDeclared,
      ecosystems: detection.ecosystems,
      manifests: detection.manifests.map((m) => m.file),
      declared: detection.deps.filter((dep) => dep.rejected === null).map((dep) => dep.spec),
      rejected: detection.deps
        .filter((dep) => dep.rejected !== null)
        .map((dep) => ({ spec: dep.spec, reason: dep.rejected ?? '' })),
      lifecycleScriptsSkipped: detection.lifecycleScripts,
    },
  };
}


function guessNameFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const parts = url.pathname.split('/').filter((part) => part !== '');
    const repo = parts[1]?.replace(/\.git$/, '');
    return repo ?? parts[parts.length - 1] ?? url.hostname;
  } catch {
    return null;
  }
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const queue = [root];
  while (queue.length > 0 && out.length < 500) {
    const dir = queue.shift();
    if (dir === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  return out.sort();
}

/** Prefers a root-level SKILL.md, then the shallowest one anywhere. */
function findSkillMd(root: string, files: string[]): string | null {
  const candidates = files.filter((file) => /(^|\/)skill\.md$/i.test(file));
  if (candidates.length === 0) {
    const readme = files.find((file) => /(^|\/)readme\.md$/i.test(file));
    return readme ?? null;
  }
  candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
  return candidates[0] ?? null;
}

// --- confirm / discard ------------------------------------------------------

export interface ConfirmIntakeInput {
  stagingId: string;
  /** Overrides the parsed name; required if none was detected. */
  name?: string;
  description?: string | null;
  /** The skill's own credential, encrypted on the way in. */
  token?: string | null;
  enabled?: boolean;
  /**
   * The frontend must pass the risk report back (or `acknowledgeRisk: true`) when
   * there are warnings, so registration is always a deliberate act.
   */
  acknowledgeRisk?: boolean;
  /**
   * Skip the dependency install for this registration.
   *
   * The skill still lands with its declared dependencies recorded, so the status
   * says `failed` with "not installed yet" and the user can provision later. This
   * exists for the offline case, not as a normal path.
   */
  skipProvisioning?: boolean;
}

/**
 * Registers a staged skill, then installs what it declared.
 *
 * Provisioning is awaited rather than backgrounded: the response is what tells
 * the user whether the skill is usable, and "registered, ask again later" is a
 * worse answer than waiting for the install. The detection from the preview is
 * handed to `insertSkill` so the row knows what it is waiting for even if the
 * install never completes.
 */
export async function confirmIntake(input: ConfirmIntakeInput): Promise<SkillRecord> {
  const skill = registerStaged(input);
  if (input.skipProvisioning === true) return skill;

  try {
    return await provisionSkill(skill, { force: true });
  } catch (error) {
    // A thrown provisioner is a bug, not a failed install — those are recorded as
    // a status. Either way the skill stays registered; losing the files because
    // pip had a bad day would be the worse outcome.
    log.warn(`dependency provisioning threw for "${skill.name}"`, error);
    return skill;
  }
}

function registerStaged(input: ConfirmIntakeInput): SkillRecord {
  const root = stagingRoot(input.stagingId);

  if (!fs.existsSync(root)) {
    throw new AppError(
      'not_found',
      'That staged upload is no longer available. Please upload the skill again.',
    );
  }

  const preview = buildPreview(
    input.stagingId,
    root,
    'upload',
    null,
    [],
  );
  const name = (input.name ?? preview.name ?? '').trim();
  if (name === '') {
    throw new AppError('bad_request', 'This skill has no detectable name; provide one.');
  }
  if (findSkillByName(name)) {
    throw new AppError('conflict', `A skill named "${name}" is already registered.`);
  }
  if (preview.risk.hasWarnings && input.acknowledgeRisk !== true) {
    throw new AppError(
      'bad_request',
      'This skill has risk-scan warnings. Re-submit with acknowledgeRisk: true to register it anyway. ' +
        DISCLAIMER,
      { details: { flags: preview.risk.flags } },
    );
  }

  // Move the staged files to their permanent home before inserting the row, so a
  // failed move never leaves a registered skill with no files.
  const slug = slugify(name);
  const finalRelative = uniqueRelative(slug);
  const finalPath = resolveInScope('skills', finalRelative);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  try {
    fs.renameSync(root, finalPath);
  } catch (error) {
    // Cross-device or a locked handle: fall back to a copy.
    try {
      fs.cpSync(root, finalPath, { recursive: true });
      fs.rmSync(root, { recursive: true, force: true });
    } catch (copyError) {
      throw new AppError('storage_error', 'The skill files could not be moved into place.', {
        cause: copyError ?? error,
      });
    }
  }

  const detection = detectDependencies(finalPath);

  try {
    return insertSkill({
      name,
      description: input.description !== undefined ? input.description : preview.description,
      sourceType: preview.sourceType,
      sourceRef: preview.sourceRef,
      relPath: toRelative('skills', finalPath),
      token: input.token ?? null,
      needsCredential: preview.needsCredential,
      riskFlags: preview.risk.flags,
      enabled: input.enabled !== false,
      detection,
    });

  } catch (error) {
    // Keep the two stores consistent: no row means no directory.
    fs.rmSync(finalPath, { recursive: true, force: true });
    throw error;
  }
}

/** Drops a staged intake the user abandoned. */
export function discardStaging(stagingId: string): void {
  try {
    fs.rmSync(stagingRoot(stagingId), { recursive: true, force: true });
  } catch (error) {
    log.warn(`could not clean up staging ${stagingId}`, error);
  }
}

/** Removes staged intakes older than a day. Called by the cleanup job. */
export function pruneStaging(maxAgeMs = 24 * 60 * 60 * 1000): number {
  const dir = resolveInScope('skills', STAGING_DIR);
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      /* raced with another delete */
    }
  }
  return removed;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug === '' ? 'skill' : slug;
}

function uniqueRelative(slug: string): string {
  let candidate = slug;
  let counter = 2;
  while (fs.existsSync(path.join(env.paths.skills, candidate))) {
    candidate = `${slug}-${counter}`;
    counter += 1;
  }
  return candidate;
}

/** Ensures the skills root and its staging directory exist. */
export function ensureSkillDirs(): void {
  ensureDirInScope('skills', STAGING_DIR);
}
