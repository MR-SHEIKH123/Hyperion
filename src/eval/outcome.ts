/**
 * The seven outcomes a run can have, and how the run row maps onto them.
 *
 * The vocabulary is the brief's; the mapping is the product's own states plus
 * two eval-specific answers: a wall-clock timeout (nothing in the product
 * records it, because the product does not time runs out) and the brief's rule
 * that a scenario parked on an approval is `blocked` — even though the product
 * parks `approval_required` as `ready_for_review`, because for an eval the
 * question is "did it finish without asking", and asking is a refusal to
 * proceed on its own.
 */
export type Outcome =
  | 'complete'
  | 'ready_for_review'
  | 'paused'
  | 'blocked'
  | 'error'
  | 'stopped'
  | 'timeout';

export interface OutcomeInput {
  /** True when the harness's wall-clock timer fired. */
  timedOut: boolean;
  /** The run row's state after the run settled. */
  state: string | null;
  /** The run row's pause reason (park reason, ceiling, provider failure). */
  pauseReason: string | null;
  /** The TaskResult error, when the agent returned one. */
  error: { code: string; message: string } | undefined;
}

export function outcomeOf(input: OutcomeInput): Outcome {
  if (input.timedOut) return 'timeout';
  if (input.error !== undefined) return 'error';
  // The brief's rule: an approval park is a blocked run for eval purposes.
  if (input.pauseReason === 'approval_required') return 'blocked';
  switch (input.state) {
    case 'complete':
      return 'complete';
    case 'blocked':
      return 'blocked';
    case 'ready_for_review':
      return 'ready_for_review';
    case 'paused':
      return 'paused';
    case 'stopped':
      return 'stopped';
    case 'error':
      return 'error';
    case 'interrupted':
      return 'stopped';
    default:
      // No row, or a row still claiming `running` after the promise settled:
      // bookkeeping we cannot read is reported as an error, never as a
      // completion the record does not support.
      return 'error';
  }
}
