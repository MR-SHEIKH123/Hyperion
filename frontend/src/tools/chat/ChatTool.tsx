import { useCallback, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { createChat } from '../../api/chat';
import { usePersistedDraft } from '../../state/persistence/usePersistedDraft';
import { NEW_CHAT_DRAFT_KEY } from './drafts';
import { useModelSelection } from './useModelSelection';
import { Composer } from './Composer';
import { ChatConversation } from './ChatConversation';
import { ChatList } from './ChatList';
import styles from './ChatTool.module.css';

export interface PendingSend {
  prompt: string;
  modelId: string;
}

interface ChatLocationState {
  pendingSend?: PendingSend | null;
}

/**
 * Chat — the first fully-wired tool (Milestone B).
 *
 * `/chat` is the new-conversation state: type and send, and the chat is
 * created on first use. `/chat/:chatId` opens a real conversation.
 */
export default function ChatTool() {
  const params = useParams();
  // The route is `/chat/*`, so the conversation id is the splat remainder.
  // Reading `params.chatId` here returned undefined for every URL, which made
  // `/chat/<id>` render the new-conversation pane: the list could link to a chat
  // and the pane would ignore which one.
  const remainder = params['*'] ?? '';
  const chatId = (remainder.split('/')[0] ?? '') === '' ? null : (remainder.split('/')[0] as string);
  const location = useLocation();
  const navigate = useNavigate();
  const pendingSend: PendingSend | null =
    (location.state as ChatLocationState | null)?.pendingSend ?? null;

  const consumePendingSend = useCallback(() => {
    // Clear the one-shot prompt from the location state; a reload must not
    // send it a second time.
    void navigate(location.pathname, { replace: true, state: null });
  }, [navigate, location.pathname]);

  return (
    <div className={styles.tool}>
      <ChatList selectedId={chatId} />
      {chatId === null ? (
        <NewConversation />
      ) : (
        <ChatConversation key={chatId} chatId={chatId} pendingSend={pendingSend} onPendingSendConsumed={consumePendingSend} />
      )}
    </div>
  );
}

/**
 * New-conversation state. The chat is created lazily on first send: the prompt
 * rides on the location state and the created chat's conversation consumes it.
 *
 * The draft is remembered under its own key (1.39 A5) until that happens: typing a
 * prompt and reloading should not lose it. Once the chat exists the draft is
 * dropped, because the prompt is then carried by the conversation that owns it —
 * keeping both would send it twice on a back-navigation.
 */
function NewConversation() {
  const navigate = useNavigate();
  const [notice, setNotice] = useState<string | null>(null);
  const model = useModelSelection(null);
  const draft = usePersistedDraft(NEW_CHAT_DRAFT_KEY);

  const createMutation = useMutation({
    mutationFn: ({ modelId }: { modelId: string }) =>
      createChat({ tool: 'chat', title: 'New conversation', modelId }),
  });

  const send = useCallback(
    async (prompt: string, modelId: string) => {
      setNotice(null);
      try {
        const data = await createMutation.mutateAsync({ modelId });
        draft.clear();
        void navigate(`/chat/${data.chat.id}`, {
          state: { pendingSend: { prompt, modelId } } satisfies ChatLocationState,
        });
      } catch (error) {
        // Rejected to the composer: it keeps the draft. The reason is also
        // surfaced inline.
        setNotice(error instanceof Error ? error.message : 'The conversation could not be created.');
        throw error;
      }
    },
    [createMutation, draft, navigate],
  );

  return (
    <section className={styles.newChat} aria-label="New conversation">
      <div className={styles.newChatHeader}>
        <h1 className={styles.newChatTitle}>New conversation</h1>
        <p className={styles.newChatHint}>
          Pick a model and say what you want. The conversation is saved when you send your first
          message.
        </p>
      </div>
      <div className={styles.newChatComposer}>
        <Composer
          model={model}
          phase="idle"
          notice={notice}
          onSend={send}
          onStop={() => {}}
          privacy={model.privacy}
          initialDraft={draft.initial}
          onDraftChange={draft.onChange}
        />
      </div>
    </section>
  );
}
