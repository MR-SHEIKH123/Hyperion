import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Pin, PinOff, Trash2 } from 'lucide-react';
import { archiveChat, deleteChat, listChats, pinChat, unarchiveChat } from '../../api/chat';
import type { ChatRecord } from '../../contracts/wire/chat';
import { Button } from '../../design-system/components/Button/Button';
import { Dialog } from '../../design-system/components/Dialog/Dialog';
import styles from './ChatList.module.css';

/**
 * The conversation list. Unarchived by default (the API's sidebar default);
 * archived is a separate toggle view. Archiving is "keep, but out of the way"
 * — it is never a step toward deletion, so delete always confirms.
 */
export function ChatList({ selectedId }: { selectedId: string | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [toDelete, setToDelete] = useState<ChatRecord | null>(null);

  const chatsQuery = useQuery({
    queryKey: ['chats', showArchived ? 'archived' : 'active'],
    queryFn: ({ signal }) =>
      listChats(showArchived ? { tool: 'chat', archivedOnly: true } : { tool: 'chat' }, signal),
    retry: false,
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => deleteChat(id),
    onSuccess: () => {
      setToDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
      if (selectedId !== null) void navigate('/chat');
    },
  });

  const invalidateChats = () => void queryClient.invalidateQueries({ queryKey: ['chats'] });

  const chats: ChatRecord[] = chatsQuery.data?.chats ?? [];

  const select = (id: string) => {
    if (id !== selectedId) void navigate(`/chat/${id}`);
  };

  return (
    <nav className={styles.list} aria-label="Conversations">
      <div className={styles.header}>
        <h2 className={styles.heading}>Conversations</h2>
        <Button variant="primary" onClick={() => void navigate('/chat')} disabled={selectedId === null}>
          New
        </Button>
      </div>

      <div className={styles.listBody} role="list">
        {chatsQuery.isPending && (
          <p className={styles.empty} role="status">
            Loading conversations…
          </p>
        )}
        {chatsQuery.isError && (
          <p className={styles.empty} role="alert">
            Conversations could not be loaded.
          </p>
        )}
        {!chatsQuery.isPending && chats.length === 0 && (
          <p className={styles.empty}>
            {showArchived ? 'Nothing archived.' : 'No conversations yet — start one.'}
          </p>
        )}
        {chats.map((chat) => (
          <div
            key={chat.id}
            className={`${styles.item} ${chat.id === selectedId ? styles.selected : ''}`}
            role="listitem"
          >
            <button type="button" className={styles.itemButton} onClick={() => select(chat.id)}>
              <span className={styles.itemTitle}>
                {chat.pinned && <Pin className={styles.itemPin} aria-label="Pinned" />}
                {chat.title}
              </span>
              <span className={styles.itemMeta}>
                {new Date(chat.updatedAt).toLocaleDateString()}
                {chat.modelId ? ` · ${chat.modelId}` : ''}
              </span>
            </button>
            <div className={styles.itemActions}>
              <Button
                variant="quiet"
                className={styles.iconButton}
                aria-label={chat.pinned ? `Unpin ${chat.title}` : `Pin ${chat.title}`}
                onClick={() => void pinChat(chat.id, !chat.pinned).then(invalidateChats)}
              >
                {chat.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
              </Button>
              <Button
                variant="quiet"
                className={styles.iconButton}
                aria-label={showArchived ? `Unarchive ${chat.title}` : `Archive ${chat.title}`}
                onClick={() =>
                  void (showArchived ? unarchiveChat(chat.id) : archiveChat(chat.id)).then(invalidateChats)
                }
              >
                {showArchived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
              </Button>
              <Button
                variant="quiet"
                className={styles.iconButton}
                aria-label={`Delete ${chat.title}`}
                onClick={() => setToDelete(chat)}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <label className={styles.footer}>
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(event) => setShowArchived(event.target.checked)}
        />
        Show archived
      </label>

      <Dialog open={toDelete !== null} title="Delete conversation?" onClose={() => setToDelete(null)}>
        <p className={styles.confirmCopy}>
          <strong>{toDelete?.title}</strong> and its messages will be removed immediately. This cannot be
          undone — archive it instead if you might want it back.
        </p>
        <div className={styles.confirmActions}>
          <Button onClick={() => setToDelete(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={deleteMutation.isPending}
            onClick={() => {
              if (toDelete !== null) deleteMutation.mutate({ id: toDelete.id });
            }}
          >
            {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </Dialog>
    </nav>
  );
}
