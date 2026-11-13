/**
 * The `npm run eval:live` command: plan, run, compare — in that order of
 * spending. Everything that can refuse to start does so here, before a
 * single request is made, and the whole world is a throwaway directory the
 * entry script created and this file deletes on the way out.
 */
import fs from 'node:fs';
import path from 'node:path';

import { parseEvalArgv, resolveEvalConfig } from './config.ts';
import { buildPlan, buildResults, prepareEvalWorld, runSuite, seedProfileProvider } from './runner.ts';
import { EVAL_SCENARIOS } from './scenarios.ts';
import { renderCompare, renderMarkdown, writeResults, writeTranscripts } from './report.ts';

import type { EvalResults } from './report.ts';

function printPlan(plan: ReturnType<typeof buildPlan>): string {
  const lines: string[] = [];
  lines.push('Live eval plan — nothing will be spent.');
  lines.push('');
  lines.push(
    `  profile  ${plan.profile.name} (${plan.profile.type}, apiKey ${plan.profile.hasApiKey ? 'present' : 'absent'})`,
  );
  lines.push(`  endpoint ${plan.profile.baseUrl}`);
  lines.push(`  model    ${plan.profile.model}`);
  lines.push('');
  lines.push(
    `  runs     ${plan.scenarios.map((scenario) => scenario.id).join(', ')} × ${plan.repeats} repeat(s) = ${plan.runs}`,
  );
  lines.push(
    `  per run  token ceiling ${plan.perRun.tokenCeiling} · step ceiling ${plan.perRun.stepCeiling} · wall clock ${plan.perRun.wallClockMs} ms`,
  );
  const dollar =
    plan.total.usdCeiling === null
      ? 'none configured — cost is reported, and reported as unpriced when the model has no price'
      : `${plan.total.usdCeiling}`;
  lines.push(
    `  worst    token ceiling ${plan.total.tokenCeiling} (existing task budget × runs${plan.total.tokenCeiling === plan.perRun.tokenCeiling * plan.runs ? '' : ', overridden by env'}) · dollar ceiling ${dollar}`,
  );
  lines.push('');
  lines.push('Pass --confirm to run.');
  return lines.join('\n');
}

function loadResults(dir: string): EvalResults {
  const file = path.join(dir, 'results.json');
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw) as EvalResults;
}

/**
 * Run the CLI. Returns the process exit code:
 *   0 — a plan, a completed eval, or a comparison
 *   2 — refused to start (missing opt-in, endpoint, model or --confirm)
 * A thrown error is a bug or an environment failure and propagates.
 */
export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const parsed = parseEvalArgv(argv);
  const { config, refusal } = resolveEvalConfig(env, parsed);
  const home = env['HYPERION_HOME'] ?? '';

  if (parsed.mode === 'compare') {
    const [leftDir, rightDir] = parsed.compare as [string, string];
    const left = loadResults(leftDir);
    const right = loadResults(rightDir);
    process.stdout.write(`${renderCompare(left, right)}\n`);
    return 0;
  }

  if (refusal.length > 0) {
    process.stderr.write('Refusing to start the live eval:\n');
    for (const reason of refusal) process.stderr.write(`  - ${reason}\n`);
    // No cleanup here: the entry script owns the throwaway home's lifecycle
    // (it created it, and `--keep` is its flag to read). A refusal must not
    // delete a directory this function did not create.
    void home;
    return 2;
  }

  await prepareEvalWorld(home);

  if (parsed.mode === 'plan') {
    const plan = buildPlan(config, EVAL_SCENARIOS);
    process.stdout.write(`${printPlan(plan)}\n`);
    return 0;
  }

  seedProfileProvider(config);
  const startedAt = new Date();
  process.stdout.write(
    `Running ${EVAL_SCENARIOS.length} scenario(s) × ${config.repeats} repeat(s) against ${config.profile.model} at ${config.profile.baseUrl} …\n`,
  );
  const suite = await runSuite(config, EVAL_SCENARIOS);
  const results = buildResults(config, suite, EVAL_SCENARIOS, { createdAt: startedAt });
  const dir = path.join(
    config.resultsRoot,
    startedAt.toISOString().replace(/[:T]/g, '-').slice(0, 19),
  );
  const written = writeResults(dir, results);
  const transcripts = config.includeTranscripts ? writeTranscripts(dir, suite.runs) : null;
  process.stdout.write(`${renderMarkdown(results)}\n`);
  process.stdout.write(`\nWrote ${written.json} and ${written.md}`);
  if (transcripts !== null) process.stdout.write(` (+ ${transcripts})`);
  process.stdout.write('\n');
  return 0;
}
