import { endSentence, logEntries } from './agentFrames';
import styles from './StartTask.module.css';

import type { StartState } from './useTaskStart';

/**
 * The frames of a run started from this surface, as they arrive.
 *
 * This is the composer's own view of a run it started, and it exists because the
 * surface's progress region said the opposite: "step-by-step progress arrives on the
 * task's SSE stream while it runs. This surface shows the persisted state instead."
 * That was the honest sentence while nothing here *had* a stream — the region's only
 * job was to explain why it was empty. Now that the surface starts runs, the frames
 * belong here, next to the control that caused them.
 *
 * What it does **not** do is pretend a stream is a state. The closing line reports the
 * persisted run the session reconciled to, and when the two disagree the persisted one
 * is what is stated — the stream was a view, the database is the run. Undecodable
 * frames are listed with their channel and the validator's complaint rather than
 * dropped.
 */
export function RunProgress({
  state,
  taskId,
  onDismiss,
}: {
  state: StartState;
  /** The task the frames belong to, or `null` before anything was started. */
  taskId: string | null;
  onDismiss?: (() => void) | undefined;
}) {
  if (state.phase === 'idle' && taskId === null) {
    return (
      <p className={styles.idle}>
        Step-by-step progress appears here while a task started from this surface runs. A run started elsewhere is
        shown by its persisted state in the main region, so a reload shows the truth rather than an empty stream.
      </p>
    );
  }

  const entries = logEntries(state.events);

  return (
    <div className={styles.progress} aria-label="Run progress">
      {taskId === null ? null : (
        <p className={styles.progressHead}>
          Task <code>{taskId}</code>
          {state.phase === 'streaming' ? ' — running' : ' — not streaming'}
        </p>
      )}

      {state.phase === 'streaming' && entries.length === 0 ? (
        <p className={styles.pending}>
          Waiting for the first frame. Under a queued Code lane the stream opens before a slot frees, and the run
          announces itself with <code>started</code> once it has one.
        </p>
      ) : null}

      {entries.length > 0 || state.invalid.length > 0 ? (
        <ul className={styles.frames}>
          {entries.map((entry, index) => (
            <li key={index} className={styles.frame} data-channel={entry.channel}>
              {entry.text}
            </li>
          ))}
          {state.invalid.map((frame, index) => (
            <li key={`invalid-${index}`} className={styles.frame} data-channel="unknown">
              {frame.eventName}: {frame.reason}
            </li>
          ))}
        </ul>
      ) : null}

      {state.error !== null ? <p className={styles.failure}>{state.error}</p> : null}
      {state.end !== null || state.reconciliation !== null ? (
        <p className={styles.end}>{endSentence(state.end, state.reconciliation, state.events)}</p>
      ) : null}
      {onDismiss === undefined ? null : (
        <button type="button" className={styles.clear} onClick={onDismiss}>
          Clear the log
        </button>
      )}
    </div>
  );
}
