import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PersistenceProvider } from './PersistenceProvider';
import { PersistenceStore, type StorageLike } from './storage';
import { useScrollAnchor } from './useScrollAnchor';

/**
 * A fake layout: jsdom has none.
 *
 * Rows are 100px tall, the container shows 300px, and a row's position in the
 * container's frame is its index times 100 minus the scroll position — exactly the
 * relationship the anchoring rules are stated against. Installing it on the
 * prototype means every element the test renders agrees on the same geometry.
 */
const ROW_HEIGHT = 100;
const VIEWPORT = 300;

const originalScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
const originalClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');

function containerFrame(element: Element): HTMLElement | null {
  return element.closest('[data-testid="transcript"]');
}

function installLayout(): void {
  // Own property on HTMLElement, shadowing jsdom's no-layout version; removed after
  // each test so the next file gets the real one back.
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value: function (this: HTMLElement): DOMRect {
      const container = containerFrame(this);
      let top = 0;
      if (this.dataset.messageId !== undefined && container !== null) {
        const rows = Array.from(container.querySelectorAll('[data-message-id]'));
        top = rows.indexOf(this) * ROW_HEIGHT - container.scrollTop;
      }
      return {
        top,
        bottom: top + ROW_HEIGHT,
        left: 0,
        right: 0,
        width: 0,
        height: ROW_HEIGHT,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    },
  });
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: Element) {
      return (this.querySelectorAll('[data-message-id]').length || 0) * ROW_HEIGHT;
    },
  });
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return VIEWPORT;
    },
  });
}

afterEach(() => {
  localStorage.clear();
  delete (HTMLElement.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  if (originalScrollHeight !== undefined) Object.defineProperty(Element.prototype, 'scrollHeight', originalScrollHeight);
  if (originalClientHeight !== undefined) Object.defineProperty(Element.prototype, 'clientHeight', originalClientHeight);
});

class MemoryStorage implements StorageLike {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

function TranscriptBody({ viewKey, rows }: { viewKey: string; rows: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollAnchor(ref, viewKey, rows.map((id) => ({ id })));
  return (
    <div data-testid="transcript" ref={ref}>
      {rows.map((id) => (
        <div key={id} data-message-id={id} />
      ))}
    </div>
  );
}

// The provider must be *outside* the component that calls the hook — the hook
// reads the store through context, so rendering it beside the provider would test
// the tab fallback instead of the store under test.
function Transcript({ viewKey, rows, store }: { viewKey: string; rows: string[]; store: PersistenceStore }) {
  return (
    <PersistenceProvider store={store}>
      <TranscriptBody viewKey={viewKey} rows={rows} />
    </PersistenceProvider>
  );
}

const rows = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];

function setup(initialRows: string[] = rows, seed?: (store: PersistenceStore) => void) {
  installLayout();
  const store = new PersistenceStore(new MemoryStorage());
  seed?.(store);
  const view = render(<Transcript viewKey="chat:1" rows={initialRows} store={store} />);
  const container = screen.getByTestId('transcript');
  return { store, container, view };
}

describe('transcript scroll memory', () => {
  it('opens at the end when nothing was remembered', () => {
    const { container } = setup();
    expect(container.scrollTop).toBe(600);
    expect(container.scrollHeight).toBe(600);
  });

  it('restores the remembered row instead of jumping to the end', () => {
    const { container } = setup(rows, (store) => store.setScrollAnchor('chat:1', { anchorId: 'm3', offset: -40 }));
    // m3 sits at 200 in content space; 40px above the top edge means scrollTop 240.
    expect(container.scrollTop).toBe(240);
  });

  it('follows the tail while the reader is at the bottom', () => {
    const store = new PersistenceStore(new MemoryStorage());
    installLayout();
    const view = render(<Transcript viewKey="chat:1" rows={rows} store={store} />);
    const container = screen.getByTestId('transcript');
    expect(container.scrollTop).toBe(600);

    // A streamed token grows the transcript while the reader is at the end: the
    // view moves with it, which is the behaviour a transcript is expected to have.
    container.scrollTop = 600;
    fireEvent.scroll(container);
    view.rerender(<Transcript viewKey="chat:1" rows={[...rows, 'm7']} store={store} />);
    expect(container.scrollTop).toBe(700);
  });

  it('stops following once the reader scrolls up, and resumes at the bottom', () => {
    const store = new PersistenceStore(new MemoryStorage());
    installLayout();
    const view = render(<Transcript viewKey="chat:1" rows={rows} store={store} />);
    const container = screen.getByTestId('transcript');
    expect(container.scrollTop).toBe(600);

    // The reader scrolls back into the transcript.
    container.scrollTop = 250;
    fireEvent.scroll(container);
    view.rerender(<Transcript viewKey="chat:1" rows={[...rows, 'm7']} store={store} />);
    expect(container.scrollTop).toBe(250);

    // Back at the end, growth is followed again.
    container.scrollTop = 700;
    fireEvent.scroll(container);
    view.rerender(<Transcript viewKey="chat:1" rows={[...rows, 'm7', 'm8']} store={store} />);
    expect(container.scrollTop).toBe(800);
  });

  it('records the topmost visible row, and flushes the position on unmount', () => {
    vi.useFakeTimers();
    try {
      const store = new PersistenceStore(new MemoryStorage());
      installLayout();
      const view = render(<Transcript viewKey="chat:1" rows={rows} store={store} />);
      const container = screen.getByTestId('transcript');

      container.scrollTop = 250;
      fireEvent.scroll(container);
      // Debounced: nothing is written the instant the finger lifts.
      expect(store.snapshot().scrollAnchors['chat:1']).toBeUndefined();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      // At 250 the first two rows are gone; m3 (content top 200) is the first one
      // still on screen, 50px above the top edge.
      expect(store.snapshot().scrollAnchors['chat:1']).toEqual({ anchorId: 'm3', offset: -50 });

      // A scroll that is not followed by the debounce — navigating away — is
      // flushed by the unmount, which is when the position matters most.
      container.scrollTop = 340;
      fireEvent.scroll(container);
      view.unmount();
      // At 340 the topmost visible row is m4, 40px above the top edge.
      expect(store.snapshot().scrollAnchors['chat:1']).toEqual({ anchorId: 'm4', offset: -40 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the end, and drops the anchor, when the remembered row is no longer loaded', () => {
    const { container, store } = setup(['m4', 'm5', 'm6'], (s) =>
      s.setScrollAnchor('chat:1', { anchorId: 'm1', offset: -10 }),
    );
    expect(container.scrollTop).toBe(300);
    expect(store.snapshot().scrollAnchors['chat:1']).toBeUndefined();
  });
});
