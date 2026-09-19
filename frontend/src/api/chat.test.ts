import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createChat,
  listChats,
  listMessages,
  resumeRun,
  streamChat,
  type ChatStreamCallbacks,
} from './chat';
import { ApiError } from './errors';

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

const chatBody = {
  chat: {
    id: 'c1',
    title: 'First',
    tool: 'chat',
    modelId: 'm1',
    providerId: 'p1',
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    lastOpenedAt: 3,
  },
};

describe('chat feature module', () => {
  it('lists unarchived chats by default and archived when asked', async () => {
    // A fresh Response per call — a body can only be read once.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ chats: [] })));
    vi.stubGlobal('fetch', fetchMock);

    await listChats({ tool: 'chat' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/chat?tool=chat');

    await listChats({ tool: 'chat', archivedOnly: true });
    // archivedOnly wins: it is the more specific request.
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/chat?tool=chat&archivedOnly=1');
  });

  it('posts a new chat and parses the 201 record', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(chatBody, 201));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createChat({ tool: 'chat', title: 'First', modelId: 'm1' });
    expect(result.chat.id).toBe('c1');
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('/api/chat');
    expect((call?.[1] as RequestInit | undefined)?.method).toBe('POST');
  });

  it('walks the transcript with the message-id cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [], nextBefore: null }));
    vi.stubGlobal('fetch', fetchMock);

    await listMessages('c1', { limit: 25, before: 'm9' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/chat/c1/messages?limit=25&before=m9');
  });

  it('surfaces a busy conflict as an ApiError with the busy code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: 'busy',
              message: 'A chat request has been running since 2026-01-01T00:00:00.000Z.',
              retryable: true,
              details: { jobId: 'j1' },
            },
          },
          409,
        ),
      ),
    );

    await expect(
      streamChat(
        { chatId: 'c1', tool: 'chat', modelId: 'm1', prompt: 'hi' },
        { onEvent: () => {}, onEnd: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'busy', status: 409, retryable: true });
  });
});

describe('chat stream session', () => {
  function callbacks(): ChatStreamCallbacks & { events: string[]; ends: string[] } {
    const events: string[] = [];
    const ends: string[] = [];
    return {
      events,
      ends,
      onEvent: (event) => events.push(event.type),
      onEnd: (reason) => ends.push(reason),
      onReconciled: vi.fn().mockImplementation(() => {}),
    };
  }

  it('delivers decoded frames and ends on done without reconciliation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse('event: open\ndata: {"runId":"r1","chatId":"c1","messageId":"m2","providerId":"p1","providerName":"P","modelId":"m1"}\n\nevent: token\ndata: {"text":"Hel"}\n\nevent: token\ndata: {"text":"lo"}\n\nevent: done\ndata: {"runId":"r1","messageId":"m2","finishReason":"stop"}\n\n')));
    const cb = callbacks();

    await streamChat({ chatId: 'c1', tool: 'chat', modelId: 'm1', prompt: 'hi' }, cb);

    expect(cb.events).toEqual(['open', 'token', 'token', 'done']);
    expect(cb.ends).toEqual(['terminal-event']);
    expect(cb.onReconciled).not.toHaveBeenCalled();
  });

  it('reports a paused frame as a normal event, then reconciles the closed stream', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.startsWith('/api/chat/stream')) {
        return Promise.resolve(
          sseResponse('event: token\ndata: {"text":"partial"}\n\nevent: paused\ndata: {"runId":"r1","reason":"provider_failure","code":"provider_error","message":"upstream failed","retryable":true,"partialContent":"partial"}\n\n'),
        );
      }
      if (input.startsWith('/api/chat/c1/runs')) {
        return Promise.resolve(
          jsonResponse({
            latest: {
              runId: 'r1',
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
        );
      }
      if (input.startsWith('/api/chat/c1/messages')) {
        return Promise.resolve(jsonResponse({ messages: [], nextBefore: null }));
      }
      throw new Error(`unexpected url ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const cb = callbacks();

    await streamChat({ chatId: 'c1', tool: 'chat', modelId: 'm1', prompt: 'hi' }, cb);

    expect(cb.events).toEqual(['token', 'paused']);
    expect(cb.ends).toEqual(['socket-closed']);
    expect(cb.onReconciled).toHaveBeenCalledTimes(1);
    // The mutation stream itself was opened exactly once — never replayed.
    const streamCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/chat/stream'));
    expect(streamCalls).toHaveLength(1);
  });

  it('throws a typed error when resume targets a run that is not paused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          { error: { code: 'run_not_paused', message: 'Run "r1" is complete, not paused.', retryable: false, details: { state: 'complete' } } },
          409,
        ),
      ),
    );

    await expect(
      resumeRun({ runId: 'r1' }, 'c1', { onEvent: () => {}, onEnd: () => {} }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
