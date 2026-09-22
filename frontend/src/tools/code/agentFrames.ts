import type { AgentSseEvent } from '../../api/sse/events';
import type { RunReconciliation } from '../../api/agentStream';
import type { StreamEnd } from '../../api/sse/session';

/**
 * Rendering the agent protocol's frames, once, for every surface that shows them.
 *
 * Both Code surfaces that watch a run — continuing a parked task and starting a new
 * one — read the same stream and must describe it the same way. Keeping this here
 * rather than in either panel is the same argument as `runStreamSession`: two copies
 * of "what does `task_parked` say" would drift, and the copy that drifted would be
 * the one nobody was looking at.
 *
 * Nothing here invents a summary. Every line names fields the channel is
 * *documented* to carry (the emitters in `services/agent/loop.ts`,
 * `orchestrator/agentContext.ts` and `services/code/agent.ts`), and a channel whose
 * payload carries none of them renders as its own name — an unfamiliar payload is a
 * fact about the wire, not something to smooth over.
 */

export interface LogEntry {
  channel: string;
  text: string;
}

/** The tail kept for a streamed-text entry, so one long answer cannot fill the log. */
export const TEXT_TAIL = 600;

/**
 * Frames to log lines, with consecutive `partial` chunks joined.
 *
 * The joining is a rendering choice, not a summary: `partial` carries the model's
 * streamed text one chunk at a time, and one line per chunk is a wall of fragments.
 * Nothing is dropped by it — a long stream is shown by its tail, and the elision is
 * marked when it happens.
 */
export function logEntries(events: AgentSseEvent[]): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const event of events) {
    const channel = event.type === 'agent' ? event.data.channel : event.type;
    const chunk =
      event.type === 'agent' && event.data.channel === 'partial' ? stringField(event.data, 'text') : null;
    if (chunk !== null) {
      const previous = entries.at(-1);
      if (previous !== undefined && previous.channel === 'partial') {
        const joined = previous.text + chunk;
        previous.text = joined.length > TEXT_TAIL ? `…${joined.slice(-TEXT_TAIL)}` : joined;
        continue;
      }
      entries.push({ channel: 'partial', text: chunk.length > TEXT_TAIL ? `…${chunk.slice(-TEXT_TAIL)}` : chunk });
      continue;
    }
    entries.push({ channel, text: describe(event) });
  }
  return entries;
}

/** A field that is a non-empty string, or `null` if it is anything else. */
function stringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberField(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  return typeof value === 'number' ? value : null;
}

/**
 * One line per frame.
 *
 * Each channel's line names the fields that channel is documented to carry, and
 * falls back to the channel name alone when a payload does not carry them.
 */
export function describe(event: AgentSseEvent): string {
  // The run's error shape, as `sendError` writes it — not the HTTP envelope.
  if (event.type === 'error') return `error: ${event.data.code} — ${event.data.message}`;
  const data = event.data as Record<string, unknown>;
  const text = (key: string): string | null => stringField(data, key);
  const after = (key: string, separator = ': '): string => (text(key) === null ? '' : `${separator}${text(key) ?? ''}`);
  switch (event.data.channel) {
    case 'started':
      return `started ${text('tool') ?? event.data.tool}${after('mode', ' in ')}${after('dir', ' at ')}${data.continued === true ? ' (continuing the parked run)' : ''}`;
    case 'task_parked': {
      const reason = text('reason');
      return `parked${after('state', ' as ')}${reason === null ? '' : ` (${reason})`}${after('detail', ' — ')}`;
    }
    case 'approval_required': {
      const reason = text('reason');
      return `decision needed on ${text('toolName') ?? 'a call'}${reason === null ? '' : ` (${reason})`}`;
    }
    case 'provider':
      return `provider → ${text('providerName') ?? text('providerId') ?? 'unknown'}${after('modelId', '/')}${after('attempt', ' attempt ')}`;
    case 'switched':
      return `switched ${text('from') ?? '?'} → ${text('to') ?? '?'}${after('reason', ' — ')}${after('message', ': ')}`;
    case 'ceiling_reached': {
      const kind = text('kind');
      return `stopped at a ceiling${kind === null ? '' : ` (${kind})`}${after('detail', ' — ')}`;
    }
    case 'context_compacted':
      return `context compacted: ${numberField(data, 'tokensBefore') ?? '?'} → ${numberField(data, 'tokensAfter') ?? '?'} tokens, ${numberField(data, 'droppedMessages') ?? '?'} messages dropped`;
    case 'subagent_started': {
      const sequence = numberField(data, 'sequence');
      return `subagent ${text('childTaskId') ?? '?'} started${sequence === null ? '' : ` (#${sequence})`}`;
    }
    case 'subagent_finished':
      return `subagent ${text('childTaskId') ?? '?'} finished${data.ok === true ? '' : data.ok === false ? ' — failed' : ''}`;
    case 'artifact': {
      const version = numberField(data, 'version');
      const format = text('format');
      return `artifact ${text('artifactKey') ?? '?'}${version === null ? '' : ` v${version}`}${format === null ? '' : ` (${format})`}`;
    }
    case 'stopped':
      return `stopped${after('reason', ': ')}`;
    case 'result':
      if (data.ok === false) {
        // `TaskResult.error` is `{code, message}`; read as a string and never
        // stringified blindly, because a shape that is not a string here would
        // otherwise render as "[object Object]" in the failure line.
        const failure = data.error;
        const message =
          typeof failure === 'object' && failure !== null && 'message' in failure
            ? (failure as { message?: unknown }).message
            : null;
        return `failed: ${
          typeof message === 'string' && message.length > 0 ? message : (text('summary') ?? 'no reason was recorded')
        }`;
      }
      return `finished: ${text('summary') ?? 'no summary was recorded'}${
        Array.isArray(data.changedFiles) && data.changedFiles.length > 0 ? ` (${data.changedFiles.length} files changed)` : ''
      }`;
    case 'partial':
      return 'partial text';
    default:
      return event.data.channel;
  }
}

/**
 * How the stream ended, in the terms the facts support.
 *
 * The distinction that matters: a `result` frame is an outcome and a closed socket is
 * not. The agent protocol carries every frame inside one `agent` event, so the
 * session's terminal-event check cannot see a result and reconciles instead — and the
 * reconciliation is what gets reported, including when it disagrees with what is
 * already on screen.
 */
export function endSentence(
  end: StreamEnd | null,
  reconciliation: RunReconciliation | null,
  events: AgentSseEvent[],
): string {
  const sawResult = events.some((event) => event.type === 'agent' && event.data.channel === 'result');
  if (end === 'cancelled') {
    return 'You stopped watching, so the run was re-read from the server rather than assumed from the last frame.';
  }
  if (sawResult) {
    return reconciliation === null
      ? 'The run finished and reported a result.'
      : `The run reported a result, and the server records ${reconciliation.runId} as ${reconciliation.state}.`;
  }
  if (reconciliation !== null) {
    const parked =
      reconciliation.pauseReason === null ? '' : `, parked on ${reconciliation.pauseReason.replaceAll('_', ' ')}`;
    return `The stream ended (${end ?? 'with no terminal frame'}) without a result, so the run was re-read: ${reconciliation.runId} is ${reconciliation.state}${parked}.`;
  }
  return `The stream ended (${end ?? 'with no terminal frame'}).`;
}
