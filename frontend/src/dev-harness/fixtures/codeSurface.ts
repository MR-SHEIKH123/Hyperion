import type { z } from 'zod';

import type { codeLaneSchema, taskUsageSchema } from '../../contracts/wire/tasks';

type CodeLane = z.infer<typeof codeLaneSchema>;
type TaskSpend = z.infer<typeof taskUsageSchema>;

/**
 * Code surface fixtures (Prompt 1.39 A3/A4) for the dev harness.
 *
 * The surface's own rules are about what it refuses to claim, so the fixtures are
 * chosen to make each claim visible: a lane that is full and one that is idle, a
 * slot with no task id, a task parked while holding its worktree, spend that is
 * priced, a floor, and unpriced — and a task with nothing recorded at all, which
 * is the state most easily mistaken for "free".
 */

const NOW = 1_766_000_000_000;

export const codeLaneFixture: CodeLane = {
  running: 2,
  limit: 3,
  queued: 4,
  active: [
    { id: 'slot-1', taskId: 'task-7f2a', label: 'Move the parser behind an interface', startedAt: NOW - 320_000, worktree: '/tmp/hyperion/wt-7f2a' },
    { id: 'slot-2', taskId: null, label: null, startedAt: NOW - 4_000, worktree: null },
  ],
  held: [
    { taskId: 'task-31c8', worktree: '/tmp/hyperion/wt-31c8', branch: 'hyperion/task-31c8', heldSince: NOW - 3_600_000, state: 'paused' },
    { taskId: 'task-9e01', worktree: '/tmp/hyperion/wt-9e01', branch: 'hyperion/task-9e01', heldSince: NOW - 7_200_000, state: 'interrupted' },
  ],
};

export const idleCodeLaneFixture: CodeLane = { running: 0, limit: 3, queued: 0, active: [], held: [] };

/** Spend with a price for every request: the figure is the whole bill. */
export const pricedTaskSpendFixture: TaskSpend = {
  requests: 12,
  runs: 2,
  tokensIn: 128_400,
  tokensOut: 21_930,
  costUsd: 0.4182,
  priced: true,
  unpricedRequests: 0,
};

/** Some requests have no price row: the figure is a floor, and says so. */
export const partiallyPricedTaskSpendFixture: TaskSpend = {
  requests: 9,
  runs: 1,
  tokensIn: 44_100,
  tokensOut: 7_820,
  costUsd: 0.1027,
  priced: false,
  unpricedRequests: 3,
};

/** No price matched at all, and nothing was recorded: both are absences, not zeros. */
export const unpricedTaskSpendFixture: TaskSpend = {
  requests: 4,
  runs: 1,
  tokensIn: 900,
  tokensOut: 140,
  costUsd: null,
  priced: false,
  unpricedRequests: 4,
};

export const unrecordedTaskSpendFixture: TaskSpend = {
  requests: 0,
  runs: 0,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: null,
  priced: false,
  unpricedRequests: 0,
};
