import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before, describe } from 'node:test';
import './helpers.ts';
import { testHome } from './helpers.ts';

import type { Server } from 'node:http';

let server: Server;
let base: string;

before(async () => {
  const { createApp } = await import('../src/http/app.ts');
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
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

describe('project context listings', () => {
  test('empty when nothing exists', async () => {
    const rules = await fetch(`${base}/api/code/rules`);
    assert.equal(rules.status, 200);
    const rulesJson = (await rules.json()) as { source: string; count: number; rules: unknown[] };
    assert.equal(rulesJson.source, 'none');
    assert.equal(rulesJson.count, 0);
    assert.deepEqual(rulesJson.rules, []);

    const agents = await fetch(`${base}/api/code/agents`);
    assert.equal(agents.status, 200);
    const agentsJson = (await agents.json()) as { count: number; agents: unknown[] };
    assert.equal(agentsJson.count, 0);
    assert.deepEqual(agentsJson.agents, []);

    const commands = await fetch(`${base}/api/code/commands`);
    assert.equal(commands.status, 200);
    const commandsJson = (await commands.json()) as { count: number; commands: unknown[] };
    assert.equal(commandsJson.count, 0);
    assert.deepEqual(commandsJson.commands, []);
  });

  test('frontmatter name and description are extracted', async () => {
    const projectRoot = join(testHome, 'projects', 'demo');
    const rulesDir = join(projectRoot, '.hyperion', 'rules');
    await mkdir(rulesDir, { recursive: true });
    await writeFile(
      join(rulesDir, 'no-console.md'),
      `---
name: No console.log
description: Use a real logger instead of console.
scope: "*.ts"
---

# Rule body here
`,
    );

    const res = await fetch(`${base}/api/code/rules?project=demo`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      source: string;
      count: number;
      rules: Array<{ name: string; description: string; scope: string; path: string }>;
    };
    assert.equal(json.source, 'hyperion');
    assert.equal(json.count, 1);
    assert.equal(json.rules[0]?.name, 'No console.log');
    assert.equal(json.rules[0]?.description, 'Use a real logger instead of console.');
    assert.equal(json.rules[0]?.scope, '*.ts');
    assert.equal(json.rules[0]?.path, '.hyperion/rules/no-console.md');
  });

  test('CLAUDE.md fallback when .hyperion/rules is absent', async () => {
    const projectRoot = join(testHome, 'projects', 'fallback');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, 'CLAUDE.md'),
      `---
name: Project rules
description: Instructions for this project.
---

Body content.
`,
    );

    const res = await fetch(`${base}/api/code/rules?project=fallback`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      source: string;
      count: number;
      rules: Array<{ name: string; description: string; path: string }>;
    };
    assert.equal(json.source, 'claude-md');
    assert.equal(json.count, 1);
    assert.equal(json.rules[0]?.name, 'Project rules');
    assert.equal(json.rules[0]?.description, 'Instructions for this project.');
    assert.equal(json.rules[0]?.path, 'CLAUDE.md');
  });

  test('.claude/rules fallback when CLAUDE.md is also absent', async () => {
    const projectRoot = join(testHome, 'projects', 'legacy');
    const claudeRules = join(projectRoot, '.claude', 'rules');
    await mkdir(claudeRules, { recursive: true });
    await writeFile(
      join(claudeRules, 'style.md'),
      `# Code style

Prefer composition over inheritance.
`,
    );

    const res = await fetch(`${base}/api/code/rules?project=legacy`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      source: string;
      count: number;
      rules: Array<{ name: string; description: string; path: string }>;
    };
    assert.equal(json.source, 'claude-dir');
    assert.equal(json.count, 1);
    assert.equal(json.rules[0]?.name, 'Code style');
    assert.equal(json.rules[0]?.description, 'Prefer composition over inheritance.');
    assert.equal(json.rules[0]?.path, '.claude/rules/style.md');
  });

  test('scope violation for a path outside projects root', async () => {
    const res = await fetch(`${base}/api/code/rules?project=../../etc`);
    assert.equal(res.status, 403);
    const json = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(json.error.code, 'scope_violation');
  });

  test('filename fallback when no frontmatter or heading exists', async () => {
    const projectRoot = join(testHome, 'projects', 'minimal');
    const agentsDir = join(projectRoot, '.hyperion', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, 'data-analyst.md'), 'Just some text, no heading.\n');

    const res = await fetch(`${base}/api/code/agents?project=minimal`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      count: number;
      agents: Array<{ name: string; description: string | null; path: string }>;
    };
    assert.equal(json.count, 1);
    assert.equal(json.agents[0]?.name, 'data analyst');
    assert.equal(json.agents[0]?.description, null);
    assert.equal(json.agents[0]?.path, '.hyperion/agents/data-analyst.md');
  });

  test('agent tool and model preferences are surfaced', async () => {
    const projectRoot = join(testHome, 'projects', 'prefs');
    const agentsDir = join(projectRoot, '.hyperion', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'reviewer.md'),
      `---
name: Code reviewer
description: Reviews PRs for style and correctness.
tools: [read, bash]
model: claude-opus-4
---

Body.
`,
    );

    const res = await fetch(`${base}/api/code/agents?project=prefs`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      count: number;
      agents: Array<{ name: string; tools: string[] | null; model: string | null }>;
    };
    assert.equal(json.count, 1);
    assert.deepEqual(json.agents[0]?.tools, ['read', 'bash']);
    assert.equal(json.agents[0]?.model, 'claude-opus-4');
  });

  test('commands list as name + description', async () => {
    const projectRoot = join(testHome, 'projects', 'cmds');
    const commandsDir = join(projectRoot, '.hyperion', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, 'deploy.md'),
      `---
name: Deploy
description: Ship the current branch to staging.
---

# How it works
...
`,
    );

    const res = await fetch(`${base}/api/code/commands?project=cmds`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      count: number;
      commands: Array<{ name: string; description: string; path: string }>;
    };
    assert.equal(json.count, 1);
    assert.equal(json.commands[0]?.name, 'Deploy');
    assert.equal(json.commands[0]?.description, 'Ship the current branch to staging.');
    assert.equal(json.commands[0]?.path, '.hyperion/commands/deploy.md');
  });
});
