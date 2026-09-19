export interface ParsedSseEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

/** Incremental SSE parser. It preserves an unfinished frame until finish(). */
export class SseParser {
  private buffer = '';
  private eventName = '';
  private data: string[] = [];
  private id: string | undefined;
  private retry: number | undefined;

  push(chunk: string): ParsedSseEvent[] {
    this.buffer += chunk;
    const events: ParsedSseEvent[] = [];
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const event = this.consumeLine(line);
      if (event !== null) events.push(event);
    }
    return events;
  }

  finish(): ParsedSseEvent[] {
    const events: ParsedSseEvent[] = [];
    if (this.buffer.length > 0) {
      let line = this.buffer;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.buffer = '';
      const event = this.consumeLine(line);
      if (event !== null) events.push(event);
    }
    const final = this.dispatch();
    if (final !== null) events.push(final);
    return events;
  }

  private consumeLine(line: string): ParsedSseEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event': this.eventName = value; break;
      case 'data': this.data.push(value); break;
      case 'id': if (!value.includes('\0')) this.id = value; break;
      case 'retry': if (/^\d+$/.test(value)) this.retry = Number(value); break;
      default: break;
    }
    return null;
  }

  private dispatch(): ParsedSseEvent | null {
    if (this.data.length === 0) {
      this.eventName = '';
      this.retry = undefined;
      return null;
    }
    const event: ParsedSseEvent = {
      event: this.eventName || 'message',
      data: this.data.join('\n'),
      ...(this.id === undefined ? {} : { id: this.id }),
      ...(this.retry === undefined ? {} : { retry: this.retry }),
    };
    this.eventName = '';
    this.data = [];
    this.retry = undefined;
    return event;
  }
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ParsedSseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const abort = () => { void reader.cancel(signal?.reason); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted === true) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) yield event;
    }
    const tail = decoder.decode();
    for (const event of parser.push(tail)) yield event;
    for (const event of parser.finish()) yield event;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
