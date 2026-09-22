import { attentionToolSchema } from '../contracts/wire/attention';

import type { AttentionItem } from '../contracts/wire/attention';
import type { z } from 'zod';

export type AttentionTool = z.infer<typeof attentionToolSchema>;

export interface AttentionDestination {
  /** A shell route. The frontend owns this space; the backend never sends one. */
  href: string;
  label: string;
  /**
   * Present when the destination cannot show the item, which is a fact the user
   * needs rather than a link that looks like every other link and then explains
   * itself on arrival.
   */
  caveat?: string;
}

const TASK_TOOL_LABEL: Record<'code' | 'cowork' | 'design', string> = {
  code: 'Code',
  cowork: 'Cowork',
  design: 'Design',
};

/**
 * Where a queue item points.
 *
 * The mapping lives here rather than in the backend's `resolve` field on purpose:
 * `resolve` is the *call* that answers an item, and a server that also emitted
 * frontend URLs would have to be redeployed every time a route moved. The shell
 * owns its own URL space, so the shell is where the translation happens.
 *
 * What a task item points at depends on whether the tool has a surface, and the
 * answer changed under this comment once. Code has one — a Code item is a real deep
 * link to `/code?task=…&run=…`, and since 2026-09-22 that screen can also *continue*
 * the parked run, which is what the queue's own notice tells the user to do. Cowork
 * and Design do not, so their items link to the tool's honest placeholder *with the
 * ids attached*, and the destination carries a caveat saying so rather than letting
 * the user discover it. A dead-looking row with no link at all would be worse — the
 * queue is where the user learns the task is waiting, and it has to take them
 * somewhere that tells them the truth.
 *
 * One kind is deliberately not actionable from here: an orphaned worktree carries
 * a `resolve` call that *deletes a directory*, and a queue row is one mis-click
 * away from a link someone is scanning. It links to the surface that owns Code
 * and says where the listing actually is. Destructive calls belong on the screen
 * that describes them, not behind a row in an inbox.
 */
export function attentionDestination(item: AttentionItem): AttentionDestination {
  switch (item.kind) {
    case 'approval_required':
    case 'paused':
    case 'blocked':
    case 'plan_ready':
    case 'interrupted':
    case 'ready_for_review': {
      if (item.tool === 'chat') {
        const chatId = item.chatId ?? null;
        return chatId === null
          ? { href: '/chat', label: 'Open Chat' }
          : { href: `/chat/${chatId}`, label: 'Open conversation' };
      }
      if (item.tool === 'system') {
        // No task id and a system tool: nothing owns this. It should not happen,
        // and saying so is better than inventing a destination.
        return {
          href: '/attention',
          label: 'No destination',
          caveat: 'This item arrived without a tool that can show it.',
        };
      }
      const label = TASK_TOOL_LABEL[item.tool];
      const query = new URLSearchParams();
      if (item.taskId !== undefined) query.set('task', item.taskId);
      if (item.runId !== undefined) query.set('run', item.runId);
      const href = `/${item.tool}${query.size === 0 ? '' : `?${query}`}`;
      const destination = { href, label: `Open in ${label}` };
      // Code's surface landed (1.39 A3), so a Code item is a real deep link to
      // the task and carries no caveat. The remaining task tools still open their
      // placeholders, and the placeholder is what tells the truth about them.
      return item.tool === 'code'
        ? destination
        : {
            ...destination,
            caveat: `The ${label} workspace is not built yet — this opens the ${label} surface, which names the task and says so.`,
          };
    }
    case 'scheduled_run_failed':
      return { href: '/cowork', label: 'Open Cowork', caveat: 'Scheduled tasks live in Cowork, whose surface is not built yet.' };
    case 'backup_failure':
      return { href: '/settings', label: 'Open Settings', caveat: 'Backups are configured in Settings, whose surface is not built yet.' };
    case 'spending_cap':
      return { href: '/settings', label: 'Open Settings', caveat: 'The daily cap is set in Settings, whose surface is not built yet.' };
    case 'mcp_disconnected':
      return { href: '/settings', label: 'Open Settings', caveat: 'MCP servers are managed in Settings, whose surface is not built yet.' };
    case 'orphaned_worktree':
      // No screen lists worktrees yet, and the queue is not the place to invent
      // one: the row says what the directory is and the caveat says where the
      // decision actually lives. `resolve` on the item is the call, and the queue
      // does not fire destructive calls from a link — that would make a mis-click
      // delete a checkout.
      return {
        href: '/code',
        label: 'Open Code',
        caveat:
          'The leftover checkout is listed by the storage API (`GET /api/storage/worktrees`), which has no screen yet.',
      };
  }
}

/** Human labels for the eleven kinds, in one place so a badge cannot drift from a heading. */
export const KIND_LABEL: Record<AttentionItem['kind'], string> = {
  approval_required: 'Decision needed',
  plan_ready: 'Plan ready',
  interrupted: 'Interrupted',
  paused: 'Paused',
  blocked: 'Blocked',
  ready_for_review: 'Ready for review',
  scheduled_run_failed: 'Scheduled run failed',
  backup_failure: 'Backup failed',
  spending_cap: 'Spending',
  mcp_disconnected: 'MCP disconnected',
  orphaned_worktree: 'Leftover checkout',
};

export const KIND_TONE: Record<
  AttentionItem['kind'],
  'neutral' | 'info' | 'warning' | 'success' | 'error'
> = {
  approval_required: 'warning',
  plan_ready: 'info',
  interrupted: 'warning',
  paused: 'warning',
  blocked: 'warning',
  ready_for_review: 'info',
  scheduled_run_failed: 'error',
  backup_failure: 'error',
  spending_cap: 'warning',
  mcp_disconnected: 'error',
  // A warning, not an error: nothing failed. Work may be sitting in a directory
  // nobody owns, which is a decision rather than a fault.
  orphaned_worktree: 'warning',
};

/** "3m ago" — short because it sits in a dense list, and never "in the future". */
export function relativeTime(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The three decisions, in the order the task view offers them. */
export const DECISIONS = [
  { decision: 'allow_once', label: 'Allow once' },
  { decision: 'allow_session', label: 'Allow for this task' },
  { decision: 'deny', label: 'Deny' },
] as const;
