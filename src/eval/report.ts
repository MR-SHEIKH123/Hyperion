/**
 * Result sets: one JSON file, one markdown summary, and `compare`.
 *
 * The rules this module exists to keep:
 *   - results land under `eval-results/<timestamp>/`, gitignored;
 *   - a key is never written — the profile carries `hasApiKey`, not the key;
 *   - prompts and transcripts appear only when `--include-transcripts` was
 *     passed, and then only after `redactSecrets`;
 *   - the markdown summary ends with Observations, because that is the
 *     section a reader is meant to stop on.
 */
import fs from 'node:fs';
import path from 'node:path';

import { redactSecrets } from '../util/redact.ts';

import type { ScenarioAggregate, TokenTotals } from './metrics.ts';
import type { RunRecord } from './runner.ts';

export interface EvalResults {
  schema: 1;
  createdAt: string;
  profile: {
    name: string;
    baseUrl: string;
    model: string;
    type: string;
    hasApiKey: boolean;
  };
  options: {
    repeats: number;
    runTimeoutMs: number;
    totalTokenCeiling: number | null;
    totalUsdCeiling: number | null;
    includeTranscripts: boolean;
  };
  runs: RunRecord[];
  aggregates: ScenarioAggregate[];
  totals: {
    runs: number;
    tokens: TokenTotals;
    /** `null` when nothing in the eval was priced — never zero. */
    costUsd: number | null;
    priced: boolean;
    unpricedRequests: number;
    aborted: string | null;
  };
  observations: string[];
}

export function resultsDirName(createdAt: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${createdAt.getFullYear()}${pad(createdAt.getMonth() + 1)}${pad(createdAt.getDate())}` +
    `-${pad(createdAt.getHours())}${pad(createdAt.getMinutes())}${pad(createdAt.getSeconds())}`
  );
}

/** Strip everything the brief forbids before anything is written. */
export function sanitizeForDisk(results: EvalResults): EvalResults {
  const runs = results.runs.map(({ prompt: _prompt, transcript: _transcript, ...rest }) => rest);
  return { ...results, runs };
}

export function writeResults(dir: string, results: EvalResults): { json: string; md: string } {
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, 'results.json');
  const mdPath = path.join(dir, 'summary.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(sanitizeForDisk(results), null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(results), 'utf8');
  return { json: jsonPath, md: mdPath };
}

/** Optional per-run extras, written beside the JSON only when asked for. */
export function writeTranscripts(dir: string, runs: readonly RunRecord[]): string | null {
  const withTranscripts = runs.filter(
    (run) => run.prompt !== undefined || run.transcript !== undefined,
  );
  if (withTranscripts.length === 0) return null;
  const file = path.join(dir, 'transcripts.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      withTranscripts.map((run) => ({
        scenario: run.scenario,
        repeat: run.repeat,
        prompt: run.prompt === undefined ? null : redactSecrets(run.prompt),
        requests: run.transcript?.requests.map((request) => redactSecrets(request)) ?? [],
        events: run.transcript?.events.map((event) => redactSecrets(event)) ?? [],
      })),
      null,
      2,
    )}\n`,
    'utf8',
  );
  return file;
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function money(costUsd: number | null, priced: boolean): string {
  if (costUsd === null) return priced ? '$0.00' : 'unpriced';
  return `$${costUsd.toFixed(4)}`;
}

export function renderMarkdown(results: EvalResults): string {
  const lines: string[] = [];
  lines.push(`# Live eval — ${results.createdAt}`);
  lines.push('');
  lines.push(
    `Profile **${results.profile.name}** → \`${results.profile.baseUrl}\` model \`${results.profile.model}\` (${results.profile.type}, apiKey: ${results.profile.hasApiKey ? 'present' : 'absent'}).`,
  );
  lines.push(
    `Repeats: ${results.options.repeats} per scenario · run timeout: ${results.options.runTimeoutMs} ms · eval token ceiling: ${results.options.totalTokenCeiling ?? 'unset'} · dollar ceiling: ${results.options.totalUsdCeiling ?? 'unset'}.`,
  );
  lines.push('');
  lines.push('## Pass rates and medians');
  lines.push('');
  lines.push('| Scenario | Pass rate | Outcomes | Steps (median) | Tokens in (median) | Tokens out (median) | Time (median) | TTFT (median) | Cost (median) |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const aggregate of results.aggregates) {
    const outcomes = Object.entries(aggregate.outcomes)
      .map(([name, count]) => `${name} ${count}`)
      .join(', ');
    const cost =
      aggregate.costUsdMedian === null
        ? aggregate.unpricedRuns > 0
          ? 'unpriced'
          : '—'
        : `$${aggregate.costUsdMedian.toFixed(4)}`;
    lines.push(
      `| ${aggregate.scenario} | ${pct(aggregate.passRate)} (${aggregate.passes}/${aggregate.runs}) | ${outcomes} | ${aggregate.steps.median} | ${aggregate.tokensIn.median} | ${aggregate.tokensOut.median} | ${Math.round(aggregate.totalMs.median)} ms | ${aggregate.ttftMs.n > 0 ? `${Math.round(aggregate.ttftMs.median)} ms` : '—'} | ${cost} |`,
    );
  }
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(
    `Runs: ${results.totals.runs} · tokens in/out/cached/reasoning: ${results.totals.tokens.in}/${results.totals.tokens.out}/${results.totals.tokens.cached}/${results.totals.tokens.reasoning} · cost: ${money(results.totals.costUsd, results.totals.priced)}${results.totals.unpricedRequests > 0 ? ` (${results.totals.unpricedRequests} unpriced request(s))` : ''}.`,
  );
  if (results.totals.aborted !== null) {
    lines.push('');
    lines.push(`**Aborted:** ${results.totals.aborted}`);
  }
  lines.push('');
  lines.push('## Runs');
  lines.push('');
  lines.push('| Scenario | Repeat | Outcome | Pass | Steps | Malformed | Refusals | TTFT | Total | Cost |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const run of results.runs) {
    lines.push(
      `| ${run.scenario} | ${run.repeat} | ${run.outcome} | ${run.pass ? 'yes' : 'no'} | ${run.metrics.steps} | ${run.metrics.malformedToolCalls} | ${run.metrics.permissionRefusals} | ${run.metrics.ttftMs === null ? '—' : `${run.metrics.ttftMs} ms`} | ${run.metrics.totalMs} ms | ${money(run.metrics.costUsd, run.metrics.priced)} |`,
    );
  }
  lines.push('');
  // The brief: the summary ends with Observations.
  lines.push('## Observations');
  lines.push('');
  if (results.observations.length === 0) {
    lines.push('None.');
  } else {
    for (const observation of results.observations) {
      lines.push(`- ${observation}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** `compare a b` — two result sets, side by side, on stdout. */
export function renderCompare(left: EvalResults, right: EvalResults): string {
  const byScenario = (results: EvalResults): Map<string, ScenarioAggregate> =>
    new Map(results.aggregates.map((aggregate) => [aggregate.scenario, aggregate]));
  const leftMap = byScenario(left);
  const rightMap = byScenario(right);
  const scenarios = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort();

  const pad = (value: string, width: number): string =>
    value.length >= width ? value.slice(0, width) : value.padEnd(width);
  const rows: string[] = [];
  rows.push(
    `${pad('scenario', 20)} ${pad(left.profile.name, 24)} ${pad(right.profile.name, 24)}`,
  );
  rows.push('-'.repeat(70));
  for (const scenario of scenarios) {
    const l = leftMap.get(scenario);
    const r = rightMap.get(scenario);
    rows.push(
      `${pad(scenario, 20)} ${pad(
        l === undefined ? '—' : `${pct(l.passRate)} (${l.passes}/${l.runs}) steps~${l.steps.median}`,
        24,
      )} ${pad(
        r === undefined ? '—' : `${pct(r.passRate)} (${r.passes}/${r.runs}) steps~${r.steps.median}`,
        24,
      )}`,
    );
  }
  rows.push('-'.repeat(70));
  rows.push(
    `${pad('totals', 20)} ${pad(
      `tokens ${left.totals.tokens.in}/${left.totals.tokens.out} ${money(left.totals.costUsd, left.totals.priced)}`,
      24,
    )} ${pad(
      `tokens ${right.totals.tokens.in}/${right.totals.tokens.out} ${money(right.totals.costUsd, right.totals.priced)}`,
      24,
    )}`,
  );
  rows.push('');
  rows.push(`Left observations (${left.profile.name}):`);
  for (const observation of left.observations) rows.push(`  - ${observation}`);
  rows.push(`Right observations (${right.profile.name}):`);
  for (const observation of right.observations) rows.push(`  - ${observation}`);
  rows.push('');
  return rows.join('\n');
}
