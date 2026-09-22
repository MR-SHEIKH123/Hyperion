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
  /**
   * The two allow decisions — and deliberately not `deny`.
   *
   * `POST /continue` accepts a denial, and answers it with **JSON on the same 200**
   * rather than a stream, because a denial finishes the run and there is no agent to
   * watch (`finishDenied`). A caller of this function is a stream watcher, so passing
   * a denial through it could only ever produce a protocol error for a success;
   * denials belong to `POST /approve`, which is idempotent and answers `applied` and
   * `state` for exactly that case (`api/attention.ts`, and the parked-task panel
   * shows it that way).
   */
  decision?: 'allow_once' | 'allow_session';
}

/**
 * What the persisted run says, read after a stream that ended without a result.
 *
 * Shared by every caller that watches an agent run, which is why the name is not
 * `Continue…`: starting a run reconciles the same way, for the same reason.
 */
export interface RunReconciliation {
  state: string;
  pauseReason: string | null;
  /** The run the re-read found, which is a different run id from the parked one. */
  runId: string;
}

export interface RunStreamCallbacks {
  onEvent: (event: AgentSseEvent) => void;
  onEnd: (reason: StreamEnd) => void;
  /** The persisted truth after a stream that ended without a terminal frame. */
  onReconciled?: (reconciliation: RunReconciliation) => void;
  /** Decoded frames that failed validation, kept separate so drift is diagnosable. */
  onInvalidFrame?: (eventName: string, reason: string) => void;
}

/**
 * One agent run's stream, whichever route started it.
 *
 * The two routes that drive a task — `/continue` and `/run-task` — answer with the
 * same protocol: a JSON refusal before the stream opens, then `agent` frames until the
 * run ends, with no terminal event name a session can watch for. So they share this
 * call rather than a copy of it, and they share the reconciliation below: the run's
 * *persisted* state is read back from `GET /api/{tool}/tasks/:taskId/state`, which
 * both routes keep up to date and which is the only answer that survives a dropped
 * socket.
 */
function runAgentStream(
  input: { request: string; body: Record<string, unknown>; tool: TaskTool; taskId: string },
  callbacks: RunStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  return runStreamSession({
    request: input.request,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input.body) },
    // `error` is the only terminal *event name* the protocol uses; a `result` frame
    // rides inside `agent`, so a normal ending reconciles rather than terminating.
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

export function continueTask(
  input: ContinueTaskInput,
  callbacks: RunStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const body: Record<string, string> = {};
  if (input.approvalId !== undefined) body.approvalId = input.approvalId;
  if (input.decision !== undefined) body.decision = input.decision;

  return runAgentStream(
    { request: `/api/${input.tool}/tasks/${encodeURIComponent(input.taskId)}/continue`, body, tool: input.tool, taskId: input.taskId },
    callbacks,
    signal,
  );
}

/**
 * Starting a Code task — `POST /api/code/run-task` (docs/API.md §12).
 *
 * The body is `TaskInput` plus the task id, which for Code is **required** and is the
 * run's identity for its whole life: it is the key for the worktree, the lane slot and
 * `GET /api/code/tasks`. The route validates the id before the stream opens — a letter
 * or digit first, then letters, digits, `.`, `-` or `_`, at most 100 characters, and
 * never `..` (`safeTaskId` in `src/services/code/worktree.ts`) — because it becomes a
 * directory name and a git ref; anything else is a `bad_request` rather than something
 * quietly rewritten. `taskIdValid` in `tools/code/useTaskStart.ts` mirrors that rule so
 * the composer refuses a typo in place.
 *
 * Two facts a caller has to be told rather than discover:
 *
 *   - **`chatId` is a correlation handle, not necessarily a conversation.** The route
 *     requires the field, and stores it only when a chat with that id exists
 *     (`linkedChatId`: `chat_id` is a real foreign key, and a run about to start must
 *     not lose its state row over a convenience link). A surface starting a task with
 *     no conversation behind it passes its own handle, exactly as the scheduler does
 *     for an unattended run (`sched_<task>_<runId>`); the run row keeps `NULL` and the
 *     task remains continuable, because `continuationInput` falls back to the task id.
 *   - **The lane is a real refusal.** With `concurrency_mode: reject` a full Code lane
 *     answers 409 `busy` *before* the stream, with `details: { running, limit, queued }`;
 *     under `queue` the stream opens and sits silent until `started` arrives, which the
 *     progress view states rather than looking hung.
 */
export interface StartCodeTaskInput {
  taskId: string;
  /** A chat id when the task belongs to one; otherwise a surface-scoped handle. */
  chatId: string;
  modelId: string;
  prompt: string;
  mode?: 'ask' | 'plan' | 'act';
}

export function startCodeTask(
  input: StartCodeTaskInput,
  callbacks: RunStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  return runAgentStream(
    {
      request: '/api/code/run-task',
      body: {
        taskId: input.taskId,
        chatId: input.chatId,
        modelId: input.modelId,
        prompt: input.prompt,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
      },
      tool: 'code',
      taskId: input.taskId,
    },
    callbacks,
    signal,
  );
}
