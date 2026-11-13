import { useState } from 'react';

import { consoleErrorTexts, type ConsoleEntry } from './consoleShim';
import styles from './CanvasTabs.module.css';

/**
 * The Console panel: the bounded log of what the preview frame printed.
 *
 * Presentational by design — the accepted entries, whether a frame is open,
 * and the two actions arrive as props. The wire gate lives in
 * `consoleShim.ts` and the `message` listener in `ConsoleTab.tsx`, so this
 * component cannot be tricked into rendering something the gate would not
 * accept: everything it shows is a `ConsoleEntry`, i.e. already-validated
 * text, rendered as text.
 */

export interface ConsoleViewProps {
  /** Accepted entries, oldest first, already bounded by the gate. */
  readonly entries: readonly ConsoleEntry[];
  /** Whether a preview frame is open for this task right now. */
  readonly frameOpen: boolean;
  readonly onClear: () => void;
  /** Prefills the composer with the error entries; never submits. */
  readonly onSendErrors: () => void;
}

const KIND_LABEL: Record<ConsoleEntry['kind'], string> = {
  log: 'log',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

export function ConsoleView({
  entries,
  frameOpen,
  onClear,
  onSendErrors,
}: ConsoleViewProps) {
  const [showAll, setShowAll] = useState(false);
  const errorCount = consoleErrorTexts(entries).length;
  // Show the newest stretch; the full log is one click away.
  const visible = showAll ? entries : entries.slice(-100);

  if (entries.length === 0) {
    return (
      <div className={styles.console} data-testid="console-empty">
        <p className={styles.consoleHint}>
          {frameOpen
            ? 'The preview frame has logged nothing yet. Output from console.log, console.warn and console.error appears here as it happens.'
            : 'No preview frame is open, so there is nothing to report. Start a preview from the Preview tab and its console output will appear here.'}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.console} data-testid="console">
      <div className={styles.consoleBar}>
        <span className={styles.consoleCount} data-testid="console-count">
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
          {errorCount > 0 ? ` · ${errorCount} ${errorCount === 1 ? 'error' : 'errors'}` : ''}
        </span>
        <span className={styles.consoleActions}>
          <button
            type="button"
            className={styles.consoleButton}
            onClick={() => setShowAll((previous) => !previous)}
          >
            {showAll ? 'Show latest 100' : 'Show all'}
          </button>
          <button
            type="button"
            className={styles.consoleButton}
            onClick={onClear}
          >
            Clear
          </button>
          <button
            type="button"
            className={styles.consoleButton}
            onClick={onSendErrors}
            disabled={errorCount === 0}
            data-testid="console-send-errors"
          >
            Send errors to composer
          </button>
        </span>
      </div>
      <ol className={styles.consoleList} data-testid="console-list">
        {visible.map((entry, index) => (
          <li
            key={`${entries.length - visible.length + index}-${entry.kind}`}
            className={styles.consoleLine}
            data-kind={entry.kind}
          >
            <span className={styles.consoleKind}>{KIND_LABEL[entry.kind]}</span>
            {/* Text only: the entry is a validated string, joined into a
                single text node, never interpreted as markup. */}
            <span className={styles.consoleText}>{entry.text}</span>
          </li>
        ))}
      </ol>
      {entries.length > visible.length ? (
        <p className={styles.consoleHint}>
          {entries.length - visible.length} older entries not shown — use Show all.
        </p>
      ) : null}
    </div>
  );
}
