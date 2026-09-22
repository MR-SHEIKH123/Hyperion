import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { continueTask, type ContinueReconciliation } from '../../api/agentStream';
import { ApiError } from '../../api/errors';

import type { AgentSseEvent } from '../../api/sse/events';
import type { ContinueTaskInput } from '../../api/agentStream';
import type { StreamEnd } from '../../api/sse/session';

/**
 * Owning the continuation stream for one task.
 *
 * A parked task is the one place in this surface where a read is not enough: the
 * user has to be able to *do* something, and the thing is a stream they then watch.
 * Three properties are the reason this is a hook rather than a button that fires a
 * fetch and forgets:
 *
 *   - **The stream is owned and cancellable.** A continuation edits files; a person
 *     who navigates away or changes their mind must be able to stop it, and the
 *     server's cancellation route is separate (`POST /cancel`) — what this abort
 *     does is drop the connection, which the route treats as the run's liveness for
 *     a *queued* continuation and as a normal disconnect once it is running. The
 *     button says which of the two it is doing rather than pretending they are the
 *     same act.
 *   - **Every frame is kept, and none is interpreted here.** The agent protocol's
 *     payloads are per-channel and open by design (`docs/API.md` §12.5), so the hook
 *     stores what arrived and the surface renders the channels it understands —
 *     an unfamiliar channel renders as itself rather than disappearing.
 *   - **A stream that ends without a result reconciles instead of guessing.** The
 *     end reason is reported (`terminal-event`, `socket-closed`, `disconnected`,
 *     `cancelled`) and the persisted state is re-read, because "the socket closed"
 *     and "the run finished" are different facts and only the second one is an
 *     outcome.
 *
 * A refusal before the stream opens (409 `not_parked`, `already_claimed`, `expired`)
 * arrives as an `ApiError`, and `already_claimed` gets its own sentence: it means
 * somebody else is already continuing this task, which is not the user's mistake.
 */
export interface ContinuationState {
  phase: 'idle' | 'streaming' | 'ended';
  events: AgentSseEvent[];
  /**
   * Frames that arrived and could not be decoded.
   *
   * Kept beside the events rather than dropped, and *not* turned into a fake event:
   * an unfamiliar channel is a fact about the wire, and a surface that either hid it
   * or rendered it as if the server had sent a known channel would be lying in one
   * of the two directions. The chat stream keeps the same distinction
   * (`ChatStreamCallbacks.onInvalidFrame`).
   */
  invalid: { eventName: string; reason: string }[];
  end: StreamEnd | null;
  reconciliation: ContinueReconciliation | null;
  error: string | null;
  /** Which act the running stream is: resolving an approval, or a bare continue. */
  act: 'continue' | 'decision' | 'cancel' | null;
}

const IDLE: ContinuationState = {
  phase: 'idle',
  events: [],
  invalid: [],
  end: null,
  reconciliation: null,
  error: null,
  act: null,
};

export function useTaskContinuation(tool: 'code' | 'cowork' | 'design', taskId: string | null) {
  const client = useQueryClient();
  const [state, setState] = useState<ContinuationState>(IDLE);
  const abort = useRef<AbortController | null>(null);

  // A task change is a different subject: keeping the previous task's frames on
  // screen would attribute one run's output to another.
  useEffect(() => {
    abort.current?.abort();
    abort.current = null;
    setState(IDLE);
  }, [tool, taskId]);

  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );

  const start = useCallback(
    (input: Omit<ContinueTaskInput, 'tool' | 'taskId'> = {}) => {
      if (taskId === null || abort.current !== null) return;
      const controller = new AbortController();
      abort.current = controller;
      setState({
        phase: 'streaming',
        events: [],
        invalid: [],
        end: null,
        reconciliation: null,
        error: null,
        act: input.approvalId === undefined ? 'continue' : 'decision',
      });

      void continueTask(
        { tool, taskId, ...input },
        {
          onEvent: (event) => {
            setState((previous) => ({ ...previous, events: [...previous.events, event] }));
          },
          onInvalidFrame: (eventName, reason) => {
            setState((previous) => ({
              ...previous,
              invalid: [...previous.invalid, { eventName, reason }],
            }));
          },
          onReconciled: (reconciliation) => {
            setState((previous) => ({ ...previous, reconciliation }));
          },
          onEnd: (reason) => {
            setState((previous) => ({ ...previous, phase: 'ended', end: reason, act: previous.act }));
            abort.current = null;
            // The run row, the lane and the queue all move when a continuation
            // starts, parks again or finishes; refetching is what makes the screen
            // agree with the server rather than with the frames it saw.
            void client.invalidateQueries();
          },
        },
        controller.signal,
      ).catch((error: unknown) => {
        abort.current = null;
        setState((previous) => ({ ...previous, phase: 'ended', end: null, error: messageFor(error) }));
        void client.invalidateQueries({ queryKey: ['code', 'task', taskId] });
      });
    },
    [client, taskId, tool],
  );

  /**
   * Stop watching the stream.
   *
   * Deliberately *not* named "stop the task": dropping the connection stops a
   * queued continuation from ever starting, and leaves a running one to notice the
   * disconnect. Stopping the work itself is `POST /api/{tool}/tasks/:taskId/cancel`,
   * a different call with a different promise, and conflating the two in one button
   * would make a user believe they had stopped an agent they merely stopped
   * watching.
   */
  const detach = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setState((previous) =>
      previous.phase === 'streaming' ? { ...previous, phase: 'ended', end: 'cancelled', act: 'cancel' } : previous,
    );
  }, []);

  const dismiss = useCallback(() => {
    if (abort.current !== null) return;
    setState(IDLE);
  }, []);

  return { state, start, detach, dismiss, isStreaming: state.phase === 'streaming' };
}

/**
 * A continuation refusal, in the words that say what to do about it.
 *
 * The route refuses before the stream opens, so every one of these arrives as an
 * `ApiError` on a 404/409 with a `details.reason` (docs/API.md §12.6):
 *
 *   - `already_claimed` — somebody else (or an earlier click) is continuing this task.
 *     Not the user's mistake, and not a bug: two windows on one task is ordinary.
 *   - `expired` — the prompt aged out before it was answered. Nobody answered it, so
 *     the way back is a bare continue, which asks again; the server's own message
 *     says exactly that and is passed through.
 *   - `no_snapshot` — the task parked without a stored conversation, so there is
 *     nothing to resume from. Retrying cannot help; starting the task again can.
 *   - `already_resolved` — a decision landed between the read and the click.
 *
 * `error.details?.reason` is read rather than the message text because the reason is
 * the stable part; the prose around it is the server's to change.
 */
export function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    // `already_claimed` is the one refusal that is about somebody else's action
    // rather than this user's: two clients on one task, or a retry of a click whose
    // first attempt is still running. Saying so is the difference between a bug
    // report and "it is already continuing".
    if (error.code === 'conflict' && error.details?.reason === 'already_claimed') {
      return 'This task is already being continued — another window or an earlier click got there first.';
    }
    if (error.code === 'conflict' && error.details?.reason === 'no_snapshot') {
      return 'This task parked without a stored conversation, so there is nothing to resume from. Starting it again begins a new run.';
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'The continuation could not be started.';
}
