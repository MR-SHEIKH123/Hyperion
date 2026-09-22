import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentSseEvent } from '../../api/sse/events';
import type { RunStreamCallbacks } from '../../api/agentStream';
import type { RunReconciliation } from '../../api/agentStream';
import type { StreamEnd } from '../../api/sse/session';

/**
 * Owning one agent run's stream, for whichever surface started it.
 *
 * Two Code surfaces watch a run: the parked-task panel continues one, and the
 * composer starts one. Both need the same four properties, and they are the reason
 * this is a hook rather than a button that fires a fetch and forgets:
 *
 *   - **The stream is owned and cancellable.** An agent edits files; a person who
 *     navigates away or changes their mind must be able to stop *watching*, and the
 *     difference between that and stopping the work is stated by whoever asks. What
 *     this abort does is drop the connection — the route treats that as a disconnect
 *     once the run is going, and as "never start" while a queued run is still waiting.
 *   - **Every frame is kept, and none is interpreted here.** The agent protocol's
 *     payloads are per-channel and open by design (`docs/API.md` §12.6), so the hook
 *     stores what arrived and `agentFrames.ts` renders the channels it understands —
 *     an unfamiliar channel renders as itself rather than disappearing.
 *   - **A stream that ends without a result reconciles instead of guessing.** The end
 *     reason is reported (`terminal-event`, `socket-closed`, `disconnected`,
 *     `cancelled`) and the persisted run is re-read, because "the socket closed" and
 *     "the run finished" are different facts and only the second one is an outcome. A
 *     mutation stream is never replayed.
 *   - **A refusal before the stream opens is a sentence, not a stack.** Input
 *     validation, the agent lookup, the lane check and the claim all happen before the
 *     response becomes a stream, so a 400/404/409 arrives as an `ApiError` the caller
 *     words with `messageOf`.
 *
 * The state is keyed on `subject`: when it changes, the previous stream is aborted and
 * the frames are cleared, because attributing one run's output to another is worse
 * than showing nothing.
 */
export interface RunStreamState<Act extends string> {
  phase: 'idle' | 'streaming' | 'ended';
  events: AgentSseEvent[];
  /**
   * Frames that arrived and could not be decoded.
   *
   * Kept beside the events rather than dropped, and *not* turned into a fake event: an
   * unfamiliar channel is a fact about the wire, and a surface that either hid it or
   * rendered it as if the server had sent a known channel would be lying in one of the
   * two directions. The chat stream keeps the same distinction
   * (`ChatStreamCallbacks.onInvalidFrame`).
   */
  invalid: { eventName: string; reason: string }[];
  end: StreamEnd | null;
  reconciliation: RunReconciliation | null;
  error: string | null;
  /** Which act the stream is: for the parked panel, a bare continue or a decision. */
  act: Act | null;
}

export interface RunStreamOptions<Input, Act extends string> {
  /** Identity of what is being watched. A change aborts and resets. */
  subject: string;
  run: (input: Input, callbacks: RunStreamCallbacks, signal: AbortSignal) => Promise<void>;
  actOf: (input: Input) => Act;
  /** The refusal's sentence, from the `ApiError` the route refused with. */
  messageOf: (error: unknown) => string;
  /** Refetch after the stream ends: the run row, the lane and the queue all moved. */
  invalidate: () => void;
  /** Refetch after a refusal, which changes less: nothing started. */
  invalidateAfterRefusal: () => void;
}

export function useAgentRunStream<Input, Act extends string>(options: RunStreamOptions<Input, Act>) {
  const { subject, run, actOf, messageOf, invalidate, invalidateAfterRefusal } = options;
  const client = useRef<AbortController | null>(null);
  const [state, setState] = useState<RunStreamState<Act>>({
    phase: 'idle',
    events: [],
    invalid: [],
    end: null,
    reconciliation: null,
    error: null,
    act: null,
  });

  useEffect(() => {
    client.current?.abort();
    client.current = null;
    setState({
      phase: 'idle',
      events: [],
      invalid: [],
      end: null,
      reconciliation: null,
      error: null,
      act: null,
    });
  }, [subject]);

  useEffect(
    () => () => {
      client.current?.abort();
    },
    [],
  );

  const start = useCallback(
    (input: Input): boolean => {
      if (client.current !== null) return false;
      const controller = new AbortController();
      client.current = controller;
      setState({
        phase: 'streaming',
        events: [],
        invalid: [],
        end: null,
        reconciliation: null,
        error: null,
        act: actOf(input),
      });

      void run(
        input,
        {
          onEvent: (event) => {
            setState((previous) => ({ ...previous, events: [...previous.events, event] }));
          },
          onInvalidFrame: (eventName, reason) => {
            setState((previous) => ({ ...previous, invalid: [...previous.invalid, { eventName, reason }] }));
          },
          onReconciled: (reconciliation) => {
            setState((previous) => ({ ...previous, reconciliation }));
          },
          onEnd: (reason) => {
            setState((previous) => ({ ...previous, phase: 'ended', end: reason }));
            client.current = null;
            invalidate();
          },
        },
        controller.signal,
      ).catch((error: unknown) => {
        client.current = null;
        setState((previous) => ({ ...previous, phase: 'ended', end: null, error: messageOf(error) }));
        invalidateAfterRefusal();
      });
      return true;
    },
    [actOf, invalidate, invalidateAfterRefusal, messageOf, run],
  );

  /**
   * Stop watching the stream.
   *
   * Deliberately *not* named "stop the task": dropping the connection stops a queued
   * run from ever starting and leaves a running one to notice the disconnect. Stopping
   * the work itself is `POST /api/{tool}/tasks/:taskId/cancel`, a different call with a
   * different promise, and conflating the two in one button would make a user believe
   * they had stopped an agent they merely stopped watching.
   */
  const detach = useCallback(() => {
    if (client.current === null) return;
    client.current.abort();
    client.current = null;
    setState((previous) => (previous.phase === 'streaming' ? { ...previous, phase: 'ended', end: 'cancelled' } : previous));
  }, []);

  /** Clear the log once nothing is streaming. Refuses to hide a live stream. */
  const dismiss = useCallback(() => {
    if (client.current !== null) return;
    setState((previous) => ({ ...previous, phase: 'idle', events: [], invalid: [], end: null, reconciliation: null, error: null, act: null }));
  }, []);

  return { state, start, detach, dismiss, isStreaming: state.phase === 'streaming' };
}
