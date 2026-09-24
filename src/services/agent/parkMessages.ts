/**
 * Why a parked run is parked, in words a person reads (1.31).
 *
 * Two readers were already written as if this existed. `attention/queue.ts` uses
 * `run.pause_reason ?? <generic sentence>` as the detail of its `blocked`,
 * `paused` and `ready_for_review` items — a fallback sentence is only there
 * because the author expected a *sentence*, and `parkRun` wrote nothing at all, so
 * the fallback is what every parked run actually showed. The unattended-run
 * notification has the same need: a scheduled task that parks is a task waiting on
 * somebody who is not looking, and "failed" is the wrong word for it.
 *
 * ## The codes stay codes, the sentences live here
 *
 * `task_runs.pause_reason` carries a **token** (`plan_ready`, `cancelled`,
 * `ceiling_reached`, `approval_denied`) and keeps carrying one: every other writer
 * in the tree writes a token, and a column that sometimes holds prose cannot be
 * switched on later. Translating to a sentence belongs at the point of display,
 * which is what this module is. Storing the sentence instead would have been the
 * smaller change and the worse one — the queue would read it correctly and the
 * next reader would have to guess which spellings were sentences.
 *
 * ## Why the words differ per reason
 *
 * Because the *action* differs, and a sentence that suggests the wrong one is
 * worse than a generic sentence that suggests none. `redaction_blocked` invites
 * review — there is a finding to look at and a send to approve. `zdr_blocked`
 * must not: nothing can be approved, and the block lifts only when a setting or a
 * recorded provider fact changes. `context_exhausted` cannot be continued at all —
 * the same conversation would fill the window again — so it points at a fresh
 * task. `iteration_ceiling` is the opposite: continuing is exactly what it wants.
 *
 * The map is a total `Record<ParkReason, string>`, so adding a park reason is a
 * compile error here until somebody decides what to tell the user. That is the
 * same rule `PARK_STATE` and `adapterFor` follow, for the same reason: a missing
 * case should be a decision, not a fallback nobody notices.
 */
import type { ParkReason } from './loop.ts';

/** One sentence per reason, saying what the run is waiting for and what ends it. */
const PARK_SUMMARY: Record<ParkReason, string> = {
  plan_ready: 'It produced a plan and is waiting for your approval before it acts.',
  approval_required: 'A step needs your go-ahead before it runs.',
  doom_loop: 'It looked like it was repeating itself, so it stopped to ask before doing it again.',
  loop_detected: 'It repeated a call you had already denied, so it stopped.',
  iteration_ceiling: 'It reached the step limit for a single run. Continue it to carry on.',
  context_exhausted:
    'The conversation no longer fits the model’s window and could not be shortened enough to send. Start it as a fresh task.',
  // Not "nobody was watching": a task run can park this way with the user in
  // front of it, because no task route reads the acknowledgement a chat turn
  // would resend. What is true in both cases is that the send needs an answer.
  redaction_blocked:
    'Its next message appeared to contain a credential and sending it needs your approval. Open the task to review the finding.',
  zdr_blocked:
    'No provider that can serve it satisfies your zero-data-retention requirement. Record ZDR support for a provider, or lower the requirement, then resume it.',
};

/**
 * The sentence for a recorded reason token, or null when there is nothing to say.
 *
 * Null rather than a generic sentence: a caller that wants a fallback can write
 * one that fits its own context (the queue's items read differently from a push
 * notification), and a caller that does not want one is spared having to detect
 * this module's placeholder. Unknown tokens — a row written by a newer build, a
 * `cancelled` stop that is not a park — are no answer either. (`ceiling_reached`
 * is also not a park and is answered by `stopSummary` below, which exists because
 * a limit stopping a run is worth saying and the user pressing Stop is not.)
 */
export function parkSummary(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string') return null;
  return (PARK_SUMMARY as Record<string, string | undefined>)[reason] ?? null;
}

/** True when this token names a park reason this build knows how to describe. */
export function isParkReason(reason: string | null | undefined): reason is ParkReason {
  return parkSummary(reason) !== null;
}

/**
 * The sentences for the reasons a run *stopped*, which are not parks (1.31).
 *
 * A stop and a park share the `pause_reason` column and nothing else: a park is
 * waiting for an answer and will continue, a stop is over. Two of the stop tokens
 * have nothing to add — `cancelled` is the user's own action, and `approval_denied`
 * and `loop_detected` are park reasons already translated above, because a denial
 * is the *answer* to a park — while `ceiling_reached` is the case worth saying out
 * loud: the run was ended by a limit the user set, at a boundary where the work was
 * preserved, and a reader who only sees "stopped" cannot tell that from having
 * pressed Stop themselves.
 *
 * The sentence deliberately does not name *which* ceiling tripped. The row does not
 * carry that (`ceiling_reached` is one token for the token budget, the iteration
 * limit and the subagent limit), the kind rides in the step the loop records and
 * the SSE event beside it, and inventing one here would be a guess dressed as a
 * record.
 */
const STOP_SUMMARY: Record<string, string> = {
  ceiling_reached: 'It reached a limit you set — the token budget, the step count or the subagent limit — and stopped with its work preserved.',
};

/**
 * The sentence for a *stop* token, or null when the stop needs no explanation.
 *
 * Paired with `parkSummary` at the point of display: a run's reason column is one
 * column holding both vocabularies, and a reader that wants a sentence for
 * whatever it finds there tries the park map first and this one second.
 */
export function stopSummary(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string') return null;
  return (STOP_SUMMARY as Record<string, string | undefined>)[reason] ?? null;
}
