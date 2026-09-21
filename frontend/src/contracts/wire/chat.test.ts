import { describe, expect, it } from 'vitest';

import {
  chatContextSchema,
  chatRecordSchema,
  chatSseDoneSchema,
  chatSsePausedSchema,
  chatSseResumedSchema,
  chatSseTokenSchema,
  chatSseUsageSchema,
  forkChatResponseSchema,
  messageRecordSchema,
  messagesPageSchema,
  openChatResponseSchema,
  resumeInNewSessionResponseSchema,
  runStateSnapshotSchema,
} from './chat';

const chat = {
  id: 'c1',
  title: 'First',
  tool: 'chat',
  modelId: 'gpt-test',
  providerId: 'p1',
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  lastOpenedAt: 3,
};

const message = {
  id: 'm1',
  chatId: 'c1',
  role: 'assistant',
  content: 'Hello',
  tool: 'chat',
  modelId: 'gpt-test',
  providerId: 'p1',
  providerName: 'Test Provider',
  status: 'complete',
  errorCode: null,
  errorMessage: null,
  tokensIn: 10,
  tokensOut: 20,
  seq: 1,
  createdAt: 1,
  updatedAt: 1,
};

const run = {
  runId: 'r1',
  chatId: 'c1',
  tool: 'chat',
  state: 'paused',
  pauseReason: 'provider_failure',
  errorCode: 'provider_error',
  errorMessage: 'upstream',
  modelId: 'gpt-test',
  providerId: 'p1',
  providerName: 'Test Provider',
  messageId: 'm1',
  attempt: 1,
  updatedAt: 1,
};

describe('chat wire schemas', () => {
  it('accepts the documented record shapes', () => {
    expect(chatRecordSchema.safeParse(chat).success).toBe(true);
    expect(messageRecordSchema.safeParse(message).success).toBe(true);
    expect(runStateSnapshotSchema.safeParse(run).success).toBe(true);
  });

  it('accepts a fork response and requires the paused count', () => {
    const branch = { ...chat, id: 'c2', title: 'First (fork)' };
    const copy = { ...message, id: 'm2', chatId: 'c2' };
    const payload = { chat: branch, messages: [copy], forkedFrom: 'c1', pausedPartials: 1 };
    expect(forkChatResponseSchema.safeParse(payload).success).toBe(true);

    // The count is how a surface explains a copied message that was mid-stream.
    // Optional would mean the UI could not tell "none paused" from "not said".
    const missing: Record<string, unknown> = { ...payload };
    delete missing.pausedPartials;
    expect(forkChatResponseSchema.safeParse(missing).success).toBe(false);
    expect(forkChatResponseSchema.safeParse({ ...payload, pausedPartials: -1 }).success).toBe(false);
    expect(forkChatResponseSchema.safeParse({ ...payload, forkedFrom: null }).success).toBe(false);
  });

  it('accepts the context read and requires the window provenance', () => {
    const context = {
      chatId: 'c1',
      modelId: 'gpt-test',
      window: { tokens: 8192, source: 'default', assumed: true },
      estimatedTokens: 7000,
      ratio: 7000 / 8192,
      messageCount: 12,
      needsNewSession: true,
    };
    expect(chatContextSchema.safeParse(context).success).toBe(true);

    // `assumed` is not decoration: most gateways report no context length, so
    // this flag is how a surface knows whether it is showing a limit or a guess.
    // Defaulting it would turn a guess into a measurement.
    const noFlag: Record<string, unknown> = { ...context, window: { tokens: 8192, source: 'default' } };
    expect(chatContextSchema.safeParse(noFlag).success).toBe(false);
    expect(
      chatContextSchema.safeParse({ ...context, window: { tokens: 8192, source: 'guesswork', assumed: true } }).success,
    ).toBe(false);
  });

  it('accepts a resume response and keeps the receipt and the counts', () => {
    const resumed = { ...chat, id: 'c2', title: 'First (continued)' };
    const receiptRow = { ...message, id: 'm3', chatId: 'c2', role: 'system', content: '…left behind…', seq: 1 };
    const payload = {
      chat: resumed,
      messages: [receiptRow, { ...message, id: 'm4', chatId: 'c2', seq: 2 }],
      source: { id: 'c1', title: 'First' },
      droppedMessages: 6,
      pausedPartials: 1,
      receipt: '…left behind…',
      assessment: {
        chatId: 'c1',
        modelId: 'gpt-test',
        window: { tokens: 4096, source: 'model', assumed: false },
        estimatedTokens: 3900,
        ratio: 3900 / 4096,
        messageCount: 8,
        needsNewSession: true,
      },
    };
    expect(resumeInNewSessionResponseSchema.safeParse(payload).success).toBe(true);

    // Every one of these is load-bearing: the counts say what was left behind,
    // the receipt is the note the new session opens with, and the assessment is
    // the numbers the decision was made from. Optional would mean the surface
    // could not say any of it.
    for (const key of ['receipt', 'droppedMessages', 'source', 'assessment', 'pausedPartials']) {
      const missing: Record<string, unknown> = { ...payload };
      delete missing[key];
      expect(resumeInNewSessionResponseSchema.safeParse(missing).success).toBe(false);
    }
    expect(resumeInNewSessionResponseSchema.safeParse({ ...payload, droppedMessages: -1 }).success).toBe(false);
  });

  it('rejects an unknown tool name', () => {
    expect(chatRecordSchema.safeParse({ ...chat, tool: 'nope' }).success).toBe(false);
  });

  it('keeps nullable identity fields nullable and rejects missing ones', () => {
    const nulls = { ...chat, modelId: null, providerId: null };
    expect(chatRecordSchema.safeParse(nulls).success).toBe(true);
    const missing: Record<string, unknown> = { ...chat };
    delete missing.modelId;
    expect(chatRecordSchema.safeParse(missing).success).toBe(false);
  });

  it('accepts a paused run snapshot with its pause reason', () => {
    const paused = runStateSnapshotSchema.safeParse(run);
    expect(paused.success).toBe(true);
    if (paused.success) expect(paused.data.pauseReason).toBe('provider_failure');
    expect(runStateSnapshotSchema.safeParse({ ...run, pauseReason: 'mystery' }).success).toBe(false);
  });

  it('accepts a null latest run (a chat with no runs yet)', () => {
    expect(openChatResponseSchema.safeParse({ chat, messages: [message], latestRun: null }).success).toBe(true);
    expect(openChatResponseSchema.safeParse({ chat, messages: [message], latestRun: run }).success).toBe(true);
  });

  it('accepts a cursor page with a null nextBefore at the start of the transcript', () => {
    expect(messagesPageSchema.safeParse({ messages: [message], nextBefore: null }).success).toBe(true);
    expect(messagesPageSchema.safeParse({ messages: [message], nextBefore: 'm0' }).success).toBe(true);
    expect(messagesPageSchema.safeParse({ messages: [message] }).success).toBe(false);
  });

  it('validates stream payloads against the documented shapes', () => {
    expect(chatSseTokenSchema.safeParse({ text: 'a' }).success).toBe(true);
    expect(chatSseTokenSchema.safeParse({}).success).toBe(false);

    expect(
      chatSseUsageSchema.safeParse({ tokensIn: 1, tokensOut: 2, costUsd: null }).success,
    ).toBe(true);
    expect(chatSseUsageSchema.safeParse({ tokensIn: 1, tokensOut: 2 }).success).toBe(false);

    expect(
      chatSsePausedSchema.safeParse({
        runId: 'r1',
        reason: 'provider_failure',
        code: 'provider_error',
        message: 'upstream',
        retryable: true,
        partialContent: 'so far',
      }).success,
    ).toBe(true);
    expect(
      chatSsePausedSchema.safeParse({
        runId: 'r1',
        reason: 'not-a-reason',
        code: 'x',
        message: 'y',
        retryable: true,
        partialContent: '',
      }).success,
    ).toBe(false);

    expect(
      chatSseResumedSchema.safeParse({ runId: 'r1', providerId: 'p2', providerName: 'Other', modelId: 'm', attempt: 2 })
        .success,
    ).toBe(true);

    expect(chatSseDoneSchema.safeParse({ runId: 'r1', messageId: 'm1' }).success).toBe(true);
    expect(chatSseDoneSchema.safeParse({ runId: 'r1', messageId: 'm1', finishReason: 'stop' }).success).toBe(true);
    expect(chatSseDoneSchema.safeParse({ runId: 'r1' }).success).toBe(false);
  });
});
