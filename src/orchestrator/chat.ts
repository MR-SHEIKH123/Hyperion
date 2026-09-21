/**
 * The chat engine: provider routing wired into the pause/resume machine.
 *
 * This module is where the app's central behavioural promise is actually kept,
 * so the rules it enforces are worth stating plainly:
 *
 * 1. A provider failure PAUSES. It never crashes, never truncates history, and
 *    never deletes the partial reply. The partial text is persisted with
 *    `status = 'paused'` and echoed in the `paused` event.
 * 2. It does NOT auto-retry into the same broken state. The router may attempt
 *    the same provider a second time only to establish the 2-failure health
 *    threshold, and only while nothing has been emitted yet; once the provider
 *    is judged unhealthy the same provider is never tried again on this run.
 * 3. When the router fails over to a DIFFERENT provider, the run auto-resumes
 *    and emits `resumed`. Continuing elsewhere is not retrying into the same
 *    broken state. This happens inside a single routed stream, so the request
 *    is never sent twice to the same provider. If the replacement also fails,
 *    the run pauses and stops. (Toggle: `auto_resume_after_failover`.)
 * 4. A manual model/provider switch pauses, reconfigures, and auto-resumes on
 *    success. If the switch itself fails, it stays paused rather than silently
 *    falling back to the old provider.
 */

import * as router from '../providers/router.ts';
import * as runState from './runState.ts';
import { SseStream } from './sse.ts';
import {
  appendMessage,
  ensureChat,
  listMessages,
  saveStreamProgress,
  toProviderMessages,
  touchChat,
  updateMessage,
} from '../db/chats.ts';
import { computeCost, recordUsage } from '../db/usage.ts';
import { autoResumeAfterFailover, redactionCheckEnabled, zdrRequirement } from '../db/settings.ts';
import { findProvider, getActiveProvider } from '../providers/repository.ts';
import { assertOutboundSafe } from '../services/safety/outbound.ts';
import { zdrStatusFor } from '../services/safety/zdr.ts';
import { recallForTurn, rememberTurn } from '../services/memory/index.ts';
import { AppError, toAppError } from '../util/errors.ts';

import type {
  ChatMessage,
  MessageRecord,
  PauseReason,
  ProviderRecord,
  ToolName,
  TokenUsage,
} from '../types/core.ts';
import type { SwitchReason } from '../providers/router.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('chat');

/** Flush partial text to SQLite at most this often while streaming. */
const PROGRESS_FLUSH_MS = 750;

export interface SendMessageInput {
  chatId: string;
  tool: ToolName;
  modelId: string;
  /** New user turn. Omitted when resuming or regenerating. */
  prompt?: string;
  /** Prepended as a system message; not persisted as history. */
  systemPrompt?: string;
  /** Force a specific provider — the manual-switch path. */
  providerId?: string;
  temperature?: number;
  maxTokens?: number;
  attachments?: { id: string; filename: string }[];
  /** Continue this paused run instead of starting a new one. */
  resumeRunId?: string;
  /**
   * The user has seen an outbound-safety finding for this exact text and asked
   * to send it anyway (Part 1.23). Deliberately per-request rather than a stored
   * preference: acknowledging one prompt must not silence the check for the next
   * one, which is a different payload the user has not looked at.
   */
  acknowledgeSensitive?: boolean;
}

export interface SendResult {
  runId: string;
  messageId: string;
  state: 'complete' | 'paused';
  content: string;
}

interface Attempt {
  provider: ProviderRecord;
  usage: TokenUsage | null;
  finishReason: string | undefined;
  emitted: boolean;
}

function mapPauseReason(code: string): PauseReason {
  switch (code) {
    case 'no_provider_for_model':
      return 'capability_mismatch';
    case 'no_healthy_provider':
    case 'no_active_provider':
    // A ZDR refusal is not a failure of any provider, but its *effect* on the run
    // is the one this reason names: nothing can serve it right now. The precise
    // cause travels in the `code` field, which is what the UI branches on — see
    // the note at the top of util/errors.ts.
    case 'zdr_requirement_unmet':
      return 'no_healthy_provider';
    case 'aborted':
      return 'user_request';
    default:
      return 'provider_failure';
  }
}

/**
 * How a router-level provider switch is reported to the run state machine.
 *
 * A `switch` with no `default`, on purpose: adding a `SwitchReason` must be a
 * compile error here rather than silently folding into `provider_failure` and
 * telling the user a provider broke when none did. Same discipline as
 * `adapterFor`.
 */
function mapSwitchReason(reason: SwitchReason): PauseReason {
  switch (reason) {
    case 'capability_mismatch':
      return 'capability_mismatch';
    case 'health_failure':
      return 'provider_failure';
    // A cooldown is a failure being respected, not a decided move: the provider
    // did fail, and the user's next question is what to fix. `provider_failure`
    // is the reason that says so.
    case 'cooldown':
      return 'provider_failure';
    // Nothing failed: the run moved because the standing policy barred the
    // provider it started with. `provider_switch` is the reason that says the
    // move was decided rather than forced.
    case 'zdr_requirement':
      return 'provider_switch';
  }
}

/**
 * Runs one exchange to completion or to a pause, streaming over `sse`.
 *
 * Callers are expected to already hold the app-wide job lock.
 */
export async function sendMessage(input: SendMessageInput, sse: SseStream): Promise<SendResult> {
  const chat = ensureChat({ id: input.chatId, tool: input.tool, modelId: input.modelId });

  // A resume reuses the existing run and its half-written assistant message,
  // so the user sees the reply continue rather than a duplicate bubble appear.
  const resuming = input.resumeRunId ? runState.requireRun(input.resumeRunId) : null;
  if (resuming && resuming.chatId !== chat.id) {
    throw new AppError('bad_request', `Run "${resuming.runId}" does not belong to chat "${chat.id}".`);
  }

  // An explicit "try again" is a request to re-evaluate from scratch. Without
  // this, a provider that failed twice is still carrying that streak, so the
  // very next failure trips the threshold immediately and the retry is judged
  // on evidence the user was deliberately setting aside. Clearing the provider
  // about to be used — the one the user picked, or the one that failed —
  // restores the full 2-failure budget for this attempt.
  if (resuming) {
    const target = input.providerId ?? resuming.providerId;
    if (target) router.clearFailureState(target);
  }

  const history = listMessages(chat.id);
  const priorAssistant = resuming?.messageId
    ? history.find((message) => message.id === resuming.messageId) ?? null
    : null;

  // Memory recall. Returns null when the plugin toggle is off, when the backend
  // is unavailable, or when nothing relevant was found, so the request shape is
  // unchanged in the common case.
  const memoryBlock = input.prompt ? await recallForTurn(input.prompt, input.tool) : null;

  const requestMessages = buildRequest(input, history, priorAssistant, memoryBlock);

  // Outbound safety (Part 1.23). Scanned here, on the assembled payload, because
  // this is the last point at which nothing has been written and nothing has been
  // sent: a refusal must leave the chat exactly as it was. The acknowledged retry
  // is the same request with one flag added, so persisting the user turn first
  // would store it once per attempt and show the prompt twice in the transcript.
  //
  // The provider is resolved from the same two sources the router consults —
  // an explicit id for a manual switch, otherwise the active provider — rather
  // than read off the result, because a check that ran after the stream could
  // only report an exposure that had already happened. A mid-run failover can
  // still land on a provider of a different class; that residual gap is recorded
  // in docs/CONTRACTS.md rather than papered over here.
  const intendedProvider = input.providerId ? findProvider(input.providerId) : getActiveProvider();
  assertOutboundSafe({
    messages: requestMessages,
    // The whole record, not just its type: a provider that declares itself local
    // is only local if that is where the request will actually go.
    provider: intendedProvider,
    ...(input.acknowledgeSensitive === true ? { acknowledged: true } : {}),
    enabled: redactionCheckEnabled(),
  });

  // Zero data retention (Part 1.26). Checked here for the same reason and at the
  // same point as the scan above: a refusal must leave the transcript exactly as
  // it was, and a block raised from inside `router.stream()` would land after the
  // user turn and the assistant placeholder are already persisted.
  //
  // This is not a duplicate of the router's filtering — it is the same question
  // asked early. The router still enforces the policy on every candidate it
  // considers, including mid-run failover targets, which is what makes `require`
  // structurally safe rather than merely checked once.
  router.assertZdrDispatchable(intendedProvider, input.modelId);

  // Read once, before anything is dispatched, so the row records the policy that
  // was actually in force for this turn even if the user changes it while the
  // reply is still streaming.
  const requirementAtStart = zdrRequirement();

  if (input.prompt !== undefined && input.prompt !== '') {
    appendMessage({
      chatId: chat.id,
      role: 'user',
      content: input.prompt,
      tool: input.tool,
      status: 'complete',
    });
    touchChat(chat.id, { modelId: input.modelId, opened: true });
  }

  const assistant: MessageRecord =
    priorAssistant ??
    appendMessage({
      chatId: chat.id,
      role: 'assistant',
      content: '',
      tool: input.tool,
      modelId: input.modelId,
      status: 'streaming',
    });

  const run = resuming
    ? runState.resumeRun(resuming.runId, { modelId: input.modelId, providerId: input.providerId ?? null })
    : runState.createRun({
        chatId: chat.id,
        tool: input.tool,
        modelId: input.modelId,
        providerId: input.providerId ?? null,
        messageId: assistant.id,
      });

  // Text already produced before the pause. Kept so a resumed reply reads as
  // one message instead of restarting from nothing.
  let content = priorAssistant?.content ?? '';

  const startedAt = Date.now();
  const contentAtStart = content;

  // A single routed attempt. The router already fails over internally within
  // this one call (emitting `switched`), so there is no outer retry pass — an
  // outer retry would re-send the whole request to a provider that may have
  // already produced output.
  let outcome: Attempt;
  try {
    outcome = await runAttempt({
      input,
      requestMessages,
      run,
      assistantId: assistant.id,
      chatId: chat.id,
      sse,
      onText: (text) => {
        content += text;
      },
      getContent: () => content,
    });
  } catch (error) {
    const app = toAppError(error);

    // Every failure lands here — an upstream error, a client hang-up, or a
    // failover with nowhere left to go. Persist whatever was produced and leave
    // the run paused so it can be resumed; history is never rewritten.
    const reason = mapPauseReason(app.code);

    // `run.providerId` is rewritten by `attachExecution` on every `provider`
    // event, so it names the provider that actually received the request — which
    // is not necessarily the one aimed at, once a failover has happened.
    const pausedOn = (run.providerId ? findProvider(run.providerId) : null) ?? intendedProvider;

    updateMessage(assistant.id, {
      content,
      status: 'paused',
      errorCode: app.code,
      errorMessage: app.message,
    });
    runState.pauseRun({ runId: run.runId, reason, code: app.code, message: app.message });

    recordUsage({
      chatId: chat.id,
      messageId: assistant.id,
      tool: input.tool,
      modelId: input.modelId,
      providerId: run.providerId,
      providerName: run.providerName,
      // Attributed to whichever provider the run last attached, falling back to
      // the one selected up front when the failure happened before any provider
      // was reached. Both fields come from that single provider on purpose: a row
      // that took `provider_type` from one provider and `zdr_status` from another
      // would describe an exposure that never occurred.
      providerType: pausedOn?.type ?? null,
      zdrStatus: pausedOn ? zdrStatusFor(pausedOn) : null,
      zdrRequirement: requirementAtStart,
      tokensIn: 0,
      tokensOut: 0,
      status: content.length > contentAtStart.length ? 'partial' : 'error',
      durationMs: Date.now() - startedAt,
    });

    sse.send({
      event: 'paused',
      data: {
        runId: run.runId,
        reason,
        code: app.code,
        message: app.message,
        retryable: app.retryable,
        partialContent: content,
      },
    });

    log.warn(`run ${run.runId} paused: ${app.code} — ${app.message}`);
    return { runId: run.runId, messageId: assistant.id, state: 'paused', content };
  }

  // Success.
  const tokensIn = outcome.usage?.tokensIn ?? 0;
  const tokensOut = outcome.usage?.tokensOut ?? 0;
  // Cache and reasoning accounting (1.28) rides along exactly as reported:
  // `undefined` when the provider said nothing, so the column stays NULL.
  const cacheReadTokens = outcome.usage?.cacheReadTokens;
  const cacheWriteTokens = outcome.usage?.cacheWriteTokens;
  const reasoningTokens = outcome.usage?.reasoningTokens;

  updateMessage(assistant.id, {
    content,
    status: 'complete',
    errorCode: null,
    errorMessage: null,
    tokensIn: outcome.usage ? tokensIn : null,
    tokensOut: outcome.usage ? tokensOut : null,
    providerId: outcome.provider.id,
    providerName: outcome.provider.name,
    modelId: input.modelId,
  });
  runState.attachExecution(run.runId, { providerId: outcome.provider.id, modelId: input.modelId });
  runState.completeRun(run.runId);
  touchChat(chat.id, { modelId: input.modelId, providerId: outcome.provider.id });

  recordUsage({
    chatId: chat.id,
    messageId: assistant.id,
    tool: input.tool,
    modelId: input.modelId,
    providerId: outcome.provider.id,
    providerName: outcome.provider.name,
    // Read off the provider that actually served the request, not the one
    // selected up front: a mid-run failover can move the turn to a provider of a
    // different egress class, and the exposure summary has to reflect where the
    // bytes went rather than where they were aimed.
    providerType: outcome.provider.type,
    zdrStatus: zdrStatusFor(outcome.provider),
    zdrRequirement: requirementAtStart,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    status: 'ok',
    durationMs: Date.now() - startedAt,
  });

  // Extraction runs only on a completed turn — never on the pause path, where
  // the reply is a fragment. Fire-and-forget: a memory write must not delay or
  // fail the response, and it no-ops when the toggle is off.
  if (input.prompt) {
    rememberTurn(input.prompt, content, { tool: input.tool, chatId: chat.id });
  }

  if (outcome.usage) {
    sse.send({
      event: 'usage',
      data: {
        tokensIn,
        tokensOut,
        // Optional on the wire, and omitted rather than zeroed: a client that
        // shows "cache 0%" for a provider that reports no cache accounting would
        // be inventing a measurement.
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
        ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        costUsd: computeCost(input.modelId, outcome.provider.id, tokensIn, tokensOut),
      },
    });
  }
  sse.send({
    event: 'done',
    data: {
      runId: run.runId,
      messageId: assistant.id,
      ...(outcome.finishReason ? { finishReason: outcome.finishReason } : {}),
    },
  });
  return { runId: run.runId, messageId: assistant.id, state: 'complete', content };
}

interface AttemptArgs {
  input: SendMessageInput;
  requestMessages: ChatMessage[];
  run: { runId: string };
  assistantId: string;
  chatId: string;
  sse: SseStream;
  onText(text: string): void;
  getContent(): string;
}

/**
 * One pass through the router.
 *
 * A `switched` event from the router means a *different* provider is taking
 * over. When that happens before any output, this is exactly the situation
 * rule 3 covers: the pause is transient and immediately followed by `resumed`,
 * so the UI can show the switch without the user having to act.
 */
async function runAttempt(args: AttemptArgs): Promise<Attempt> {
  const { input, sse, run } = args;

  let provider: ProviderRecord | null = null;
  let usage: TokenUsage | null = null;
  let finishReason: string | undefined;
  let emitted = false;
  let lastFlush = 0;
  let announced = false;
  // Set when a `switched` event pauses the run, and cleared by the `provider`
  // event for the replacement. Only a genuine pause may be `resumed`: the
  // router also re-attempts the *same* provider once to establish the
  // 2-failure threshold, and reporting that as a resume would tell the
  // frontend the pause was lifted when there was never a pause to lift.
  let pendingResume = false;

  const events = router.stream(
    {
      modelId: input.modelId,
      messages: args.requestMessages,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      signal: sse.signal,
    },
    {
      ...(input.providerId ? { providerId: input.providerId } : {}),
    },
  );

  for await (const event of events) {
    switch (event.type) {
      case 'provider': {
        provider = event.provider;
        runState.attachExecution(run.runId, { providerId: provider.id, modelId: input.modelId });
        updateMessage(args.assistantId, {
          providerId: provider.id,
          providerName: provider.name,
          modelId: input.modelId,
        });
        if (!announced) {
          announced = true;
          sse.send({
            event: 'open',
            data: {
              runId: run.runId,
              chatId: args.chatId,
              messageId: args.assistantId,
              providerId: provider.id,
              providerName: provider.name,
              modelId: input.modelId,
            },
          });
        }
        // Checked independently of `open`, NOT as its `else` branch. A
        // capability mismatch is decided during provider *selection*, so the
        // router yields `switched` before its first `provider` event — the
        // pause therefore arrives while `announced` is still false. Treating
        // resume as the alternative to `open` meant that pause was never
        // lifted and the frontend's paused banner stuck forever. Health
        // failover, which switches mid-run after `open`, was the only case
        // that worked.
        if (pendingResume) {
          // The far side of a switch: this is a different provider, and the
          // transient pause emitted alongside `switched` is now lifted.
          pendingResume = false;
          sse.send({
            event: 'resumed',
            data: {
              runId: run.runId,
              providerId: provider.id,
              providerName: provider.name,
              modelId: input.modelId,
              attempt: runState.requireRun(run.runId).attempt,
            },
          });
        }
        break;
      }

      case 'switched': {
        // Surface the interruption honestly — the old provider did fail — but
        // as a transient pause, since the `resumed` event follows immediately.
        const pauseReason = mapSwitchReason(event.reason);
        runState.pauseRun({
          runId: run.runId,
          reason: pauseReason,
          code: event.reason,
          message: event.message,
        });
        sse.send({
          event: 'paused',
          data: {
            runId: run.runId,
            reason: pauseReason,
            code: event.reason,
            message: event.message,
            retryable: true,
            partialContent: args.getContent(),
          },
        });
        if (!autoResumeAfterFailover()) {
          throw new AppError('provider_error', event.message, { retryable: true });
        }
        runState.resumeRun(run.runId, { providerId: event.to.id, modelId: input.modelId });
        pendingResume = true;
        break;
      }

      case 'token': {
        emitted = true;
        args.onText(event.text);
        sse.send({ event: 'token', data: { text: event.text } });
        // Flushing on a timer rather than per token keeps SQLite out of the
        // hot path while still bounding how much text a hard kill can lose.
        const now = Date.now();
        if (now - lastFlush >= PROGRESS_FLUSH_MS) {
          lastFlush = now;
          saveStreamProgress(args.assistantId, args.getContent());
        }
        break;
      }

      case 'usage': {
        usage = event.usage;
        break;
      }

      case 'done': {
        finishReason = event.finishReason;
        break;
      }
    }
  }

  if (!provider) {
    throw new AppError('internal_error', 'The router finished without naming a provider.');
  }
  return { provider, usage, finishReason, emitted };
}

/**
 * Assembles the provider request.
 *
 * When resuming, the half-finished assistant turn is dropped from the request
 * and replaced with an explicit continuation instruction. Sending a trailing
 * assistant message makes some gateways restart the turn and others reject the
 * request outright; an instruction works everywhere.
 */
function buildRequest(
  input: SendMessageInput,
  history: MessageRecord[],
  priorAssistant: MessageRecord | null,
  memoryBlock: string | null,
): ChatMessage[] {
  const usable = priorAssistant ? history.filter((message) => message.id !== priorAssistant.id) : history;
  const messages: ChatMessage[] = [];

  if (input.systemPrompt) {
    messages.push({ role: 'system', content: input.systemPrompt });
  }
  if (memoryBlock) {
    messages.push({ role: 'system', content: memoryBlock });
  }
  messages.push(...toProviderMessages(usable));

  // Mirrors the `content.trim().length > 0` filter in `toProviderMessages`: a
  // whitespace-only prompt is stored but never sent, and that has to stay true
  // whether the turn comes from the database or from this argument.
  if (input.prompt !== undefined && input.prompt.trim().length > 0) {
    messages.push({ role: 'user', content: input.prompt });
  }

  if (priorAssistant && priorAssistant.content.trim().length > 0) {
    messages.push({
      role: 'user',
      content:
        'Your previous reply was cut off by a provider failure. Here is what was received:\n\n' +
        `${priorAssistant.content}\n\n` +
        'Continue from exactly where it stops. Do not repeat what is above and do not restate it.',
    });
  }

  if (input.attachments && input.attachments.length > 0) {
    messages.push({
      role: 'user',
      content: `Attached files: ${input.attachments.map((file) => file.filename).join(', ')}`,
    });
  }

  return messages;
}

/**
 * Manual model/provider switch on a paused run: reconfigure, then resume.
 *
 * `sendMessage` with `resumeRunId` performs the resume, and the pause is only
 * lifted once the new provider actually starts producing output — a failed
 * switch therefore leaves the run paused, with no silent fallback.
 */
export async function switchAndResume(
  input: { runId: string; modelId?: string; providerId?: string; tool?: ToolName },
  sse: SseStream,
): Promise<SendResult> {
  const run = runState.requireRun(input.runId);
  if (run.state !== 'paused') {
    throw new AppError('run_not_paused', `Run "${input.runId}" is ${run.state}, not paused.`, {
      details: { state: run.state },
    });
  }
  const modelId = input.modelId ?? run.modelId;
  if (!modelId) {
    throw new AppError('bad_request', 'A model id is required to resume this run.');
  }
  return await sendMessage(
    {
      chatId: run.chatId,
      tool: input.tool ?? run.tool,
      modelId,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      resumeRunId: run.runId,
    },
    sse,
  );
}
