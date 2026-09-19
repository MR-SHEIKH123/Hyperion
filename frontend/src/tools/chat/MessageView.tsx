import { StatusBadge } from '../../design-system/components/StatusBadge/StatusBadge';
import styles from './MessageView.module.css';

export interface MessageViewData {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  modelId: string | null;
  providerName: string | null;
  status: 'streaming' | 'paused' | 'complete' | 'error';
  errorCode: string | null;
  errorMessage: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  /** True for the optimistic/live rows that are not yet persisted. */
  ephemeral?: boolean;
}

const ROLE_LABELS: Record<MessageViewData['role'], string> = {
  system: 'System',
  user: 'You',
  assistant: 'Assistant',
  tool: 'Tool',
};

/**
 * One transcript row. Content is plain text by design — Hyperion's dark
 * card aesthetic, no markdown engine in the dependency set.
 */
export function MessageView({ message }: { message: MessageViewData }) {
  const meta: string[] = [];
  if (message.modelId) meta.push(message.modelId);
  if (message.providerName) meta.push(message.providerName);

  return (
    <article className={`${styles.message} ${styles[message.role]}`} data-message-id={message.id}>
      <header className={styles.header}>
        <span className={styles.role}>{ROLE_LABELS[message.role]}</span>
        {meta.length > 0 && <span className={styles.meta}>{meta.join(' · ')}</span>}
        {message.status === 'streaming' && <StatusBadge tone="info">Streaming</StatusBadge>}
        {message.status === 'paused' && <StatusBadge tone="warning">Paused</StatusBadge>}
        {message.status === 'error' && <StatusBadge tone="error">Error</StatusBadge>}
      </header>
      {message.content.trim().length > 0 && <div className={styles.content}>{message.content}</div>}
      {message.status === 'paused' && message.errorMessage && (
        <p className={styles.problem} role="note">
          Paused: {message.errorMessage}
        </p>
      )}
      {message.status === 'error' && message.errorMessage && (
        <p className={styles.problem} role="alert">
          {message.errorMessage}
        </p>
      )}
      {message.tokensIn !== null && message.tokensOut !== null && (
        <footer className={styles.usage}>
          {message.tokensIn} in · {message.tokensOut} out
        </footer>
      )}
    </article>
  );
}
