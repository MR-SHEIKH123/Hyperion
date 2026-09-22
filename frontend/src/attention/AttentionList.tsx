import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '../design-system/components/StatusBadge/StatusBadge';
import { Button } from '../design-system/components/Button/Button';
import { DECISIONS, KIND_LABEL, KIND_TONE, attentionDestination, relativeTime } from './links';

import type { AttentionItem, AttentionQueue, AttentionSource } from '../contracts/wire/attention';
import type { ApprovalDecision } from '../api/attention';
import styles from './AttentionCenter.module.css';

const SOURCE_LABEL: Record<string, string> = {
  pending_approvals: 'Permission prompts',
  task_runs: 'Task runs',
  chat_runs: 'Chat runs',
  scheduled_task_runs: 'Scheduled tasks',
  backup_failures: 'Backups',
  spending: 'Spending',
  mcp: 'MCP servers',
};

export interface AttentionListProps {
  queue: AttentionQueue;
  /** `now` is injected so relative times are testable and never read a clock twice. */
  now: number;
  /** Present when a decision may be made from the queue at all. */
  onDecide?: (item: AttentionItem, decision: ApprovalDecision) => void;
  /** The item currently being answered, so its own buttons disable rather than all of them. */
  decidingId?: string | null;
  /** Rendered above the list: the notice after a decision, and its failure. */
  banner?: React.ReactNode;
}

/**
 * The queue, rendered.
 *
 * Presentational on purpose: everything it needs arrives as props, which is what
 * lets the dev harness render the ten kinds without a server and lets the tests
 * cover the keyboard path without a network stub.
 *
 * **Keyboard navigation hangs off the row's link, not off the row.** A focusable
 * `<article>` with its own key handler would be a non-interactive element faking
 * interactivity — the arrow keys belong to the thing that is already a control, so
 * ArrowUp/ArrowDown/Home/End work while the destination link has focus and Tab
 * continues into that row's decision buttons. Each link is labelled with the item
 * it opens (`Decision needed: bash needs a decision — Open in Code`), because a
 * column of links that all read "Open conversation" is useless read aloud.
 *
 * **A poll that removes the focused row moves focus to its successor.** The common
 * case is the user answering the item they are standing on; without this, focus
 * falls to `<body>` and the next keystroke goes nowhere. It only happens when
 * focus was actually lost — a 30-second refresh must never steal focus from
 * somewhere else on the page.
 */
export function AttentionList({ queue, now, onDecide, decidingId = null, banner }: AttentionListProps) {
  const links = useRef(new Map<string, HTMLAnchorElement>());
  const [focused, setFocused] = useState<{ id: string; index: number } | null>(null);

  useEffect(() => {
    if (focused === null) return;
    if (queue.items.some((item) => item.id === focused.id)) return;
    if (typeof document !== 'undefined' && document.activeElement !== document.body) return;
    const successor = queue.items[Math.min(focused.index, queue.items.length - 1)];
    if (successor !== undefined) links.current.get(successor.id)?.focus();
    setFocused(null);
  }, [queue.items, focused]);

  const move = useCallback(
    (event: React.KeyboardEvent<HTMLAnchorElement>, index: number) => {
      const target = (next: number) => {
        const item = queue.items[Math.min(queue.items.length - 1, Math.max(0, next))];
        if (item !== undefined) links.current.get(item.id)?.focus();
      };
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          target(index + 1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          target(index - 1);
          break;
        case 'Home':
          event.preventDefault();
          target(0);
          break;
        case 'End':
          event.preventDefault();
          target(queue.items.length - 1);
          break;
        default:
          break;
      }
    },
    [queue.items],
  );

  const unavailable = useMemo(
    () => queue.sources.filter((source) => source.status === 'unavailable'),
    [queue.sources],
  );

  return (
    <section className={styles.center} aria-labelledby="attention-title">
      <header className={styles.header}>
        <div>
          <h1 id="attention-title" className={styles.title}>
            Waiting on you
          </h1>
          <p className={styles.subtitle}>
            {queue.total === 0
              ? 'Nothing is waiting. This is a live queue, not a history.'
              : `${String(queue.total)} ${queue.total === 1 ? 'item' : 'items'} · updated ${relativeTime(queue.generatedAt, now)}`}
          </p>
        </div>
        <Button
          variant="quiet"
          disabled={queue.items.length === 0}
          onClick={() => {
            const first = queue.items[0];
            if (first !== undefined) links.current.get(first.id)?.focus();
          }}
        >
          Jump to first
        </Button>
      </header>

      {banner === null || banner === undefined ? null : <div className={styles.banner}>{banner}</div>}

      {queue.items.length === 0 ? (
        <p className={styles.empty} role="status">
          No approvals, no paused runs, no plans waiting.
          {unavailable.length > 0
            ? ` ${String(unavailable.length)} source(s) could not be read — see below.`
            : ' Every source was read.'}
        </p>
      ) : (
        <ul className={styles.list} aria-label="Items waiting on you">
          {queue.items.map((item, index) => {
            const destination = attentionDestination(item);
            const isApproval = item.kind === 'approval_required';
            return (
              <li key={item.id}>
                <article className={styles.row} data-kind={item.kind} data-tool={item.tool}>
                  <div className={styles.rowHead}>
                    <StatusBadge tone={KIND_TONE[item.kind]}>{KIND_LABEL[item.kind]}</StatusBadge>
                    <span className={styles.tool}>{item.tool}</span>
                    <span className={styles.age} title={new Date(item.createdAt).toLocaleString()}>
                      {relativeTime(item.createdAt, now)}
                    </span>
                  </div>
                  <h2 className={styles.itemTitle}>{item.title}</h2>
                  <p className={styles.detail}>{item.detail}</p>
                  <div className={styles.actions}>
                    <Link
                      className={styles.link}
                      to={destination.href}
                      aria-label={`${KIND_LABEL[item.kind]}: ${item.title} — ${destination.label}`}
                      onFocus={() => { setFocused({ id: item.id, index }); }}
                      onKeyDown={(event) => { move(event, index); }}
                      ref={(node) => {
                        if (node === null) links.current.delete(item.id);
                        else links.current.set(item.id, node);
                      }}
                    >
                      {destination.label}
                    </Link>
                    {isApproval && onDecide !== undefined ? (
                      <span className={styles.decisions} role="group" aria-label={`Decide ${item.title}`}>
                        {DECISIONS.map(({ decision, label }) => (
                          <Button
                            key={decision}
                            variant={decision === 'allow_once' ? 'primary' : 'quiet'}
                            disabled={decidingId === item.id}
                            onClick={() => { onDecide(item, decision); }}
                          >
                            {label}
                          </Button>
                        ))}
                      </span>
                    ) : null}
                  </div>
                  {destination.caveat === undefined ? null : (
                    <p className={styles.caveat} role="note">
                      {destination.caveat}
                    </p>
                  )}
                </article>
              </li>
            );
          })}
        </ul>
      )}

      <footer className={styles.sources} aria-label="Where the queue looked">
        <h2 className={styles.sourcesTitle}>Sources</h2>
        <ul className={styles.sourceList}>
          {queue.sources.map((source) => (
            <SourceLine key={source.source} source={source} />
          ))}
        </ul>
      </footer>
    </section>
  );
}

/**
 * One source line. `unavailable` is rendered with its reason, because a category
 * that could not be read must not look like a category with nothing in it — that
 * distinction is the reason the backend sends `sources` at all.
 */
function SourceLine({ source }: { source: AttentionSource }) {
  const label = SOURCE_LABEL[source.source] ?? source.source;
  return (
    <li className={styles.source} data-status={source.status}>
      <span className={styles.sourceName}>{label}</span>
      <StatusBadge
        tone={source.status === 'unavailable' ? 'warning' : source.status === 'ok' ? 'info' : 'neutral'}
      >
        {source.status === 'unavailable'
          ? 'not readable'
          : source.status === 'empty'
            ? 'nothing'
            : `${String(source.count)} waiting`}
      </StatusBadge>
      {source.reason === undefined ? null : <span className={styles.sourceReason}>{source.reason}</span>}
    </li>
  );
}
