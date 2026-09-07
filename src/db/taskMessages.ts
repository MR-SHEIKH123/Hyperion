/**
 * Conversation snapshots, taken only at stopping points.
 *
 * A run's `messages` array lived entirely in a `let` inside the agent closure, so
 * a parked run had nothing to resume from. `db/taskRuns.ts` said so plainly:
 * *"unlike a chat run there is no resume path."* That was true, and it meant five
 * separate park reasons — three of which already existed — were dead ends
 * presented to the user as pauses.
 *
 * This table is the minimum needed to make a park continuable, and the design is
 * mostly about what it deliberately is not.
 *
 * ## It is not continuous persistence
 *
 * `014_task_steps.sql` drew a line at "not deltas, not prompt text", and `007`
 * rejected "persist every token". Both were about *step history*: what did this run
 * do, readable afterwards. Run continuation did not exist as a requirement then.
 *
 * A snapshot is written at a park and at a ceiling warning — never per turn. On the
 * hot path this costs nothing, and what lands is one row set replacing another at a
 * moment the run has already stopped. That is a different thing from streaming every
 * token into the database, and the boundary moved for a stated reason rather than
 * being quietly abandoned.
 *
 * ## It is stored verbatim, and that is the security trade
 *
 * Continuation replays this conversation. Redacting it would have the agent resume
 * believing it read something it can no longer see — a `read` whose output was
 * masked becomes a file the model thinks it knows and does not. Correct replay and
 * redaction are mutually exclusive, and a continuation that silently resumes from a
 * corrupted memory is worse than no continuation.
 *
 * So the control is the **retention window**, not the content. A snapshot exists
 * only between a park and its continuation or terminal state. Deleting it on the
 * terminal transition is therefore a security property with a test behind it, not
 * housekeeping — `runCleanup` is a backstop for rows a crash orphaned, never the
 * primary mechanism.
 *
 * Be clear about the size of the surface: tool results carry **full file contents
 * the agent read and raw command output**, so a live snapshot is effectively a
 * partial copy of the user's source tree. That is why `exportBackup` strips this
 * table from the archive it writes — see `backup/export.ts`.
 *
 * ## It has no foreign key
 *
 * Verbatim from `015_subagent_runs.sql`: scheduled and headless work may have no
 * run row, and `task_runs` uses `INSERT OR REPLACE` when an attempt restarts, so a
 * cascading relation would erase the snapshot during exactly the restart it needs
 * to survive.
 */

import { getDb } from './adapter.ts';
import { createLogger } from '../util/logger.ts';

import type { ChatMessage, MessageRole } from '../types/core.ts';

const log = createLogger('taskmessages');

/**
 * The largest conversation kept whole.
 *
 * Past this the *pruned* form is stored instead. Prune already runs before every
 * turn, so the pruned conversation is a real one the run could have been sent —
 * unlike a truncated message, which is neither the conversation nor a valid
 * request. This caps at-rest exposure as well as size.
 */
export const SNAPSHOT_BYTE_CAP = 2 * 1024 * 1024;

const ROLES: readonly MessageRole[] = ['system', 'user', 'assistant', 'tool'];

interface TaskMessageRow {
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  name: string | null;
}

function mapRow(row: TaskMessageRow): ChatMessage {
  const message: ChatMessage = {
    role: ROLES.includes(row.role as MessageRole) ? (row.role as MessageRole) : 'user',
    content: row.content,
  };
  if (row.tool_calls !== null) {
    try {
      const parsed = JSON.parse(row.tool_calls) as ChatMessage['toolCalls'];
      if (Array.isArray(parsed) && parsed.length > 0) message.toolCalls = parsed;
    } catch {
      // A row this process wrote cannot normally fail to parse. Dropping the
      // field rather than the message is the recoverable half: the assistant turn
      // still reads back, and the continuation refuses on the missing pairing
      // instead of throwing here.
      log.warn('a snapshotted assistant turn had unreadable tool calls');
    }
  }
  if (row.tool_call_id !== null) message.toolCallId = row.tool_call_id;
  if (row.name !== null) message.name = row.name;
  return message;
}

export interface SnapshotResult {
  /** How many messages were stored. */
  messages: number;
  bytes: number;
  /** True when the byte cap forced the pruned form to be stored instead. */
  truncated: boolean;
}

/**
 * Replace a task's snapshot with this conversation, in one transaction.
 *
 * `DELETE` then `INSERT` inside a transaction rather than an upsert per row: a
 * partial write would leave a spliced conversation — the head of the new one
 * followed by the tail of an older, longer one — which is a valid-looking message
 * list that never existed and would be replayed as though it had.
 *
 * `prune` supplies the shorter form used when the conversation exceeds the cap. It
 * is a callback rather than a precomputed array so the cost is paid only when the
 * cap is actually hit.
 */
export function snapshotConversation(
  taskId: string,
  messages: readonly ChatMessage[],
  prune?: () => readonly ChatMessage[],
): SnapshotResult {
  let chosen = messages;
  let bytes = measure(chosen);
  let truncated = false;

  if (bytes > SNAPSHOT_BYTE_CAP && prune !== undefined) {
    const pruned = prune();
    const prunedBytes = measure(pruned);
    if (prunedBytes < bytes) {
      chosen = pruned;
      bytes = prunedBytes;
      truncated = true;
    }
  }

  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO task_messages
       (task_id, seq, role, content, tool_calls, tool_call_id, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();

  db.transaction(() => {
    db.prepare('DELETE FROM task_messages WHERE task_id = ?').run(taskId);
    for (const [index, message] of chosen.entries()) {
      insert.run(
        taskId,
        index + 1,
        message.role,
        message.content,
        message.toolCalls === undefined || message.toolCalls.length === 0
          ? null
          : JSON.stringify(message.toolCalls),
        message.toolCallId ?? null,
        message.name ?? null,
        now,
      );
    }
  })();

  return { messages: chosen.length, bytes, truncated };
}

/**
 * The stored conversation, in the order it will be sent.
 *
 * An empty array means no snapshot, which the continuation route must treat as a
 * refusal rather than as an empty conversation to start from — an agent that
 * supplies no `LoopContextAccess` parks without one, and continuing it from nothing
 * would re-run the task's first turn while claiming to resume it.
 */
export function loadConversation(taskId: string): ChatMessage[] {
  return getDb()
    .prepare<TaskMessageRow>(
      'SELECT role, content, tool_calls, tool_call_id, name FROM task_messages WHERE task_id = ? ORDER BY seq ASC',
    )
    .all(taskId)
    .map(mapRow);
}

export function hasConversation(taskId: string): boolean {
  const row = getDb()
    .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM task_messages WHERE task_id = ?')
    .get(taskId);
  return (row?.n ?? 0) > 0;
}

/**
 * Delete a task's snapshot.
 *
 * Called inline on the terminal transition. This is what bounds the at-rest window
 * to "while parked", so it is a security property rather than cleanup — see the
 * module header and `test/continuation.test.ts`.
 */
export function clearConversation(taskId: string): number {
  return getDb().prepare('DELETE FROM task_messages WHERE task_id = ?').run(taskId).changes;
}

/**
 * Snapshots whose task has no non-terminal run left, for the cleanup backstop.
 *
 * Deliberately conservative: a task with **no** `task_runs` row at all is left
 * alone, because a scheduled or headless park may legitimately have none and
 * deleting its snapshot would destroy the only thing it could continue from. Only a
 * task whose every recorded run has reached a terminal state is swept.
 */
export function orphanedSnapshotTaskIds(): string[] {
  return getDb()
    .prepare<{ task_id: string }>(
      `SELECT DISTINCT m.task_id AS task_id
         FROM task_messages m
        WHERE EXISTS (SELECT 1 FROM task_runs r WHERE r.task_id = m.task_id)
          AND NOT EXISTS (
                SELECT 1 FROM task_runs r
                 WHERE r.task_id = m.task_id
                   AND r.state NOT IN ('complete', 'error', 'stopped')
              )`,
    )
    .all()
    .map((row) => row.task_id);
}

/** Rough byte size of the conversation as it would be stored. */
function measure(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += message.content.length + message.role.length;
    if (message.toolCalls !== undefined) total += JSON.stringify(message.toolCalls).length;
    if (message.toolCallId !== undefined) total += message.toolCallId.length;
    if (message.name !== undefined) total += message.name.length;
  }
  return total;
}
