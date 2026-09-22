import { describe, expect, it } from 'vitest';

import { taskStateResponseSchema } from '../../contracts/wire/tasks';
import { fromBackendRun } from './task-state';

/**
 * `interrupted` reached the backend vocabulary in migration `020` (Prompt 1,
 * item 1.31): a run the server left mid-flight is `interrupted`, not `error`.
 *
 * The frontend has to follow in the same two places that would otherwise fail
 * silently — the wire enum, which decides whether a perfectly valid response is
 * refused as a contract mismatch, and the view-state mapping, whose switch
 * returns `undefined` for a state it does not know.
 */
const run = (state: string, reason: string | null) => ({
  runId: 'run-1',
  taskId: 'task-1',
  tool: 'code',
  state,
  pauseReason: null,
  errorCode: 'internal_error',
  errorMessage: reason,
  startedAt: 1,
  updatedAt: 2,
  completedAt: 3,
});

describe('the interrupted task run state', () => {
  it('is part of the wire contract rather than an invalid response', () => {
    expect(taskStateResponseSchema.safeParse({ run: run('interrupted', 'The server restarted.') }).success).toBe(true);
  });

  it('maps to a view state of its own, not to error', () => {
    const state = fromBackendRun(taskStateResponseSchema.parse({ run: run('interrupted', 'The server restarted while this task was running.') }).run);
    expect(state.kind).toBe('interrupted');
    expect(state).toMatchObject({ reason: 'The server restarted while this task was running.' });
    // The mapping is total: every state the wire accepts has a view state, and a
    // state added to the enum without a case here would return undefined.
    expect(state).toBeDefined();
  });

  it('still tells a plain failure apart from an interruption', () => {
    const failed = fromBackendRun(
      taskStateResponseSchema.parse({ run: run('error', 'The provider refused the request.') }).run,
    );
    expect(failed.kind).toBe('error');
  });
});
