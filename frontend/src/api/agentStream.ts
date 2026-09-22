import { runStreamSession, type StreamEnd } from './sse/session';
import { decodeAgentEvent, type AgentSseEvent } from './sse/events';
import { getTaskState } from './tasks';

import type { taskToolSchema } from '../contracts/wire/tasks';
import type { z } from 'zod';

type TaskTool = z.infer<typeof taskToolSchema>;

/**
 * Continuing a parked task — `POST /api/{tool}/tasks/:taskId/continue`.
 *
 * This is the call that starts a parked run again, and it is deliberately separate
 * from approving one: `POST /approve` records a decision and stops there, which is
 * what lets a notification be answered without committing to drive a run from that
 * connection (docs/API.md §12.5). The consequence for a UI is that *answering a
 * prompt is not resuming the task*, and until this module existed nothing in the
 * frontend made the second call — the Attention Center posted the decision and then
 * told the user to "open the task and continue it", which no screen could do.
 *
 * **Why it is a stream and not a POST with a JSON answer.** The continuation is a
 * real agent run: it edits files and spends tokens, and its progress is what the
 * person is watching. The route validates, claims and resolves before the response
 * becomes a stream, so every refusal above arrives as an ordinary JSON `ApiError`
 * (409 `already_claimed`, `not_parked`, `expired`) — that is what the shared
 * `runStreamSession` already does for chat, reused here rather than reimplemented.
 *
 * **Why `error` is the only terminal event name.** The agent protocol carries
 * everything inside one `agent` event with a `channel` discriminator, so the
 * session's terminal-event check — which matches on the SSE event name — cannot see
 * `result`. A normal close therefore falls through to reconciliation, which is the
 * truth-telling path anyway: the persisted run state is read back and reported, and
 * a stream that died mid-run is not replayed (a mutation, unlike a chat turn, must
 * never be re-sent by a client that lost the socket).
 */
export interface ContinueTaskInput {
  tool: TaskTool;
  taskId: string;
  /**
   * Resolve this approval and continue in one call.
   *
   * The pair is what makes "allow once and resume" a single act here rather than two
   * calls that can disagree — the route applies the decision and starts the run, or
   * refuses both. Omit it to simply continue: the stored conversation is replayed,
   * the gated call is re-emitted and the user is asked again with fresh arguments.
   */
  approvalId?: string;
  decision?: 'allow_once' | 'allow_session' | 'deny';
}

export interface ContinueReconciliation {
  state: string;
  pauseReason: string | null;
  /** The run the re-read found, which is a different run id from the parked one. */
  runId: string;
}

export interface ContinueCallbacks {
  onEvent: (event: AgentSseEvent) => void;
  onEnd: (reason: StreamEnd) => void;
  /** The persisted truth after a stream that ended without a terminal frame. */
  onReconciled?: (reconciliation: ContinueReconciliation) => void;
  /** Decoded frames that failed validation, kept separate so drift is diagnosable. */
  onInvalidFrame?: (eventName: string, reason: string) => void;
}

export function continueTask(
  input: ContinueTaskInput,
  callbacks: ContinueCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const body: Record<string, string> = {};
  if (input.approvalId !== undefined) body.approvalId = input.approvalId;
  if (input.decision !== undefined) body.decision = input.decision;

  return runStreamSession({
    request: `/api/${input.tool}/tasks/${encodeURIComponent(input.taskId)}/continue`,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    terminalEvents: new Set(['error']),
    onFrame: (frame) => {
      const decoded = decodeAgentEvent(frame);
      if (decoded.ok) {
        callbacks.onEvent(decoded.event);
      } else {
        callbacks.onInvalidFrame?.(decoded.eventName, decoded.reason);
      }
    },
    onEnd: callbacks.onEnd,
    reconcile: async (sessionSignal) => {
      const state = await getTaskState(input.tool, input.taskId, sessionSignal);
      callbacks.onReconciled?.({
        state: state.run.state,
        pauseReason: state.run.pauseReason,
        runId: state.run.runId,
      });
    },
    ...(signal === undefined ? {} : { signal }),
  });
}
