import './helpers.ts';

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

const { freshDb, cleanupHome, testHome } = await import('./helpers.ts');
const { AppError } = await import('../src/util/errors.ts');
const { setSetting } = await import('../src/db/settings.ts');
const {
  BUILTIN_PROFILES,
  builtinProfile,
  DEFAULT_AGENT_PROFILE_KEY,
  defaultAgentProfileName,
  listProfiles,
  permissionLayers,
  profileRules,
  resolveProfile,
  assertKnownTools,
} = await import('../src/services/agent/profiles.ts');
const { evaluate, ANY_TOOL } = await import('../src/services/agent/permissions.ts');
const { loadAgentProfile, loadProjectPermissions, loadProjectProfiles } = await import(
  '../src/services/code/projectContext.ts'
);

import type { AgentProfile, ToolCall } from '../src/types/core.ts';
import type { ProfileSource } from '../src/services/agent/profiles.ts';
import type { ToolEffect } from '../src/services/agent/loop.ts';

const CODE_TOOLS = new Set(['read', 'write', 'restore', 'bash', 'command', 'delegate']);

let counter = 0;

/** A project directory with `.hyperion/agents/<name>.md` files written into it. */
async function project(files: Record<string, string>, permissions?: string): Promise<string> {
  counter += 1;
  const name = `profiles-${counter}`;
  const root = join(testHome, 'projects', name);
  await mkdir(join(root, '.hyperion', 'agents'), { recursive: true });
  for (const [filename, contents] of Object.entries(files)) {
    await writeFile(join(root, '.hyperion', 'agents', filename), contents, 'utf8');
  }
  if (permissions !== undefined) {
    await writeFile(join(root, '.hyperion', 'permissions.json'), permissions, 'utf8');
  }
  return name;
}

function source(projectDir: string): ProfileSource {
  return {
    load: (selector) => loadAgentProfile(projectDir, selector),
    list: () => loadProjectProfiles(projectDir),
  };
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `c-${name}`, name, arguments: JSON.stringify(args) };
}

function decide(profile: AgentProfile, toolCall: ToolCall, effect: ToolEffect) {
  return evaluate({
    call: toolCall,
    effect,
    layers: permissionLayers({ profile }),
    knownTools: CODE_TOOLS,
  });
}

before(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

beforeEach(() => {
  setSetting(DEFAULT_AGENT_PROFILE_KEY, null);
});

describe('the built-in three', () => {
  it('reproduce the old mode gate exactly', () => {
    // The load-bearing assertion for the whole reframe. If these drift, every user
    // who never opens this feature silently gets different behaviour from the same
    // UI control — see services/agent/profiles.ts.
    const ask = builtinProfile('ask');
    const plan = builtinProfile('plan');
    const act = builtinProfile('act');
    assert.ok(ask && plan && act);

    assert.equal(decide(ask, call('read', { path: 'a' }), 'read').action, 'deny');
    assert.equal(decide(ask, call('write', { path: 'a' }), 'mutate').action, 'deny');

    assert.equal(decide(plan, call('read', { path: 'a' }), 'read').action, 'allow');
    assert.equal(decide(plan, call('write', { path: 'a' }), 'mutate').action, 'deny');

    assert.equal(decide(act, call('read', { path: 'a' }), 'read').action, 'allow');
    assert.equal(decide(act, call('write', { path: 'a' }), 'mutate').action, 'allow');
  });

  it('treat an unclassified tool as mutating, so Plan refuses it', () => {
    const plan = builtinProfile('plan');
    assert.ok(plan);
    // `mutate` is what the loop folds `undefined` into before it ever gets here.
    assert.equal(decide(plan, call('delegate', { prompt: 'x' }), 'mutate').action, 'deny');
  });

  it('are frozen, so nothing can rewrite the baseline in place', () => {
    const act = builtinProfile('act');
    assert.ok(act);
    assert.throws(() => {
      (act as { name: string }).name = 'tampered';
    });
  });

  it('contribute their rules as the builtin layer and not twice', () => {
    // A built-in's rules *are* the builtin layer. Contributing them again as a
    // `profile` layer would make every verdict's provenance read `profile`.
    const act = builtinProfile('act');
    assert.ok(act);
    assert.deepEqual(profileRules(act), {});

    const layers = permissionLayers({ profile: act });
    assert.deepEqual(layers.map((entry) => entry.layer), ['builtin']);
  });
});

describe('resolution order', () => {
  it('honours an explicit selector over everything else', async () => {
    const dir = await project({
      'auditor.md': '---\nname: auditor\nmode: plan\n---\nRead-only reviewer.\n',
    });
    setSetting(DEFAULT_AGENT_PROFILE_KEY, 'act');

    const profile = await resolveProfile({ mode: 'act', selector: 'auditor', source: source(dir) });
    assert.equal(profile.name, 'auditor');
    assert.equal(profile.mode, 'plan');
  });

  it('keeps Ask and Plan out of reach of the stored default', async () => {
    // Both are explicit, per-run restrictions. A stored setting that could widen
    // them would make a safety control advisory.
    const dir = await project({
      'wide.md': `---\nname: wide\nmode: act\npermissions: {"${ANY_TOOL}":"allow"}\n---\nEverything.\n`,
    });
    setSetting(DEFAULT_AGENT_PROFILE_KEY, 'wide');

    for (const mode of ['ask', 'plan'] as const) {
      const profile = await resolveProfile({ mode, source: source(dir) });
      assert.equal(profile.name, mode, `${mode} must not be replaced by the stored default`);
      assert.equal(profile.builtin, true);
    }
  });

  it('applies the stored default to Act, which is where it means something', async () => {
    const dir = await project({
      'house.md': '---\nname: house\nmode: act\npermissions: {"bash":"ask"}\n---\nHouse rules.\n',
    });
    setSetting(DEFAULT_AGENT_PROFILE_KEY, 'house');

    const profile = await resolveProfile({ mode: 'act', source: source(dir) });
    assert.equal(profile.name, 'house');
  });

  it('falls back to the act built-in when nothing is stored', async () => {
    const profile = await resolveProfile({ mode: 'act', source: source(await project({})) });
    assert.equal(profile.name, 'act');
    assert.equal(profile.builtin, true);
  });

  it('lets a project shadow a built-in name with its own file', async () => {
    const dir = await project({
      'act.md': '---\nname: act\nmode: act\npermissions: {"bash":"deny"}\n---\nNo shell here.\n',
    });

    const profile = await resolveProfile({ mode: 'act', selector: 'act', source: source(dir) });
    assert.equal(profile.builtin, false, 'the project file must win over the in-code profile');
    assert.equal(decide(profile, call('bash', { command: 'ls' }), 'mutate').action, 'deny');
  });

  it('refuses an unresolvable selector rather than quietly running something else', async () => {
    // Running a task under different permissions from the ones the caller asked
    // for is the one outcome nobody wants.
    await assert.rejects(
      resolveProfile({ mode: 'act', selector: 'nope', source: source(await project({})) }),
      (error: unknown) => error instanceof AppError && error.code === 'not_found',
    );
  });

  it('surfaces a malformed profile instead of falling back to act', async () => {
    const dir = await project({
      'broken.md': '---\nname: broken\npermissions: {not json}\n---\nBroken.\n',
    });

    await assert.rejects(
      resolveProfile({ mode: 'act', selector: 'broken', source: source(dir) }),
      (error: unknown) => error instanceof AppError && error.code === 'bad_request',
    );
  });

  it('ignores a stored default that names a subagent-only profile', async () => {
    // A misconfigured setting must not break every run until somebody notices.
    const dir = await project({
      'worker.md': '---\nname: worker\nvisibility: subagent\n---\nA worker.\n',
    });
    setSetting(DEFAULT_AGENT_PROFILE_KEY, 'worker');

    const profile = await resolveProfile({ mode: 'act', source: source(dir) });
    assert.equal(profile.name, 'act');
  });

  it('reads the stored default back as null when unset, not as act', async () => {
    assert.equal(defaultAgentProfileName(), null);
  });
});

describe('visibility and hidden are independent', () => {
  it('rejects a subagent-only profile as a primary selection', async () => {
    const dir = await project({
      'worker.md': '---\nname: worker\nvisibility: subagent\n---\nA worker.\n',
    });

    await assert.rejects(
      resolveProfile({ mode: 'act', selector: 'worker', source: source(dir) }),
      (error: unknown) => error instanceof AppError && error.code === 'bad_request',
    );
  });

  it('allows the same profile for a delegated child', async () => {
    const dir = await project({
      'worker.md': '---\nname: worker\nvisibility: subagent\n---\nA worker.\n',
    });

    const profile = await resolveProfile({
      mode: 'act',
      selector: 'worker',
      source: source(dir),
      forSubagent: true,
    });
    assert.equal(profile.name, 'worker');
  });

  it('keeps a hidden profile resolvable by name', async () => {
    // `hidden` affects listings only. A personal shortcut is a real reason to want
    // a profile that works but does not clutter the picker.
    const dir = await project({
      'shortcut.md': '---\nname: shortcut\nhidden: true\n---\nMine.\n',
    });

    const profile = await resolveProfile({ mode: 'act', selector: 'shortcut', source: source(dir) });
    assert.equal(profile.name, 'shortcut');
    assert.equal(profile.hidden, true);
  });

  it('omits a hidden profile from a listing unless asked for', async () => {
    const dir = await project({
      'shortcut.md': '---\nname: shortcut\nhidden: true\n---\nMine.\n',
      'shown.md': '---\nname: shown\n---\nVisible.\n',
    });

    const listed = await listProfiles(source(dir));
    assert.equal(listed.some((profile) => profile.name === 'shortcut'), false);
    assert.equal(listed.some((profile) => profile.name === 'shown'), true);

    const all = await listProfiles(source(dir), { includeHidden: true });
    assert.equal(all.some((profile) => profile.name === 'shortcut'), true);
  });

  it('lists a subagent-only profile that is not hidden', async () => {
    // The two flags are orthogonal: a documented worker a parent delegates to is
    // worth showing even though nobody drives it directly.
    const dir = await project({
      'worker.md': '---\nname: worker\nvisibility: subagent\n---\nA worker.\n',
    });

    const listed = await listProfiles(source(dir));
    assert.equal(listed.some((profile) => profile.name === 'worker'), true);
  });

  it('always includes the built-ins in a listing', async () => {
    const listed = await listProfiles(source(await project({})));
    for (const builtin of BUILTIN_PROFILES) {
      assert.equal(listed.some((profile) => profile.name === builtin.name), true, `${builtin.name} is missing`);
    }
  });
});

describe('front matter', () => {
  it('parses a JSON permission block from one scalar', async () => {
    const dir = await project({
      'scoped.md': '---\nname: scoped\nmode: act\npermissions: {"bash":"ask","write":{"src/**":"allow","*":"deny"}}\n---\nScoped.\n',
    });

    const profile = await loadAgentProfile(dir, 'scoped');
    assert.equal(profile.permissions?.bash, 'ask');
    assert.deepEqual(profile.permissions?.write, { 'src/**': 'allow', '*': 'deny' });

    assert.equal(decide(profile, call('write', { path: 'src/a.ts' }), 'mutate').action, 'allow');
    assert.equal(decide(profile, call('write', { path: 'docs/a.md' }), 'mutate').action, 'deny');
    assert.equal(decide(profile, call('bash', { command: 'ls' }), 'mutate').action, 'ask');
  });

  it('defaults a profile with no declarations to the act baseline', async () => {
    const dir = await project({ 'plain.md': '---\nname: plain\n---\nNothing declared.\n' });

    const profile = await loadAgentProfile(dir, 'plain');
    assert.equal(profile.mode, 'act');
    assert.equal(profile.visibility, 'primary');
    assert.equal(profile.hidden, false);
    assert.equal(profile.variant, null);
    assert.equal(profile.permissions, null);
    assert.equal(profile.builtin, false);
  });

  it('specializes a base mode rather than starting from nothing', async () => {
    // The point of `mode:` on a project profile: start from Plan's read-only
    // baseline and open exactly one hole in it.
    const dir = await project({
      'docs.md': '---\nname: docs\nmode: plan\npermissions: {"write":{"docs/**":"allow"}}\n---\nDocs only.\n',
    });

    const profile = await loadAgentProfile(dir, 'docs');
    assert.equal(decide(profile, call('read', { path: 'src/a.ts' }), 'read').action, 'allow');
    assert.equal(decide(profile, call('write', { path: 'docs/a.md' }), 'mutate').action, 'allow');
    assert.equal(decide(profile, call('write', { path: 'src/a.ts' }), 'mutate').action, 'deny');
  });

  it('turns a declared tool list into rules so a refusal stays legible', async () => {
    const dir = await project({ 'reader.md': '---\nname: reader\ntools: [read]\n---\nReader.\n' });

    const profile = await loadAgentProfile(dir, 'reader');
    assert.deepEqual(profile.tools, ['read']);

    const verdict = decide(profile, call('bash', { command: 'ls' }), 'mutate');
    assert.equal(verdict.action, 'deny');
    assert.equal(verdict.layer, 'profile', 'the refusal must name the profile, not an unknown tool');
  });

  it('reads a variant and rejects one it does not recognise', async () => {
    const good = await project({ 'deep.md': '---\nname: deep\nvariant: high\n---\nThink hard.\n' });
    assert.equal((await loadAgentProfile(good, 'deep')).variant, 'high');

    const bad = await project({ 'odd.md': '---\nname: odd\nvariant: maximum\n---\nNope.\n' });
    await assert.rejects(
      loadAgentProfile(bad, 'odd'),
      (error: unknown) => error instanceof AppError && error.code === 'bad_request',
    );
  });

  it('rejects an unknown visibility rather than defaulting it to primary', async () => {
    // Silently ignoring `visibility: subagnet` grants a profile to the primary
    // picker that its author meant to withhold.
    const dir = await project({ 'typo.md': '---\nname: typo\nvisibility: subagnet\n---\nOops.\n' });

    await assert.rejects(
      loadAgentProfile(dir, 'typo'),
      (error: unknown) => error instanceof AppError && error.code === 'bad_request',
    );
  });

  it('accepts the lenient boolean spellings front matter is written with', async () => {
    for (const [index, spelling] of ['true', 'yes', '1'].entries()) {
      const dir = await project({ [`h${index}.md`]: `---\nname: h${index}\nhidden: ${spelling}\n---\nHidden.\n` });
      assert.equal((await loadAgentProfile(dir, `h${index}`)).hidden, true, spelling);
    }
    const dir = await project({ 'shown.md': '---\nname: shown\nhidden: false\n---\nShown.\n' });
    assert.equal((await loadAgentProfile(dir, 'shown')).hidden, false);
  });
});

describe('the project permission file', () => {
  it('reads real JSON and applies over the profile', async () => {
    const dir = await project(
      { 'wide.md': '---\nname: wide\nmode: act\npermissions: {"write":"allow"}\n---\nWide.\n' },
      '{"write":"deny"}',
    );

    const profile = await loadAgentProfile(dir, 'wide');
    const projectRules = await loadProjectPermissions(dir);
    const verdict = evaluate({
      call: call('write', { path: 'a.ts' }),
      effect: 'mutate',
      layers: permissionLayers({ profile, project: projectRules }),
      knownTools: CODE_TOOLS,
    });

    assert.equal(verdict.action, 'deny');
    assert.equal(verdict.layer, 'project');
  });

  it('reads an absent file as no rules rather than an error', async () => {
    assert.deepEqual(await loadProjectPermissions(await project({})), {});
  });

  it('refuses a malformed file instead of running with rules the user did not write', async () => {
    const dir = await project({}, '{not json}');

    await assert.rejects(
      loadProjectPermissions(dir),
      (error: unknown) => error instanceof AppError && error.code === 'bad_request',
    );
  });
});

describe('tool validation against the running agent', () => {
  it('accepts a profile naming only registered tools', async () => {
    const dir = await project({ 'reader.md': '---\nname: reader\ntools: [read, bash]\n---\nReader.\n' });
    const profile = await loadAgentProfile(dir, 'reader');

    assert.doesNotThrow(() => assertKnownTools(profile, CODE_TOOLS));
  });

  it('rejects a profile naming a tool this agent does not have', async () => {
    // This is the runtime check that replaced the compile-time CodeToolName[]. It
    // is strictly better placed: the old one could never have validated an MCP
    // tool name, because those are not known until a server is configured.
    const dir = await project({ 'odd.md': '---\nname: odd\ntools: [teleport]\n---\nOdd.\n' });
    const profile = await loadAgentProfile(dir, 'odd');

    assert.throws(
      () => assertKnownTools(profile, CODE_TOOLS),
      (error: unknown) => error instanceof AppError && error.code === 'bad_request',
    );
  });

  it('accepts a dotted MCP tool name against the agent that registered it', async () => {
    const dir = await project({ 'searcher.md': '---\nname: searcher\ntools: [wigolo.search]\n---\nSearcher.\n' });
    const profile = await loadAgentProfile(dir, 'searcher');

    assert.doesNotThrow(() => assertKnownTools(profile, new Set(['wigolo.search'])));
  });

  it('accepts a profile declaring no tool list at all', async () => {
    const dir = await project({ 'plain.md': '---\nname: plain\n---\nPlain.\n' });
    const profile = await loadAgentProfile(dir, 'plain');

    assert.doesNotThrow(() => assertKnownTools(profile, new Set()));
  });
});
