/**
 * The skills table: CRUD plus the summary that makes relevance detection possible.
 *
 * The important design point is the summary endpoint. Skill *content* is never
 * injected wholesale — only `name + description` for every registered skill. That
 * short list goes into the running model's system prompt, and the model itself
 * decides whether a skill is relevant to the current task. That is why no
 * separate classification call is needed: the decision happens inside the request
 * already being made by whichever model drives the tool. This module's job is to
 * supply an accurate list cheaply.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { getDb } from '../../db/adapter.ts';

import { fromRelative } from '../../security/fsScope.ts';
import { encrypt, keyHint, tryDecrypt } from '../../security/keystore.ts';
import { AppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';
import type {
  DeclaredDep,
  DepEcosystem,
  DependencyDetection,
  DepsStatus,
  DetectedManifest,
  RequiredBinary,
} from './deps.ts';
import { detectDependencies, isProvisioning } from './deps.ts';
import type { RiskFlag } from './riskscan.ts';
import { DISCLAIMER } from './riskscan.ts';

const log = createLogger('skills');

export type SkillSourceType = 'upload' | 'url' | 'builtin';

/** A dependency that was declared but could not be installed. */
export interface FailedDep {
  ecosystem: DepEcosystem;
  name: string;
  spec: string;
  error: string;
}

/** A required system binary plus the result of looking for it on PATH. */
export interface CheckedBinary extends RequiredBinary {
  present: boolean;
}

/** The stored half of a skill's dependency state — what provisioning wrote. */
export interface SkillDeps {
  status: DepsStatus;
  ecosystems: DepEcosystem[];
  manifests: DetectedManifest[];
  declared: DeclaredDep[];
  /** Specs that installed successfully. */
  installed: string[];
  failed: FailedDep[];
  /** `package.json` lifecycle scripts that were deliberately not run. */
  lifecycleScripts: string[];
  /**
   * System commands the skill needs, each with whether it was on PATH when we
   * last looked. A missing one is what makes the status `needs-user-approval`.
   */
  binaries: CheckedBinary[];
  /** The overall failure reason, when there is one. */
  error: string | null;
  fingerprint: string | null;
  provisionedAt: number | null;
  /** Relative to the skills scope root; absolute in `SkillPublic`. */
  pythonPath: string | null;
  nodeModulesPath: string | null;
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string | null;
  sourceType: SkillSourceType;
  /** Original filename or URL, for provenance. */
  sourceRef: string | null;
  /** Path relative to the skills scope root. */
  relPath: string;
  tokenEnc: string | null;
  needsCredential: boolean;
  riskFlags: RiskFlag[];
  enabled: boolean;
  deps: SkillDeps;
  createdAt: number;
  updatedAt: number;
}

/**
 * What a consumer sees. `runnable` is the field to branch on: it folds the
 * status, the in-flight flag and the staleness check into the one question the
 * agentic layer actually asks — may I run this skill's scripts right now?
 */
export interface SkillDepsPublic {
  status: DepsStatus;
  runnable: boolean;
  /** Provisioning is in flight in this process. */
  installing: boolean;
  /** The manifests changed, or the installed artifacts are gone (e.g. restored backup). */
  stale: boolean;
  ecosystems: DepEcosystem[];
  manifests: string[];
  declared: string[];
  installed: string[];
  failed: FailedDep[];
  /** Declared entries we refuse to install automatically, with the reason. */
  rejected: { name: string; spec: string; reason: string }[];
  lifecycleScriptsSkipped: string[];
  /**
   * Every system command the skill needs, present or not, so the UI can render
   * "ffmpeg ✓ / pandoc ✗" without a second call.
   */
  binaries: CheckedBinary[];
  /** The subset that is missing — what an approval prompt is asking about. */
  missingBinaries: string[];
  error: string | null;
  /** Absolute path to the skill's own interpreter, for running its scripts. */
  pythonPath: string | null;
  nodeModulesPath: string | null;
  provisionedAt: number | null;
}

export interface SkillPublic {
  id: string;
  name: string;
  description: string | null;
  sourceType: SkillSourceType;
  sourceRef: string | null;
  relPath: string;
  hasToken: boolean;
  tokenHint: string | null;
  needsCredential: boolean;
  riskFlags: RiskFlag[];
  /** Repeated on every read so the caveat travels with the findings. */
  riskDisclaimer: string;
  enabled: boolean;
  dependencies: SkillDepsPublic;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  name: string;
  description: string | null;
  source_type: string;
  source_ref: string | null;
  rel_path: string;
  token_enc: string | null;
  needs_credential: number;
  risk_flags_json: string | null;
  enabled: number;
  deps_status: string | null;
  deps_json: string | null;
  deps_error: string | null;
  deps_fingerprint: string | null;
  deps_provisioned_at: number | null;
  deps_python_path: string | null;
  deps_node_modules_path: string | null;
  created_at: number;
  updated_at: number;
}


/**
 * Must list every member of `DepsStatus`. `mapDeps` treats anything absent as
 * unrecognised and silently falls back to `none-declared` — which is *runnable*,
 * so forgetting to add a value here turns a skill that is waiting on the user
 * into one the agentic layer will happily execute. The database CHECK (009) and
 * this array have to move together.
 */
const DEPS_STATUSES: DepsStatus[] = [
  'none-declared',
  'ready',
  'partial',
  'failed',
  'needs-user-approval',
];

function emptyDeps(): SkillDeps {
  return {
    status: 'none-declared',
    ecosystems: [],
    manifests: [],
    declared: [],
    installed: [],
    failed: [],
    lifecycleScripts: [],
    binaries: [],
    error: null,
    fingerprint: null,
    provisionedAt: null,
    pythonPath: null,
    nodeModulesPath: null,
  };
}

/** Rebuilds the dependency state from its row, tolerating older/partial rows. */
function mapDeps(row: Row): SkillDeps {
  const deps = emptyDeps();
  const status = row.deps_status as DepsStatus | null;
  if (status && DEPS_STATUSES.includes(status)) deps.status = status;
  deps.error = row.deps_error;
  deps.fingerprint = row.deps_fingerprint;
  deps.provisionedAt = row.deps_provisioned_at;
  deps.pythonPath = row.deps_python_path;
  deps.nodeModulesPath = row.deps_node_modules_path;

  if (row.deps_json) {
    try {
      const parsed = JSON.parse(row.deps_json) as Partial<SkillDeps>;
      if (Array.isArray(parsed.ecosystems)) deps.ecosystems = parsed.ecosystems;
      if (Array.isArray(parsed.manifests)) deps.manifests = parsed.manifests;
      if (Array.isArray(parsed.declared)) deps.declared = parsed.declared;
      if (Array.isArray(parsed.installed)) deps.installed = parsed.installed;
      if (Array.isArray(parsed.failed)) deps.failed = parsed.failed;
      if (Array.isArray(parsed.lifecycleScripts)) deps.lifecycleScripts = parsed.lifecycleScripts;
      if (Array.isArray(parsed.binaries)) deps.binaries = parsed.binaries;
    } catch {
      /* a corrupt blob must not make the skill unreadable */
    }
  }
  return deps;
}

function mapRow(row: Row): SkillRecord {
  let flags: RiskFlag[] = [];
  if (row.risk_flags_json) {
    try {
      const parsed = JSON.parse(row.risk_flags_json);
      if (Array.isArray(parsed)) flags = parsed as RiskFlag[];
    } catch {
      flags = [];
    }
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceType:
      row.source_type === 'url' || row.source_type === 'builtin'
        ? row.source_type
        : 'upload',
    sourceRef: row.source_ref,
    relPath: row.rel_path,
    tokenEnc: row.token_enc,
    needsCredential: row.needs_credential === 1,
    riskFlags: flags,
    enabled: row.enabled === 1,
    deps: mapDeps(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Resolves a stored relative path, or null if it no longer resolves in scope. */
function absoluteOrNull(relative: string | null): string | null {
  if (!relative) return null;
  try {
    return fromRelative('skills', relative);
  } catch {
    return null;
  }
}

/**
 * Is what we installed still on disk?
 *
 * The case this exists for is a restored backup: the export deliberately omits
 * `.venv/` and `node_modules/` (they are large, machine-specific, and a venv's
 * scripts hard-code absolute paths, so they would not work anyway). Without this
 * check a restored skill would claim `ready` while having nothing installed.
 */
function artifactsPresent(deps: SkillDeps): boolean {
  for (const relative of [deps.pythonPath, deps.nodeModulesPath]) {
    if (!relative) continue;
    const absolute = absoluteOrNull(relative);
    if (absolute === null || !fs.existsSync(absolute)) return false;
  }
  return true;
}

/**
 * Have the skill's manifests changed since we provisioned it?
 *
 * Re-hashing costs a few small file reads, and only for skills that declared
 * something in the first place, so listing a workspace of instruction-only
 * skills stays free.
 */
function isStale(skill: SkillRecord): boolean {
  const { deps } = skill;
  if (deps.status === 'none-declared' && deps.fingerprint === null) return false;
  if (!artifactsPresent(deps)) return true;

  let root: string;
  try {
    root = fromRelative('skills', skill.relPath);
  } catch {
    return true;
  }
  if (!fs.existsSync(root)) return true;

  const current = detectDependencies(root);
  if (current.noneDeclared && deps.status === 'none-declared') return false;
  return current.fingerprint !== deps.fingerprint;
}

/**
 * The single question the agentic layer asks before running a skill's scripts.
 *
 * `partial` is deliberately not runnable: a skill missing one of the packages it
 * declared will fail somewhere in the middle of a task, which is exactly the
 * failure mode this whole feature exists to prevent. The caller is told which
 * package is missing so it can say so up front instead.
 *
 * `needs-user-approval` is not runnable either — a missing system binary fails
 * the same way mid-task — but it is a *question*, not a fault. The distinction
 * lives in `status`; this boolean only answers "may I run it right now?".
 *
 * Deliberately an allowlist. A denylist would make every future status runnable
 * by default, which is the wrong way round for a check that gates execution.
 */
function computeRunnable(deps: SkillDeps, installing: boolean, stale: boolean): boolean {
  if (installing || stale) return false;
  return deps.status === 'none-declared' || deps.status === 'ready';
}

/** Builds the public dependency view, including the derived fields. */
export function dependencyView(skill: SkillRecord): SkillDepsPublic {
  const { deps } = skill;
  const installing = isProvisioning(skill.id);
  const stale = installing ? false : isStale(skill);

  return {
    status: deps.status,
    runnable: computeRunnable(deps, installing, stale),
    installing,
    stale,
    ecosystems: deps.ecosystems,
    manifests: deps.manifests.map((manifest) => manifest.file),
    declared: deps.declared.filter((dep) => dep.rejected === null).map((dep) => dep.spec),
    installed: deps.installed,
    failed: deps.failed,
    rejected: deps.declared
      .filter((dep) => dep.rejected !== null)
      .map((dep) => ({ name: dep.name, spec: dep.spec, reason: dep.rejected ?? '' })),
    lifecycleScriptsSkipped: deps.lifecycleScripts,
    binaries: deps.binaries,
    missingBinaries: deps.binaries.filter((binary) => !binary.present).map((b) => b.name),
    error: deps.error,
    pythonPath: absoluteOrNull(deps.pythonPath),
    nodeModulesPath: absoluteOrNull(deps.nodeModulesPath),
    provisionedAt: deps.provisionedAt,
  };
}

export function toPublic(skill: SkillRecord): SkillPublic {
  const token = skill.tokenEnc ? tryDecrypt(skill.tokenEnc) : null;
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    sourceType: skill.sourceType,
    sourceRef: skill.sourceRef,
    relPath: skill.relPath,
    hasToken: skill.tokenEnc !== null,
    tokenHint: token ? keyHint(token) : null,
    needsCredential: skill.needsCredential,
    riskFlags: skill.riskFlags,
    riskDisclaimer: DISCLAIMER,
    enabled: skill.enabled,
    dependencies: dependencyView(skill),
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}


const SELECT = `SELECT * FROM skills`;

export function listSkills(): SkillRecord[] {
  return getDb().prepare<Row>(`${SELECT} ORDER BY name COLLATE NOCASE`).all().map(mapRow);
}

export function findSkill(id: string): SkillRecord | null {
  const row = getDb().prepare<Row>(`${SELECT} WHERE id = ?`).get(id);
  return row ? mapRow(row) : null;
}

export function findSkillByName(name: string): SkillRecord | null {
  const row = getDb().prepare<Row>(`${SELECT} WHERE name = ? COLLATE NOCASE`).get(name);
  return row ? mapRow(row) : null;
}

export function requireSkill(id: string): SkillRecord {
  const skill = findSkill(id);
  if (!skill) throw new AppError('not_found', `No skill with id ${id}.`);
  return skill;
}

/** Decrypts a skill's own credential, for backend use only. */
export function skillToken(skill: SkillRecord): string | null {
  return skill.tokenEnc ? tryDecrypt(skill.tokenEnc) : null;
}

export interface SkillInsert {
  name: string;
  description?: string | null;
  sourceType: SkillSourceType;
  sourceRef?: string | null;
  relPath: string;
  token?: string | null;
  needsCredential?: boolean;
  riskFlags?: RiskFlag[];
  enabled?: boolean;
  /** What intake's detection pass found, before anything is installed. */
  detection?: DependencyDetection;
}

/**
 * The row's dependency state at registration time, before provisioning runs.
 *
 * A skill that declares nothing is `none-declared` and done. A skill that
 * declares something starts as `failed` — not because anything failed yet, but
 * because the alternative is a row that claims to be ready while nothing is
 * installed. If the process dies mid-install, this is the state that survives,
 * and it is the safe one: the agentic layer declines to run the skill's scripts
 * rather than running them against missing packages.
 */
function seedDeps(detection: DependencyDetection | undefined): SkillDeps {
  const deps = emptyDeps();
  if (!detection) return deps;

  deps.ecosystems = detection.ecosystems;
  deps.manifests = detection.manifests;
  deps.declared = detection.deps;
  deps.lifecycleScripts = detection.lifecycleScripts;
  deps.fingerprint = detection.fingerprint;
  // Seeded as not-yet-found rather than absent: provisioning is what probes PATH,
  // and until it has run "we have not looked" must not read as "it is there".
  deps.binaries = detection.binaries.map((binary) => ({ ...binary, present: false }));

  if (detection.noneDeclared) {
    deps.status = 'none-declared';
    return deps;
  }
  deps.status = 'failed';
  deps.error = 'Dependencies were detected but have not been installed yet.';
  return deps;
}

export function insertSkill(input: SkillInsert): SkillRecord {
  const name = input.name.trim();
  if (name === '') throw new AppError('bad_request', 'A skill needs a name.');
  if (findSkillByName(name)) {
    throw new AppError('conflict', `A skill named "${name}" is already registered.`);
  }

  const id = randomUUID();
  const now = Date.now();
  const deps = seedDeps(input.detection);
  getDb()
    .prepare(
      `INSERT INTO skills
         (id, name, description, source_type, source_ref, rel_path, token_enc,
          needs_credential, risk_flags_json, enabled, deps_status, deps_json,
          deps_error, deps_fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      name,
      // `description` is NOT NULL DEFAULT '' — a DEFAULT does not apply when a
      // statement passes an explicit NULL, so an absent description has to be
      // coerced here. Intake genuinely produces null: a skill with no SKILL.md
      // has nothing to parse a description from, and without this that upload
      // fails on a constraint instead of registering.
      input.description ?? '',

      input.sourceType,
      input.sourceRef ?? null,
      input.relPath,
      input.token ? encrypt(input.token) : null,
      input.needsCredential === true,
      input.riskFlags && input.riskFlags.length > 0 ? JSON.stringify(input.riskFlags) : null,
      input.enabled === false ? 0 : 1,
      deps.status,
      depsBlob(deps),
      deps.error,
      deps.fingerprint,
      now,
      now,
    );
  log.info(`registered skill "${name}" (${input.sourceType})`);
  return requireSkill(id);
}

/** Only the fields worth persisting; the rest are columns or derived. */
function depsBlob(deps: SkillDeps): string {
  return JSON.stringify({
    ecosystems: deps.ecosystems,
    manifests: deps.manifests,
    declared: deps.declared,
    installed: deps.installed,
    failed: deps.failed,
    lifecycleScripts: deps.lifecycleScripts,
    binaries: deps.binaries,
  });
}

/**
 * Writes a provisioning outcome. Called only by the provisioner.
 *
 * `updated_at` is deliberately left alone: provisioning is a machine-local fact
 * about this install, not an edit to the skill, and bumping it would make every
 * restart look like the user changed something.
 */
export function recordDependencyOutcome(id: string, deps: SkillDeps): SkillRecord {
  getDb()
    .prepare(
      `UPDATE skills
          SET deps_status = ?, deps_json = ?, deps_error = ?, deps_fingerprint = ?,
              deps_provisioned_at = ?, deps_python_path = ?, deps_node_modules_path = ?
        WHERE id = ?`,
    )
    .run(
      deps.status,
      depsBlob(deps),
      deps.error,
      deps.fingerprint,
      deps.provisionedAt,
      deps.pythonPath,
      deps.nodeModulesPath,
      id,
    );
  return requireSkill(id);
}


export interface SkillUpdate {
  name?: string;
  description?: string | null;
  /** Tri-state, as everywhere else: undefined keeps, null/'' clears. */
  token?: string | null;
  enabled?: boolean;
}

export function updateSkill(id: string, input: SkillUpdate): SkillRecord {
  const existing = requireSkill(id);
  const name = input.name?.trim() ?? existing.name;
  if (name === '') throw new AppError('bad_request', 'A skill needs a name.');
  if (name !== existing.name && findSkillByName(name)) {
    throw new AppError('conflict', `A skill named "${name}" is already registered.`);
  }

  const tokenEnc =
    input.token === undefined ? existing.tokenEnc : input.token ? encrypt(input.token) : null;

  getDb()
    .prepare(
      `UPDATE skills
          SET name = ?, description = ?, token_enc = ?, enabled = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      name,
      // Same NOT NULL coercion as the insert: clearing a description sends null,
      // which the column rejects rather than defaulting.
      (input.description !== undefined ? input.description : existing.description) ?? '',

      tokenEnc,
      (input.enabled ?? existing.enabled) ? 1 : 0,
      Date.now(),
      id,
    );
  return requireSkill(id);
}

/**
 * Removes a skill and, by default, its files.
 *
 * The directory is removed only if it resolves inside the skills scope — a
 * corrupt `rel_path` must never turn a delete into an arbitrary recursive
 * removal.
 */
export function deleteSkill(id: string, options: { keepFiles?: boolean } = {}): void {
  const skill = requireSkill(id);
  getDb().prepare(`DELETE FROM skills WHERE id = ?`).run(id);

  if (!options.keepFiles && skill.relPath) {
    try {
      const absolute = fromRelative('skills', skill.relPath);
      fs.rmSync(absolute, { recursive: true, force: true });
    } catch (error) {
      log.warn(`removed skill "${skill.name}" but could not delete its files`, error);
    }
  }
  log.info(`removed skill "${skill.name}"`);
}

// --- context injection -----------------------------------------------------

export interface SkillSummaryEntry {
  name: string;
  description: string;
  /** Provisioning status, so a consumer can see it without a second call. */
  status: DepsStatus;
  /** False when the skill's scripts must not be run yet. */
  runnable: boolean;
  /**
   * System commands the skill needs that are not on PATH.
   *
   * Present here, and not only on the full record, because "cannot run" and
   * "cannot run *because ffmpeg is missing*" are different messages to give a
   * user, and the caller of this list is usually the one writing that message.
   * `runnable` stays the boolean to branch on; this is only the reason.
   */
  missingBinaries: string[];
}


/**
 * Name + description for every enabled skill — never the file contents.
 *
 * This is what gets injected into the active model's system prompt. Keeping it to
 * two short fields is what makes it affordable to include on *every* request,
 * which in turn is what lets the model notice a skill is relevant without a
 * separate classification round-trip.
 *
 * The dependency status rides along because the alternative is worse: the agentic
 * layer would have to fetch every skill individually just to learn whether the
 * one it picked can actually run.
 */
export function skillsSummary(): SkillSummaryEntry[] {
  return listSkills()
    .filter((skill) => skill.enabled)
    .map((skill) => {
      const view = dependencyView(skill);
      return {
        name: skill.name,
        description: skill.description ?? '',
        status: view.status,
        runnable: view.runnable,
        missingBinaries: view.missingBinaries,
      };

    });
}

/**
 * Renders the summary as a system-prompt block. Empty string when none.
 *
 * A skill whose dependencies are not in place gets a short marker rather than
 * being hidden. Hiding it would stop the model mentioning a skill the user
 * installed on purpose; saying nothing would let the model confidently propose a
 * skill whose scripts cannot run. The marker lets it recommend the skill *and*
 * tell the user what needs fixing first.
 *
 * A skill waiting on a system binary gets a marker naming it. The generic wording
 * would send the model down the wrong path — it reads as a broken install to be
 * retried, when the actual next step is a person saying yes to `ffmpeg`, and only
 * the specific name lets the model tell the user that.
 */
export function skillsPromptBlock(): string {
  const entries = skillsSummary();
  if (entries.length === 0) return '';
  const lines = entries.map((entry) => {
    const head = entry.description ? `- ${entry.name}: ${entry.description}` : `- ${entry.name}`;
    if (entry.runnable) return head;
    if (entry.status === 'needs-user-approval' && entry.missingBinaries.length > 0) {
      return `${head} [needs ${entry.missingBinaries.join(', ')} installed — ask the user before using it]`;
    }
    return `${head} [dependencies not installed — its scripts cannot run yet]`;
  });

  return [
    'Skills available in this workspace. If one is clearly relevant to the current task,',
    'say so and ask to use it; otherwise ignore this list.',
    ...lines,
  ].join('\n');
}


