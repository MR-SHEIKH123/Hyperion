import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Pin, PinOff, RefreshCw } from 'lucide-react';
import { archiveChat, openChat, patchChat, pinChat, unarchiveChat } from '../../api/chat';
import type { ChatReconciliation } from '../../api/chat';
import type { MessageRecord, RunStateSnapshot } from '../../contracts/wire/chat';
import { Button } from '../../design-system/components/Button/Button';
import { StatusBadge } from '../../design-system/components/StatusBadge/StatusBadge';
import { useScrollAnchor } from '../../state/persistence/useScrollAnchor';
import { usePersistedDraft } from '../../state/persistence/usePersistedDraft';
import { chatDraftKey } from './drafts';
import { useChatStream } from './useChatStream';
import { useModelSelection } from './useModelSelection';
import { Composer } from './Composer';
import { MessageView, type MessageViewData } from './MessageView';
import styles from './ChatConversation.module.css';

const PAUSE_REASON_LABELS: Record<string, string> = {
  provider_failure: 'The provider failed mid-run',
  provider_switch: 'The provider switched away',
  model_switch: 'The model or provider was switched',
  no_healthy_provider: 'No healthy provider available',
  capability_mismatch: 'The active provider does not offer that model',
  user_request: 'Stopped on request',
};

function pauseLabel(reason: string | null): string {
  return reason ? (PAUSE_REASON_LABELS[reason] ?? reason) : 'Paused';
}

interface ConversationProps {
  chatId: string;
  /** A prompt the user typed before this chat existed (new-chat fast path). */
  pendingSend: { prompt: string; modelId: string } | null;
  onPendingSendConsumed: () => void;
}

/**
 * One open chat: header, transcript, run banners, composer.
 *
 * The transcript is always rendered from the query (persisted truth); the
 * stream hook only contributes the live rows (optimistic user prompt,
 * unflushed assistant text). Settling a stream applies the reconciliation or
 * refetches — the UI never shows state the server does not also hold.
 */
export function ChatConversation({ chatId, pendingSend, onPendingSendConsumed }: ConversationProps) {
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);

  // The unsent draft and the reading position are the two things this surface is
  // expected to come back to (1.39 A5).
  const draft = usePersistedDraft(chatDraftKey(chatId));

  const chatQuery = useQuery({
    queryKey: ['chat', chatId],
    queryFn: ({ signal }) => openChat(chatId, signal),
    retry: false,
  });

  const onSettled = useCallback(
    (reason: 'terminal' | 'reconciled' | 'failed' | 'cancelled', reconciliation?: ChatReconciliation) => {
      if (reason === 'cancelled') return;
      if (reconciliation !== undefined) {
        // The reconciliation page is a single 50-message tail. Apply it only
        // when the cache holds at most one page; otherwise refetch so a long
        // transcript is never silently truncated.
        let needsFullRefetch = false;
        queryClient.setQueryData(['chat', chatId], (previous: unknown) => {
          const prior = previous as { messages?: MessageRecord[] } | undefined;
          if (prior !== undefined && Array.isArray(prior.messages) && prior.messages.length > 50) {
            needsFullRefetch = true;
            return previous;
          }
          return { ...(previous as object), messages: reconciliation.messages, latestRun: reconciliation.latest };
        });
        if (needsFullRefetch) void queryClient.invalidateQueries({ queryKey: ['chat', chatId] });
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ['chat', chatId] });
    },
    [queryClient, chatId],
  );

  const stream = useChatStream(chatId, onSettled);
  const chat = chatQuery.data?.chat ?? null;
  const latestRun: RunStateSnapshot | null = chatQuery.data?.latestRun ?? null;
  const persisted = useMemo(() => chatQuery.data?.messages ?? [], [chatQuery.data?.messages]);

  // A switched model persists to the chat so the next visit picks it up.
  const persistModel = useCallback(
    (modelId: string) => {
      if (modelId === '' || chat === null || chat.modelId === modelId) return;
      void patchChat(chatId, { modelId }).then(() =>
        queryClient.setQueryData(['chat', chatId], (previous: unknown) => {
          const prior = previous as { chat?: { modelId: string | null } } | undefined;
          if (prior?.chat !== undefined) return { ...prior, chat: { ...prior.chat, modelId } };
          return previous;
        }),
      );
    },
    [chat, chatId, queryClient],
  );

  const model = useModelSelection(chat?.modelId ?? null);
  const modelId = model.selectedId;

  // New-chat fast path: the user typed before the chat existed; send now that
  // the id is real. Fires once per chat, when the transcript is known empty.
  const pendingRef = useRef(pendingSend);
  useEffect(() => {
    const pending = pendingRef.current;
    if (pending === null || chatQuery.isPending || chatQuery.data?.messages.length !== 0) return;
    pendingRef.current = null;
    onPendingSendConsumed();
    stream.send(pending.prompt, pending.modelId).catch(() => {
      // A pre-stream refusal (busy) is already in the hook's error state; the
      // banner renders it. Swallowing here keeps it from being an unhandled
      // rejection.
    });
    // Deliberately one-shot: the pending prompt is consumed exactly once per
    // chat mount; stream/query identity must not re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatQuery.isPending, chatQuery.data?.messages.length]);

  const togglePin = useCallback(() => {
    if (chat === null) return;
    void pinChat(chatId, !chat.pinned);
  }, [chat, chatId]);

  const toggleArchive = useCallback(() => {
    if (chat === null) return;
    void (chat.archived ? unarchiveChat(chatId) : archiveChat(chatId)).then(() => {
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
    });
  }, [chat, chatId, queryClient]);

  const resume = useCallback(() => {
    const run = latestRun;
    if (run === null || run.state !== 'paused' || modelId === null) return;
    persistModel(modelId);
    stream.resume(run.runId, modelId).catch(() => {
      // run_not_paused (another tab resumed first) lands in the hook's error
      // state; the banner renders it.
    });
  }, [latestRun, modelId, stream, persistModel]);

  const send = useCallback(
    async (prompt: string, chosenModelId: string) => {
      persistModel(chosenModelId);
      // A paused run with a fresh prompt is a switch-and-resume: the backend
      // reconfigures and resumes, staying paused if the switch fails.
      if (latestRun !== null && latestRun.state === 'paused') {
        stream.resume(latestRun.runId, chosenModelId).catch(() => {
          // Pre-stream refusal (run no longer paused): in the hook's error
          // state, rendered by the banner.
        });
        return;
      }
      // Awaiting: a pre-stream refusal rejects, and the composer keeps the
      // draft in that case.
      await stream.send(prompt, chosenModelId);
    },
    [latestRun, stream, persistModel],
  );

  // The rendered transcript: persisted rows, plus the live rows while running.
  const view: MessageViewData[] = useMemo(() => {
    const rows: MessageViewData[] = persisted.map((m) => ({ ...m, ephemeral: false }));
    const { phase, liveText, pendingUser, messageId } = stream.status;
    if (phase === 'running') {
      if (pendingUser !== null) {
        rows.push({
          id: 'pending-user',
          role: 'user',
          content: pendingUser,
          modelId: null,
          providerName: null,
          status: 'complete',
          errorCode: null,
          errorMessage: null,
          tokensIn: null,
          tokensOut: null,
          ephemeral: true,
        });
      }
      const last = rows[rows.length - 1];
      if (messageId !== null && last !== undefined && last.id === messageId && last.role === 'assistant') {
        // Resume case: tokens continue the same persisted (paused) message.
        rows[rows.length - 1] = { ...last, content: last.content + liveText, status: 'streaming' };
      } else if (liveText.length > 0) {
        rows.push({
          id: `live-${messageId ?? 'assistant'}`,
          role: 'assistant',
          content: liveText,
          modelId,
          providerName: model.activeProviderName,
          status: 'streaming',
          errorCode: null,
          errorMessage: null,
          tokensIn: null,
          tokensOut: null,
          ephemeral: true,
        });
      }
    }
    return rows;
  }, [persisted, stream.status, modelId, model.activeProviderName]);

  // Reading position: restored once per conversation, then followed only while the
  // viewport is already at the bottom. The old behaviour — jump to the end whenever
  // the transcript grew — moved the view out from under anyone reading back.
  useScrollAnchor(scrollRef, chatDraftKey(chatId), view, { enabled: !chatQuery.isPending });

  const pausedRun = latestRun !== null && latestRun.state === 'paused' ? latestRun : null;
  const showResumeBanner = pausedRun !== null && stream.status.phase !== 'running';
  const serverRunInFlight = latestRun?.state === 'running' && stream.status.phase !== 'running';
  const busyError = stream.status.phase === 'error' && stream.status.error?.code === 'busy' ? stream.status.error : null;
  const fatalError = stream.status.phase === 'error' && stream.status.error !== null && busyError === null ? stream.status.error : null;

  return (
    <section className={styles.conversation} aria-label={chat?.title ?? 'Conversation'}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h1 className={styles.title}>{chatQuery.isPending ? 'Loading…' : chat?.title ?? 'Conversation'}</h1>
          {chat?.pinned && <Pin className={styles.pinIcon} aria-label="Pinned" />}
          {chatQuery.isFetching && !chatQuery.isPending && <StatusBadge tone="info">Syncing</StatusBadge>}
        </div>
        <div className={styles.actions}>
          <Button variant="quiet" onClick={togglePin} disabled={chat === null} aria-label={chat?.pinned ? 'Unpin chat' : 'Pin chat'}>
            {chat?.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
          </Button>
          <Button variant="quiet" onClick={toggleArchive} disabled={chat === null} aria-label={chat?.archived ? 'Unarchive chat' : 'Archive chat'}>
            {chat?.archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
          </Button>
        </div>
      </header>

      {chatQuery.isError && (
        <p className={styles.problem} role="alert">
          This conversation could not be opened. {chatQuery.error instanceof Error ? chatQuery.error.message : ''}
        </p>
      )}

      {serverRunInFlight && (
        <div className={styles.banner} role="status">
          <StatusBadge tone="info">Running</StatusBadge>
          <span>A run is in flight for this conversation.</span>
        </div>
      )}

      {showResumeBanner && pausedRun !== null && (
        <div className={styles.resumeBanner} role="alert">
          <div className={styles.resumeCopy}>
            <h2 className={styles.resumeTitle}>{pauseLabel(pausedRun.pauseReason)}</h2>
            <p className={styles.resumeDetail}>{pausedRun.errorMessage ?? 'The run was paused.'}</p>
          </div>
          <Button variant="primary" onClick={resume} disabled={modelId === null}>
            <RefreshCw className={styles.resumeIcon} aria-hidden="true" /> Resume
          </Button>
        </div>
      )}

      {fatalError !== null && (
        <div className={styles.errorBanner} role="alert">
          <p>
            {fatalError.message}
            {fatalError.retryable ? ' — retryable; send again or resume the run.' : ''}
          </p>
        </div>
      )}

      <div className={styles.messages} ref={scrollRef}>
        {chatQuery.isPending ? (
          <p className={styles.empty} role="status">
            Opening conversation…
          </p>
        ) : view.length === 0 ? (
          <p className={styles.empty}>No messages yet. Say something below.</p>
        ) : (
          view.map((m) => <MessageView key={m.id} message={m} />)
        )}
      </div>

      <footer className={styles.composerWrap}>
        <Composer
          model={model}
          phase={stream.status.phase === 'running' ? 'running' : 'idle'}
          notice={busyError !== null ? busyError.message : null}
          onSend={send}
          onStop={() => stream.stop()}
          privacy={model.privacy}
          initialDraft={draft.initial}
          onDraftChange={draft.onChange}
        />
      </footer>
    </section>
  );
}
