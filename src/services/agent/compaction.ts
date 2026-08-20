/**
 * Context compaction: dropping the middle of a long conversation before the
 * provider refuses it.
 *
 * A long agent run eventually exceeds the model's context window. The provider's
 * answer to that is a hard rejection of the whole request, which arrives as a
 * failed run after the user has been waiting — so the loop has to notice it
 * coming and shorten the conversation itself.
 *
 * Five decisions here are load-bearing.
 *
 * **Compaction is visible.** Every compaction records a `compression` step and
 * emits an event naming exactly what was dropped. Silent compaction is the worst
 * version of this feature: the model's memory of the conversation changes
 * underneath the user, who then cannot understand why it forgot something they
 * remember saying. `014_task_steps.sql` reserved the `compression` kind for this.
 *
 * **The digest is built from what was dropped, not written by a model.** Asking
 * the model to summarise costs a request, can fail, and can hallucinate content
 * into the record that was never in the conversation. A deterministic digest —
 * how many messages, from which roles, which tools — is honest, free and cannot
 * fail mid-run. It is a *receipt*, not a substitute.
 *
 * **The digest is a `system` message.** Attributing it to the assistant would put
 * words in the model's mouth that it never said and that it will then treat as
 * its own reasoning. A system note reads as context supplied by the harness,
 * which is what it is.
 *
 * **A tool result is never separated from the call that asked for it.** The
 * tool-call protocol requires a `tool` message to carry the id of the assistant
 * call it answers, and a provider given an orphan rejects **the entire
 * conversation**, not the offending message. So messages are dropped in groups —
 * an assistant turn leaves with all of its tool answers — and never individually.
 * Compaction that unpaired them would turn "this run is getting long" into "this
 * run is broken".
 *
 * **Refusing to compact is a valid outcome.** If everything left is pinned, this
 * reports that it could not help rather than dropping something it promised to
 * keep. The caller — the agent loop — then parks the run, which is a state the
 * user can act on. Quietly dropping the system prompt to get under the limit
 * would produce an agent that forgets its own instructions and nobody could see
 * why.
 */

import { nextStepNumber, recordStep } from '../../db/taskSteps.ts';
import { createLogger } from '../../util/logger.ts';

import type { AgentContext, ChatMessage, ModelInfo } from '../../types/core.ts';

const log = createLogger('compaction');

// --- estimating size -------------------------------------------------------

/**
 * Characters per token. Matches the estimate the provider adapter falls back to
 * when a gateway reports no usage, deliberately: two different guesses about the
 * same conversation would disagree about whether it fits.
 *
 * It is an approximation in both directions and that is acceptable here, because
 * it is compared against a threshold well below the real limit. Being wrong by a
 * few per cent moves *when* compaction happens, not whether the request fits.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Per-message overhead. Every message costs more than its text: role, framing
 * and separators all consume tokens the character count cannot see. Ignoring it
 * underestimates a conversation of many short messages badly.
 */
const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * The estimated cost of one message, including the parts that are easy to
 * forget: a tool call's arguments are sent to the provider and are frequently
 * larger than the message content they accompany.
 */
export function estimateMessageTokens(message: ChatMessage): number {
  let total = estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
  for (const call of message.toolCalls ?? []) {
    total += estimateTokens(call.name) + estimateTokens(call.arguments);
  }
  if (message.toolCallId !== undefined) total += estimateTokens(message.toolCallId);
  if (message.name !== undefined) total += estimateTokens(message.name);
  return total;
}

export function estimateConversationTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

// --- the context window ----------------------------------------------------

/** Where the context size came from, so the UI can say "assumed" when it is. */
export type WindowSource = 'override' | 'model' | 'default';

export interface ContextWindow {
  tokens: number;
  source: WindowSource;
  /** True when nobody actually told us the limit and this is a guess. */
  assumed: boolean;
}

/**
 * What to assume when nothing reports a context length.
 *
 * `ModelInfo.contextLength` is optional because most OpenAI-compatible gateways
 * simply do not return it, so this path is the common one rather than the edge
 * case. The value is deliberately small: guessing low compacts a conversation
 * earlier than strictly necessary, which costs a little fidelity, while guessing
 * high means the provider rejects the request and the run fails outright. Those
 * two errors are not equally bad.
 */
export const DEFAULT_CONTEXT_TOKENS = 8_192;

/**
 * Resolve the window through a ladder, most authoritative first: an explicit
 * override, then what the provider reported, then the conservative default.
 *
 * A non-positive or non-finite value at any rung is treated as absent rather
 * than honoured — a gateway reporting `context_length: 0` means "I did not tell
 * you", and taking it literally would compact every conversation to nothing.
 */
export function resolveContextWindow(input: {
  model?: ModelInfo | undefined;
  override?: number | undefined;
}): ContextWindow {
  if (usable(input.override)) return { tokens: input.override, source: 'override', assumed: false };
  const reported = input.model?.contextLength;
  if (usable(reported)) return { tokens: reported, source: 'model', assumed: false };
  return { tokens: DEFAULT_CONTEXT_TOKENS, source: 'default', assumed: true };
}

function usable(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// --- deciding whether to act ----------------------------------------------

/**
 * Compact once the conversation reaches this share of the window.
 *
 * 80% leaves room for the reply. A threshold at 95% would be technically tidier
 * and useless in practice: the request that tips over the limit is the one
 * carrying the model's answer, and the answer's size is not known in advance.
 */
export const COMPACTION_TRIGGER_RATIO = 0.8;

/**
 * Compact down to this share, not merely back under the trigger.
 *
 * Stopping at 79% would compact again on the very next turn, and again on the
 * one after — each time emitting an event and dropping a little more, which
 * reads to the user as a stutter rather than an action. Going further buys
 * several turns of headroom per compaction.
 */
export const COMPACTION_TARGET_RATIO = 0.5;

export interface CompactionDecision {
  needed: boolean;
  /** Estimated tokens as a share of the window. Can exceed 1. */
  ratio: number;
  estimatedTokens: number;
  window: ContextWindow;
}

export function assessContext(
  messages: readonly ChatMessage[],
  window: ContextWindow,
  trigger: number = COMPACTION_TRIGGER_RATIO,
): CompactionDecision {
  const estimatedTokens = estimateConversationTokens(messages);
  const ratio = estimatedTokens / window.tokens;
  return { needed: ratio >= trigger, ratio, estimatedTokens, window };
}

// --- grouping --------------------------------------------------------------

/**
 * An atomic unit of conversation.
 *
 * An assistant message that requested tools and the `tool` messages answering it
 * are one group and leave together. See the module comment: an orphaned tool
 * result invalidates the whole request, so a group is the smallest thing that
 * can be dropped without corrupting the conversation.
 */
interface MessageGroup {
  messages: ChatMessage[];
  tokens: number;
  /** True when any member is a system message, which is never dropped. */
  system: boolean;
  /** True when any member is a tool result. */
  hasToolResult: boolean;
}

function groupMessages(messages: readonly ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];

  for (const message of messages) {
    const answersOpenCall =
      message.role === 'tool' &&
      message.toolCallId !== undefined &&
      groups.length > 0 &&
      openCallIds(groups[groups.length - 1]).has(message.toolCallId);

    if (answersOpenCall) {
      const group = groups[groups.length - 1];
      // Guarded by `groups.length > 0` above; the index check is for the
      // compiler, which cannot see that.
      if (group) {
        group.messages.push(message);
        group.tokens += estimateMessageTokens(message);
        group.hasToolResult = true;
        continue;
      }
    }

    groups.push({
      messages: [message],
      tokens: estimateMessageTokens(message),
      system: message.role === 'system',
      hasToolResult: message.role === 'tool',
    });
  }

  return groups;
}

/** The tool-call ids requested by a group and not yet answered inside it. */
function openCallIds(group: MessageGroup | undefined): Set<string> {
  const ids = new Set<string>();
  if (!group) return ids;
  for (const message of group.messages) {
    for (const call of message.toolCalls ?? []) ids.add(call.id);
  }
  for (const message of group.messages) {
    if (message.role === 'tool' && message.toolCallId !== undefined) ids.delete(message.toolCallId);
  }
  return ids;
}

// --- compacting ------------------------------------------------------------

/** Why a compaction attempt changed nothing. */
export type CompactionSkipReason =
  /** The conversation is not close enough to the limit yet. */
  | 'not_needed'
  /** Everything that remains is pinned, so there is nothing left to give. */
  | 'nothing_droppable';

export interface CompactionInput {
  messages: readonly ChatMessage[];
  window: ContextWindow;
  /** Recent groups kept whole regardless of size. */
  keepRecentGroups?: number;
  trigger?: number;
  target?: number;
}

export interface CompactionResult {
  messages: ChatMessage[];
  compacted: boolean;
  skippedBecause?: CompactionSkipReason;
  /** How many original messages were replaced by the digest. */
  droppedMessages: number;
  tokensBefore: number;
  tokensAfter: number;
  /** The digest text, when one was inserted. */
  digest?: string;
  decision: CompactionDecision;
}

/**
 * How many trailing groups survive untouched.
 *
 * Two, because the most recent exchange is what the model is actually reasoning
 * about. Dropping it to save space produces an agent that loses its train of
 * thought at exactly the moment the conversation got interesting.
 */
export const DEFAULT_KEEP_RECENT_GROUPS = 2;

/**
 * Shorten a conversation, preserving everything that must not move.
 *
 * Pinned, in every case: all system messages, the group holding the most recent
 * tool result, and the last `keepRecentGroups` groups. Everything else is
 * droppable oldest-first, which is the right order because the oldest turns are
 * the ones the model is least likely to still need and the most likely to have
 * been superseded.
 */
export function compactConversation(input: CompactionInput): CompactionResult {
  const { messages, window } = input;
  const trigger = input.trigger ?? COMPACTION_TRIGGER_RATIO;
  const target = input.target ?? COMPACTION_TARGET_RATIO;
  const keepRecent = input.keepRecentGroups ?? DEFAULT_KEEP_RECENT_GROUPS;

  const decision = assessContext(messages, window, trigger);
  const tokensBefore = decision.estimatedTokens;

  if (!decision.needed) {
    return {
      messages: [...messages],
      compacted: false,
      skippedBecause: 'not_needed',
      droppedMessages: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      decision,
    };
  }

  const groups = groupMessages(messages);
  const lastToolResult = lastIndexWhere(groups, (g) => g.hasToolResult);
  const firstRecent = Math.max(0, groups.length - keepRecent);

  const pinned = groups.map(
    (group, index) => group.system || index >= firstRecent || index === lastToolResult,
  );

  const targetTokens = Math.floor(window.tokens * target);
  const dropped: MessageGroup[] = [];
  let running = tokensBefore;

  for (let index = 0; index < groups.length; index += 1) {
    if (running <= targetTokens) break;
    if (pinned[index] === true) continue;
    const group = groups[index];
    if (!group) continue;
    dropped.push(group);
    running -= group.tokens;
  }

  if (dropped.length === 0) {
    // Honest failure: the caller decides what to do about a conversation that
    // cannot be shortened. This module will not buy space by dropping something
    // it said it would keep.
    return {
      messages: [...messages],
      compacted: false,
      skippedBecause: 'nothing_droppable',
      droppedMessages: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      decision,
    };
  }

  const digest = describeDropped(dropped);
  const droppedGroups = new Set(dropped);
  const kept: ChatMessage[] = [];
  let digestInserted = false;

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!group) continue;
    if (droppedGroups.has(group)) {
      // The digest sits where the removed block was, so the conversation still
      // reads in order rather than opening with a note about its own middle.
      if (!digestInserted) {
        kept.push({ role: 'system', content: digest });
        digestInserted = true;
      }
      continue;
    }
    kept.push(...group.messages);
  }

  return {
    messages: kept,
    compacted: true,
    droppedMessages: dropped.reduce((sum, group) => sum + group.messages.length, 0),
    tokensBefore,
    tokensAfter: estimateConversationTokens(kept),
    digest,
    decision,
  };
}

function lastIndexWhere(groups: MessageGroup[], predicate: (group: MessageGroup) => boolean): number {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group && predicate(group)) return index;
  }
  return -1;
}

/**
 * Describe the removed block.
 *
 * Names roles, counts and tool names — never content. A digest that quoted the
 * messages would defeat the point by costing the tokens it was meant to reclaim,
 * and the conversation it is quoting may contain anything the user pasted.
 */
function describeDropped(dropped: readonly MessageGroup[]): string {
  let user = 0;
  let assistant = 0;
  let toolResults = 0;
  const tools = new Set<string>();

  for (const group of dropped) {
    for (const message of group.messages) {
      if (message.role === 'user') user += 1;
      else if (message.role === 'assistant') assistant += 1;
      else if (message.role === 'tool') toolResults += 1;
      for (const call of message.toolCalls ?? []) tools.add(call.name);
      if (message.role === 'tool' && message.name !== undefined) tools.add(message.name);
    }
  }

  const parts: string[] = [];
  if (user > 0) parts.push(`${user} user message(s)`);
  if (assistant > 0) parts.push(`${assistant} assistant message(s)`);
  if (toolResults > 0) parts.push(`${toolResults} tool result(s)`);

  const named = tools.size > 0 ? ` Tools used in that span: ${[...tools].sort().join(', ')}.` : '';

  return (
    `[Earlier conversation removed to stay within the model's context window: ` +
    `${parts.join(', ')}.${named} ` +
    `Ask the user rather than guessing if you need something from that span.]`
  );
}

// --- making it visible -----------------------------------------------------

/**
 * Put a compaction on the record and tell the client.
 *
 * The step row is written before the event for the same reason parking is: the
 * database is the record and SSE is a notification about it, and a client told
 * about a compaction the history does not contain will disagree with the server
 * after a reload.
 *
 * `tokensIn`/`tokensOut` carry before and after. They are estimates, and the
 * column is the natural place for them — a reader comparing the two sees how
 * much the compaction actually bought, which is the number that tells you
 * whether the thresholds are set sensibly.
 */
export function recordCompaction(
  ctx: Pick<AgentContext, 'emit' | 'log'>,
  runId: string,
  result: CompactionResult,
): void {
  if (!result.compacted) return;

  recordStep({
    runId,
    step: nextStepNumber(runId),
    kind: 'compression',
    ok: true,
    detail:
      `dropped ${result.droppedMessages} message(s); ` +
      `~${result.tokensBefore} to ~${result.tokensAfter} tokens ` +
      `(window ~${result.decision.window.tokens}${result.decision.window.assumed ? ', assumed' : ''})`,
    tokensIn: result.tokensBefore,
    tokensOut: result.tokensAfter,
  });

  ctx.emit('context_compacted', {
    runId,
    droppedMessages: result.droppedMessages,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    windowTokens: result.decision.window.tokens,
    windowAssumed: result.decision.window.assumed,
    digest: result.digest,
  });

  ctx.log.info(`compacted the context for run ${runId}`, {
    dropped: result.droppedMessages,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
  });
  log.debug('compaction detail', { runId, source: result.decision.window.source });
}
