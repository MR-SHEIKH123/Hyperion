import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { getTaskApprovals, taskApprovalPath } from '../../api/tasks';
import { decideApproval } from '../../api/attention';
import { Button } from '../../design-system/components/Button/Button';
import { ErrorNotice } from '../../components/ErrorNotice/ErrorNotice';
import { relativeTime } from '../../attention/links';
import { messageFor, useTaskContinuation } from './useTaskContinuation';
import styles from './ParkedTask.module.css';

import type { AgentSseEvent } from '../../api/sse/events';
import type { ContinueReconciliation } from '../../api/agentStream';
import type { StreamEnd } from '../../api/sse/session';
import type { TaskApproval } from '../../contracts/wire/tasks';

/**
 * The one place a parked task becomes a running task again — the frontend half of
 * `POST /api/{tool}/tasks/:taskId/continue` (docs/API.md §12.6).
 *
 * **Why this had to exist.** The Attention Center can answer a prompt
 * (`POST /approve`), and it says, correctly, that answering does **not** resume the
 * run — the task surface is where that happens. But nothing in the frontend had ever
 * posted `/continue`. The `tasks.continue` contract was `implemented` about the route
 * and, until the client-half rule landed, said nothing about whether any client
 * called it. None did, so an approved task could never resume from the UI, and the
 * queue's own sentence ("open it to resume" / "continue it from the task") pointed at
 * a screen that had no such button. This panel is the caller. It lives on the task
 * surface rather than in the queue for a reason the contract already gives: a
 * standing `allow_session` is a decision about a *rule*, and it needs the call, the
 * layer that refused it and the arguments in front of the person making it.
 *
 * **Three verbs, three different promises — stated separately because they are.**
 *
 *   - *Allow once* / *Allow for this session* post the decision **and** the
 *     continuation in one call, because they are one act: a decision recorded with
 *     no run to carry it out is exactly the dead end the queue's `continuable` flag
 *     describes. The route applies the decision first and claims the run after, so a
 *     refusal in between (another window continuing it, a full lane) leaves the
 *     decision recorded — and a bare *Continue* then finishes the job. Each refusal
 *     is worded to say which of those happened.
 *   - *Continue this task* starts the run with no decision: the stored conversation
 *     is replayed, the gated call is re-emitted, and the user is asked again with
 *     fresh arguments. That is the way back from an expired prompt, and the only
 *     thing available while a prompt is unanswered — so with one outstanding, the
 *     bare continue is refused here, in words, rather than posted to be 409'd.
 *   - *Deny* is **not** a continuation and does not go to `/continue`: the server
 *     finalises the run (`stopped`, `pauseReason` `approval_denied`, or
 *     `loop_detected` for a declined doom loop) and there is nothing left to drive.
 *     It posts to `/approve`, which is idempotent, so answering twice cannot turn
 *     "I said no" into an error.
 *
 * **Narration comes from the wire, not from composition.** Frames are listed by
 * channel with the strings the server actually sent; consecutive streamed text is
 * joined, because a token-per-line log is unreadable and joining chunks is what a
 * token stream *is*, not a summary of it. Frames the decoder rejects are listed with
 * their channel and validator complaint, because an unknown channel is a fact about
 * the protocol and hiding it would make a broken stream look like a quiet run. The
 * end of the stream is reported with its own reason, and when the session
 * reconciled, the persisted run is what is reported — including when it disagrees
 * with the frames on screen, since the stream was only ever a view of the run.
 */
export function ParkedTask({
  tool,
  taskId,
  state,
  pauseReason,
}: {
  tool: 'code' | 'cowork' | 'design';
  taskId: string;
  /** The persisted run state. This panel is rendered for `blocked` and `ready_for_review`. */
  state: string;
  pauseReason: string | null;
}) {
  const client = useQueryClient();
  const { state: continuation, start, detach, dismiss } = useTaskContinuation(tool, taskId);
  const [refusedBareContinue, setRefusedBareContinue] = useState(false);
  const [viewed, setViewed] = useState<string | null>(null);

  const approvals = useQuery({
    queryKey: ['task-approvals', tool, taskId],
    queryFn: ({ signal }) => getTaskApprovals(tool, taskId, signal),
    retry: false,
    refetchInterval: continuation.phase === 'streaming' ? 5_000 : false,
  });

  const deny = useMutation({
    mutationFn: (approvalId: string) =>
      decideApproval(taskApprovalPath(tool, taskId), { approvalId, decision: 'deny' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['task-approvals', tool, taskId] });
      void client.invalidateQueries({ queryKey: ['attention'] });
      void client.invalidateQueries({ queryKey: ['code', 'task', taskId] });
      void client.invalidateQueries({ queryKey: ['code', 'lane'] });
    },
  });

  const busy = continuation.phase === 'streaming';
  const waiting = approvals.data?.approvals ?? [];
  const parked = state === 'blocked' || state === 'ready_for_review';

  return (
    <section className={styles.panel} aria-label="Parked task">
      <h3 className={styles.heading}>{busy ? 'Continuing this task' : 'This task is parked'}</h3>
      <p className={styles.plain}>{reasonSentence(pauseReason)}</p>

      {approvals.isPending ? <p className={styles.pending}>Reading what it is waiting on…</p> : null}
      {approvals.isError ? <ErrorNotice onRetry={() => void approvals.refetch()} /> : null}

      {approvals.data !== undefined && waiting.length === 0 && !busy ? (
        <p className={styles.pending}>
          No decision is pending. Continuing replays the stored conversation and asks again if a call needs one.
        </p>
      ) : null}

      {waiting.length > 0 ? (
        <>
          <h4 className={styles.subheading}>
            {waiting.length === 1 ? 'Waiting on your decision' : `Waiting on ${waiting.length} decisions`}
          </h4>
          <ul className={styles.approvals}>
            {waiting.map((approval) => (
              <ApprovalItem
                key={approval.id}
                approval={approval}
                expanded={viewed === approval.id}
                onToggle={() => setViewed(viewed === approval.id ? null : approval.id)}
                onAllow={(decision) => {
                  setRefusedBareContinue(false);
                  start({ approvalId: approval.id, decision });
                }}
                onDeny={() => deny.mutate(approval.id)}
                disabled={busy || deny.isPending}
              />
            ))}
          </ul>
        </>
      ) : null}

      {parked ? (
        <div className={styles.buttons}>
          <Button
            variant="primary"
            disabled={busy || deny.isPending}
            onClick={() => {
              if (waiting.length > 0) {
                // An unanswered prompt is not something a bare continue can step
                // over: the route replays the conversation, re-emits the gated call
                // and parks again. Saying so beats a round trip that ends in 409.
                setRefusedBareContinue(true);
                return;
              }
              setRefusedBareContinue(false);
              start();
            }}
          >
            {busy ? 'Continuing…' : 'Continue this task'}
          </Button>
          {busy ? (
            <Button variant="quiet" onClick={detach}>
              Stop watching
            </Button>
          ) : continuation.phase === 'ended' ? (
            <Button variant="quiet" onClick={dismiss}>
              Hide the log
            </Button>
          ) : null}
        </div>
      ) : null}

      {refusedBareContinue ? (
        <p className={styles.warning}>
          The held call needs your decision first. Answering it above starts the continuation with your answer —
          continuing without one would only park on the same call again.
        </p>
      ) : null}

      {busy ? (
        <p className={styles.meta}>
          Stopping here drops this stream, which stops a queued continuation from ever starting and leaves a running
          one to notice the disconnect. To stop the work itself, use the task&rsquo;s cancel.
        </p>
      ) : null}

      {deny.data?.applied === true ? (
        <p className={styles.warning}>
          Denied, and the run was finished as <code>stopped</code>. There is nothing left to continue — starting this
          task again begins a new run, and the denied call is on record with it.
        </p>
      ) : null}
      {deny.data?.applied === false ? (
        <p className={styles.warning}>
          That prompt was already resolved as <code>{deny.data.state}</code>, so this denial changed nothing.
        </p>
      ) : null}
      {deny.isError ? <p className={styles.failure}>{messageFor(deny.error)}</p> : null}
      {continuation.error !== null ? <p className={styles.failure}>{continuation.error}</p> : null}

      {continuation.events.length > 0 || continuation.invalid.length > 0 ? (
        <>
          <h4 className={styles.subheading}>What the run reported</h4>
          <ul className={styles.frames}>
            {logEntries(continuation.events).map((entry, index) => (
              <li key={index} className={styles.frame} data-channel={entry.channel}>
                {entry.text}
              </li>
            ))}
            {continuation.invalid.map((frame, index) => (
              <li key={`invalid-${index}`} className={styles.frame} data-channel="unknown">
                {frame.eventName}: {frame.reason}
              </li>
            ))}
          </ul>
          <p className={styles.end}>
            {endSentence(continuation.end, continuation.reconciliation, continuation.events)}
          </p>
        </>
      ) : null}
    </section>
  );
}

/**
 * The reason, in the words the action deserves.
 *
 * `parkMessages.ts` owns this translation on the server, and this is deliberately a
 * second, smaller map: the verbs available here are different from the queue's — that
 * screen resolves a decision, this one continues a run — and `zdr_blocked` in
 * particular must not read as something a person can clear by clicking.
 */
function reasonSentence(pauseReason: string | null): string {
  switch (pauseReason) {
    case 'approval_required':
      return 'A tool call was held for your decision. Nothing runs until you answer it, and allowing it resumes the task in the same act.';
    case 'doom_loop':
      return 'The task repeated the same call with identical arguments. Answering it continues from there; denying it ends the run as a declined loop.';
    case 'plan_ready':
      return 'A plan is ready for review. Continuing starts the work from it.';
    case 'iteration_ceiling':
      return 'The run reached its iteration ceiling. Continuing gives it another run with the same conversation.';
    case 'context_exhausted':
      return 'The run ran out of context window. Continuing replays what it kept, so the work resumes rather than starts over.';
    case 'zdr_blocked':
      return 'The run stopped because no provider satisfies the zero-data-retention requirement. There is nothing to approve: the block lifts when a provider or the requirement changes, not by clicking.';
    case 'redaction_blocked':
      return 'The run stopped on content the redaction rules withheld. Continuing is a decision about that content, so read what was flagged before you continue.';
    case 'loop_detected':
      return 'A repeated call was detected and the run stopped there rather than looping on. The reason stays recorded on the run that stopped.';
    case null:
      return 'The run stopped at a point it can continue from, and nothing is running now.';
    default:
      return `The run parked because of ${pauseReason.replaceAll('_', ' ')}.`;
  }
}

function ApprovalItem({
  approval,
  expanded,
  onToggle,
  onAllow,
  onDeny,
  disabled,
}: {
  approval: TaskApproval;
  expanded: boolean;
  onToggle: () => void;
  onAllow: (decision: 'allow_once' | 'allow_session') => void;
  onDeny: () => void;
  disabled: boolean;
}) {
  return (
    <li className={styles.approval}>
      <div className={styles.approvalHead}>
        <span className={styles.toolName}>{approval.toolName}</span>
        <span className={styles.meta}>
          held {relativeTime(approval.createdAt, Date.now())} · answerable {relativeTime(approval.expiresAt, Date.now())}
        </span>
      </div>
      {approval.reason !== null ? <p className={styles.meta}>{approval.reason}</p> : null}
      {approval.matchedLayer !== null ? (
        <p className={styles.meta}>
          refused by the {approval.matchedLayer} layer
          {approval.matchedPattern === null ? '' : `, matching ${approval.matchedPattern}`}
        </p>
      ) : null}
      {expanded ? (
        <pre className={styles.arguments}>{approval.arguments}</pre>
      ) : (
        // Deliberately not a one-line preview: a truncated shell command is exactly
        // the part that would lie about what is being authorised.
        <p className={styles.meta}>
          The call is hidden. Show it before deciding — these arguments are what will run.
        </p>
      )}
      <div className={styles.decisions}>
        <Button variant="quiet" onClick={onToggle}>
          {expanded ? 'Hide the call' : 'Show the call'}
        </Button>
        <Button variant="primary" disabled={disabled} onClick={() => onAllow('allow_once')}>
          Allow once and continue
        </Button>
        <Button variant="quiet" disabled={disabled} onClick={() => onAllow('allow_session')}>
          Allow for this session
        </Button>
        <Button disabled={disabled} onClick={onDeny}>
          Deny and stop the run
        </Button>
      </div>
    </li>
  );
}

interface LogEntry {
  channel: string;
  text: string;
}

/** The tail kept for a streamed-text entry, so one long answer cannot fill the log. */
const TEXT_TAIL = 600;

/**
 * Frames to log lines, with consecutive `partial` chunks joined.
 *
 * The joining is a rendering choice, not a summary: `partial` carries the model's
 * streamed text one chunk at a time (§12.6), and one line per chunk is a wall of
 * fragments. Nothing is dropped by it — a long stream is shown by its tail, and the
 * elision is marked when it happens.
 */
export function logEntries(events: AgentSseEvent[]): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const event of events) {
    const channel = event.type === 'agent' ? event.data.channel : event.type;
    const chunk = event.type === 'agent' && event.data.channel === 'partial' ? stringField(event.data, 'text') : null;
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
 * Each channel's line names the fields that channel is *documented* to carry (§12.6
 * and the emitters in `services/agent/loop.ts`, `orchestrator/agentContext.ts`), and
 * falls back to the channel name alone when a payload does not carry them. It never
 * invents a summary: a channel this version does not know appears as its own name
 * rather than as "working…".
 */
function describe(event: AgentSseEvent): string {
  if (event.type === 'error') return `error: ${event.data.error.code} — ${event.data.error.message}`;
  const data = event.data as Record<string, unknown>;
  const text = (key: string): string | null => stringField(data, key);
  const after = (key: string, separator = ': '): string => (text(key) === null ? '' : `${separator}${text(key) ?? ''}`);
  switch (event.data.channel) {
    case 'started':
      return `started ${text('tool') ?? event.data.tool}${after('mode', ' in ')}${after('dir', ' at ')}${data.continued === true ? ' (continuing the parked run)' : ''}`;
    case 'task_parked':
      return `parked${after('state', ' as ')}${after('reason', ' (')}${text('reason') === null ? '' : ')'}${after('detail', ' — ')}`;
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
    case 'subagent_started':
      return `subagent ${text('childTaskId') ?? '?'} started${(() => { const sequence = numberField(data, 'sequence'); return sequence === null ? '' : ` (#${sequence})`; })()}`;
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
function endSentence(
  end: StreamEnd | null,
  reconciliation: ContinueReconciliation | null,
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
