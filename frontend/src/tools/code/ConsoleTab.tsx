import { useEffect, useRef, useState } from 'react';

import {
  appendConsoleEntry,
  consoleErrorTexts,
  formatErrorReport,
  parseConsoleMessage,
  type ConsoleEntry,
} from './consoleShim';
import { ConsoleView } from './ConsoleView';

/**
 * The Console tab: the wire gate's home.
 *
 * Everything the preview frame sends arrives here as a `message` event. Three
 * checks stand between the frame and the DOM:
 *
 *  1. `event.source` must be the preview frame's own `contentWindow` — the
 *     check only passes while this tab holds a live frame reference, so a
 *     message that arrives before the frame loads, or from anywhere else, is
 *     dropped without being inspected.
 *  2. `parseConsoleMessage` validates the shim's envelope (tag, kind, args)
 *     and bounds the text; anything that fails is ignored, not repaired.
 *  3. The list itself is capped by the gate: the oldest entries fall off.
 *
 * The panel keeps collecting while another tab is showing — the listener is
 * attached for as long as the tab exists — so opening Console after a run
 * shows what the frame said, not only what it said while you watched.
 */
export interface ConsoleTabProps {
  /** The preview frame's content window, or `null` when none is mounted. */
  readonly frameWindow: Window | null;
  /** Prefills the composer with the error report; never submits. */
  readonly onSendErrors: (text: string) => void;
}

export function ConsoleTab({ frameWindow, onSendErrors }: ConsoleTabProps) {
  const [entries, setEntries] = useState<readonly ConsoleEntry[]>([]);
  const frameWindowRef = useRef<Window | null>(null);

  useEffect(() => {
    frameWindowRef.current = frameWindow;
  }, [frameWindow]);

  useEffect(() => {
    function onMessage(event: MessageEvent<unknown>): void {
      if (event.source !== frameWindowRef.current) return;
      const entry = parseConsoleMessage(event.data);
      if (entry === null) return;
      setEntries((previous) => appendConsoleEntry(previous, entry));
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <ConsoleView
      entries={entries}
      frameOpen={frameWindow !== null}
      onClear={() => setEntries([])}
      onSendErrors={() => {
        const texts = consoleErrorTexts(entries);
        if (texts.length === 0) return;
        onSendErrors(formatErrorReport(texts));
      }}
    />
  );
}
