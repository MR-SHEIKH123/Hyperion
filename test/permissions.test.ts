import './helpers.ts';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { PermissionLayer, PermissionVerdict, ToolCall } from '../src/types/core.ts';
import type { ToolEffect } from '../src/services/agent/loop.ts';

const { freshDb, cleanupHome } = await import('./helpers.ts');
const { AppError } = await import('../src/util/errors.ts');
const {
  ANY_MUTATE,
  ANY_READ,
  ANY_TOOL,
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
  options: { effect?: ToolEffect; knownTools?: ReadonlySet<string> } = {},
): PermissionVerdict {
  return evaluate({
    call: toolCall,
    effect: options.effect ?? 'mutate',
    layers,
    knownTools: options.knownTools ?? CODE_TOOLS,
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
