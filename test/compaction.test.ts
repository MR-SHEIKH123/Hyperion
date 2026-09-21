import './helpers.ts';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { AgentContext, ChatMessage } from '../src/types/core.ts';

const { cleanupHome, freshDb } = await import('./helpers.ts');
const { startTaskRun } = await import('../src/db/taskRuns.ts');
const { listSteps, summarizeSteps } = await import('../src/db/taskSteps.ts');
const { getDb } = await import('../src/db/adapter.ts');
const {
  COMPACTION_TARGET_RATIO,
  COMPACTION_TRIGGER_RATIO,
  DEFAULT_CONTEXT_TOKENS,
  assessContext,
  compactConversation,
  estimateConversationTokens,
  estimateMessageTokens,
  recordCompaction,
  resolveContextWindow,
} = await import('../src/services/agent/compaction.ts');

import type { ContextWindow } from '../src/services/agent/compaction.ts';

let counter = 0;

/**
 * A real run row. `task_runs.chat_id` is a live foreign key into `chats`, so a
 * made-up chat id fails the constraint rather than the assertion — this fixture
 * omits it deliberately.
 */
function makeRun(): string {
  counter += 1;
  const runId = `run-compact-${counter}`;
  startTaskRun({ runId, tool: 'code', taskId: `task-compact-${counter}` });
  return runId;
}

function user(content: string): ChatMessage {
  return { role: 'user', content };
}

function assistant(content: string): ChatMessage {
  return { role: 'assistant', content };
}

/** An assistant turn that asked for a tool, and the `tool` message answering it. */
function toolExchange(id: string, name: string, args: string, output: string): ChatMessage[] {
  return [
    { role: 'assistant', content: '', toolCalls: [{ id, name, arguments: args }] },
    { role: 'tool', content: output, toolCallId: id, name },
  ];
}

/** Text long enough to matter against a small window. */
function filler(tokens: number): string {
  return 'x'.repeat(tokens * 4);
}

function fakeCtx(): { ctx: Pick<AgentContext, 'emit' | 'log'>; events: { event: string; data: unknown }[] } {
  const events: { event: string; data: unknown }[] = [];
  const ctx = {
    emit: (event: string, data: unknown) => {
      events.push({ event, data });
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as Pick<AgentContext, 'emit' | 'log'>;
  return { ctx, events };
}

const window1k: ContextWindow = { tokens: 1_000, source: 'model', assumed: false };

before(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

beforeEach(() => {
  getDb().prepare('DELETE FROM task_steps').run();
});

describe('estimating how big a conversation is', () => {
  it('counts a tool call\'s arguments, not just the message text', () => {
    const plain = assistant('');
    const withCall: ChatMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a/very/long/path/to/a/file.ts"}' }],
    };
    assert.ok(
      estimateMessageTokens(withCall) > estimateMessageTokens(plain) + 5,
      'arguments sent to the provider must count toward the estimate',
    );
  });

  it('charges every message some overhead, so many short messages are not free', () => {
    const one = estimateConversationTokens([user('hi')]);
    const ten = estimateConversationTokens(Array.from({ length: 10 }, () => user('hi')));
    assert.ok(ten >= one * 10, `ten short messages cost at least ten times one (${ten} vs ${one})`);
  });
});

describe('resolving the context window', () => {
  it('prefers an explicit override over what the model reported', () => {
    const w = resolveContextWindow({ model: { id: 'm', contextLength: 4_000 }, override: 32_000 });
    assert.equal(w.tokens, 32_000);
    assert.equal(w.source, 'override');
    assert.equal(w.assumed, false);
  });

  it('uses the reported context length when there is no override', () => {
    const w = resolveContextWindow({ model: { id: 'm', contextLength: 4_000 } });
    assert.equal(w.tokens, 4_000);
    assert.equal(w.source, 'model');
    assert.equal(w.assumed, false);
  });

  it('falls back to a conservative default and admits the number is a guess', () => {
    const w = resolveContextWindow({ model: { id: 'm' } });
    assert.equal(w.tokens, DEFAULT_CONTEXT_TOKENS);
    assert.equal(w.source, 'default');
    assert.equal(w.assumed, true, 'the UI has to be able to say this was assumed');
  });

  it('takes a caller-supplied fallback as the bottom rung', () => {
    // The local runner's own default is smaller than a gateway's (Ollama loads
    // 4 096 tokens by default and *truncates* past it, where a gateway refuses),
    // so the bottom rung is the caller's to set. The rung stays `assumed`: it is
    // still a guess, just the right guess for that endpoint.
    const local = resolveContextWindow({ model: { id: 'm' }, fallback: 4_096 });
    assert.equal(local.tokens, 4_096);
    assert.equal(local.source, 'default');
    assert.equal(local.assumed, true);
  });

  it('ignores a nonsense fallback rather than propagating it', () => {
    // Same rule as every other rung: a zero or a NaN means "no answer", and
    // taking it literally would compact every conversation to nothing.
    for (const fallback of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const window = resolveContextWindow({ model: { id: 'm' }, fallback });
      assert.equal(window.tokens, DEFAULT_CONTEXT_TOKENS, String(fallback));
    }
  });

  it('a reported length still beats the fallback', () => {
    const window = resolveContextWindow({ model: { id: 'm', contextLength: 32_768 }, fallback: 4_096 });
    assert.equal(window.tokens, 32_768);
    assert.equal(window.source, 'model');
  });

  it('treats a reported zero as no answer rather than a window of nothing', () => {
    const w = resolveContextWindow({ model: { id: 'm', contextLength: 0 } });
    assert.equal(w.tokens, DEFAULT_CONTEXT_TOKENS);
    assert.equal(w.source, 'default');
  });

  it('ignores a nonsense context length instead of propagating NaN', () => {
    const w = resolveContextWindow({ model: { id: 'm', contextLength: Number.NaN } });
    assert.equal(w.tokens, DEFAULT_CONTEXT_TOKENS);
    const negative = resolveContextWindow({ override: -5, model: { id: 'm' } });
    assert.equal(negative.tokens, DEFAULT_CONTEXT_TOKENS);
  });
});

describe('deciding whether to compact', () => {
  it('leaves a short conversation alone', () => {
    const decision = assessContext([user('hello')], window1k);
    assert.equal(decision.needed, false);
    assert.ok(decision.ratio < 0.1);
  });

  it('acts at eighty per cent, not at the limit itself', () => {
    const justUnder = assessContext([user(filler(700))], window1k);
    assert.equal(justUnder.needed, false, `700/1000 must not trigger (ratio ${justUnder.ratio})`);
    const over = assessContext([user(filler(850))], window1k);
    assert.equal(over.needed, true, `850/1000 must trigger (ratio ${over.ratio})`);
    assert.equal(COMPACTION_TRIGGER_RATIO, 0.8);
  });

  it('reports a ratio above one for a conversation that already will not fit', () => {
    const decision = assessContext([user(filler(1_500))], window1k);
    assert.equal(decision.needed, true);
    assert.ok(decision.ratio > 1);
  });
});

describe('compacting a conversation', () => {
  it('changes nothing when the conversation is not close to the limit', () => {
    const messages = [user('a'), assistant('b')];
    const result = compactConversation({ messages, window: window1k });
    assert.equal(result.compacted, false);
    assert.equal(result.skippedBecause, 'not_needed');
    assert.deepEqual(result.messages, messages);
    assert.equal(result.digest, undefined);
  });

  it('drops the oldest turns and leaves a digest in their place', () => {
    const messages = [
      { role: 'system' as const, content: 'you are a careful engineer' },
      user(filler(300)),
      assistant(filler(300)),
      user(filler(300)),
      assistant('the latest answer'),
    ];
    const result = compactConversation({ messages, window: window1k });

    assert.equal(result.compacted, true);
    assert.ok(result.droppedMessages > 0);
    assert.ok(result.tokensAfter < result.tokensBefore, 'compaction has to actually shrink it');

    // The digest replaced the dropped span in place.
    assert.ok(result.digest !== undefined);
    assert.ok(result.messages.some((m) => m.content === result.digest));
    assert.equal(result.messages[0]?.content, 'you are a careful engineer');
    assert.equal(result.messages.at(-1)?.content, 'the latest answer');
  });

  it('never drops a system message, even to get under the target', () => {
    const messages = [
      { role: 'system' as const, content: `SYSTEM_PROMPT ${filler(400)}` },
      user(filler(300)),
      assistant(filler(300)),
      user('now do the thing'),
      assistant('working'),
    ];
    const result = compactConversation({ messages, window: window1k });
    assert.equal(result.compacted, true);
    assert.ok(
      result.messages.some((m) => m.role === 'system' && m.content.startsWith('SYSTEM_PROMPT')),
      'the system prompt must survive compaction',
    );
  });

  it('keeps the most recent tool result, which is what the model is working from', () => {
    // The newest tool exchange sits *outside* the recent window deliberately. Put
    // it inside and the recency rule saves it on its own, so the test would pass
    // even with the tool-result pin deleted -- which is exactly what it must not
    // do.
    const messages = [
      user(filler(200)),
      ...toolExchange('c1', 'read_file', '{"path":"old.ts"}', filler(200)),
      user(filler(100)),
      ...toolExchange('c2', 'read_file', '{"path":"new.ts"}', 'THE LATEST TOOL OUTPUT'),
      user(filler(300)),
      assistant(filler(300)),
    ];
    const result = compactConversation({ messages, window: window1k });

    assert.equal(result.compacted, true);
    assert.ok(result.droppedMessages > 0, 'the fixture must actually drop something');
    assert.ok(
      result.messages.some((m) => m.content === 'THE LATEST TOOL OUTPUT'),
      'the newest tool result must not be dropped',
    );
  });

  it('never leaves a tool result without the call that asked for it', () => {
    // The pinned tail is heavy enough that the drop loop cannot stop after the
    // first group, so it goes on to consider the assistant turn that asked for
    // the tool while the answer itself is pinned. Grouping the call with its
    // answer is the only thing standing between that and an orphan.
    const messages = [
      user(filler(300)),
      ...toolExchange('c1', 'read_file', '{"path":"a.ts"}', filler(300)),
      user(filler(200)),
      assistant(filler(200)),
    ];
    const result = compactConversation({ messages, window: window1k });
    assert.equal(result.compacted, true);
    assert.ok(
      result.messages.some((m) => m.role === 'tool'),
      'a fixture that drops every tool result proves nothing about orphaning',
    );

    // Every surviving `tool` message must still have its requesting call present,
    // or the provider rejects the whole conversation rather than one message.
    const offered = new Set<string>();
    for (const message of result.messages) {
      for (const call of message.toolCalls ?? []) offered.add(call.id);
    }
    for (const message of result.messages) {
      if (message.role === 'tool' && message.toolCallId !== undefined) {
        assert.ok(
          offered.has(message.toolCallId),
          `tool result ${message.toolCallId} was orphaned by compaction`,
        );
      }
    }
  });

  it('refuses rather than dropping something it promised to keep', () => {
    // Every message here is either a system message or inside the recent window,
    // so there is nothing droppable and the honest answer is "I cannot help".
    const messages = [
      { role: 'system' as const, content: filler(500) },
      user(filler(300)),
      assistant(filler(300)),
    ];
    const result = compactConversation({ messages, window: window1k });
    assert.equal(result.compacted, false);
    assert.equal(result.skippedBecause, 'nothing_droppable');
    assert.deepEqual(result.messages, messages, 'a refusal must not quietly alter the conversation');
    assert.equal(result.droppedMessages, 0);
  });

  it('compacts well past the trigger so it does not fire again next turn', () => {
    const messages = [
      user(filler(200)),
      assistant(filler(200)),
      user(filler(200)),
      assistant(filler(200)),
      user(filler(200)),
      assistant('latest'),
    ];
    const result = compactConversation({ messages, window: window1k });
    assert.equal(result.compacted, true);

    // Clearing the trigger is not the guarantee -- stopping there would leave the
    // conversation one turn away from compacting again. Assert the target, which
    // is the number that actually buys the headroom.
    const targetTokens = Math.floor(window1k.tokens * COMPACTION_TARGET_RATIO);
    assert.ok(
      result.tokensAfter <= targetTokens,
      `compaction must reach the target, not merely clear the trigger (landed at ${result.tokensAfter} of ${targetTokens})`,
    );

    const after = assessContext(result.messages, window1k);
    assert.equal(after.needed, false, 'compacting must buy headroom, not land back on the trigger');
    assert.ok(COMPACTION_TARGET_RATIO < COMPACTION_TRIGGER_RATIO);
  });

  it('describes what it dropped without quoting any of it', () => {
    const secret = 'sk-live-DEADBEEF-DO-NOT-LEAK';
    const messages = [
      user(`${secret} ${filler(500)}`),
      ...toolExchange('c1', 'read_file', '{"path":"a.ts"}', filler(400)),
      user('carry on'),
      assistant('done'),
    ];
    const result = compactConversation({ messages, window: window1k });

    assert.equal(result.compacted, true);
    assert.ok(result.digest !== undefined);
    assert.ok(!result.digest.includes(secret), 'the digest must never quote dropped content');
    assert.ok(!result.digest.includes('xxxx'), 'the digest must not carry dropped text at all');
    assert.match(result.digest, /message\(s\)/);
  });

  it('attributes the digest to the system, never to the assistant', () => {
    const messages = [
      user(filler(300)),
      assistant(filler(300)),
      user(filler(300)),
      assistant('latest'),
    ];
    const result = compactConversation({ messages, window: window1k });
    assert.equal(result.compacted, true);

    const inserted = result.messages.find((m) => m.content === result.digest);
    assert.ok(inserted !== undefined);
    assert.equal(inserted.role, 'system', 'a digest in the assistant\'s voice is words it never said');
  });

  it('names the tools used in the span it removed', () => {
    // The newest tool exchange is pinned, so an older one has to exist for any
    // tool name to end up in a digest at all.
    const messages = [
      user(filler(300)),
      ...toolExchange('c1', 'grep_files', '{"pattern":"x"}', filler(500)),
      ...toolExchange('c2', 'read_file', '{"path":"latest.ts"}', 'latest'),
      user('carry on'),
      assistant('done'),
    ];
    const result = compactConversation({ messages, window: window1k });
    assert.equal(result.compacted, true);
    assert.match(result.digest ?? '', /grep_files/);
  });
});

describe('making a compaction visible', () => {
  it('records a compression step the run history can show', () => {
    const runId = makeRun();
    const { ctx } = fakeCtx();
    const messages = [user(filler(300)), assistant(filler(300)), user(filler(300)), assistant('latest')];
    const result = compactConversation({ messages, window: window1k });
    assert.equal(result.compacted, true);

    recordCompaction(ctx, runId, result);

    const steps = listSteps(runId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.kind, 'compression');
    assert.equal(steps[0]?.ok, true);
    assert.equal(steps[0]?.tokensIn, result.tokensBefore);
    assert.equal(steps[0]?.tokensOut, result.tokensAfter);
    assert.equal(summarizeSteps(runId).compressions, 1);
  });

  it('tells the client what was dropped and how much it saved', () => {
    const runId = makeRun();
    const { ctx, events } = fakeCtx();
    const messages = [user(filler(300)), assistant(filler(300)), user(filler(300)), assistant('latest')];
    const result = compactConversation({ messages, window: window1k });

    recordCompaction(ctx, runId, result);

    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, 'context_compacted');
    const data = events[0]?.data as Record<string, unknown>;
    assert.equal(data.runId, runId);
    assert.equal(data.droppedMessages, result.droppedMessages);
    assert.equal(data.tokensBefore, result.tokensBefore);
    assert.equal(data.tokensAfter, result.tokensAfter);
    assert.equal(data.windowTokens, window1k.tokens);
  });

  it('writes the step before it announces it', () => {
    const runId = makeRun();
    let stepsWhenAnnounced = -1;
    const ctx = {
      emit: () => {
        stepsWhenAnnounced = listSteps(runId).length;
      },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as unknown as Pick<AgentContext, 'emit' | 'log'>;

    const messages = [user(filler(300)), assistant(filler(300)), user(filler(300)), assistant('latest')];
    recordCompaction(ctx, runId, compactConversation({ messages, window: window1k }));

    assert.equal(stepsWhenAnnounced, 1, 'the history must already hold the step when the event fires');
  });

  it('says nothing at all when nothing was compacted', () => {
    const runId = makeRun();
    const { ctx, events } = fakeCtx();
    const result = compactConversation({ messages: [user('short')], window: window1k });

    recordCompaction(ctx, runId, result);

    assert.equal(events.length, 0, 'a no-op must not emit an event the user has to interpret');
    assert.equal(listSteps(runId).length, 0);
  });

  it('marks the window as assumed in the record when nobody reported one', () => {
    const runId = makeRun();
    const { ctx, events } = fakeCtx();
    const window = resolveContextWindow({ model: { id: 'm' } });
    const messages = [
      user(filler(2_500)),
      assistant(filler(2_500)),
      user(filler(2_500)),
      assistant('latest'),
    ];
    const result = compactConversation({ messages, window });
    assert.equal(result.compacted, true);

    recordCompaction(ctx, runId, result);

    assert.match(listSteps(runId)[0]?.detail ?? '', /assumed/);
    assert.equal((events[0]?.data as Record<string, unknown>).windowAssumed, true);
  });
});
