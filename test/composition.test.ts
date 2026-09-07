/** Production composition registers only the modules that are ready to run. */
import './helpers.ts';
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

const { registerProductionModules } = await import('../src/services/agent/composition.ts');
const { getAgent, getTerminal, registeredAgents, resetModules } = await import('../src/orchestrator/agents.ts');

afterEach(() => resetModules());

describe('production agent composition', () => {
  test('registers Cowork, Code, and terminal while leaving Design absent', () => {
    resetModules();

    registerProductionModules();

    assert.deepEqual(registeredAgents(), ['cowork', 'code']);
    assert.notEqual(getAgent('cowork'), null);
    assert.notEqual(getTerminal(), null);
    assert.notEqual(getAgent('code'), null);
    assert.equal(getAgent('design'), null);
  });
});