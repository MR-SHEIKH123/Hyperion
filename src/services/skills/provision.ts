/**
 * Skill dependency *provisioning* — the step that makes a skill runnable.
 *
 * Detection (`deps.ts`) says what a skill declares. This installs it, once, into
 * an environment that belongs to that skill alone:
 *
 *   ~/AIStudio/skills/<skill-id>/.venv/         Python
 *   ~/AIStudio/skills/<skill-id>/node_modules/  Node
 *
 * **Isolation is the whole point.** Installing into the app's own environment
 * would mean one skill pinning `requests==2.20` could break another skill, or the
 * app itself. Per-skill environments cost disk and buy the guarantee that a skill
 * can declare whatever it likes without consequence for anything else.
 *
 * Three behaviours worth knowing about:
 *
 *   - **Batch first, then one at a time.** A single `pip install -r` is the fast
 *     path, but pip fails the whole batch when one package fails. So when the
 *     batch fails we retry package-by-package, which is what turns a useless
 *     "installation failed" into `partial` plus "pandas failed because <error>" —
 *     the difference between a user who can fix it and one who can't.
 *   - **Never runs a skill's own scripts.** `pip install` / `npm install` of
 *     declared packages only, with `--ignore-scripts` on npm so a `postinstall`
 *     hook cannot execute during intake. Same posture as the risk scan.
 *   - **Cached against the manifest fingerprint.** Provisioning happens on intake
 *     and on manifest change, not per run.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { env } from '../../config/env.ts';
import { fromRelative, toRelative } from '../../security/fsScope.ts';

import { createLogger } from '../../util/logger.ts';
import type { DeclaredDep, DependencyDetection } from './deps.ts';
import { clearProvisioning, detectDependencies, isProvisioning, markProvisioning } from './deps.ts';
import type { FailedDep, SkillDeps, SkillRecord } from './registry.ts';
import { recordDependencyOutcome } from './registry.ts';

const log = createLogger('skills:deps');

/** Keeps a stored error readable in a UI without truncating past the useful part. */
const MAX_ERROR_CHARS = 2_000;

export interface ProvisionOptions {
  /** Re-install even when the fingerprint already matches. */
  force?: boolean;
  /** Detection already performed by the caller, so we don't read twice. */
  detection?: DependencyDetection;
}

/**
 * Concurrent callers get the same promise.
 *
 * Two requests provisioning one skill at once would have two pips writing into
 * one venv, which corrupts it in ways that are painful to diagnose. Sharing the
 * promise makes the second caller wait for the first result instead.
 */
const running = new Map<string, Promise<SkillRecord>>();

/** Provisions a skill's dependencies. Resolves to the updated record. */
export function provisionSkill(
  skill: SkillRecord,
  options: ProvisionOptions = {},
): Promise<SkillRecord> {
  const existing = running.get(skill.id);
  if (existing) return existing;

  const task = run(skill, options).finally(() => {
    running.delete(skill.id);
    clearProvisioning(skill.id);
  });
  running.set(skill.id, task);
  return task;
}

/** True when a provision for this skill is in flight. */
export function isProvisionRunning(skillId: string): boolean {
  return isProvisioning(skillId);
}

async function run(skill: SkillRecord, options: ProvisionOptions): Promise<SkillRecord> {
  let root: string;
  try {
    root = skillRoot(skill);
  } catch (error) {
    return fail(skill, `The skill's directory could not be resolved: ${message(error)}`, null);
  }

  const detection = options.detection ?? detectDependencies(root);

  // Nothing to install. Recorded as a real status rather than left blank so the
  // agentic layer reads `none-declared` and runs the skill instead of guessing.
  if (detection.noneDeclared) {
    return record(skill, {
      status: 'none-declared',
      detection,
      installed: [],
      failed: [],
      error: null,
      pythonPath: null,
      nodeModulesPath: null,
    });
  }

  if (env.skillDepsDisabled) {
    return record(skill, {
      status: 'failed',
      detection,
      installed: [],
      failed: [],
      error:
        'Automatic dependency installation is disabled (AISTUDIO_SKILL_DEPS_DISABLED). ' +
        'Install this skill\'s dependencies yourself, or unset that variable and re-provision.',
      pythonPath: null,
      nodeModulesPath: null,
    });
  }

  if (
    !options.force &&
    skill.deps.fingerprint === detection.fingerprint &&
    (skill.deps.status === 'ready' || skill.deps.status === 'partial')
  ) {
    return skill; // already provisioned for exactly these manifests
  }

  markProvisioning(skill.id);

  const installed: string[] = [];
  const failed: FailedDep[] = [];
  let pythonPath: string | null = null;
  let nodeModulesPath: string | null = null;
  const errors: string[] = [];

  // Entries we already refused during detection are failures the user should see,
  // not silent omissions — a skill needing a git dependency is genuinely not
  // ready, and saying why is the whole point.
  for (const dep of detection.deps) {
    if (dep.rejected !== null) {
      failed.push({
        ecosystem: dep.ecosystem,
        name: dep.name,
        spec: dep.spec,
        error: `Not installed automatically: ${dep.rejected}.`,
      });
    }
  }

  const python = detection.deps.filter((dep) => dep.ecosystem === 'python' && dep.rejected === null);
  if (python.length > 0) {
    const result = await provisionPython(root, python, detection);
    installed.push(...result.installed);
    failed.push(...result.failed);
    pythonPath = result.interpreter ?? null;
    if (result.error) errors.push(result.error);
  }

  const node = detection.deps.filter((dep) => dep.ecosystem === 'node' && dep.rejected === null);
  if (node.length > 0) {
    const result = await provisionNode(root, node, detection);
    installed.push(...result.installed);
    failed.push(...result.failed);
    nodeModulesPath = result.nodeModules ?? null;
    if (result.error) errors.push(result.error);
  }


  if (detection.lifecycleScripts.length > 0) {
    log.info(
      `skill "${skill.name}" declares ${detection.lifecycleScripts.join(', ')} script(s); ` +
        'they were not run (npm --ignore-scripts)',
    );
  }

  // The status is decided by what is actually installed, not by exit codes:
  // "some of it worked" is the case a single boolean would lose.
  const status = installed.length === 0 ? 'failed' : failed.length > 0 ? 'partial' : 'ready';
  const error =
    status === 'ready'
      ? null
      : truncate([...errors, ...failed.map((dep) => `${dep.name}: ${dep.error}`)].join(' | '));

  const updated = record(skill, {
    status,
    detection,
    installed,
    failed,
    error,
    pythonPath,
    nodeModulesPath,
  });

  const summary =
    status === 'ready'
      ? `${installed.length} package(s) installed`
      : `${installed.length} installed, ${failed.length} failed`;
  log.info(`provisioned skill "${skill.name}": ${status} — ${summary}`);
  return updated;
}

// --- Python -----------------------------------------------------------------

interface EcosystemResult {
  installed: string[];
  failed: FailedDep[];
  error: string | null;
  interpreter?: string | null;
  nodeModules?: string | null;
}

/**
 * Builds `<skill>/.venv` and installs into it.
 *
 * `--upgrade-deps` is deliberately not used: it reaches the network before we
 * know the install can work at all, and a stock pip installs a requirements file
 * fine.
 */
async function provisionPython(
  root: string,
  deps: DeclaredDep[],
  detection: DependencyDetection,
): Promise<EcosystemResult> {
  const venv = path.join(root, '.venv');
  const base = await findPython();
  if (base === null) {
    return {
      installed: [],
      failed: deps.map((dep) => ({
        ecosystem: dep.ecosystem,
        name: dep.name,
        spec: dep.spec,
        error: 'no Python 3 interpreter was found on PATH',
      })),
      error:
        'This skill needs Python, but no Python 3 interpreter was found. Install Python 3 ' +
        'or set AISTUDIO_SKILL_DEPS_PYTHON to its full path, then re-provision the skill.',
      interpreter: null,
    };
  }

  const interpreter = venvPython(venv);
  if (!fs.existsSync(interpreter)) {
    const created = await exec(base, ['-m', 'venv', venv], { cwd: root });
    if (!created.ok || !fs.existsSync(interpreter)) {
      return {
        installed: [],
        failed: deps.map((dep) => ({
          ecosystem: dep.ecosystem,
          name: dep.name,
          spec: dep.spec,
          error: 'the skill\'s virtual environment could not be created',
        })),
        error: truncate(
          `Could not create a virtual environment for this skill: ${created.output}. ` +
            'On Debian/Ubuntu this usually means the python3-venv package is missing.',
        ),
        interpreter: null,
      };
    }
  }

  // A requirements file, when the skill has one, is the most faithful input: it
  // carries markers and ordering that a flattened list of names would lose.
  const requirements = detection.manifests.find((m) => m.kind === 'requirements.txt');
  const batch = requirements
    ? ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', requirements.file]
    : ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...deps.map((d) => d.spec)];

  const first = await exec(interpreter, batch, { cwd: root });
  if (first.ok) {
    return {
      installed: deps.map((dep) => dep.spec),
      failed: [],
      error: null,
      interpreter,
    };
  }

  // pip fails the batch when any one package fails, so retry individually to
  // find out *which*. This is what produces a `partial` instead of a `failed`.
  const installed: string[] = [];
  const failed: FailedDep[] = [];
  for (const dep of deps) {
    const attempt = await exec(
      interpreter,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', dep.spec],
      { cwd: root },
    );
    if (attempt.ok) installed.push(dep.spec);
    else {
      failed.push({
        ecosystem: dep.ecosystem,
        name: dep.name,
        spec: dep.spec,
        error: lastMeaningfulLine(attempt.output),
      });
    }
  }

  return {
    installed,
    failed,
    error: installed.length === 0 ? truncate(lastMeaningfulLine(first.output)) : null,
    interpreter,
  };
}

/** Where a venv puts its interpreter, which differs by platform. */
function venvPython(venv: string): string {
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
}

let cachedPython: string | null | undefined;

/**
 * Finds a usable Python 3.
 *
 * `python` is checked last and verified, because on many systems it is either
 * absent or still Python 2 — and on Windows a bare `python` may be the Store
 * stub that only prints an advert.
 */
async function findPython(): Promise<string | null> {
  if (cachedPython !== undefined) return cachedPython;

  const candidates = env.skillDepsPython
    ? [env.skillDepsPython]
    : process.platform === 'win32'
      ? ['py', 'python3', 'python']
      : ['python3', 'python'];

  for (const candidate of candidates) {
    const args = candidate === 'py' ? ['-3', '--version'] : ['--version'];
    const probe = await exec(candidate, args, { timeoutMs: 20_000 });
    if (probe.ok && /python\s*3\./i.test(probe.output)) {
      cachedPython = candidate === 'py' ? 'py' : candidate;
      return cachedPython;
    }
  }
  cachedPython = null;
  return null;
}

// --- Node -------------------------------------------------------------------

/**
 * Installs into `<manifest dir>/node_modules`.
 *
 * `--prefix` is not used: npm resolves `node_modules` from the working directory
 * and a prefix interacts badly with workspaces. Running *in* the manifest's own
 * directory is both simpler and exactly the isolation we want.
 */
async function provisionNode(
  root: string,
  deps: DeclaredDep[],
  detection: DependencyDetection,
): Promise<EcosystemResult> {
  const manifest = detection.manifests.find((m) => m.kind === 'package.json');
  const workDir = manifest ? path.join(root, manifest.dir.split('/').join(path.sep)) : root;
  const nodeModules = path.join(workDir, 'node_modules');

  const npm = env.skillDepsNpm || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  // --ignore-scripts is the load-bearing flag: it stops a dependency's install
  // hook executing code on this machine during intake.
  const common = ['--ignore-scripts', '--no-audit', '--no-fund'];

  // Only `npm install` with no arguments when there is a real package.json —
  // otherwise npm would create one, and a skill that declared its deps in
  // SKILL.md would end up with a stray manifest it never asked for.
  const batch = manifest
    ? ['install', ...common]
    : ['install', '--no-save', ...common, ...deps.map((dep) => dep.spec)];

  const first = await exec(npm, batch, { cwd: workDir, shell: process.platform === 'win32' });
  if (first.ok) {
    return { installed: deps.map((dep) => dep.spec), failed: [], error: null, nodeModules };
  }

  if (isMissingExecutable(first)) {
    return {
      installed: [],
      failed: deps.map((dep) => ({
        ecosystem: dep.ecosystem,
        name: dep.name,
        spec: dep.spec,
        error: 'npm was not found on PATH',
      })),
      error:
        'This skill needs npm, which was not found. Install Node.js or set ' +
        'AISTUDIO_SKILL_DEPS_NPM to the full path of npm, then re-provision the skill.',
      nodeModules: null,
    };
  }

  const installed: string[] = [];
  const failed: FailedDep[] = [];
  for (const dep of deps) {
    const attempt = await exec(npm, ['install', '--no-save', ...common, dep.spec], {
      cwd: workDir,
      shell: process.platform === 'win32',
    });
    if (attempt.ok) installed.push(dep.spec);
    else {
      failed.push({
        ecosystem: dep.ecosystem,
        name: dep.name,
        spec: dep.spec,
        error: lastMeaningfulLine(attempt.output),
      });
    }
  }

  return {
    installed,
    failed,
    error: installed.length === 0 ? truncate(lastMeaningfulLine(first.output)) : null,
    nodeModules: fs.existsSync(nodeModules) ? nodeModules : null,
  };
}

// --- process plumbing -------------------------------------------------------

interface ExecResult {
  ok: boolean;
  code: number | null;
  output: string;
  spawnError: boolean;
}

/**
 * Runs an installer, capturing merged stdout/stderr.
 *
 * Two details that matter. The timeout is enforced by us rather than left to the
 * child, because a wedged installer holding a lock would otherwise keep the
 * skill "installing" forever. And `stdin` is closed: pip and npm both prompt on
 * occasion, and a prompt nobody can answer is a hang.
 */
function exec(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; shell?: boolean } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell ?? false,
      windowsHide: true,
      // Installers read config from the environment; PIP_REQUIRE_VIRTUALENV in
      // particular would break the venv install we are deliberately doing.
      env: { ...process.env, PIP_REQUIRE_VIRTUALENV: '', PIP_DISABLE_PIP_VERSION_CHECK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;
    const append = (chunk: Buffer | string): void => {
      if (output.length < 64 * 1024) output += chunk.toString();
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const timer = setTimeout(() => {
      if (settled) return;
      output += `\nTimed out after ${Math.round((options.timeoutMs ?? env.skillDepsTimeoutMs) / 1000)}s.`;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? env.skillDepsTimeoutMs);
    timer.unref?.();

    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on('error', (error) => {
      finish({ ok: false, code: null, output: `${output}\n${error.message}`.trim(), spawnError: true });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, code, output: output.trim(), spawnError: false });
    });
  });
}

function isMissingExecutable(result: ExecResult): boolean {
  return (
    result.spawnError ||
    /ENOENT|not recognized as an internal or external command|command not found/i.test(result.output)
  );
}

/**
 * The last line that says something.
 *
 * Installer output ends in progress noise and a "see the log for details"
 * pointer; the actual cause is usually the last `error:`-ish line. Preferring
 * that over the tail is what makes the surfaced message useful.
 */
function lastMeaningfulLine(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.replace(/^npm (ERR!|error)\s*/i, '').trim())
    .filter((line) => line !== '' && !/^\d+%|^\[[=>\s]*\]$/.test(line));
  if (lines.length === 0) return 'the installer failed without producing any output';

  for (const line of [...lines].reverse()) {
    if (/error|not found|no matching|could not|failed|unable|denied/i.test(line)) return truncate(line);
  }
  return truncate(lines[lines.length - 1] ?? '');
}

function truncate(text: string): string {
  const clean = text.trim();
  return clean.length <= MAX_ERROR_CHARS ? clean : `${clean.slice(0, MAX_ERROR_CHARS)}…`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- persistence ------------------------------------------------------------

function skillRoot(skill: SkillRecord): string {
  return fromRelative('skills', skill.relPath);
}


interface Outcome {
  status: SkillDeps['status'];
  detection: DependencyDetection;
  installed: string[];
  failed: FailedDep[];
  error: string | null;
  pythonPath: string | null;
  nodeModulesPath: string | null;
}

/** Stores the outcome, converting absolute install paths back to relative. */
function record(skill: SkillRecord, outcome: Outcome): SkillRecord {
  const deps: SkillDeps = {
    status: outcome.status,
    ecosystems: outcome.detection.ecosystems,
    manifests: outcome.detection.manifests,
    declared: outcome.detection.deps,
    installed: outcome.installed,
    failed: outcome.failed,
    lifecycleScripts: outcome.detection.lifecycleScripts,
    error: outcome.error,
    fingerprint: outcome.detection.fingerprint,
    provisionedAt: Date.now(),
    pythonPath: relativeOrNull(outcome.pythonPath),
    nodeModulesPath: relativeOrNull(outcome.nodeModulesPath),
  };
  return recordDependencyOutcome(skill.id, deps);
}

function relativeOrNull(absolute: string | null): string | null {
  if (!absolute) return null;
  try {
    return toRelative('skills', absolute);
  } catch {
    return null;
  }
}

/** Records a hard failure that happened before any install was attempted. */
function fail(skill: SkillRecord, error: string, detection: DependencyDetection | null): SkillRecord {
  const deps: SkillDeps = {
    ...skill.deps,
    status: 'failed',
    error: truncate(error),
    provisionedAt: Date.now(),
  };
  if (detection) {
    deps.ecosystems = detection.ecosystems;
    deps.manifests = detection.manifests;
    deps.declared = detection.deps;
    deps.fingerprint = detection.fingerprint;
  }
  return recordDependencyOutcome(skill.id, deps);
}
