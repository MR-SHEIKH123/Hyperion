import './helpers.ts';

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { PermissionLayer, PermissionVerdict, ToolCall } from '../src/types/core.ts';
import type { ToolEffect } from '../src/services/agent/loop.ts';

const { freshDb, cleanupHome } = await import('./helpers.ts');
const { AppError } = await import('../src/util/errors.ts');
const {
  ANY_MUTATE,
  ANY_READ,
  ANY_TOOL,
  assertNoPermissionKeyCollisions,
  createPermissionResolver,
  describeVerdict,
  evaluate,
  parsePermissionRules,
  parsePermissionScalar,
  permissionKey,
  primaryArgument,
} = await import('../src/services/agent/permissions.ts');

import type { PermissionLayerInput, PermissionRules } from '../src/services/agent/permissions.ts';

const CODE_TOOLS = new Set(['read', 'write', 'restore', 'bash', 'command', 'delegate']);

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `c-${name}`, name, arguments: JSON.stringify(args) };
}

function layer(name: PermissionLayer, rules: PermissionRules): PermissionLayerInput {
  return { layer: name, rules };
}

function decide(
  toolCall: ToolCall,
  layers: PermissionLayerInput[],
  options: {
    effect?: ToolEffect;
    knownTools?: ReadonlySet<string>;
    pathResolver?: (candidate: string) => string;
  } = {},
): PermissionVerdict {
  return evaluate({
    call: toolCall,
    effect: options.effect ?? 'mutate',
    layers,
    knownTools: options.knownTools ?? CODE_TOOLS,
    ...(options.pathResolver === undefined ? {} : { pathResolver: options.pathResolver }),
  });
}

before(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

describe('layer order', () => {
  it('lets a later layer override an earlier one', () => {
    const verdict = decide(call('write', { path: 'a.ts' }), [
      layer('builtin', { write: 'deny' }),
      layer('project', { write: 'allow' }),
    ]);

    assert.equal(verdict.action, 'allow');
    assert.equal(verdict.layer, 'project');
  });

  it('falls through a layer that has no opinion rather than treating silence as an answer', () => {
    // The distinction that matters: a layer which omits a key must not reset the
    // verdict to its own catch-all-less default, or every narrow layer added later
    // would silently erase the one before it.
    const verdict = decide(call('read', { path: 'a.ts' }), [
      layer('builtin', { read: 'allow' }),
      layer('project', { bash: 'deny' }),
      layer('session', {}),
    ]);

    assert.equal(verdict.action, 'allow');
    assert.equal(verdict.layer, 'builtin');
  });

  it('gives the session layer the last word over the project file', () => {
    const verdict = decide(call('bash', { command: 'npm test' }), [
      layer('builtin', { [ANY_TOOL]: 'allow' }),
      layer('project', { bash: 'deny' }),
      layer('session', { bash: 'allow' }),
    ]);

    assert.equal(verdict.action, 'allow');
    assert.equal(verdict.layer, 'session');
  });

  it('denies when no layer says anything at all', () => {
    // Never "no answer": a caller with no verdict has to invent one, and the
    // invented one is always the permissive one.
    const verdict = decide(call('write', { path: 'a.ts' }), [layer('project', { read: 'allow' })]);

    assert.equal(verdict.action, 'deny');
    assert.equal(verdict.layer, 'builtin');
  });
});

describe('the inherited ceiling', () => {
  it('cannot be overridden downward', () => {
    // A parent's denial is the whole point of denial inheritance. If a child's own
    // profile could reverse it, a Plan-mode parent could delegate its way to a
    // writable child.
    const verdict = decide(call('write', { path: 'a.ts' }), [
      layer('profile', { write: 'allow' }),
      layer('session', { write: 'allow' }),
      layer('inherited', { write: 'deny' }),
    ]);

    assert.equal(verdict.action, 'deny');
    assert.equal(verdict.layer, 'inherited');
  });

  it('never widens what an earlier layer denied', () => {
    const verdict = decide(call('write', { path: 'a.ts' }), [
      layer('project', { write: 'deny' }),
      layer('inherited', { write: 'allow' }),
    ]);

    assert.equal(verdict.action, 'deny');
    assert.equal(verdict.layer, 'project', 'an inherited allow must not become the deciding layer');
  });
});

describe('glob matching', () => {
  it('matches the tool\'s own primary argument', () => {
    const rules: PermissionRules = { write: { 'src/**': 'allow', '*': 'deny' } };

    assert.equal(decide(call('write', { path: 'src/a/b.ts' }), [layer('profile', rules)]).action, 'allow');
    assert.equal(decide(call('write', { path: 'docs/a.md' }), [layer('profile', rules)]).action, 'deny');
  });

  it('reports the pattern that decided, not just the action', () => {
    const verdict = decide(call('write', { path: 'src/a.ts' }), [
      layer('project', { write: { 'src/**': 'allow', '*': 'deny' } }),
    ]);

    assert.equal(verdict.pattern, 'src/**');
    assert.match(describeVerdict(verdict), /project:src\/\*\*/);
  });

  it('prefers the more specific pattern regardless of key order', () => {
    // Object key order is an authoring accident. A rule file that happens to list
    // `*` first must not shadow the specific pattern under it.
    const verdict = decide(call('write', { path: 'src/a.ts' }), [
      layer('project', { write: { '*': 'deny', 'src/**': 'allow' } }),
    ]);

    assert.equal(verdict.action, 'allow');
    assert.equal(verdict.pattern, 'src/**');
  });

  it('normalizes Windows separators before matching', () => {
    const verdict = decide(call('write', { path: 'src\\nested\\a.ts' }), [
      layer('project', { write: { 'src/**': 'allow', '*': 'deny' } }),
    ]);

    assert.equal(verdict.action, 'allow');
  });

  it('uses command for bash and selector for command', () => {
    assert.equal(primaryArgument(call('bash', { command: 'npm test' })), 'npm test');
    assert.equal(primaryArgument(call('command', { selector: 'lint' })), 'lint');
    assert.equal(primaryArgument(call('read', { path: 'a.ts' })), 'a.ts');
  });

  it('reads delegate\'s prose from either the single or the batch form', () => {
    assert.equal(primaryArgument(call('delegate', { prompt: 'do a thing' })), 'do a thing');
    assert.equal(primaryArgument(call('delegate', { prompts: ['first', 'second'] })), 'first');
  });

  it('treats malformed arguments as naming nothing rather than guessing', () => {
    // A model that emitted broken JSON has not named a path, and matching the
    // broken text against a glob could allow a write by accident.
    const broken: ToolCall = { id: 'x', name: 'write', arguments: '{"path":' };
    assert.equal(primaryArgument(broken), null);

    const verdict = decide(broken, [layer('project', { write: { '**': 'allow' } })]);
    assert.equal(verdict.action, 'deny', 'a map rule with nothing to match must not apply');
  });
});

describe('a path rule matches the file, not the spelling', () => {
  // Everything below turns on one fact: the file tools resolve their argument
  // before touching disk (`ctx.resolvePath`, then the same containment check the
  // write itself uses), so all of these spellings name *one* file. A rule matched
  // against the raw argument would govern the string instead of the file —
  // `{"secrets/**": "deny"}` would refuse `secrets/key.txt` and allow
  // `./secrets/key.txt`, and the write would land in the denied directory.
  const denied: PermissionRules = { write: { 'secrets/**': 'deny', '*': 'allow' } };

  it('refuses every spelling of a denied file', () => {
    for (const spelling of [
      'secrets/key.txt',
      './secrets/key.txt',
      'src/../secrets/key.txt',
      './/secrets/key.txt',
      'secrets/./key.txt',
      'secrets//key.txt',
    ]) {
      const verdict = decide(call('write', { path: spelling }), [layer('project', denied)]);
      assert.equal(
        verdict.action,
        'deny',
        `${spelling} resolves to the same file as secrets/key.txt`,
      );
    }
  });

  it('spells one file one way on disk, which is why the verdict has to agree', async () => {
    const { resolveInScope } = await import('../src/security/fsScope.ts');
    const target = resolveInScope('projects', 'demo/secrets/key.txt');

    for (const spelling of ['./secrets/key.txt', 'src/../secrets/key.txt', './/secrets/key.txt']) {
      assert.equal(
        resolveInScope('projects', `demo/${spelling}`),
        target,
        `${spelling} must be the file the rule refused`,
      );
    }
  });

  it('still allows what the rule allowed, and still denies what it did not', () => {
    const scoped: PermissionRules = { write: { 'src/**': 'allow', '*': 'deny' } };

    assert.equal(
      decide(call('write', { path: 'src/./a.ts' }), [layer('project', scoped)]).action,
      'allow',
      'normalising must not turn a spelling of an allowed file into a refusal',
    );
    assert.equal(
      decide(call('write', { path: '../outside/a.ts' }), [layer('project', scoped)]).action,
      'deny',
      'a leading .. cannot be popped, so it cannot reach a rule written for the workspace',
    );
  });

  it('matches an absolute path once the agent supplies its own resolver', async () => {
    // The engine does not know which root a run is confined to, so this is the
    // seam: the caller hands over the same resolver its file tools use, reduced to
    // a workspace-relative path (patterns are authored relative to the project).
    // Absolute spellings matter because the tools accept them — `resolveInScope`
    // takes an absolute candidate as long as it is inside the scope.
    const { resolveInScope } = await import('../src/security/fsScope.ts');
    const workspace = resolveInScope('projects', 'demo');
    const pathResolver = (candidate: string): string =>
      path.relative(workspace, resolveInScope('projects', candidate)).split(path.sep).join('/');

    const absolute = path.join(workspace, 'secrets', 'key.txt');
    assert.equal(
      decide(call('write', { path: absolute }), [layer('project', denied)], { pathResolver }).action,
      'deny',
    );

    // Without the seam a relative pattern cannot match an absolute spelling at
    // all. Asserted rather than left implicit: this is why the Code adapter must
    // pass a resolver, and a caller that quietly stops passing one fails here
    // instead of silently reopening the hole the case above closes.
    assert.equal(
      decide(call('write', { path: absolute }), [layer('project', denied)]).action,
      'allow',
    );
  });

  it('falls back to the lexical form when the resolver refuses the path', () => {
    const verdict = decide(call('write', { path: './secrets/key.txt' }), [layer('project', denied)], {
      pathResolver: () => {
        throw new Error('scope violation');
      },
    });

    assert.equal(verdict.action, 'deny', 'a refused path is the tool\'s refusal to report, not an allow');
  });
});

describe('the effect-qualified catch-alls', () => {
  it('let a rule cover every read without naming a tool', () => {
    // This is what makes the `plan` built-in work across agents: which tools only
    // read is a fact about the agent, not about the profile.
    const rules: PermissionRules = { [ANY_READ]: 'allow', [ANY_MUTATE]: 'deny' };

    assert.equal(decide(call('read', { path: 'a' }), [layer('builtin', rules)], { effect: 'read' }).action, 'allow');
    assert.equal(decide(call('write', { path: 'a' }), [layer('builtin', rules)], { effect: 'mutate' }).action, 'deny');
  });

  it('bind more tightly than the bare catch-all', () => {
    const verdict = decide(call('read', { path: 'a' }), [
      layer('builtin', { [ANY_READ]: 'allow', [ANY_TOOL]: 'deny' }),
    ], { effect: 'read' });

    assert.equal(verdict.action, 'allow');
  });

  it('bind less tightly than an exact tool name', () => {
    const verdict = decide(call('read', { path: 'a' }), [
      layer('profile', { read: 'deny', [ANY_READ]: 'allow' }),
    ], { effect: 'read' });

    assert.equal(verdict.action, 'deny');
    assert.equal(verdict.pattern, null, 'an exact scalar rule has no pattern');
  });
});

describe('an unknown tool', () => {
  it('is denied even when a catch-all would allow it', () => {
    // Mirrors the loop's "an unclassified tool is mutating" stance. This layer can
    // grant more than Plan mode ever could, so the default has to be no.
    const verdict = decide(call('teleport'), [layer('builtin', { [ANY_TOOL]: 'allow' })]);

    assert.equal(verdict.action, 'deny');
    assert.equal(verdict.layer, 'builtin');
  });

  it('is denied against the running agent\'s own tool set, not a global list', () => {
    const verdict = decide(call('write', { path: 'a' }), [layer('builtin', { [ANY_TOOL]: 'allow' })], {
      knownTools: new Set(['read']),
    });

    assert.equal(verdict.action, 'deny', 'a tool this agent never registered cannot be allowed');
  });
});

describe('MCP key derivation', () => {
  it('turns a dotted wire name into an underscored key', () => {
    assert.equal(permissionKey('wigolo.search'), 'wigolo_search');
    assert.equal(permissionKey('cowork.save_artifact'), 'cowork_save_artifact');
  });

  it('leaves a flat name alone', () => {
    assert.equal(permissionKey('bash'), 'bash');
  });

  it('is what a rule is written against, while the wire name stays dotted', () => {
    const verdict = decide(call('wigolo.search', { query: 'x' }), [
      layer('project', { wigolo_search: 'allow' }),
    ], { knownTools: new Set(['wigolo.search']), effect: 'read' });

    assert.equal(verdict.action, 'allow');
    assert.equal(verdict.key, 'wigolo_search');
  });

  it('rejects registration of tools that collide under permissionKey normalization', () => {
    // Both 'a.b_c' and 'a_b.c' normalize to 'a_b_c', which would lead to silent permission sharing.
    // The resolver must fail closed by rejecting the registration.
    assert.throws(
      () =>
        createPermissionResolver({
          layers: [layer('project', { a_b_c: 'allow' })],
          knownTools: new Set(['a.b_c', 'a_b.c']),
        }),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'bad_request' &&
        /collision/i.test(err.message),
    );

    // Non-colliding tools register cleanly
    assert.doesNotThrow(() =>
      createPermissionResolver({
        layers: [layer('project', { a_b_c: 'allow', other_tool: 'deny' })],
        knownTools: new Set(['a.b_c', 'other.tool']),
      }),
    );
  });
});

describe('the credential downgrade', () => {
  it('turns an allowed write into an ask when the content looks like a key', () => {
    const verdict = decide(
      call('write', { path: 'src/config.ts', content: 'export const key = "sk-live-ABCDEFGHIJKLMNOPQRST";' }),
      [layer('project', { write: 'allow' })],
    );

    assert.equal(verdict.action, 'ask');
  });

  it('keeps the rule that allowed it in the provenance', () => {
    // The user's rule was honoured and then overridden by a finding. Reporting the
    // rule as the thing that failed would send them to edit the wrong line.
    const verdict = decide(
      call('write', { path: 'src/a.ts', content: 'Authorization: Bearer abcdefghijklmnopqrstuvwx' }),
      [layer('project', { write: { 'src/**': 'allow' } })],
    );

    assert.equal(verdict.action, 'ask');
    assert.equal(verdict.layer, 'project');
    assert.equal(verdict.pattern, 'src/**');
  });

  it('leaves an ordinary write alone', () => {
    const verdict = decide(
      call('write', { path: 'src/a.ts', content: 'export const answer = 42;' }),
      [layer('project', { write: 'allow' })],
    );

    assert.equal(verdict.action, 'allow');
  });

  it('does not upgrade a denial into an ask', () => {
    const verdict = decide(
      call('write', { path: 'a.ts', content: 'sk-live-ABCDEFGHIJKLMNOPQRST' }),
      [layer('project', { write: 'deny' })],
    );

    assert.equal(verdict.action, 'deny', 'a refused write is already not happening');
  });

  it('applies to restore, which also puts content back on disk', () => {
    const verdict = decide(
      call('restore', { path: 'src/a.ts', content: 'Authorization: Bearer abcdefghijklmnopqrstuvwx' }),
      [layer('project', { restore: 'allow' })],
    );

    assert.equal(verdict.action, 'ask');
  });

  it('leaves a read alone even when the path is suspicious', () => {
    // Reading is not exfiltration; the outbound check owns that boundary. Asking
    // here would interrupt the ordinary act of looking at a config file.
    const verdict = decide(
      call('read', { path: 'secrets/api_key=sk-live-ABCDEFGHIJKLMNOPQRST' }),
      [layer('project', { read: 'allow' })],
      { effect: 'read' },
    );

    assert.equal(verdict.action, 'allow');
  });
});

describe('parsing an untrusted permissions block', () => {
  it('accepts a scalar and a glob map', () => {
    const rules = parsePermissionRules({ bash: 'ask', write: { 'src/**': 'allow', '*': 'deny' } }, 'test');

    assert.equal(rules.bash, 'ask');
    assert.deepEqual(rules.write, { 'src/**': 'allow', '*': 'deny' });
  });

  it('rejects an unknown action instead of dropping the rule', () => {
    // A silently dropped rule presents as a permission the user believes they
    // granted and did not.
    assert.throws(
      () => parsePermissionRules({ bash: 'maybe' }, 'test'),
      (error: unknown) => error instanceof AppError && error.code === 'bad_request',
    );
  });

  it('rejects a non-object block', () => {
    for (const bad of [[], 'allow', 42, null]) {
      assert.throws(
        () => parsePermissionRules(bad, 'test'),
        (error: unknown) => error instanceof AppError && error.code === 'bad_request',
      );
    }
  });

  it('validates each glob at parse time, not at the call it would govern', () => {
    // A broken pattern discovered mid-run is a broken pattern discovered after the
    // agent already started working.
    assert.throws(
      () => parsePermissionRules({ write: { '/absolute': 'allow' } }, 'test'),
      (error: unknown) => error instanceof AppError && error.code === 'bad_request',
    );
  });

  it('reads a JSON block written as one front-matter scalar', () => {
    const rules = parsePermissionScalar('{"bash":"ask","write":{"src/**":"allow"}}', 'test');

    assert.equal(rules.bash, 'ask');
    assert.deepEqual(rules.write, { 'src/**': 'allow' });
  });

  it('rejects an unparseable front-matter block with a usable message', () => {
    assert.throws(
      () => parsePermissionScalar('{bash: ask}', 'test'),
      (error: unknown) => error instanceof AppError && /valid JSON/.test(error.message),
    );
  });
});

describe('the bound resolver', () => {
  it('answers per call from one prepared layer stack', () => {
    const resolve = createPermissionResolver({
      layers: [layer('builtin', { [ANY_READ]: 'allow', [ANY_MUTATE]: 'deny' })],
      knownTools: CODE_TOOLS,
    });

    assert.equal(resolve({ call: call('read', { path: 'a' }), effect: 'read' }).action, 'allow');
    assert.equal(resolve({ call: call('write', { path: 'a' }), effect: 'mutate' }).action, 'deny');
  });
});
