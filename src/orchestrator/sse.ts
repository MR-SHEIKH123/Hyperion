/**
 * Server-Sent Events writer.
 *
 * Every event emitted here is a member of the `SseEvent` union in
 * `src/types/core.ts`, so the frontend can exhaustively switch on `event`
 * and never has to infer state from HTTP status codes. In particular a
 * `paused` event arrives on a perfectly normal 200 response — pausing is a
 * state, not a transport error.
 */

import type { ServerResponse } from 'node:http';
import type { SseEvent } from '../types/core.ts';
import { toAppError } from '../util/errors.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('sse');

/** Anything with the subset of ServerResponse we actually use. */
export interface SseSink {
  write(chunk: string): boolean;
  end(): void;
  writableEnded: boolean;
  headersSent: boolean;
  setHeader(name: string, value: string): unknown;
  flushHeaders?(): void;
  on(event: 'close', listener: () => void): unknown;
}

const HEARTBEAT_MS = 15_000;

export class SseStream {
  #res: SseSink;
  #closed = false;
  #heartbeat: NodeJS.Timeout | undefined;
  #abort = new AbortController();

  constructor(res: SseSink | ServerResponse) {
    this.#res = res as SseSink;

    if (!this.#res.headersSent) {
      this.#res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      this.#res.setHeader('Cache-Control', 'no-cache, no-transform');
      this.#res.setHeader('Connection', 'keep-alive');
      // Compression middleware buffers, which defeats streaming entirely.
      this.#res.setHeader('X-Accel-Buffering', 'no');
      this.#res.flushHeaders?.();
    }

    this.#res.on('close', () => {
      // The browser navigated away or hit stop. Signal the producer so it can
      // abandon the upstream request instead of streaming into a dead socket.
      this.#closed = true;
      this.#stopHeartbeat();
      if (!this.#abort.signal.aborted) this.#abort.abort();
    });

    // Proxy-free localhost does not strictly need this, but a comment-only
    // heartbeat also lets the client notice a wedged server.
    this.#heartbeat = setInterval(() => {
      if (this.#closed) return;
      this.#res.write(': ping\n\n');
    }, HEARTBEAT_MS);
    this.#heartbeat.unref?.();
  }

  /** Aborts when the client disconnects. Pass this into provider requests. */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  get closed(): boolean {
    return this.#closed || this.#res.writableEnded;
  }

  /** Type-checked emit. Prefer this everywhere in backend code. */
  send(event: SseEvent): void {
    this.#raw(event.event, event.data);
  }

  /**
   * Untyped emit, for the `agent` channel where Kimi's and Sol's loops define
   * their own payload shapes.
   */
  emit(event: string, data: unknown): void {
    this.#raw(event, data);
  }

  #raw(event: string, data: unknown): void {
    if (this.closed) return;
    let payload: string;
    try {
      payload = JSON.stringify(data ?? {});
    } catch (error) {
      log.warn(`dropping unserialisable "${event}" event: ${String(error)}`);
      return;
    }
    // A literal newline inside data would terminate the field early.
    const lines = payload.split('\n').map((line) => `data: ${line}`).join('\n');
    this.#res.write(`event: ${event}\n${lines}\n\n`);
  }

  /** Emits a normalised `error` event. Never throws. */
  sendError(error: unknown, runId: string | null = null): void {
    const app = toAppError(error);
    this.send({
      event: 'error',
      data: { runId, code: app.code, message: app.message, retryable: app.retryable },
    });
  }

  close(): void {
    if (this.closed) {
      this.#stopHeartbeat();
      return;
    }
    this.#stopHeartbeat();
    this.#closed = true;
    this.#res.end();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
  }
}

/** Convenience for route handlers. */
export function openStream(res: ServerResponse): SseStream {
  return new SseStream(res);
}
