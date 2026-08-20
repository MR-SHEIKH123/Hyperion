/**
 * Per-step history for a task run.
 *
 * `task_runs` answers "should I wait, retry, or show a result" — the question a
 * reconnecting client has. This answers the one the *user* has afterwards: what
 * did it actually do? A run that stopped at a ceiling or failed three tool calls
 * in leaves no trace of its work once the stream is gone, because the stream was
 * the only place that detail ever existed.
 *
 * One row per decision the loop made: a tool call and its outcome, a plan, a
 * compression, or a note about the loop's own behaviour. Not deltas, not prompt
 * text — `014_task_steps.sql` records why that line is drawn where it is.
 *
 * Recording is best-effort by design. See `recordStep`: a run must not die
 * because its own bookkeeping failed.
 */

import { getDb } from './adapter.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('tasksteps');

/**
 * The gate the step ran under.
 *
 * Matches the three-mode vocabulary the agent loop enforces rather than
 * inventing a parallel one, so a UI that already labels a run's mode does not
 * need a second mapping. `null` means the step predates any mode being in
 * force — an honest "not applicable", never a guess at `act`.
 */
export type TaskStepMode = 'ask' | 'plan' | 'act';

/**
 * What kind of decision the row records.
 *
 * `note` is the escape hatch for something the loop wants on the record that is
 * not a call, a plan or a compression — a retry, a refusal, a ceiling being
 * approached. It exists so those do not get logged as fake `tool_call`s with a
 * made-up name, which would corrupt any count of what the run actually invoked.
 */
export type TaskStepKind = 'tool_call' | 'plan' | 'compression' | 'note';

export interface TaskStep {
  runId: string;
  step: number;
  mode: TaskStepMode | null;
  kind: TaskStepKind;
  toolName: string | null;
  /** Null when the step is not the kind of thing that can fail. */
  ok: boolean | null;
  detail: string | null;
  /** Null means the provider did not report a count — not zero. */
  tokensIn: number | null;
  tokensOut: number | null;
  createdAt: number;
}

interface TaskStepRow {
  run_id: string;
  step: number;
  mode: string | null;
  kind: string;
  tool_name: string | null;
  ok: number | null;
  detail: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: number;
}

function mapRow(row: TaskStepRow): TaskStep {
  return {
    runId: row.run_id,
    step: row.step,
    mode: row.mode as TaskStepMode | null,
    kind: row.kind as TaskStepKind,
    toolName: row.tool_name,
    // Deliberately not `Boolean(row.ok)`: that would fold a missing outcome into
    // `false`, reporting "this failed" for a plan that never had an outcome.
    ok: row.ok === null ? null : row.ok === 1,
    detail: row.detail,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    createdAt: row.created_at,
  };
}

export interface RecordStepInput {
  runId: string;
  step: number;
  kind: TaskStepKind;
  mode?: TaskStepMode | undefined;
  toolName?: string | undefined;
  ok?: boolean | undefined;
  detail?: string | undefined;
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
}

/** Longest `detail` kept. Past this a step row is storing output, not a summary. */
const DETAIL_LIMIT = 2_000;

/**
 * Append one step, and never let the attempt break the run.
 *
 * Every failure here is swallowed to a warning, which is the opposite of this
 * project's usual "errors are values with meaning" stance and needs its reason
 * stated: this is called from inside the agent loop, mid-run, purely to describe
 * work that has *already happened*. A duplicate ordinal from a loop bug, a
 * `run_id` whose row was reconciled away by a restart, a disk that filled — none
 * of those are reasons to abort work the user is waiting on, and none of them
 * are recoverable by the caller. The write is a side effect, so it fails like
 * one.
 *
 * It is still logged, because a silently absent history would otherwise look
 * like a run that did nothing.
 */
export function recordStep(input: RecordStepInput): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO task_steps
           (run_id, step, mode, kind, tool_name, ok, detail, tokens_in, tokens_out, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.step,
        input.mode ?? null,
        input.kind,
        input.toolName ?? null,
        // Booleans go in as 0/1 explicitly. `undefined` would bind as NULL,
        // which is the right answer for "no outcome" but must not be reached by
        // accident for a step that does have one.
        input.ok === undefined ? null : input.ok ? 1 : 0,
        truncateDetail(input.detail),
        input.tokensIn ?? null,
        input.tokensOut ?? null,
        Date.now(),
      );
  } catch (error) {
    log.warn('could not record a task step', {
      runId: input.runId,
      step: input.step,
      kind: input.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Keeps one oversized detail from turning the row into a transcript.
 *
 * Truncation is marked rather than silent: a reader who cannot tell a clipped
 * line from a complete one will read the clipped one as the whole story.
 */
function truncateDetail(detail: string | undefined): string | null {
  if (detail === undefined) return null;
  if (detail.length <= DETAIL_LIMIT) return detail;
  return `${detail.slice(0, DETAIL_LIMIT)}… (truncated)`;
}

/**
 * Every step of a run, in the order they were taken.
 *
 * Ordered by `step`, not `created_at`: two steps can land inside the same
 * millisecond, and a timestamp tie would let them come back in either order.
 * The ordinal is the sequence, so it is what the ordering uses.
 */
export function listSteps(runId: string): TaskStep[] {
  return getDb()
    .prepare<TaskStepRow>('SELECT * FROM task_steps WHERE run_id = ? ORDER BY step ASC')
    .all(runId)
    .map(mapRow);
}

/**
 * The ordinal a caller should use for its next step.
 *
 * The loop owns its own counter while it is running; this exists so a *resumed*
 * or second-phase run can continue the sequence instead of restarting at 1 and
 * colliding with the primary key. `MAX` rather than `COUNT` for the same reason
 * — a gap left by a failed insert must not hand out an ordinal already taken.
 */
export function nextStepNumber(runId: string): number {
  const row = getDb()
    .prepare<{ highest: number | null }>('SELECT MAX(step) AS highest FROM task_steps WHERE run_id = ?')
    .get(runId);
  return (row?.highest ?? 0) + 1;
}

export interface TaskStepSummary {
  steps: number;
  toolCalls: number;
  failures: number;
  compressions: number;
  /**
   * Reported token totals, and whether every step contributed one.
   *
   * `complete: false` means at least one step had no count to add, so the totals
   * are a floor rather than the real figure. Without that flag a partial sum
   * reads as authoritative, and the number quietly understates the run.
   */
  tokensIn: number;
  tokensOut: number;
  complete: boolean;
}

/** Counts for the run summary, computed in SQL to avoid loading every row. */
export function summarizeSteps(runId: string): TaskStepSummary {
  const row = getDb()
    .prepare<{
      steps: number;
      tool_calls: number;
      failures: number;
      compressions: number;
      tokens_in: number | null;
      tokens_out: number | null;
      missing: number;
    }>(
      `SELECT COUNT(*)                                             AS steps,
              SUM(CASE WHEN kind = 'tool_call' THEN 1 ELSE 0 END)   AS tool_calls,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END)               AS failures,
              SUM(CASE WHEN kind = 'compression' THEN 1 ELSE 0 END) AS compressions,
              SUM(tokens_in)                                        AS tokens_in,
              SUM(tokens_out)                                       AS tokens_out,
              SUM(CASE WHEN tokens_in IS NULL OR tokens_out IS NULL THEN 1 ELSE 0 END) AS missing
         FROM task_steps
        WHERE run_id = ?`,
    )
    .get(runId);

  return {
    steps: row?.steps ?? 0,
    toolCalls: row?.tool_calls ?? 0,
    failures: row?.failures ?? 0,
    compressions: row?.compressions ?? 0,
    tokensIn: row?.tokens_in ?? 0,
    tokensOut: row?.tokens_out ?? 0,
    // A run with no steps at all is vacuously complete: there is nothing missing
    // from it. The flag is about unreported counts, not about emptiness.
    complete: (row?.missing ?? 0) === 0,
  };
}
