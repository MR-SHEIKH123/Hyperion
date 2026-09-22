import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../api/errors';
import { startCodeTask, type StartCodeTaskInput } from '../../api/agentStream';
import { useAgentRunStream } from './useAgentRunStream';

import type { RunStreamState } from './useAgentRunStream';

export type StartAct = 'start';

/**
 * Owning the stream of a Code task started from this surface.
 *
 * The same machinery as a continuation (`useAgentRunStream`), with two differences
 * that come from the route rather than from taste:
 *
 *   - **There is no task to key on yet.** The subject is the surface, not a task id, so
 *     a finished attempt's frames stay on screen while the next one is composed.
 *   - **The refusal vocabulary is the lane's.** `run-task` validates its body, looks up
 *     the agent and checks the Code lane *before* the SSE headers, so a full lane is a
 *     JSON 409 `busy` with `details: { running, limit, queued }` — three numbers the
 *     sentence uses, because "the lane is full" without them reads like a limit nobody
 *     can see. Under `concurrency_mode: queue` there is no refusal at all: the stream
 *     opens and `started` arrives when a slot frees.
 */
export function useTaskStart() {
  const client = useQueryClient();
  const [taskId, setTaskId] = useState(() => suggestTaskId());
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'ask' | 'plan' | 'act'>('act');

  const run = useCallback(
    (input: StartCodeTaskInput, callbacks: Parameters<typeof startCodeTask>[1], signal: AbortSignal) =>
      startCodeTask(input, callbacks, signal),
    [],
  );

  const stream = useAgentRunStream<StartCodeTaskInput, StartAct>({
    subject: 'code:start',
    run,
    actOf: () => 'start',
    messageOf: startMessageFor,
    invalidate: () => {
      // The lane, the task list and the attention queue all change when a run starts,
      // parks or finishes. Refetching everything is deliberate here: this surface
      // starts runs rarely, and a stale lane is exactly the kind of thing that makes a
      // user start the same task twice.
      void client.invalidateQueries();
    },
    invalidateAfterRefusal: () => {
      void client.invalidateQueries({ queryKey: ['code', 'lane'] });
    },
  });

  const idValid = taskIdValid(taskId);
  const canStart =
    !stream.isStreaming && idValid && prompt.trim().length > 0;

  /**
   * Start the run.
   *
   * The task id is also the handle the surface passes as `chatId` (`code_<taskId>`),
   * which is the scheduler's own convention for a run with no conversation behind it —
   * see `startCodeTask` for why the route requires the field and what it stores.
   */
  const begin = (modelId: string): boolean =>
    stream.start({
      taskId,
      chatId: `code_${taskId}`,
      modelId,
      prompt: prompt.trim(),
      mode,
    });

  return { ...stream, taskId, setTaskId, prompt, setPrompt, mode, setMode, idValid, canStart, begin };
}

export type StartState = RunStreamState<StartAct>;
export type StartStream = ReturnType<typeof useTaskStart>;

/**
 * The composer's own inputs, kept beside the stream rather than inside the form.
 *
 * They live here because two regions need them and they must be the same values: the
 * composer renders the controls, and the progress region renders the frames of the run
 * those controls started, including the task id it is running under. A form that owned
 * its own state would leave the progress region guessing which task it was showing.
 */
export interface StartForm {
  taskId: string;
  setTaskId: (id: string) => void;
  prompt: string;
  setPrompt: (prompt: string) => void;
  mode: 'ask' | 'plan' | 'act';
  setMode: (mode: 'ask' | 'plan' | 'act') => void;
  /** The route's own rule for a task id, checked here so the 400 is not the first news. */
  idValid: boolean;
  canStart: boolean;
  /** Start the run. `modelId` comes from the picker, which the caller owns. */
  begin: (modelId: string) => boolean;
}

/**
 * A start refusal, in the words that say what to do about it.
 *
 * Everything here is pre-stream JSON, so it is an `ApiError` with the route's own
 * status and — for the two that matter — a structured `details`:
 *
 *   - **409 `busy`** is the Code lane, and the numbers are the point: `details` carries
 *     `running`, `limit` and `queued` from the lane itself, so the sentence can say what
 *     is running and whether anything is waiting rather than just "full".
 *   - **400 `bad_request`** is almost always the task id, which becomes a directory
 *     name and a git ref: the route wants a letter or digit first, then letters,
 *     digits, `.`, `-` and `_`, at most 100 characters, and never `..`. The client
 *     validates with that same rule before sending, so this text is the second line of
 *     defence and is passed through unchanged.
 *   - **501 `agent_not_registered`** means the Code module is absent from this server.
 *     Nothing the user can do from here, and saying so beats a retry loop.
 */
export function startMessageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'busy') {
      const running = error.details?.running;
      const limit = error.details?.limit;
      const queued = error.details?.queued;
      const numbers =
        typeof running === 'number' && typeof limit === 'number'
          ? ` (${running} of ${limit} slots in use${typeof queued === 'number' && queued > 0 ? `, ${queued} waiting` : ''})`
          : '';
      return `The Code lane is full${numbers}, and this server refuses a third task rather than queueing it. Wait for one to finish, or raise the lane limit.`;
    }
    if (error.code === 'agent_not_registered') {
      return 'This server has no Code agent registered, so a task cannot be started from here.';
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'The task could not be started.';
}

/**
 * The task id's own rule, from the code that enforces it (`safeTaskId` in
 * `src/services/code/worktree.ts`, reached from `parseTaskInput`).
 *
 * Three conditions, and this list is copied from that function rather than from the
 * prose beside it — the first version of this constant was `[A-Za-z0-9._-]{1,100}`,
 * which is what `docs/API.md` said and is *looser than the route*: it let a leading
 * `.` or `-` and any `..` through, so a typo would have been refused by the server
 * after the user pressed Start, with the shape rule the composer claims to check
 * disagreeing with the one that decides. It is a directory name and a git ref, which
 * is why the rule is this narrow and why a near-miss is refused rather than rewritten.
 */
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const TASK_ID_MAX = 100;

/** Whether the route would accept this task id — the composer's own check, verbatim. */
export function taskIdValid(taskId: string): boolean {
  return TASK_ID_PATTERN.test(taskId) && taskId.length <= TASK_ID_MAX && !taskId.includes('..');
}

/** A task id a person does not have to think about, from the clock. */
export function suggestTaskId(now: number = Date.now()): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  return `task-${stamp}`;
}
