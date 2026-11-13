/**
 * Live-eval configuration: environment, argv, and the refusal to start.
 *
 * Deliberately pure — this module reads the `HYPERION_EVAL_*` variables and
 * the command line it is handed, and never imports `config/env.ts`. The entry
 * script resolves the throwaway `HYPERION_HOME` before any product module is
 * imported (env.ts fixes paths at import time), so keeping config free of that
 * import is what lets the refusal logic be unit-tested with a plain object
 * instead of a process.
 *
 * Nothing here is part of `npm test`'s live path and nothing here is imported
 * by product code: the harness is opt-in from `npm run eval:live`.
 */
import { AppError } from '../util/errors.ts';

import type { ProviderType } from '../types/core.ts';

/** One profile: a provider endpoint the suite is run against. */
export interface EvalProfile {
  /** Label used in reports; never a credential. */
  name: string;
  baseUrl: string;
  model: string;
  /** Present or absent — recorded in reports only as a boolean. */
  apiKey: string | null;
  type: ProviderType;
}

export interface EvalArgv {
  mode: 'run' | 'plan' | 'compare';
  confirm: boolean;
  keep: boolean;
  includeTranscripts: boolean;
  repeats: number;
  /** `compare a b` — two result directories, in that order. */
  compare: [string, string] | null;
  help: boolean;
}

export interface EvalConfig {
  profile: EvalProfile;
  repeats: number;
  confirm: boolean;
  keep: boolean;
  includeTranscripts: boolean;
  /** Per-run wall-clock timeout. Eval guardrail, not a product setting. */
  runTimeoutMs: number;
  /**
   * Whole-eval token ceiling. `null` means "derived at plan time" from the
   * existing task budget × the planned run count — never an invented number.
   */
  totalTokenCeiling: number | null;
  /** Whole-eval dollar ceiling; only meaningful when the model is priced. */
  totalUsdCeiling: number | null;
  /** Directory result sets are written under (repo-local, gitignored). */
  resultsRoot: string;
}

export const EVAL_ENV = {
  live: 'HYPERION_EVAL_LIVE',
  baseUrl: 'HYPERION_EVAL_BASE_URL',
  model: 'HYPERION_EVAL_MODEL',
  apiKey: 'HYPERION_EVAL_API_KEY',
  profileName: 'HYPERION_EVAL_PROFILE_NAME',
  providerType: 'HYPERION_EVAL_PROVIDER_TYPE',
  runTimeoutMs: 'HYPERION_EVAL_RUN_TIMEOUT_MS',
  totalTokens: 'HYPERION_EVAL_TOTAL_TOKENS',
  totalUsd: 'HYPERION_EVAL_TOTAL_USD',
} as const;

/**
 * Default wall-clock ceiling for one run, in milliseconds.
 *
 * The brief requires a wall-clock timeout and the product has no per-run
 * timeout to reuse, so this is the one number the harness owns. It is a
 * guardrail against a hung provider, not a performance expectation: it is
 * configurable (`HYPERION_EVAL_RUN_TIMEOUT_MS`) and reported in `--plan`.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;

const DEFAULT_RESULTS_ROOT = 'eval-results';

const KNOWN_FLAGS = new Set([
  '--plan',
  '--confirm',
  '--keep',
  '--include-transcripts',
  '--repeats',
  '--compare',
  '--help',
  '-h',
]);

/** Parse the harness argv. Unknown flags are a hard error, not a shrug. */
export function parseEvalArgv(argv: readonly string[]): EvalArgv {
  let plan = false;
  let confirm = false;
  let keep = false;
  let includeTranscripts = false;
  let help = false;
  let repeats = 3;
  let compare: [string, string] | null = null;
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--plan') plan = true;
    else if (arg === '--confirm') confirm = true;
    else if (arg === '--keep') keep = true;
    else if (arg === '--include-transcripts') includeTranscripts = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--repeats') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
        throw new AppError('bad_request', '--repeats needs a positive integer.');
      }
      repeats = Number(value);
    } else if (arg === '--compare') {
      const first = argv[index + 1];
      const second = argv[index + 2];
      index += 2;
      if (first === undefined || second === undefined) {
        throw new AppError('bad_request', '--compare needs two result directories.');
      }
      compare = [first, second];
    } else if (arg.startsWith('-') && !KNOWN_FLAGS.has(arg)) {
      throw new AppError('bad_request', `Unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  // `eval:live compare a b` reads the same as `--compare a b`.
  if (compare === null && positionals[0] === 'compare' && positionals.length === 3) {
    compare = [positionals[1] as string, positionals[2] as string];
  } else if (positionals.length > 0 && compare === null) {
    throw new AppError(
      'bad_request',
      `Unexpected argument${positionals.length > 1 ? 's' : ''}: ${positionals.join(' ')}`,
    );
  }

  const mode: EvalArgv['mode'] = plan ? 'plan' : compare !== null ? 'compare' : 'run';
  return { mode, confirm, keep, includeTranscripts, repeats, compare, help };
}

function intFrom(env: Record<string, string | undefined>, name: string): number | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return null;
  if (!/^\d+$/.test(raw.trim())) {
    throw new AppError('bad_request', `${name} must be a positive integer, got "${raw}".`);
  }
  return Number(raw.trim());
}

/**
 * Why a run may not start. Empty array means the configuration is complete.
 *
 * Every reason is named at once rather than first-failure-wins: a user
 * starting a spend-capable process should see the whole list in one pass.
 */
export function refusalReasons(
  env: Record<string, string | undefined>,
  argv: EvalArgv,
): string[] {
  if (argv.mode !== 'run') return [];
  const reasons: string[] = [];
  if (env[EVAL_ENV.live] !== '1') {
    reasons.push(`${EVAL_ENV.live}=1 is not set — the live eval is opt-in.`);
  }
  if ((env[EVAL_ENV.baseUrl] ?? '').trim() === '') {
    reasons.push(`${EVAL_ENV.baseUrl} is not set — there is no provider to run against.`);
  }
  if ((env[EVAL_ENV.model] ?? '').trim() === '') {
    reasons.push(`${EVAL_ENV.model} is not set — there is no model to run.`);
  }
  if (!argv.confirm) {
    reasons.push('--confirm is not present — this harness spends real tokens.');
  }
  return reasons;
}

/**
 * The full configuration, or the reasons a run may not start.
 *
 * `plan` and `compare` never spend, so `--confirm` only gates `run`; the
 * environment is still required for `plan` because the plan describes the
 * profile it would run against. `compare` reads result directories and needs
 * neither.
 */
export function resolveEvalConfig(
  env: Record<string, string | undefined>,
  argv: EvalArgv,
): { config: EvalConfig; refusal: string[] } {
  const apiKey = (env[EVAL_ENV.apiKey] ?? '').trim();
  const typeRaw = (env[EVAL_ENV.providerType] ?? '').trim();
  const profile: EvalProfile = {
    name: (env[EVAL_ENV.profileName] ?? '').trim() || 'default',
    baseUrl: (env[EVAL_ENV.baseUrl] ?? '').trim(),
    model: (env[EVAL_ENV.model] ?? '').trim(),
    apiKey: apiKey === '' ? null : apiKey,
    type: ((): ProviderType => {
      if (typeRaw !== '') {
        const allowed: ProviderType[] = ['remote', 'local', 'opencodex', 'colibri', 'puter'];
        if (!(allowed as string[]).includes(typeRaw)) {
          throw new AppError(
            'bad_request',
            `${EVAL_ENV.providerType} must be one of ${allowed.join(', ')}, got "${typeRaw}".`,
          );
        }
        return typeRaw as ProviderType;
      }
      // Read once, at resolve time — never per request. An endpoint that
      // names a provider API family in its URL speaks that family's
      // chat-completions protocol; a bare URL falls back to the key, since a
      // keyed endpoint is almost always remote and a keyless one local
      // (Ollama). HYPERION_EVAL_PROVIDER_TYPE overrides both.
      const url = (env[EVAL_ENV.baseUrl] ?? '').trim().toLowerCase();
      if (/(?:^|\/)(?:v1|v3)(?:\/|$)|openai|anthropic|\/api\/v1/.test(url)) {
        return 'remote';
      }
      return apiKey === '' ? 'local' : 'remote';
    })(),
  };

  const config: EvalConfig = {
    profile,
    repeats: argv.repeats,
    confirm: argv.confirm,
    keep: argv.keep,
    includeTranscripts: argv.includeTranscripts,
    runTimeoutMs: intFrom(env, EVAL_ENV.runTimeoutMs) ?? DEFAULT_RUN_TIMEOUT_MS,
    totalTokenCeiling: intFrom(env, EVAL_ENV.totalTokens),
    totalUsdCeiling: intFrom(env, EVAL_ENV.totalUsd),
    resultsRoot: DEFAULT_RESULTS_ROOT,
  };

  if (argv.mode === 'compare') {
    return { config, refusal: [] };
  }

  if (argv.mode === 'plan') {
    // A plan never spends, so it is not gated by `--confirm`; it still names
    // the profile it would run, so the endpoint and model must be present.
    const planReasons: string[] = [];
    if (config.profile.baseUrl === '') {
      planReasons.push(`${EVAL_ENV.baseUrl} is not set — there is no provider to plan against.`);
    }
    if (config.profile.model === '') {
      planReasons.push(`${EVAL_ENV.model} is not set — there is no model to plan for.`);
    }
    return { config, refusal: planReasons };
  }
  return { config, refusal: refusalReasons(env, argv) };
}

/** What `--plan` prints. Pure data — the printer lives in the CLI. */
export interface EvalPlan {
  profile: { name: string; baseUrl: string; model: string; hasApiKey: boolean; type: ProviderType };
  repeats: number;
  scenarios: { id: string; tool: string; prompt: string }[];
  runs: number;
  perRun: { tokenCeiling: number; stepCeiling: number; wallClockMs: number };
  /** Worst case for the whole eval. Dollars only when a price exists. */
  total: { tokenCeiling: number; usdCeiling: number | null };
}
