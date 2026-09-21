import { useCallback, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { createChat } from '../../api/chat';
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
  const chatId = params.chatId ?? null;
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
 * New-conversation state. The chat is created lazily on first send: the
 * prompt rides on the location state, the created chat's conversation consumes
 * it, and a reload in between simply loses the unsent draft (it was never
 * persisted, so that is the honest behaviour).
 */
function NewConversation() {
  const navigate = useNavigate();
  const [notice, setNotice] = useState<string | null>(null);
  const model = useModelSelection(null);

  const createMutation = useMutation({
    mutationFn: ({ modelId }: { modelId: string }) =>
      createChat({ tool: 'chat', title: 'New conversation', modelId }),
  });

  const send = useCallback(
    async (prompt: string, modelId: string) => {
      setNotice(null);
      try {
        const data = await createMutation.mutateAsync({ modelId });
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
    [createMutation, navigate],
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
      />
      </div>
    </section>
  );
}
