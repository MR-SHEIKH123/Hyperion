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
