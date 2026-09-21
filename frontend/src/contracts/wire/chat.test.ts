import { describe, expect, it } from 'vitest';

import {
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
