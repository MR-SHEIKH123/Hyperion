/**
 * Draft keys (1.39 A5).
 *
 * One namespace, so the classification pass has a single place to look and a key
 * can never collide with an onboarding or settings draft. The new-conversation
 * draft is keyed by the state rather than an id because the chat it belongs to
 * does not exist yet — and is dropped the moment the chat is created, since the
 * prompt then lives in the conversation that owns it.
 */
export const NEW_CHAT_DRAFT_KEY = 'chat:new';

export function chatDraftKey(chatId: string): string {
  return `chat:${chatId}`;
}
