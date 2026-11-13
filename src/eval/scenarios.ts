/**
 * The three live-eval scenarios — the same cases `test/golden/*.json` records,
 * with the same structural expectations.
 *
 * A pass is never exact text: it is the thing the golden fixture asserts —
 * the expected file changed (code), the artifact was produced and the
 * knowledge was in force (cowork), the artifact was produced (design). The
 * prompts are the golden prompts verbatim, so a live run answers the same
 * question the mock recording answers.
 *
 * Setup seeds a throwaway world: a temp git fixture for Code, a knowledge
 * source for Cowork. Both live under the eval's own `HYPERION_HOME` and die
 * with it.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { TaskInput, TaskResult } from '../types/core.ts';

/** The seed file the Code scenario renames, and its expected on-disk state. */
export const CODE_SEED_PATH = 'note.md';
export const CODE_SEED_CONTENT = 'shipping notes\n';

export interface ScenarioWorld {
  /** Absolute directory this scenario's Code-style workspace resolves to. */
  projectDir: string;
}

export interface StructuralCheck {
  pass: boolean;
  /** One sentence naming what was measured — shown in the report. */
  detail: string;
}

export interface EvalScenario {
  id: 'code-edit' | 'cowork-knowledge' | 'design-draft';
  tool: 'code' | 'cowork' | 'design';
  prompt: string;
  /**
   * Seed the throwaway world once per scenario (not per repeat — a knowledge
   * source saved three times is three sources). Returns the directory the
   * run's `resolvePath` will land in.
   */
  setup(input: { taskId: string }): Promise<ScenarioWorld>;
  /** The golden's structural expectation, evaluated against the finished run. */
  check(input: {
    result: TaskResult;
    projectDir: string;
    knowledgeCited: boolean;
  }): StructuralCheck;
}

const CODE_PROMPT = 'Rename the note.';
const COWORK_PROMPT = 'What does the handbook say about scope?';
const DESIGN_PROMPT = 'Design a small landing hero.';

/** The handbook the Cowork golden seeds — a fact, not a phrasing, to match. */
const HANDBOOK = '# Handbook\n\nScope: ship small.\n';

async function ensureGitFixture(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const gitDir = path.join(dir, '.git');
  if (fs.existsSync(gitDir)) return;
  const { spawnSync } = await import('node:child_process');
  const run = (args: string[]): void => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
  };
  run(['init']);
  run(['config', 'user.email', 'eval@hyperion.local']);
  run(['config', 'user.name', 'Hyperion Eval']);
}

export const EVAL_SCENARIOS: readonly EvalScenario[] = [
  {
    id: 'code-edit',
    tool: 'code',
    prompt: CODE_PROMPT,
    async setup({ taskId }) {
      // A temp git repo fixture under the projects scope, registered as this
      // task's worktree — the same seam production Code runs through.
      const { getRoot } = await import('../security/fsScope.ts');
      const dir = path.join(getRoot('projects'), `eval-${taskId}`);
      await ensureGitFixture(dir);
      fs.writeFileSync(path.join(dir, CODE_SEED_PATH), CODE_SEED_CONTENT, 'utf8');
      // A committed baseline: an agent that rewrites the file has something
      // real to be measured against, and git status has a change to show.
      const { spawnSync } = await import('node:child_process');
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'Eval',
        GIT_AUTHOR_EMAIL: 'eval@hyperion.local',
        GIT_COMMITTER_NAME: 'Eval',
        GIT_COMMITTER_EMAIL: 'eval@hyperion.local',
      };
      spawnSync('git', ['add', '-A'], { cwd: dir });
      spawnSync('git', ['commit', '-m', 'seed', '--allow-empty'], { cwd: dir, env: gitEnv });
      const { provisionWorktree } = await import('../services/code/worktree.ts');
      const worktree = await provisionWorktree(taskId, dir);
      return { projectDir: worktree.dir };
    },
    check({ result, projectDir }) {
      const onDisk = path.join(projectDir, CODE_SEED_PATH);
      const content = fs.existsSync(onDisk) ? fs.readFileSync(onDisk, 'utf8') : null;
      const changed = content !== null && content !== CODE_SEED_CONTENT;
      const reported = result.changedFiles?.some((file) => file.endsWith(CODE_SEED_PATH)) ?? false;
      const pass = changed || reported;
      return {
        pass,
        detail: pass
          ? `note.md changed on disk=${changed}, reported in changedFiles=${reported}`
          : `note.md still holds the seed content (changedFiles: ${JSON.stringify(result.changedFiles ?? null)})`,
      };
    },
  },
  {
    id: 'cowork-knowledge',
    tool: 'cowork',
    prompt: COWORK_PROMPT,
    async setup() {
      const { saveKnowledgeSource } = await import('../services/cowork/knowledge.ts');
      saveKnowledgeSource({
        filename: 'handbook.md',
        buffer: Buffer.from(HANDBOOK, 'utf8'),
        label: 'Handbook',
      });
      const { getRoot } = await import('../security/fsScope.ts');
      return { projectDir: getRoot('projects') };
    },
    check({ result, knowledgeCited }) {
      const artifact = (result.artifacts?.length ?? 0) > 0;
      const pass = artifact && knowledgeCited;
      return {
        pass,
        detail: `artifact produced=${artifact}, knowledge in force=${knowledgeCited} (sources read before the loop, recorded on the run)`,
      };
    },
  },
  {
    id: 'design-draft',
    tool: 'design',
    prompt: DESIGN_PROMPT,
    async setup() {
      // Design needs no seed: the deliverable is the model's to make, exactly
      // as the golden's fixture records.
      const { getRoot } = await import('../security/fsScope.ts');
      return { projectDir: getRoot('projects') };
    },
    check({ result }) {
      const artifact = (result.artifacts?.length ?? 0) > 0;
      return {
        pass: artifact,
        detail: artifact
          ? `artifact produced: ${(result.artifacts ?? []).map((entry) => `${entry.key}@v${entry.version}`).join(', ')}`
          : `no artifact in the result (changedFiles: ${JSON.stringify(result.changedFiles ?? null)})`,
      };
    },
  },
];

/** Stable task ids per scenario+repeat, so usage and steps attribute cleanly. */
export function evalTaskId(scenarioId: string, repeat: number): string {
  return `eval-${scenarioId}-${repeat}`;
}

/** The TaskInput for one run — golden input shape, profile's model. */
export function scenarioInput(
  scenario: EvalScenario,
  taskId: string,
  modelId: string,
): TaskInput {
  return {
    tool: scenario.tool,
    chatId: `eval-chat-${taskId}`,
    modelId,
    prompt: scenario.prompt,
    mode: 'act',
  };
}
