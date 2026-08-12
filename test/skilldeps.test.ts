/**
 * Skill dependency detection and provisioning status.
 *
 * Two halves, split by what they cost:
 *
 *   - **Detection** is pure file reading, so it is tested directly and
 *     thoroughly. Every manifest convention, and every form we deliberately
 *     refuse, gets a case.
 *   - **Provisioning** would otherwise reach the network and build a venv, which
 *     is not something a test suite should do. `HYPERION_SKILL_DEPS_DISABLED` is
 *     set in the harness, so what is asserted here is the *state machine* around
 *     the install — the statuses, the runnable rule, the staleness check, and the
 *     shape the API exposes — rather than pip's behaviour.
 *
 * The staleness assertions matter more than they look: they are what stops a
 * restored backup, or a hand-edited manifest, from leaving a skill claiming
 * `ready` while nothing is installed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { cleanupHome, freshDb, testHome } from './helpers.ts';

// Provisioning must never shell out during tests. Set before any src import, so
// config/env.ts reads it when it resolves everything at import time.
process.env.HYPERION_SKILL_DEPS_DISABLED = '1';

type DepsModule = typeof import('../src/services/skills/deps.ts');
type RegistryModule = typeof import('../src/services/skills/registry.ts');
type ProvisionModule = typeof import('../src/services/skills/provision.ts');

let deps: DepsModule;
let registry: RegistryModule;
let provision: ProvisionModule;

/** Writes a skill directory under the skills root and returns its relative path. */
function writeSkill(name: string, files: Record<string, string>): string {
  const root = path.join(testHome, 'skills', name);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return name;
}

before(async () => {
  await freshDb();
  deps = await import('../src/services/skills/deps.ts');
  registry = await import('../src/services/skills/registry.ts');
  provision = await import('../src/services/skills/provision.ts');
});

after(async () => {
  await cleanupHome();
});

describe('dependency detection', () => {
  it('reports none-declared for a skill that is only instructions', () => {
    const rel = writeSkill('plain', { 'SKILL.md': '# Plain\n\nJust prose.\n' });
    const found = deps.detectDependencies(path.join(testHome, 'skills', rel));

    assert.equal(found.noneDeclared, true);
    assert.deepEqual(found.deps, []);
    assert.deepEqual(found.ecosystems, []);
  });

  it('reads requirements.txt, ignoring comments, blanks and options', () => {
    const rel = writeSkill('py-req', {
      'requirements.txt': [
        '# analysis deps',
        '',
        'pandas==2.2.0',
        'requests>=2.31  # inline comment',
        '--index-url https://example.invalid/simple',
        'numpy',
      ].join('\n'),
    });
    const found = deps.detectDependencies(path.join(testHome, 'skills', rel));

    assert.equal(found.noneDeclared, false);
    assert.deepEqual(found.ecosystems, ['python']);
    const installable = found.deps.filter((d) => d.rejected === null).map((d) => d.name);
    assert.deepEqual(installable, ['pandas', 'requests', 'numpy']);
    // The inline comment must not end up in the spec we hand to pip.
    const requests = found.deps.find((d) => d.name === 'requests');
    assert.equal(requests?.spec, 'requests>=2.31');
  });

  it('refuses requirement forms that fetch and run arbitrary code', () => {
    const rel = writeSkill('py-unsafe', {
      'requirements.txt': [
        'good-package',
        'git+https://example.invalid/repo.git#egg=thing',
        './local-wheel',
        '-e .',
        '-r other-requirements.txt',
      ].join('\n'),
    });
    const found = deps.detectDependencies(path.join(testHome, 'skills', rel));

    const rejected = found.deps.filter((d) => d.rejected !== null);
    assert.equal(rejected.length, 4, 'VCS, local path, editable and -r are all refused');
    for (const dep of rejected) {
      assert.ok(
        typeof dep.rejected === 'string' && dep.rejected.length > 0,
        'a refusal must carry a reason the user can read',
      );
    }
    assert.deepEqual(
      found.deps.filter((d) => d.rejected === null).map((d) => d.name),
      ['good-package'],
    );
  });

  it('reads PEP 621 and Poetry dependencies from pyproject.toml', () => {
    const pep621 = writeSkill('py-pep621', {
      'pyproject.toml': [
        '[project]',
        'name = "thing"',
        'dependencies = ["httpx>=0.27", "rich"]',
      ].join('\n'),
    });
    const poetry = writeSkill('py-poetry', {
      'pyproject.toml': [
        '[tool.poetry.dependencies]',
        'python = "^3.11"',
        'pyyaml = "^6.0"',
      ].join('\n'),
    });

    const a = deps.detectDependencies(path.join(testHome, 'skills', pep621));
    assert.deepEqual(
      a.deps.map((d) => d.name),
      ['httpx', 'rich'],
    );

    const b = deps.detectDependencies(path.join(testHome, 'skills', poetry));
    // `python` is the interpreter constraint, not a package to install.
    assert.deepEqual(
      b.deps.map((d) => d.name),
      ['pyyaml'],
    );
  });

  it('reads package.json dependencies but not devDependencies, and flags lifecycle scripts', () => {
    const rel = writeSkill('node-pkg', {
      'package.json': JSON.stringify({
        name: 'skill',
        dependencies: { 'left-pad': '^1.3.0' },
        devDependencies: { jest: '^29.0.0' },
        scripts: { postinstall: 'node ./setup.js', test: 'jest' },
      }),
    });
    const found = deps.detectDependencies(path.join(testHome, 'skills', rel));

    assert.deepEqual(found.ecosystems, ['node']);
    assert.deepEqual(
      found.deps.map((d) => d.name),
      ['left-pad'],
      'devDependencies are not needed to run a skill',
    );
    assert.ok(
      found.lifecycleScripts.includes('postinstall'),
      'an install hook must be reported, since we deliberately do not run it',
    );
    assert.ok(!found.lifecycleScripts.includes('test'), 'test is not a lifecycle hook');
  });

  it('reads a dependencies list declared in SKILL.md front-matter', () => {
    const rel = writeSkill('md-deps', {
      'SKILL.md': [
        '---',
        'name: Declared',
        'dependencies:',
        '  - pandas',
        '  - npm:chalk',
        '---',
        '',
        'Body.',
      ].join('\n'),
    });
    const found = deps.detectDependencies(path.join(testHome, 'skills', rel));

    assert.equal(found.noneDeclared, false);
    const names = found.deps.map((d) => d.name);
    assert.ok(names.includes('pandas'));
    assert.ok(names.includes('chalk'));
    const chalk = found.deps.find((d) => d.name === 'chalk');
    assert.equal(chalk?.ecosystem, 'node', 'an npm: prefix routes the dep to npm');
  });

  it('finds more than one convention in the same skill', () => {
    const rel = writeSkill('both', {
      'requirements.txt': 'pandas\n',
      'package.json': JSON.stringify({ dependencies: { chalk: '^5.0.0' } }),
    });
    const found = deps.detectDependencies(path.join(testHome, 'skills', rel));

    assert.deepEqual([...found.ecosystems].sort(), ['node', 'python']);
    assert.equal(found.manifests.length, 2);
  });

  it('changes its fingerprint when a manifest changes, and not otherwise', () => {
    const rel = writeSkill('fingerprint', { 'requirements.txt': 'pandas\n' });
    const root = path.join(testHome, 'skills', rel);

    const first = deps.detectDependencies(root);
    const unchanged = deps.detectDependencies(root);
    assert.equal(first.fingerprint, unchanged.fingerprint);

    fs.writeFileSync(path.join(root, 'requirements.txt'), 'pandas\nnumpy\n');
    const changed = deps.detectDependencies(root);
    assert.notEqual(changed.fingerprint, first.fingerprint);
  });

  it('never throws on a directory that does not exist', () => {
    const found = deps.detectDependencies(path.join(testHome, 'skills', 'no-such-skill'));
    assert.equal(found.noneDeclared, true);
  });
});

describe('dependency status', () => {
  it('is none-declared and runnable for an instruction-only skill', async () => {
    const rel = writeSkill('status-plain', { 'SKILL.md': '# Plain\n' });
    const detection = deps.detectDependencies(path.join(testHome, 'skills', rel));
    // Deliberately no description: a skill with no SKILL.md has none to parse,
    // and `skills.description` is NOT NULL, so this is the case that used to
    // fail the insert outright.
    const skill = registry.insertSkill({
      name: 'status-plain',
      sourceType: 'upload',
      relPath: rel,
      detection,
    });

    const view = registry.dependencyView(skill);

    assert.equal(view.status, 'none-declared');
    assert.equal(view.runnable, true, 'nothing to install means nothing to wait for');
    assert.equal(view.stale, false);
  });

  it('is not runnable between registration and a successful install', () => {
    const rel = writeSkill('status-pending', { 'requirements.txt': 'pandas\n' });
    const detection = deps.detectDependencies(path.join(testHome, 'skills', rel));
    const skill = registry.insertSkill({
      name: 'status-pending',
      sourceType: 'upload',
      relPath: rel,
      detection,
    });

    const view = registry.dependencyView(skill);
    assert.equal(view.status, 'failed');
    assert.equal(view.runnable, false);
    assert.deepEqual(view.declared, ['pandas']);
    assert.ok(
      view.error && /not been installed/i.test(view.error),
      'the seeded state must say why, not just fail',
    );
  });

  it('records a clear failure when installation cannot run at all', async () => {
    const rel = writeSkill('status-disabled', { 'requirements.txt': 'pandas\n' });
    const detection = deps.detectDependencies(path.join(testHome, 'skills', rel));
    const skill = registry.insertSkill({
      name: 'status-disabled',
      sourceType: 'upload',
      relPath: rel,
      detection,
    });

    const updated = await provision.provisionSkill(skill, { force: true });
    const view = registry.dependencyView(updated);

    assert.equal(view.status, 'failed');
    assert.equal(view.runnable, false);
    assert.ok(
      view.error && view.error.includes('HYPERION_SKILL_DEPS_DISABLED'),
      'the error must name the actual cause so the user can act on it',
    );
  });

  it('treats partial as not runnable and says which package failed', () => {
    const rel = writeSkill('status-partial', { 'requirements.txt': 'pandas\nnumpy\n' });
    const detection = deps.detectDependencies(path.join(testHome, 'skills', rel));
    const skill = registry.insertSkill({
      name: 'status-partial',
      sourceType: 'upload',
      relPath: rel,
      detection,
    });

    const updated = registry.recordDependencyOutcome(skill.id, {
      ...skill.deps,
      status: 'partial',
      installed: ['pandas'],
      failed: [
        {
          ecosystem: 'python',
          name: 'numpy',
          spec: 'numpy',
          error: 'no matching distribution found',
        },
      ],
      error: 'numpy: no matching distribution found',
      provisionedAt: Date.now(),
    });

    const view = registry.dependencyView(updated);
    assert.equal(view.status, 'partial');
    assert.equal(
      view.runnable,
      false,
      'half-installed would fail mid-task, which is what this feature prevents',
    );
    assert.equal(view.failed[0]?.name, 'numpy');
    assert.ok(view.failed[0]?.error.includes('no matching distribution'));
  });

  it('is runnable once everything declared is installed', () => {
    const rel = writeSkill('status-ready', { 'requirements.txt': 'pandas\n' });
    const root = path.join(testHome, 'skills', rel);
    const detection = deps.detectDependencies(root);
    const skill = registry.insertSkill({
      name: 'status-ready',
      sourceType: 'upload',
      relPath: rel,
      detection,
    });

    // Stand in for the venv the provisioner would have built. The registry only
    // checks that the recorded interpreter still exists.
    const interpreter = path.join(root, '.venv', 'bin', 'python');
    fs.mkdirSync(path.dirname(interpreter), { recursive: true });
    fs.writeFileSync(interpreter, '');

    const updated = registry.recordDependencyOutcome(skill.id, {
      ...skill.deps,
      status: 'ready',
      installed: ['pandas'],
      failed: [],
      error: null,
      provisionedAt: Date.now(),
      pythonPath: path.posix.join(rel, '.venv', 'bin', 'python'),
    });

    const view = registry.dependencyView(updated);
    assert.equal(view.status, 'ready');
    assert.equal(view.runnable, true);
    assert.equal(view.stale, false);
    assert.ok(
      view.pythonPath !== null && path.isAbsolute(view.pythonPath),
      'the interpreter path must be absolute, since a caller will spawn it',
    );
  });

  it('goes stale, and not runnable, when the manifest changes after installing', () => {
    const rel = writeSkill('status-stale', { 'requirements.txt': 'pandas\n' });
    const root = path.join(testHome, 'skills', rel);
    const detection = deps.detectDependencies(root);
    const skill = registry.insertSkill({
      name: 'status-stale',
      sourceType: 'upload',
      relPath: rel,
      detection,
    });
    registry.recordDependencyOutcome(skill.id, {
      ...skill.deps,
      status: 'ready',
      installed: ['pandas'],
      failed: [],
      error: null,
      provisionedAt: Date.now(),
    });

    assert.equal(registry.dependencyView(registry.requireSkill(skill.id)).runnable, true);

    // The user edited the skill by hand and added a package.
    fs.writeFileSync(path.join(root, 'requirements.txt'), 'pandas\nnumpy\n');

    const view = registry.dependencyView(registry.requireSkill(skill.id));
    assert.equal(view.stale, true);
    assert.equal(view.runnable, false, 'a changed manifest means the install is out of date');
  });

  it('goes stale when the installed artifacts are gone, as after a restore', () => {
    const rel = writeSkill('status-restored', { 'requirements.txt': 'pandas\n' });
    const root = path.join(testHome, 'skills', rel);
    const detection = deps.detectDependencies(root);
    const skill = registry.insertSkill({
      name: 'status-restored',
      sourceType: 'upload',
      relPath: rel,
      detection,
    });

    // A backup archive deliberately omits .venv/, so a restored row points at an
    // interpreter that isn't there.
    registry.recordDependencyOutcome(skill.id, {
      ...skill.deps,
      status: 'ready',
      installed: ['pandas'],
      failed: [],
      error: null,
      provisionedAt: Date.now(),
      pythonPath: path.posix.join(rel, '.venv', 'bin', 'python'),
    });

    const view = registry.dependencyView(registry.requireSkill(skill.id));
    assert.equal(view.stale, true);
    assert.equal(view.runnable, false);
    assert.ok(!fs.existsSync(path.join(root, '.venv')));
  });
});

describe('what consumers see', () => {
  it('puts the status on the summary the agentic layer reads', () => {
    const rel = writeSkill('summary-skill', { 'requirements.txt': 'pandas\n' });
    const detection = deps.detectDependencies(path.join(testHome, 'skills', rel));
    registry.insertSkill({
      name: 'summary-skill',
      description: 'Does a thing',
      sourceType: 'upload',
      relPath: rel,
      detection,
    });

    const entry = registry.skillsSummary().find((s) => s.name === 'summary-skill');
    assert.ok(entry, 'an enabled skill appears in the summary');
    assert.equal(entry.status, 'failed');
    assert.equal(
      entry.runnable,
      false,
      'the summary must carry the status, or a caller has to fetch every skill to find it',
    );
  });

  it('mentions an unrunnable skill in the prompt block rather than hiding it', () => {
    const block = registry.skillsPromptBlock();
    assert.ok(block.includes('summary-skill'), 'the user installed it on purpose');
    assert.ok(
      /dependencies not installed/i.test(block),
      'the model needs to know it cannot run the scripts yet',
    );
  });

  it('exposes the dependency block on the public shape', () => {
    const skill = registry.findSkillByName('summary-skill');
    assert.ok(skill);
    const view = registry.toPublic(skill);

    assert.ok(view.dependencies, 'dependencies ride on the existing skills response');
    for (const field of ['status', 'runnable', 'installing', 'stale', 'declared', 'failed']) {
      assert.ok(field in view.dependencies, `dependencies.${field} is part of the contract`);
    }
  });
});

/**
 * A skill that shells out to `ffmpeg` is as broken without it as one missing a
 * pip package, but the remedy is different: nothing failed, a person has to say
 * yes to installing something machine-wide. These cases cover the reading of that
 * requirement, and the state that represents the wait.
 */
describe('required system binaries', () => {
  it('reads requires_binaries from front matter, ignoring the version constraint', () => {
    const rel = writeSkill('bin-declared', {
      'SKILL.md': [
        '---',
        'name: Clip maker',
        'requires_binaries: [FFmpeg >= 6, pandoc]',
        '---',
        '',
        'Cuts video.',
      ].join('\n'),
    });
    const found = deps.detectDependencies(path.join(testHome, 'skills', rel));

    assert.deepEqual(
      found.binaries.map((binary) => binary.name),
      ['ffmpeg', 'pandoc'],
      'names are lowercased and ">= 6" is not part of a command name',
    );
    assert.ok(
      found.binaries.every((binary) => binary.declared),
      'the author asked for these, so they are not guesses',
    );
    assert.equal(
      found.noneDeclared,
      false,
      'a skill needing only a binary must not take the none-declared early exit, ' +
        'or the provisioner records it as runnable',
    );
    assert.deepEqual(found.deps, [], 'no packages were declared, only binaries');
  });

  it('ignores a requires_binaries entry that is not a plain command name', () => {
    const rel = writeSkill('bin-path', {
      'SKILL.md': [
        '---',
        'name: Odd one',
        'requires_binaries:',
        '  - /usr/local/bin/ffmpeg',
        '  - pandoc',
        '---',
      ].join('\n'),
    });
    const found = deps.detectDependencies(path.join(testHome, 'skills', rel));

    assert.deepEqual(
      found.binaries.map((binary) => binary.name),
      ['pandoc'],
      'an absolute path describes one machine, not a command to look for on PATH',
    );
    assert.ok(
      found.warnings.some((warning) => warning.includes('/usr/local/bin/ffmpeg')),
      'a silently dropped requirement would look like the skill needs nothing',
    );
  });

  it('infers a binary from the scripts when the author declared none', () => {
    const rel = writeSkill('bin-inferred', {
      'SKILL.md': '# Thumbnailer\n\nMakes thumbnails.\n',
      'run.py': 'import subprocess\nsubprocess.run(["ffmpeg", "-i", src, out])\n',
    });
    const found = deps.detectDependencies(path.join(testHome, 'skills', rel));

    const ffmpeg = found.binaries.find((binary) => binary.name === 'ffmpeg');
    assert.ok(ffmpeg, 'a skill that shells out to ffmpeg needs ffmpeg');
    assert.equal(ffmpeg.declared, false, 'this was a guess, and callers must be able to tell');
    assert.equal(ffmpeg.source, 'run.py', 'the guess names the file it came from');
  });

  it('does not guess when the author already declared what is needed', () => {
    const rel = writeSkill('bin-no-guess', {
      'SKILL.md': ['---', 'name: Converter', 'requires_binaries: pandoc', '---'].join('\n'),
      'run.py': 'subprocess.run(["ffmpeg", "-i", src, out])\n',
    });
    const found = deps.detectDependencies(path.join(testHome, 'skills', rel));

    assert.deepEqual(
      found.binaries.map((binary) => binary.name),
      ['pandoc'],
      'an explicit manifest is the answer; scanning past it would add a requirement ' +
        'the author did not ask for',
    );
  });

  it('a needs-user-approval row survives the database status CHECK', () => {
    const rel = writeSkill('bin-status', {
      'SKILL.md': ['---', 'name: Waiting', 'requires_binaries: ffmpeg', '---'].join('\n'),
    });
    const detection = deps.detectDependencies(path.join(testHome, 'skills', rel));
    const skill = registry.insertSkill({
      name: 'bin-status',
      description: 'Needs a system tool',
      sourceType: 'upload',
      relPath: rel,
      detection,
    });

    // What the provisioner writes when the probe found nothing on PATH. The write
    // fails outright if migration 009 did not widen the CHECK.
    registry.recordDependencyOutcome(skill.id, {
      ...skill.deps,
      status: 'needs-user-approval',
      binaries: [{ name: 'ffmpeg', declared: true, source: 'SKILL.md', present: false }],
      error: 'ffmpeg is not installed on this computer.',
      provisionedAt: Date.now(),
    });

    const view = registry.dependencyView(registry.requireSkill(skill.id));
    assert.equal(
      view.status,
      'needs-user-approval',
      'the status must survive the round trip; an unrecognised one falls back to ' +
        'none-declared, which reads as runnable',
    );
    assert.equal(view.runnable, false, 'the scripts would fail mid-task without ffmpeg');
    assert.deepEqual(view.missingBinaries, ['ffmpeg']);
    assert.equal(view.stale, false, 'nothing changed on disk, so this is not a stale install');
  });

  it('waiting on a person is not the same as having failed', () => {
    const skill = registry.findSkillByName('bin-status');
    assert.ok(skill);
    const view = registry.dependencyView(skill);

    assert.notEqual(
      view.status,
      'failed',
      'nothing went wrong — reporting a fault would send the user to retry an install ' +
        'instead of answering the question',
    );
    assert.deepEqual(view.failed, [], 'no dependency failed to install');
  });

  it('names the missing binary in the summary and the prompt block', () => {
    const entry = registry.skillsSummary().find((s) => s.name === 'bin-status');
    assert.ok(entry, 'an enabled skill appears in the summary');
    assert.deepEqual(
      entry.missingBinaries,
      ['ffmpeg'],
      'the caller writing the message to the user is the one reading this list',
    );

    const block = registry.skillsPromptBlock();
    assert.ok(/needs ffmpeg installed/i.test(block), 'the model can name what to ask for');
    assert.ok(
      block.includes('bin-status'),
      'the skill stays listed; hiding it would stop the model mentioning it at all',
    );
  });
});

/**
 * The HTTP half of the approval gate.
 *
 * Driven through a real server because the point being asserted is the contract a
 * frontend sees — that an unconfirmed request installs nothing, and that a refusal
 * arrives as an answer rather than an error the UI has to special-case.
 *
 * Neither case reaches `where`/`which` or a package manager: `installBinary`
 * refuses before probing, which is what makes it safe to assert here.
 */
describe('the approval route', () => {
  let server: import('node:http').Server;
  let base: string;
  let skillId: string;

  before(async () => {
    const rel = writeSkill('bin-route', {
      'SKILL.md': ['---', 'name: Route subject', 'requires_binaries: ffmpeg', '---'].join('\n'),
    });
    const detection = deps.detectDependencies(path.join(testHome, 'skills', rel));
    skillId = registry.insertSkill({
      name: 'bin-route',
      sourceType: 'upload',
      relPath: rel,
      detection,
    }).id;

    const { createApp } = await import('../src/http/app.ts');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected an AddressInfo from listen(0)');
    }
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('installs nothing when the request did not confirm', async () => {
    const res = await fetch(`${base}/api/skills/${skillId}/binaries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ffmpeg' }),
    });
    const payload = (await res.json()) as {
      installed: boolean;
      message: string;
      installable: boolean;
    };

    assert.equal(res.status, 200, 'a refusal is an answer about the machine, not a bad request');
    assert.equal(payload.installed, false);
    assert.match(payload.message, /confirmation/i, 'the message says what is missing');
    assert.equal(payload.installable, true, 'ffmpeg is on the curated list, so it can be offered');
  });

  it('says so plainly when a binary is not one it installs', async () => {
    const res = await fetch(`${base}/api/skills/${skillId}/binaries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'imagemagick', confirm: true }),
    });
    const payload = (await res.json()) as {
      installed: boolean;
      message: string;
      installable: boolean;
    };

    assert.equal(res.status, 200);
    assert.equal(payload.installed, false);
    assert.equal(payload.installable, false);
    assert.match(
      payload.message,
      /install it yourself/i,
      'an unknown binary gets instructions, not a shrug — confirm: true must not widen ' +
        'the allow-list',
    );
  });

  it('rejects a request with no binary named', async () => {
    const res = await fetch(`${base}/api/skills/${skillId}/binaries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const payload = (await res.json()) as { error: { code: string } };

    assert.equal(res.status, 400, 'this one the caller can fix by retyping');
    assert.equal(payload.error.code, 'bad_request');
  });

  it('keeps the skill readable at its own route afterwards', async () => {
    const res = await fetch(`${base}/api/skills/${skillId}`);
    const payload = (await res.json()) as {
      skill: { dependencies: { binaries: { name: string }[]; runnable: boolean } };
    };

    assert.equal(res.status, 200, 'POST /:id/binaries must not shadow GET /:id');
    assert.deepEqual(
      payload.skill.dependencies.binaries.map((binary) => binary.name),
      ['ffmpeg'],
      'the requirement is on the record the UI already fetches',
    );
    assert.equal(payload.skill.dependencies.runnable, false);
  });
});

