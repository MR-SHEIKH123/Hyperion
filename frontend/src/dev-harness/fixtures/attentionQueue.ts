import type { AttentionQueue } from '../../contracts/wire/attention';

/**
 * Every kind the queue can send, in one fixture, for the dev harness (1.39 A4).
 *
 * The point of rendering all ten is the same as the operational fixtures': a state
 * that has never been seen is a state that will be discovered in production. The
 * items are shaped exactly as `GET /api/attention` shapes them — the timestamps are
 * fixed rather than relative so a screenshot is reproducible — and the sources
 * block includes one `unavailable` entry on purpose, because that is the rendering
 * most likely to regress into a silently missing category.
 */
const NOW = 1_766_000_000_000;

const item = (
  id: string,
  kind: AttentionQueue['items'][number]['kind'],
  tool: AttentionQueue['items'][number]['tool'],
  title: string,
  detail: string,
  extra: Partial<AttentionQueue['items'][number]> = {},
): AttentionQueue['items'][number] => ({
  id,
  kind,
  tool,
  title,
  detail,
  createdAt: NOW - 4 * 60_000,
  ...extra,
});

export const attentionQueueFixture: AttentionQueue = {
  generatedAt: NOW,
  total: 11,
  counts: {
    approval_required: 1,
    plan_ready: 1,
    interrupted: 1,
    paused: 1,
    blocked: 1,
    ready_for_review: 1,
    scheduled_run_failed: 1,
    backup_failure: 1,
    spending_cap: 1,
    mcp_disconnected: 1,
    orphaned_worktree: 1,
  },
  items: [
    item('approval:a1', 'approval_required', 'code', 'bash needs a decision', 'The project rules deny this command.', {
      taskId: 'task-7f2',
      runId: 'run-7f2',
      resolve: { method: 'POST', path: '/api/code/tasks/task-7f2/approve' },
    }),
    item('blocked:run-3', 'blocked', 'cowork', 'cowork task is blocked', 'waiting_for_knowledge_source', {
      taskId: 'task-3',
      runId: 'run-3',
    }),
    item('plan:run-4', 'plan_ready', 'code', 'code task has a plan ready', 'Move the parser into src/parser/ and keep the old export.', {
      taskId: 'task-4',
      runId: 'run-4',
    }),
    item('interrupted:run-5', 'interrupted', 'design', 'design task was interrupted by a restart', 'The server restarted while this task was running.', {
      taskId: 'task-5',
      runId: 'run-5',
    }),
    item('paused:run-6', 'paused', 'chat', 'A response is paused', 'The provider timed out.', {
      chatId: 'chat-1',
      runId: 'run-6',
      resolve: { method: 'POST', path: '/api/chat/resume', body: { runId: 'run-6' } },
    }),
    item('review:run-8', 'ready_for_review', 'design', 'design task is ready for review', 'The work is done and specifically wants your eyes.', {
      taskId: 'task-8',
      runId: 'run-8',
    }),
    item('schedule:s1', 'scheduled_run_failed', 'cowork', 'Scheduled task "Morning briefing" failed on its last run', 'no provider could be reached', {
      taskId: 's1',
    }),
    item('backup:41', 'backup_failure', 'system', 'A backup request failed', 'The backup directory is not writable. (/api/backup/inspect)'),
    item('spending:warning', 'spending_cap', 'system', "80% of today's spending cap is used", 'Spent $8.00 of $10.00, $2.00 left. Autonomous runs are refused at the cap.', {
      createdAt: NOW - 6 * 60 * 60_000,
    }),
    item('mcp:wigolo', 'mcp_disconnected', 'system', 'MCP server "wigolo" is not running', 'the supervisor reported a failed handshake'),
    item(
      'worktree:task-9c1',
      'orphaned_worktree',
      'code',
      'A Code checkout was left behind: task-9c1',
      'it has uncommitted changes Nothing was deleted, and this directory belongs to no running task. Remove it if that work is already somewhere else.',
      {
        taskId: 'task-9c1',
        resolve: { method: 'POST', path: '/api/storage/worktrees/task-9c1/discard' },
      },
    ),
  ],
  sources: [
    { source: 'pending_approvals', status: 'ok', count: 1 },
    { source: 'task_runs', status: 'ok', count: 5 },
    { source: 'chat_runs', status: 'ok', count: 1 },
    { source: 'scheduled_task_runs', status: 'ok', count: 1 },
    {
      source: 'backup_failures',
      status: 'ok',
      count: 1,
      reason:
        'detected from the error log over the last 24h: a backup has no run record, so a success leaves nothing to compare a failure against',
    },
    { source: 'spending', status: 'ok', count: 1 },
    { source: 'mcp', status: 'unavailable', count: 0, reason: 'the MCP process manager is not managed by this process' },
    { source: 'worktrees', status: 'ok', count: 1 },
  ],
};
