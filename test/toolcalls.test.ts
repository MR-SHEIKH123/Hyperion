/**
 * The tool-call protocol, exercised against a real HTTP provider.
 *
 * These assertions are deliberately made through the adapter rather than by
 * unit-testing the accumulator: the part most likely to be wrong is the
 * reassembly of argument fragments split across SSE frames, and that only
 * happens when real bytes cross a socket.
 */
import './helpers.ts';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, cleanupHome, startMockProvider } from './helpers.ts';
import type { MockProvider } from './helpers.ts';
import type { ProviderRecord, StreamChunk, ToolCall } from '../src/types/core.ts';

const { openAiAdapter } = await import('../src/providers/adapters.ts');
const { createProvider } = await import('../src/providers/repository.ts');

let mock: MockProvider;
// Built through the repository rather than cast from a literal: a hand-made
// object drifts the moment a column is added, and the health fields matter to
// anything that later routes through this record.
let provider: ProviderRecord;

/** Drain a stream into its chunks, so assertions can look at the whole shape. */
async function collect(request: {
  modelId: string;
  messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string }[];
  tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
  toolChoice?: 'auto' | 'none';
}): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of openAiAdapter.stream(provider, request)) {
    out.push(chunk);
  }
  return out;
}

function toolCalls(chunks: StreamChunk[]): ToolCall[] {
  return chunks.filter((c) => c.type === 'tool_call').map((c) => c.call);
}

describe('a model asking to call a tool', () => {
  before(async () => {
    freshDb();
    mock = await startMockProvider();
    provider = createProvider({ name: 'Mock', type: 'remote', baseUrl: mock.baseUrl, enabled: true });
  });

  after(async () => {
    await mock.close();
    cleanupHome();
  });

  beforeEach(() => {
    // behave() merges into the previous behaviour rather than replacing it, so a
    // scripted tool call from an earlier test would otherwise leak into the next
    // one. Clearing it explicitly is what keeps these cases independent.
    mock.behave({ models: ['mock-model'], tokens: ['Hello'], toolCalls: [] });
  });

  test('argument fragments split across frames are reassembled into one call', async () => {
    mock.behave({
      toolCalls: [
        { id: 'call_abc', name: 'read_file', arguments: '{"path":"src/index.ts","start":10}' },
      ],
    });

    const calls = toolCalls(await collect({ modelId: 'mock-model', messages: [{ role: 'user', content: 'read it' }] }));

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.id, 'call_abc');
    assert.equal(calls[0]?.name, 'read_file');
    // The mock dribbles these out two characters at a time, so an implementation
    // that forgot to concatenate would fail here with a truncated string.
    assert.deepEqual(JSON.parse(calls[0]?.arguments ?? '{}'), { path: 'src/index.ts', start: 10 });
  });

  test('two tool calls in one turn stay separate and keep their order', async () => {
    mock.behave({
      toolCalls: [
        { id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
        { id: 'call_2', name: 'list_files', arguments: '{"dir":"src"}' },
      ],
    });

    const calls = toolCalls(await collect({ modelId: 'mock-model', messages: [{ role: 'user', content: 'both' }] }));

    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((c) => c.name),
      ['read_file', 'list_files'],
    );
    // Interleaved fragments must not bleed between calls.
    assert.deepEqual(JSON.parse(calls[0]?.arguments ?? '{}'), { path: 'a.ts' });
    assert.deepEqual(JSON.parse(calls[1]?.arguments ?? '{}'), { dir: 'src' });
  });

  test('a tool call arrives before the done chunk, never after it', async () => {
    mock.behave({ toolCalls: [{ id: 'call_x', name: 'noop', arguments: '{}' }] });

    const chunks = await collect({ modelId: 'mock-model', messages: [{ role: 'user', content: 'go' }] });
    const callAt = chunks.findIndex((c) => c.type === 'tool_call');
    const doneAt = chunks.findIndex((c) => c.type === 'done');

    assert.ok(callAt !== -1, 'expected a tool_call chunk');
    assert.ok(doneAt !== -1, 'expected a done chunk');
    // A consumer that stops reading at `done` would otherwise silently lose the
    // call, which is the whole reason the adapter drains at finish_reason.
    assert.ok(callAt < doneAt, `tool_call at ${callAt} must precede done at ${doneAt}`);
  });

  test('the finish reason for a tool turn is reported as tool_calls', async () => {
    mock.behave({ toolCalls: [{ id: 'call_y', name: 'noop', arguments: '{}' }] });

    const chunks = await collect({ modelId: 'mock-model', messages: [{ role: 'user', content: 'go' }] });
    const done = chunks.find((c) => c.type === 'done');

    assert.equal(done?.type === 'done' ? done.finishReason : undefined, 'tool_calls');
  });

  test('a plain prose turn yields no tool calls at all', async () => {
    mock.behave({ tokens: ['just', ' text'] });

    const chunks = await collect({ modelId: 'mock-model', messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(toolCalls(chunks).length, 0);
    assert.equal(
      chunks.filter((c) => c.type === 'token').map((c) => (c.type === 'token' ? c.text : '')).join(''),
      'just text',
    );
  });
});

describe('what the adapter puts on the wire', () => {
  before(async () => {
    freshDb();
    mock = await startMockProvider();
    provider = createProvider({ name: 'Wire', type: 'remote', baseUrl: mock.baseUrl, enabled: true });
  });

  after(async () => {
    await mock.close();
    cleanupHome();
  });

  test('offered tools are sent as function schemas with tool_choice', async () => {
    const before = mock.streamCalls.length;

    await collect({
      modelId: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file.',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ],
    });

    const sent = mock.streamCalls[before]?.body ?? {};
    const tools = sent.tools as { type: string; function: { name: string; parameters: unknown } }[] | undefined;

    assert.ok(Array.isArray(tools), 'expected tools on the request');
    assert.equal(tools?.[0]?.type, 'function');
    assert.equal(tools?.[0]?.function?.name, 'read_file');
    assert.deepEqual(tools?.[0]?.function?.parameters, {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
    assert.equal(sent.tool_choice, 'auto');
  });

  test('a request with no tools omits both keys rather than sending empty ones', async () => {
    const before = mock.streamCalls.length;

    await collect({ modelId: 'mock-model', messages: [{ role: 'user', content: 'hi' }] });

    const sent = mock.streamCalls[before]?.body ?? {};
    // Some gateways reject `tools: []` outright instead of treating it as "none",
    // so the absence of the key is the contract, not an empty array.
    assert.equal('tools' in sent, false);
    assert.equal('tool_choice' in sent, false);
  });

  test('a tool result message carries the id of the call it answers', async () => {
    const before = mock.streamCalls.length;

    await collect({
      modelId: 'mock-model',
      messages: [
        { role: 'user', content: 'read it' },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'call_abc' },
      ],
    });

    const sent = mock.streamCalls[before]?.body ?? {};
    const messages = sent.messages as { role: string; tool_call_id?: string }[] | undefined;
    const toolMessage = messages?.find((m) => m.role === 'tool');

    // Without this pairing the provider cannot match a result to its request and
    // rejects the entire conversation.
    assert.equal(toolMessage?.tool_call_id, 'call_abc');
  });

  test('a plain message sends neither tool_calls nor tool_call_id', async () => {
    const before = mock.streamCalls.length;

    await collect({ modelId: 'mock-model', messages: [{ role: 'user', content: 'hi' }] });

    const sent = mock.streamCalls[before]?.body ?? {};
    const messages = sent.messages as Record<string, unknown>[] | undefined;

    assert.equal(messages?.[0] !== undefined && 'tool_calls' in messages[0], false);
    assert.equal(messages?.[0] !== undefined && 'tool_call_id' in messages[0], false);
  });
});
