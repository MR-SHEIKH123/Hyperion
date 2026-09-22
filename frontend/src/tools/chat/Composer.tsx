import { useCallback, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Square } from 'lucide-react';
import { Button } from '../../design-system/components/Button/Button';
import {
  PrivacyIndicator,
  type ProviderPrivacy,
} from '../../components/PrivacyIndicator/PrivacyIndicator';
import styles from './Composer.module.css';
import type { ModelSelection } from './useModelSelection';
import type { StreamPhase } from './useChatStream';

export interface ComposerProps {
  model: ModelSelection;
  phase: StreamPhase;
  /** Pre-approval failure shown inline (e.g. busy 409). */
  notice: string | null;
  /**
   * Sends the prompt. A rejection means the send was refused before any
   * stream opened (busy, no provider): the draft is kept so it can be
   * re-sent, and the refusal itself renders in the run banners.
   */
  onSend: (prompt: string, modelId: string) => Promise<void> | void;
  onStop: () => void;
  /**
   * The remembered draft, read once when the surface mounts (1.39 A5). The
   * composer owns the text while it is on screen; the caller owns remembering it.
   */
  initialDraft?: string;
  /** Called with the draft on every edit, and with `''` once a send is accepted. */
  onDraftChange?: (text: string) => void;
  /**
   * Egress and retention facts for the next send, from the active provider.
   * Required rather than optional so a new composer surface cannot ship without
   * the privacy line and still typecheck (Prompt 1.39 B); pass `null` only
   * while the provider query has not answered.
   */
  privacy: ProviderPrivacy | null;
}

/**
 * The prompt box. Enter sends, Shift+Enter breaks a line. While a run is live
 * the send control becomes a stop; the textarea stays editable so the next
 * prompt can be typed before the stream ends.
 */
export function Composer({ model, phase, notice, onSend, onStop, privacy, initialDraft, onDraftChange }: ComposerProps) {
  const [draft, setDraft] = useState(initialDraft ?? '');
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const running = phase === 'running';
  const canSend =
    !running && draft.trim().length > 0 && model.selectedId !== null && model.ready && model.error === null;

  const submit = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      if (!canSend) return;
      const prompt = draft.trim();
      try {
        await onSend(prompt, model.selectedId as string);
        setDraft('');
        onDraftChange?.('');
        if (areaRef.current) areaRef.current.style.height = 'auto';
      } catch {
        // Refused before the stream: keep the draft. The reason renders in
        // the run banners; it must not silently eat the user's text.
      }
    },
    [canSend, draft, model.selectedId, onSend, onDraftChange],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form className={styles.composer} onSubmit={(event) => void submit(event)}>
      {notice && (
        <p className={styles.notice} role="alert">
          {notice}
        </p>
      )}
      <div className={styles.row}>
        <textarea
          ref={areaRef}
          className={styles.input}
          rows={3}
          placeholder={model.error === null ? 'Message the model…' : model.error ?? 'No model available.'}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            onDraftChange?.(event.target.value);
          }}
          onKeyDown={onKeyDown}
          aria-label="Message"
        />
        {running ? (
          <Button variant="quiet" onClick={onStop} aria-label="Stop generating">
            <Square className={styles.stopIcon} aria-hidden="true" /> Stop
          </Button>
        ) : (
          <Button variant="primary" type="submit" disabled={!canSend}>
            Send
          </Button>
        )}
      </div>
      <div className={styles.metaRow}>
        <label className={styles.modelLabel}>
          <span>Model</span>
          <select
            className={styles.modelSelect}
            value={model.selectedId ?? ''}
            onChange={(event) => model.setSelectedId(event.target.value)}
            disabled={model.models.length === 0 || model.error !== null}
            aria-label="Model"
          >
            {model.models.length === 0 && <option value="" disabled>No models offered</option>}
            {model.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label ?? m.id}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.trailing}>
          {privacy !== null && <PrivacyIndicator privacy={privacy} />}
          <span className={styles.hint}>Enter to send · Shift+Enter for a new line</span>
        </div>
      </div>
    </form>
  );
}
