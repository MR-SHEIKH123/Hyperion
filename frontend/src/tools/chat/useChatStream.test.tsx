import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatReconciliation } from '../../api/chat';
import { useChatStream } from './useChatStream';

type SettledCallback = (reason: 'terminal' | 'reconciled' | 'failed' | 'cancelled', reconciliation?: ChatReconciliation) => void;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
});

function sseResponse(text: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
  );
}

/** A stream that delivers one token and then hangs — for the cancel test. */
function hangingSseResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: token\ndata: {"text":"once"}\n\n'));
        // Deliberately never closed.
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
  );
}

const HAPPY =
  'event: open\ndata: {"runId":"r1","chatId":"c1","messageId":"m2","providerId":"p1","providerName":"P","modelId":"m1"}\n\n' +
  'event: token\ndata: {"text":"Hel"}\n\n' +
  'event: token\ndata: {"text":"lo"}\n\n' +
  'event: done\ndata: {"runId":"r1","messageId":"m2","finishReason":"stop"}\n\n';

describe('useChatStream', () => {
  it('streams a happy turn: optimistic prompt, batched tokens, complete, terminal settle', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(HAPPY)));
    const onSettled = vi.fn<SettledCallback>();
    const { result } = renderHook(() => useChatStream('c1', onSettled));

    act(() => {
      void result.current.send('hi there', 'm1');
    });
    expect(result.current.status.phase).toBe('running');
    expect(result.current.status.pendingUser).toBe('hi there');
    expect(result.current.status.runId).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(result.current.status.phase).toBe('complete');
    expect(result.current.status.runId).toBe('r1');
    expect(result.current.status.messageId).toBe('m2');
    expect(result.current.status.liveText).toBe('Hello');
    expect(result.current.status.pendingUser).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]?.[0]).toBe('terminal');
  });

  it('lands in the paused state with the reason, and settles with reconciliation data', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.startsWith('/api/chat/stream')) {
        return Promise.resolve(
          sseResponse(
            'event: token\ndata: {"text":"partial"}\n\n' +
              'event: paused\ndata: {"runId":"r9","reason":"provider_failure","code":"provider_error","message":"upstream failed","retryable":true,"partialContent":"partial"}\n\n',
          ),
        );
      }
      if (input.startsWith('/api/chat/c1/runs')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              latest: {
                runId: 'r9',
                chatId: 'c1',
                tool: 'chat',
                state: 'paused',
                pauseReason: 'provider_failure',
                errorCode: 'provider_error',
                errorMessage: 'upstream failed',
                modelId: 'm1',
                providerId: 'p1',
                providerName: 'P',
                messageId: 'm2',
                attempt: 1,
                updatedAt: 2,
              },
              paused: [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (input.startsWith('/api/chat/c1/messages')) {
        return Promise.resolve(
          new Response(JSON.stringify({ messages: [], nextBefore: null }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      throw new Error(`unexpected url ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSettled = vi.fn<SettledCallback>();
    const { result } = renderHook(() => useChatStream('c1', onSettled));

    act(() => {
      void result.current.send('hi', 'm1');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(result.current.status.phase).toBe('paused');
    expect(result.current.status.pause).toMatchObject({
      reason: 'provider_failure',
      code: 'provider_error',
      retryable: true,
    });
    expect(result.current.status.liveText).toBe('partial');
    expect(onSettled).toHaveBeenCalledTimes(1);
    const settledCall = onSettled.mock.calls[0];
    expect(settledCall?.[0]).toBe('reconciled');
    const reconciliation = settledCall?.[1];
    expect(reconciliation?.latest?.state).toBe('paused');
  });

  it('surfaces a busy conflict as a typed error state without a stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'busy',
              message: 'A chat request has been running.',
              retryable: true,
              details: { jobId: 'j1' },
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const onSettled = vi.fn<SettledCallback>();
    const { result } = renderHook(() => useChatStream('c1', onSettled));

    await act(async () => {
      // The refusal is both recorded in state (for the banner) and rethrown
      // (so the composer can keep the user's draft).
      await expect(result.current.send('hi', 'm1')).rejects.toMatchObject({ code: 'busy' });
    });

    expect(result.current.status.phase).toBe('error');
    expect(result.current.status.error?.code).toBe('busy');
    expect(onSettled).toHaveBeenCalledWith('failed', undefined);
  });

  it('stop() cancels the live exchange and settles as cancelled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(hangingSseResponse()));
    const onSettled = vi.fn<SettledCallback>();
    const { result } = renderHook(() => useChatStream('c1', onSettled));

    act(() => {
      void result.current.send('hi', 'm1');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.current.status.phase).toBe('running');
    expect(onSettled).not.toHaveBeenCalled();

    act(() => {
      result.current.stop();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]?.[0]).toBe('cancelled');
  });
});
