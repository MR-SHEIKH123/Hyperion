import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../api/errors';
import { continueTask, type ContinueTaskInput } from '../../api/agentStream';
import { useAgentRunStream } from './useAgentRunStream';

import type { RunStreamState } from './useAgentRunStream';

/**
 * Owning the continuation stream for one task.
 *
 * The stream machinery lives in `useAgentRunStream` — the same four properties the
 * composer's start gesture needs — and what stays here is what is specific to a
 * continuation: the act it is performing (a bare continue, or an approval being
 * resolved), the route's own refusal vocabulary, and the queries that move when a
 * parked run is picked back up.
 */
export type ContinuationAct = 'continue' | 'decision';

export function useTaskContinuation(tool: 'code' | 'cowork' | 'design', taskId: string | null) {
  const client = useQueryClient();

  const run = useCallback(
    (input: Omit<ContinueTaskInput, 'tool' | 'taskId'>, callbacks: Parameters<typeof continueTask>[1], signal: AbortSignal) =>
      // A null task id cannot reach here: `start` refuses first. The route would 404
      // on an empty id, and a client that posted one would be inventing a task.
      continueTask({ tool, taskId: taskId ?? '', ...input }, callbacks, signal),
    [taskId, tool],
  );

  const stream = useAgentRunStream<Omit<ContinueTaskInput, 'tool' | 'taskId'>, ContinuationAct>({
    subject: `${tool}:${taskId ?? ''}`,
    run,
    actOf: (input) => (input.approvalId === undefined ? 'continue' : 'decision'),
    messageOf: messageFor,
    invalidate: () => {
      // The run row, the lane and the queue all move when a continuation starts, parks
      // again or finishes; refetching is what makes the screen agree with the server
      // rather than with the frames it saw.
      void client.invalidateQueries();
    },
    invalidateAfterRefusal: () => {
      void client.invalidateQueries({ queryKey: ['code', 'task', taskId] });
    },
  });

  const { start } = stream;
  const startForTask = useCallback(
    (input: Omit<ContinueTaskInput, 'tool' | 'taskId'> = {}) => (taskId === null ? false : start(input)),
    [start, taskId],
  );

  return { ...stream, start: startForTask };
}

export type ContinuationState = RunStreamState<ContinuationAct>;

/**
 * A continuation refusal, in the words that say what to do about it.
 *
 * The route refuses before the stream opens, so every one of these arrives as an
 * `ApiError` on a 404/409 with a `details.reason` (docs/API.md §12.6):
 *
 *   - `already_claimed` — somebody else (or an earlier click) is continuing this task.
 *     Not the user's mistake, and not a bug: two windows on one task is ordinary.
 *   - `expired` — the prompt aged out before it was answered. Nobody answered it, so
 *     the way back is a bare continue, which asks again; the server's own message says
 *     exactly that and is passed through.
 *   - `no_snapshot` — the task parked without a stored conversation, so there is
 *     nothing to resume from. Retrying cannot help; starting the task again can.
 *   - `already_resolved` — a decision landed between the read and the click.
 *
 * `error.details?.reason` is read rather than the message text because the reason is
 * the stable part; the prose around it is the server's to change.
 */
export function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
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
