/**
 * Task-run continuation — Prompt 1.27, Phase 2.
 *
 * The claims worth testing here are the ones that fail *silently* if they break.
 * A missing snapshot delete leaves source-code fragments at rest and nothing
 * complains. A non-atomic claim starts two agents against one worktree and both
 * appear to work. A released worktree makes a continuation resume into an empty
 * checkout and quietly redo work it already did. None of those surface as an error,
 * so each gets an assertion rather than a comment.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before, beforeEach, describe } from 'node:test';

import { cleanupHome, freshDb, testHome } from './helpers.ts';

import type { ChatMessage } from '../src/types/core.ts';

const { getDb } = await import('../src/db/adapter.ts');
const { startTaskRun, finishTaskRun, claimParkedRun, getTaskRun, updateTaskRunState } = await import(
  '../src/db/taskRuns.ts'
);
const {
  clearConversation,
  hasConversation,
  loadConversation,
  orphanedSnapshotTaskIds,
  snapshotConversation,
  SNAPSHOT_BYTE_CAP,
} = await import('../src/db/taskMessages.ts');
const { recordApproval, listPendingApprovals, resolveApproval, sessionPermissionRules } = await import(
  '../src/db/approvals.ts'
);

let counter = 0;

function park(state: 'blocked' | 'ready_for_review' = 'ready_for_review'): {
  runId: string;
  taskId: string;
} {
  counter += 1;
  const runId = `cont-run-${counter}`;
  const taskId = `cont-task-${counter}`;
  startTaskRun({ runId, taskId, tool: 'code' });
  updateTaskRunState(runId, state);
  return { runId, taskId };
}

function conversation(): ChatMessage[] {
  return [
    { role: 'system', content: 'You are Code.' },
    { role: 'user', content: 'Fix the failing test.' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read', arguments: '{"path":"src/a.ts"}' }],
    },
    { role: 'tool', content: 'export const answer = 41;', toolCallId: 'call-1', name: 'read' },
  ];
}

before(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

describe('the conversation snapshot', () => {
  test('round-trips verbatim, including the tool-call pairing', () => {
    // The pairing is not incidental. A provider given a `tool` message with no
    // matching assistant call rejects the *entire* conversation, so a snapshot
    // that lost `toolCallId` would produce a continuation that cannot send at all.
    const { taskId } = park();
    const original = conversation();

    snapshotConversation(taskId, original);

    assert.deepEqual(loadConversation(taskId), original);
  });

  test('replaces rather than appends, so a second park cannot splice two conversations', () => {
    const { taskId } = park();
    snapshotConversation(taskId, conversation());
    snapshotConversation(taskId, [{ role: 'user', content: 'only this' }]);

    const loaded = loadConversation(taskId);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.content, 'only this');
  });

  test('leaves no spliced conversation when a write fails midway', () => {
    // The whole set moves in one transaction. Without it a failed insert would
    // leave the head of the new conversation followed by the tail of the older,
    // longer one — a valid-looking message list that never existed.
    const { taskId } = park();
    snapshotConversation(taskId, conversation());

    const bad = [
      { role: 'user', content: 'first' },
      // A NUL byte in a JS string is storable, so the failure is forced by making
      // the second row collide on the primary key from outside the transaction.
      { role: 'user', content: 'second' },
    ] as ChatMessage[];

    const db = getDb();
    const original = db.prepare;
    let calls = 0;
    // Fail the third statement (DELETE, INSERT, INSERT) to abort mid-write.
    (db as { prepare: typeof original }).prepare = ((sql: string) => {
      const statement = original.call(db, sql);
      if (!sql.startsWith('INSERT INTO task_messages')) return statement;
      return {
        ...statement,
        run: (...args: unknown[]) => {
          calls += 1;
          if (calls === 2) throw new Error('disk full');
          return (statement as { run: (...a: unknown[]) => unknown }).run(...args);
        },
      };
    }) as typeof original;

    try {
      assert.throws(() => snapshotConversation(taskId, bad));
    } finally {
      (db as { prepare: typeof original }).prepare = original;
    }

    assert.deepEqual(
      loadConversation(taskId),
      conversation(),
      'a failed snapshot must roll back to the previous one, not leave a partial write',
    );
  });

  test('falls back to the pruned form when the conversation exceeds the cap', () => {
    // The pruned conversation is one the run could actually have been sent.
    // Truncating a message instead would store something that is neither the
    // conversation nor a valid request.
    const { taskId } = park();
    const huge: ChatMessage[] = [
      { role: 'system', content: 'You are Code.' },
      { role: 'user', content: 'x'.repeat(SNAPSHOT_BYTE_CAP + 1_000) },
    ];
    const pruned: ChatMessage[] = [{ role: 'system', content: 'You are Code.' }];

    const result = snapshotConversation(taskId, huge, () => pruned);

    assert.equal(result.truncated, true);
    assert.deepEqual(loadConversation(taskId), pruned);
  });

  test('keeps the verbatim form when it fits', () => {
    const { taskId } = park();
    const result = snapshotConversation(taskId, conversation(), () => []);

    assert.equal(result.truncated, false);
    assert.equal(result.messages, 4);
  });

  test('is deleted on the terminal transition, which is what bounds the exposure', () => {
    // A security property, not housekeeping. The snapshot is stored unredacted
    // because continuation must replay exactly what the agent saw, so what limits
    // the at-rest window is the window itself — "while parked" — and this delete is
    // what closes it. Leaving it to the cleanup timer would widen that to a day.
    const { runId, taskId } = park();
    snapshotConversation(taskId, conversation());
    assert.equal(hasConversation(taskId), true);

    finishTaskRun(runId, 'complete');

    assert.equal(hasConversation(taskId), false);
    assert.deepEqual(loadConversation(taskId), []);
  });

  test('is deleted for every terminal state, not only success', () => {
    for (const state of ['error', 'stopped'] as const) {
      const { runId, taskId } = park();
      snapshotConversation(taskId, conversation());

      finishTaskRun(runId, state, { code: 'internal_error', message: 'broke' });

      assert.equal(hasConversation(taskId), false, `${state} must clear the snapshot`);
    }
  });

  test('survives a superseded attempt reaching a terminal state', () => {
    // A task id is reused across attempts. A continuation marks the run it
    // replaces as complete, and that must not delete the snapshot the continuation
    // is about to read.
    counter += 1;
    const taskId = `cont-supersede-${counter}`;
    startTaskRun({ runId: 'supersede-old', taskId, tool: 'code' });
    updateTaskRunState('supersede-old', 'ready_for_review');
    snapshotConversation(taskId, conversation());

    startTaskRun({ runId: 'supersede-new', taskId, tool: 'code' });
    finishTaskRun('supersede-old', 'complete', { pauseReason: 'continued_as:supersede-new' });

    assert.equal(
      hasConversation(taskId),
      true,
      'the successor still needs the conversation it is continuing from',
    );
  });
});

describe('the cleanup backstop', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM task_messages').run();
  });

  test('finds a snapshot whose every run has ended', () => {
    const { runId, taskId } = park();
    snapshotConversation(taskId, conversation());
    // Written directly so the inline delete does not fire, simulating a crash
    // between the terminal transition and the delete that should have followed.
    getDb()
      .prepare("UPDATE task_runs SET state = 'complete' WHERE run_id = ?")
      .run(runId);

    assert.ok(orphanedSnapshotTaskIds().includes(taskId));
  });

  test('leaves a parked task alone', () => {
    const { taskId } = park();
    snapshotConversation(taskId, conversation());

    assert.equal(orphanedSnapshotTaskIds().includes(taskId), false);
  });

  test('leaves a snapshot with no run row at all alone', () => {
    // A headless park may legitimately have no `task_runs` row, and its snapshot is
    // the only thing it could continue from. Sweeping it would destroy the feature
    // for exactly the runs that need it most.
    snapshotConversation('headless-task', conversation());

    assert.equal(orphanedSnapshotTaskIds().includes('headless-task'), false);
    assert.equal(clearConversation('headless-task'), 4);
  });
});

describe('claiming a parked run', () => {
  test('succeeds once and fails the second time', () => {
    // The mutex. Two clients answering the same prompt — a phone and a laptop
    // showing one task — must not both start an agent against one worktree, and a
    // read-then-write would let both through because both would see the park.
    const { runId } = park();

    assert.equal(claimParkedRun(runId), true);
    assert.equal(claimParkedRun(runId), false, 'the second caller must lose');
    assert.equal(getTaskRun(runId)?.state, 'running');
  });

  test('claims a blocked run as well as one ready for review', () => {
    const { runId } = park('blocked');
    assert.equal(claimParkedRun(runId), true);
  });

  test('refuses a run that was never parked', () => {
    counter += 1;
    const runId = `never-parked-${counter}`;
    startTaskRun({ runId, taskId: `never-parked-task-${counter}`, tool: 'code' });

    assert.equal(claimParkedRun(runId), false);
    assert.equal(getTaskRun(runId)?.state, 'running', 'a running run must not be re-claimed');
  });

  test('refuses a run that already finished', () => {
    const { runId } = park();
    finishTaskRun(runId, 'complete');

    assert.equal(claimParkedRun(runId), false);
  });

  test('refuses a run id that does not exist', () => {
    assert.equal(claimParkedRun('no-such-run'), false);
  });
});

describe('approvals as session rules', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM pending_approvals').run();
  });

  test('records a call verbatim so it can be replayed', () => {
    const approval = recordApproval({
      taskId: 'appr-task',
      tool: 'code',
      toolName: 'write',
      arguments: '{"path":"src/a.ts","content":"x","expectedSha256":null}',
      permissionKey: 'write',
      matchedLayer: 'project',
      matchedPattern: 'src/**',
    });

    assert.equal(approval.state, 'pending');
    assert.equal(approval.arguments, '{"path":"src/a.ts","content":"x","expectedSha256":null}');
    assert.equal(approval.matchedPattern, 'src/**');
  });

  test('returns the existing row rather than asking the same question twice', () => {
    // A model that re-emits the call after the park, or a continuation replaying a
    // conversation that still ends in it, must not stack a second prompt the user
    // has to answer to get past one.
    const first = recordApproval({
      taskId: 'appr-dup',
      tool: 'code',
      toolName: 'bash',
      arguments: '{"command":"npm test"}',
      permissionKey: 'bash',
    });
    const second = recordApproval({
      taskId: 'appr-dup',
      tool: 'code',
      toolName: 'bash',
      arguments: '{"command":"npm test"}',
      permissionKey: 'bash',
    });

    assert.equal(second.id, first.id);
    assert.equal(listPendingApprovals('appr-dup').length, 1);
  });

  test('applies a decision exactly once', () => {
    const approval = recordApproval({
      taskId: 'appr-once',
      tool: 'code',
      toolName: 'bash',
      arguments: '{"command":"ls"}',
      permissionKey: 'bash',
    });

    const first = resolveApproval(approval.id, 'allow_once');
    const second = resolveApproval(approval.id, 'deny');

    assert.equal(first.applied, true);
    assert.equal(second.applied, false, 'the loser of the race must not overwrite the decision');
    assert.equal(second.approval.state, 'allow_once', 'and must report what it actually became');
  });

  test('projects allow_session into the session layer, scoped to the pattern that matched', () => {
    // Approving a write to `src/a.ts` under a `src/**` rule grants that rule, not
    // the whole tool. Granting the tool would silently widen a decision the user
    // made about one path.
    const approval = recordApproval({
      taskId: 'appr-session',
      tool: 'code',
      toolName: 'write',
      arguments: '{"path":"src/a.ts"}',
      permissionKey: 'write',
      matchedLayer: 'project',
      matchedPattern: 'src/**',
    });
    resolveApproval(approval.id, 'allow_session');

    assert.deepEqual(sessionPermissionRules('appr-session'), { write: { 'src/**': 'allow' } });
  });

  test('projects a scalar allowance as a scalar rule', () => {
    const approval = recordApproval({
      taskId: 'appr-scalar',
      tool: 'code',
      toolName: 'bash',
      arguments: '{"command":"ls"}',
      permissionKey: 'bash',
      matchedPattern: null,
    });
    resolveApproval(approval.id, 'allow_session');

    assert.deepEqual(sessionPermissionRules('appr-scalar'), { bash: 'allow' });
  });

  test('never projects allow_once, because "just this time" is not a rule', () => {
    const approval = recordApproval({
      taskId: 'appr-not-a-rule',
      tool: 'code',
      toolName: 'bash',
      arguments: '{"command":"ls"}',
      permissionKey: 'bash',
    });
    resolveApproval(approval.id, 'allow_once');

    assert.deepEqual(sessionPermissionRules('appr-not-a-rule'), {});
  });

  test('survives a process restart, because it lives in the table and not in memory', async () => {
    // 1.27 requires a session allowance to be cleared "on task end", which means it
    // must outlive a park — and a park can outlive the process. An in-memory set
    // would re-ask for something already granted, which is how a confirmation
    // prompt becomes noise people click through.
    const approval = recordApproval({
      taskId: 'appr-restart',
      tool: 'code',
      toolName: 'bash',
      arguments: '{"command":"ls"}',
      permissionKey: 'bash',
    });
    resolveApproval(approval.id, 'allow_session');

    const fresh = await import(`../src/db/approvals.ts?restart=${Date.now()}`);
    assert.deepEqual(
      (fresh as typeof import('../src/db/approvals.ts')).sessionPermissionRules('appr-restart'),
      { bash: 'allow' },
    );
  });

  test('is cleared when the task reaches a terminal state', () => {
    // An allowance outliving its task would pre-approve a later run that happened
    // to reuse the id.
    counter += 1;
    const runId = `appr-clear-run-${counter}`;
    const taskId = `appr-clear-${counter}`;
    startTaskRun({ runId, taskId, tool: 'code' });
    const approval = recordApproval({
      taskId,
      tool: 'code',
      toolName: 'bash',
      arguments: '{"command":"ls"}',
      permissionKey: 'bash',
    });
    resolveApproval(approval.id, 'allow_session');

    finishTaskRun(runId, 'complete');

    assert.deepEqual(sessionPermissionRules(taskId), {});
  });

  test('expires a still-pending approval on task end rather than deleting it', () => {
    // What a run stopped to ask is worth keeping even once the answer no longer
    // matters; only its force is removed.
    counter += 1;
    const runId = `appr-expire-run-${counter}`;
    const taskId = `appr-expire-${counter}`;
    startTaskRun({ runId, taskId, tool: 'code' });
    recordApproval({
      taskId,
      tool: 'code',
      toolName: 'bash',
      arguments: '{"command":"ls"}',
      permissionKey: 'bash',
    });

    finishTaskRun(runId, 'stopped');

    assert.deepEqual(listPendingApprovals(taskId), []);
    const rows = getDb()
      .prepare<{ state: string }>('SELECT state FROM pending_approvals WHERE task_id = ?')
      .all(taskId);
    assert.deepEqual(rows.map((row) => row.state), ['expired']);
  });

  test('refuses arguments too large to replay rather than storing them truncated', () => {
    // Truncated JSON is unreplayable, and an approval that cannot be replayed is
    // worse than none: the user would authorise something the continuation then
    // silently could not perform.
    assert.throws(
      () =>
        recordApproval({
          taskId: 'appr-huge',
          tool: 'code',
          toolName: 'write',
          arguments: 'x'.repeat(40_000),
          permissionKey: 'write',
        }),
      /too large/,
    );
  });
});

describe('the backup archive', () => {
  test('contains zero task_messages rows', async () => {
    // `exportBackup` archives the whole database, and `mirrorBackup` copies each
    // automatic archive off the machine. A backup today contains *no* project
    // source, so carrying snapshots would add a new category of content to an
    // off-machine artifact — in exchange for a capability the restore cannot
    // deliver, since the archive has never included worktrees.
    const { taskId } = park();
    snapshotConversation(taskId, conversation());
    assert.equal(hasConversation(taskId), true);

    const { exportBackup } = await import('../src/services/backup/export.ts');
    const result = await exportBackup();

    const AdmZip = (await import('adm-zip')).default;
    const { DB_ENTRY } = await import('../src/services/backup/export.ts');
    const zip = new AdmZip(result.file);
    const entry = zip.getEntry(DB_ENTRY);
    assert.ok(entry, 'the archive must contain the database');

    const extracted = path.join(testHome, `backup-check-${Date.now()}.db`);
    fs.writeFileSync(extracted, entry.getData());

    const { openDatabase } = await import('../src/db/adapter.ts');
    const copy = openDatabase(extracted);
    try {
      const count = copy
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM task_messages')
        .get();
      assert.equal(count?.n, 0, 'a conversation snapshot must never leave the machine');
    } finally {
      copy.close();
      fs.rmSync(extracted, { force: true });
    }

    assert.equal(
      hasConversation(taskId),
      true,
      'the strip must operate on the copy, never on the live database',
    );
  });
});
