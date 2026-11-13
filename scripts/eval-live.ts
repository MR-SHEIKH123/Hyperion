/**
 * `npm run eval:live` — the live evaluation harness entry point.
 *
 * Two duties, in this order, both before anything else is imported:
 *
 *   1. Point `HYPERION_HOME` at a fresh throwaway directory. `config/env.ts`
 *      resolves every path once at import time, so a script that configured
 *      the home after importing a product module would already have read the
 *      user's real one. Everything the eval writes — database, projects,
 *      knowledge, worktrees — lands in this directory and is deleted on the
 *      way out (`--keep` preserves it for debugging).
 *
 *   2. Disable the background machinery a headless run must not drag in: the
 *      scheduler, the MCP supervisor and the cleanup timer. The same switches
 *      the test harness sets, for the same reasons.
 *
 * Only Node builtins are imported here, on purpose: no product module may
 * see the process before the home is set.
 *
 * Usage:
 *   npm run eval:live -- --plan
 *   npm run eval:live -- --confirm [--repeats N] [--keep] [--include-transcripts]
 *   npm run eval:live -- compare <dirA> <dirB>
 *
 * The run itself refuses to start without HYPERION_EVAL_LIVE=1,
 * HYPERION_EVAL_BASE_URL, HYPERION_EVAL_MODEL and --confirm — see
 * src/eval/config.ts and docs/EVALS.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-eval-'));
process.env['HYPERION_HOME'] = home;
process.env['HYPERION_LOG_LEVEL'] ??= 'warn';
process.env['HYPERION_BIND'] ??= '127.0.0.1';
process.env['HYPERION_PORT'] ??= '0';
process.env['HYPERION_SCHEDULER_DISABLED'] ??= '1';
process.env['HYPERION_MCP_DISABLED'] ??= '1';
process.env['HYPERION_CLEANUP_DISABLED'] ??= '1';

const { main } = await import('../src/eval/cli.ts');

// The home's lifecycle lives here, next to its creation: every exit path
// removes it unless `--keep` was passed, so a refusal, a crash and a
// completed run all leave nothing behind.
const keep = process.argv.includes('--keep');
const remove = (): void => {
  if (!keep) fs.rmSync(home, { recursive: true, force: true });
};

try {
  const code = await main(process.argv.slice(2));
  remove();
  process.exit(code);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`eval:live failed: ${message}\n`);
  remove();
  process.exit(1);
}
