/**
 * The chat context ceiling, and resuming a conversation in a new session (1.28).
 *
 * Named `sessionResume` rather than `continuation` on purpose: `continue` already
 * means one specific thing in this build (picking a parked task run back up, see
 * `src/http/continuation.ts`), and two features sharing a word is how a seam gets
 * wired to the wrong one six months from now.
 *
 * A long chat eventually stops fitting in the model's window, and the provider's
 * answer to that is a hard rejection of the whole request. The agent loops handle
 * their own case by compacting (see `services/agent/compaction.ts`); a *chat* is
 * the user's transcript, so the same move is not available — silently dropping
 * the middle of a conversation someone is reading would rewrite their history in
 * front of them. What a person can act on is a new session: keep the part they are
 * working on, leave the rest behind with a receipt, and say so.
 *
 * Five decisions carry this, and each one is a way the alternative is worse.
 *
 * **Detection is a read, and it is honest about what it does not know.** The
 * window comes from the model's reported context length when a cached model
 * knows one, and otherwise from the conservative default — reported as
 * `assumed: true` rather than presented as fact. The estimate is characters/4
 * plus per-message overhead, the same arithmetic the provider adapter falls back
 * on, so the two never disagree about whether a conversation fits. It is an
 * estimate and it is labelled as one.
 *
 * **The tail is kept, the head is dropped.** A resumed session is for continuing
 * work, and the recent turns are what the model is reasoning about. The dropped
 * span is described, never quoted: a receipt that quoted the old messages would
 * cost the tokens it was meant to reclaim, and the text it would quote is
 * whatever the user happened to paste.
 *
 * **The receipt is a persisted `system` message.** In an agent run a compaction
 * digest lives only in the request, because the loop rebuilds the request each
 * turn. A chat's transcript *is* its context — the next turn is built from these
 * rows — so a receipt that existed only in memory would vanish on the next
 * message, and the model would meet a conversation that starts mid-sentence with
 * no idea it had. Attributing it to the assistant would put words in the model's
 * mouth; a system note is what it is: context supplied by the harness.
 *
 * **Refusing is a real outcome.** A conversation that already fits gets a `409`
 * naming the numbers rather than a duplicate chat, because "resume in a new
 * session" exists to escape a limit and a copy that drops nothing solves nothing.
 * The refusal points at the fork, which is the gesture that actually fits.
 *
 * **A temporary chat is refused**, like the fork: its messages exist only in the
 * process, so a resumed session would write down exactly what the user asked to
 * leave no trace of.
 */
import { AppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';
import { copyMessages, createChat, findChat, listMessages, requireChat } from '../../db/chats.ts';
import { isTemporaryChat } from '../../db/temporaryChats.ts';
import { contextWindowFallback, contextWindowOverride, findCachedModel } from '../../providers/registry.ts';
import {
  COMPACTION_TARGET_RATIO,
  COMPACTION_TRIGGER_RATIO,
  estimateMessageTokens,
  resolveContextWindow,
  type ContextWindow,
} from '../agent/compaction.ts';

import type { ChatRecord } from '../../db/chats.ts';
import type { MessageRecord } from '../../types/core.ts';

const log = createLogger('chat:continuation');

export interface ChatContextAssessment {
  chatId: string;
  /** The model the chat is pointed at, when it has one. */
  modelId: string | null;
  window: ContextWindow;
  /** Estimated tokens in the transcript, by the adapter's own arithmetic. */
  estimatedTokens: number;
  /** `estimatedTokens / window.tokens`. Can exceed 1. */
  ratio: number;
  /** Messages the estimate covers (the most recent page, like the chat route). */
  messageCount: number;
  /** True once the transcript reaches the trigger the agent loops compact at. */
  needsNewSession: boolean;
}

/** The transcript the assessment and the copy both work from. */
function transcript(chatId: string): MessageRecord[] {
  return listMessages(chatId, 500);
}

function estimate(messages: readonly MessageRecord[]): number {
  return messages.reduce(
    (sum, message) => sum + estimateMessageTokens({ role: message.role, content: message.content }),
    0,
  );
}

/**
 * The window this chat's model is judged against, with its provenance.
 *
 * The ladder's first rung is the provider's declared ceiling (1.28) — the chat's
 * own provider when it has one, the active provider otherwise, the same choice
 * `orchestrator/chat.ts` makes when a send has to pick one — and it wins over
 * what the model list reported, because a person who typed a number meant it.
 */
function windowFor(modelId: string | null, providerId: string | null): ContextWindow {
  const model = modelId === null ? null : findCachedModel(modelId);
  const override = contextWindowOverride(providerId);
  return resolveContextWindow({
    ...(model === null ? {} : { model }),
    ...(override === undefined ? {} : { override }),
    fallback: contextWindowFallback(providerId),
  });
}

/**
 * How full is this conversation?
 *
 * A read: no provider call, no write, and a `404` for a chat that does not
 * exist. The threshold is the same constant the agent loops use, so "nearly
 * full" means one thing in this build.
 */
export function assessChatContext(chatId: string): ChatContextAssessment {
  const chat = findChat(chatId);
  if (chat === null) {
    throw new AppError('not_found', `No chat with id ${chatId}.`, { details: { chatId } });
  }
  const messages = transcript(chatId);
  const window = windowFor(chat.modelId, chat.providerId);
  const estimatedTokens = estimate(messages);
  const ratio = estimatedTokens / window.tokens;
  return {
    chatId,
    modelId: chat.modelId,
    window,
    estimatedTokens,
    ratio,
    messageCount: messages.length,
    needsNewSession: ratio >= COMPACTION_TRIGGER_RATIO,
  };
}

/**
 * Describe a span in the same style as the compaction digest: counts and roles,
 * never content. Kept here rather than imported because the compaction receipt
 * ends with an instruction to the *agent*, and this one is read by a person and a
 * model in a chat.
 */
function receiptFor(dropped: readonly MessageRecord[], sourceTitle: string): string {
  let user = 0;
  let assistant = 0;
  let system = 0;
  let tool = 0;
  for (const message of dropped) {
    if (message.role === 'user') user += 1;
    else if (message.role === 'assistant') assistant += 1;
    else if (message.role === 'system') system += 1;
    else tool += 1;
  }
  const parts: string[] = [];
  if (user > 0) parts.push(`${user} user message(s)`);
  if (assistant > 0) parts.push(`${assistant} assistant message(s)`);
  if (system > 0) parts.push(`${system} system message(s)`);
  if (tool > 0) parts.push(`${tool} tool result(s)`);

  return (
    `[Earlier conversation left behind when this session was resumed from "${sourceTitle}": ` +
    `${parts.join(', ')}. That span is not in this transcript — ask the user rather than ` +
    `guessing if you need something from it.]`
  );
}

/**
 * The most recent messages that fit in `targetTokens`.
 *
 * Walks backwards and stops when the next message would exceed the budget. The
 * **last message is always kept**, even alone over budget: it is the thing the
 * user is working on, and a new session that dropped it would be a session with
 * nothing to continue. That is a deliberate overshoot, and the assessment the
 * caller gets back names the same numbers the decision was made from.
 */
function planTail(
  messages: readonly MessageRecord[],
  targetTokens: number,
): { kept: MessageRecord[]; dropped: MessageRecord[] } {
  let tokens = 0;
  let start = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) break;
    const cost = estimateMessageTokens({ role: message.role, content: message.content });
    const isLast = index === messages.length - 1;
    if (!isLast && tokens + cost > targetTokens) break;
    tokens += cost;
    start = index;
  }
  return { kept: messages.slice(start), dropped: messages.slice(0, start) };
}

export interface ResumeInput {
  /** Id for the new chat; the frontend generates chat ids client-side elsewhere. */
  id?: string;
  title?: string;
}

export interface ResumeResult {
  chat: ChatRecord;
  /** Receipt first, then the copied tail — read back out of the database. */
  messages: MessageRecord[];
  /** The source, named so a surface can say where this session came from. */
  source: { id: string; title: string };
  /** How many messages were left behind, and described rather than copied. */
  droppedMessages: number;
  /** How many copied messages were mid-stream in the source and land `paused`. */
  pausedPartials: number;
  /** The receipt text, so a surface can render it without parsing the transcript. */
  receipt: string;
  /** The numbers the decision was made from, including whether the window was assumed. */
  assessment: ChatContextAssessment;
}

/**
 * Continue this conversation in a new session.
 *
 * The source is not touched: nothing is deleted, truncated or re-stamped, so the
 * original remains exactly as it was — including the part the new session left
 * behind, which is the only copy of it that will exist.
 */
export function resumeInNewSession(chatId: string, input: ResumeInput = {}): ResumeResult {
  if (isTemporaryChat(chatId)) {
    throw new AppError(
      'conflict',
      'A temporary chat cannot be resumed in a new session: its messages are not stored, and the new session would persist them.',
      { details: { chatId } },
    );
  }
  const assessment = assessChatContext(chatId);
  const source = requireChat(chatId);
  const messages = transcript(chatId);

  const targetTokens = Math.floor(assessment.window.tokens * COMPACTION_TARGET_RATIO);
  const { kept, dropped } = planTail(messages, targetTokens);

  if (dropped.length === 0) {
    // Nothing to leave behind, so a new session would be a copy that changes only
    // the id. Two reasons reach here and they are not the same fact, so the
    // refusal says which: the transcript *fits*, or it does not and the newest
    // message alone fills the window — where dropping older messages cannot help
    // and the honest advice is about that message, not about forking.
    const fits = assessment.estimatedTokens <= assessment.window.tokens;
    const windowNote = `${assessment.window.tokens} tokens${assessment.window.assumed ? ', assumed' : ''}`;
    throw new AppError(
      'conflict',
      fits
        ? `This conversation already fits in the model's context window (~${assessment.estimatedTokens} of ` +
            `${windowNote}); a new session would leave nothing behind. Fork it instead if you want a branch.`
        : `There is nothing older to leave behind: the most recent message alone is ~${assessment.estimatedTokens} ` +
            `tokens against a ${windowNote} window. Shorten or split that message — a new session would carry it anyway.`,
      {
        details: {
          chatId,
          reason: fits ? 'fits' : 'nothing_droppable',
          estimatedTokens: assessment.estimatedTokens,
          windowTokens: assessment.window.tokens,
          assumed: assessment.window.assumed,
        },
      },
    );
  }

  const chat = createChat({
    tool: source.tool,
    title: input.title ?? `${source.title} (continued)`,
    modelId: source.modelId,
    providerId: source.providerId,
    forkedFrom: source.id,
    ...(input.id !== undefined ? { id: input.id } : {}),
  });

  const receipt = receiptFor(dropped, source.title);
  const { messages: copied, pausedPartials } = copyMessages(source.id, chat.id, kept, { receipt });

  log.info('resumed a conversation in a new session', {
    source: source.id,
    chat: chat.id,
    dropped: dropped.length,
    kept: kept.length,
  });

  return {
    chat: requireChat(chat.id),
    messages: copied,
    source: { id: source.id, title: source.title },
    droppedMessages: dropped.length,
    pausedPartials,
    receipt,
    assessment,
  };
}
