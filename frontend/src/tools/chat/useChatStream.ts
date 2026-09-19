import { useCallback, useEffect, useRef, useState } from 'react';
import { resumeRun, streamChat, type ChatReconciliation, type ChatStreamCallbacks } from '../../api/chat';
import { createTokenBatcher } from '../../api/sse/token-batcher';
import { ApiError } from '../../api/errors';

/**
 * One live chat exchange: send → stream tokens → done / paused / error.
 *
 * The hook owns only the *live* view (phase + unflushed token text). Persisted
 * truth always comes from the query layer: every settled stream settles into a
 * refetch, and a dropped stream is reconciled through server state (the api
 * layer never replays a mutation).
 */
export type StreamPhase = 'idle' | 'running' | 'paused' | 'complete' | 'error';

export interface PauseInfo {
  reason: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface StreamStatus {
  phase: StreamPhase;
  runId: string | null;
  /** The assistant message this stream writes to (from the `open` event). */
  messageId: string | null;
  /** User prompt optimistically shown before the server persists it. */
  pendingUser: string | null;
  /** Assistant text not yet flushed to the database. */
  liveText: string;
  pause: PauseInfo | null;
  error: { code: string; message: string; retryable: boolean } | null;
}

const IDLE: StreamStatus = {
  phase: 'idle',
  runId: null,
  messageId: null,
  pendingUser: null,
  liveText: '',
  pause: null,
  error: null,
};

export interface ChatStreamHandle {
  status: StreamStatus;
  /** Start a fresh exchange (optionally continuing a paused run). */
  send(prompt: string, modelId: string, providerId?: string): Promise<void>;
  /** Resume a paused run, optionally with a switched model. */
  resume(runId: string, modelId?: string, providerId?: string): Promise<void>;
  /** Cancel the live exchange. A paused run stays resumable on the server. */
  stop(): void;
  /** Forget the live view entirely (chat switched away). */
  reset(): void;
}

export function useChatStream(
  chatId: string | null,
  onSettled: (reason: 'terminal' | 'reconciled' | 'failed' | 'cancelled', reconciliation?: ChatReconciliation) => void,
): ChatStreamHandle {
  const [status, setStatus] = useState<StreamStatus>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  const liveTextRef = useRef('');
  const batcherRef = useRef<ReturnType<typeof createTokenBatcher> | null>(null);
  const reconciliationRef = useRef<ChatReconciliation | null>(null);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  const appendLive = useCallback((text: string) => {
    liveTextRef.current += text;
    setStatus((s) => ({ ...s, liveText: liveTextRef.current }));
  }, []);

  const disposeBatcher = useCallback(() => {
    batcherRef.current?.dispose();
    batcherRef.current = null;
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    disposeBatcher();
    liveTextRef.current = '';
    setStatus(IDLE);
  }, [disposeBatcher]);

  // Leaving the chat must not leak the previous conversation's stream.
  useEffect(() => {
    reset();
    return () => {
      abortRef.current?.abort();
      disposeBatcher();
    };
  }, [chatId, reset, disposeBatcher]);

  const runSession = useCallback(
    async (
      start: (callbacks: ChatStreamCallbacks, signal: AbortSignal) => Promise<void>,
      initial: Partial<StreamStatus>,
    ): Promise<void> => {
      const controller = new AbortController();
      abortRef.current = controller;
      liveTextRef.current = initial.liveText ?? '';
      setStatus({ ...IDLE, ...initial, liveText: liveTextRef.current });

      const batcher = createTokenBatcher(appendLive);
      batcherRef.current = batcher;
      reconciliationRef.current = null;

      let settled = false;
      const settle = (reason: 'terminal' | 'reconciled' | 'failed' | 'cancelled') => {
        if (settled) return;
        settled = true;
        batcher.dispose();
        batcherRef.current = null;
        settledRef.current(reason, reconciliationRef.current ?? undefined);
      };

      try {
        await start(
          {
            onEvent: (event) => {
              switch (event.type) {
                case 'open':
                  setStatus((s) => ({ ...s, runId: event.data.runId, messageId: event.data.messageId }));
                  break;
                case 'token':
                  batcher.add(event.data.text);
                  break;
                case 'resumed':
                  // A failover's transient pause is lifted — back to running.
                  setStatus((s) => ({ ...s, phase: 'running', pause: null }));
                  break;
                case 'paused':
                  batcher.flush();
                  setStatus((s) => ({
                    ...s,
                    phase: 'paused',
                    runId: event.data.runId,
                    pause: {
                      reason: event.data.reason,
                      code: event.data.code,
                      message: event.data.message,
                      retryable: event.data.retryable,
                    },
                  }));
                  break;
                case 'done':
                  batcher.flush();
                  // The turn is persisted server-side now; the optimistic user
                  // row is about to be replaced by the refetch.
                  setStatus((s) => ({ ...s, phase: 'complete', pendingUser: null }));
                  break;
                case 'error':
                  batcher.flush();
                  setStatus((s) => ({
                    ...s,
                    phase: 'error',
                    runId: event.data.runId,
                    error: { code: event.data.code, message: event.data.message, retryable: event.data.retryable },
                  }));
                  break;
                case 'usage':
                  break;
              }
            },
            onEnd: (reason) => {
              // The frame that closed the stream already set the phase; the
              // settle just tells the query layer to pick up persisted truth.
              if (reason === 'cancelled') settle('cancelled');
              else if (reason === 'terminal-event') settle('terminal');
              else settle('reconciled');
            },
            onReconciled: (reconciliation) => {
              // Server-side truth after a non-terminal close. Handed to the
              // settled handler so the view can apply it without a second
              // round trip.
              reconciliationRef.current = reconciliation;
            },
            onInvalidFrame: () => {
              // Wire drift is diagnosable server-side; it must not shape the
              // conversation. Nothing to render per frame.
            },
          },
          controller.signal,
        );
      } catch (error) {
        // Pre-stream JSON failures (busy 409, run_not_paused, no provider).
        // The error state is recorded for the banners, and the rejection is
        // rethrown so the caller (the composer) can keep the user's draft —
        // a refused send must not swallow the prompt the user typed.
        if (error instanceof ApiError) {
          setStatus({
            ...IDLE,
            phase: 'error',
            error: { code: error.code, message: error.message, retryable: error.retryable },
          });
        } else {
          setStatus(IDLE);
        }
        settle('failed');
        throw error;
      }
      // Unreachable: start() resolves only via onEnd paths above, but the
      // guard keeps a future session change from silently skipping settle.
      settle(controller.signal.aborted ? 'cancelled' : 'reconciled');
    },
    [appendLive],
  );

  const send = useCallback(
    async (prompt: string, modelId: string, providerId?: string): Promise<void> => {
      if (chatId === null) return;
      await runSession(
        (callbacks, signal) =>
          streamChat({ chatId, tool: 'chat', modelId, prompt, ...(providerId ? { providerId } : {}) }, callbacks, signal),
        { phase: 'running', pendingUser: prompt },
      );
    },
    [chatId, runSession],
  );

  const resume = useCallback(
    async (runId: string, modelId?: string, providerId?: string): Promise<void> => {
      if (chatId === null) return;
      await runSession(
        (callbacks, signal) => resumeRun({ runId, ...(modelId ? { modelId } : {}), ...(providerId ? { providerId } : {}) }, chatId, callbacks, signal),
        { phase: 'running' },
      );
    },
    [chatId, runSession],
  );

  return { status, send, resume, stop, reset };
}
