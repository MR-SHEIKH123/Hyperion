import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ParkedTask } from './ParkedTask';
import { logEntries } from './agentFrames';

import type { AgentSseEvent } from '../../api/sse/events';

const NOW = 1_700_000_000_000;

/** An approval whose arguments say exactly what would run, as the route sends them. */
const APPROVAL = {
  id: 'a1',
  toolName: 'bash',
  arguments: '{"command":"rm -rf build","cwd":"/repo"}',
  permissionKey: 'bash:rm',
  matchedLayer: 'project',
  matchedPattern: 'rm -rf',
  reason: 'The project rules deny this command.',
  createdAt: NOW - 60_000,
  expiresAt: NOW + 60_000,
};

function approvalsBody(overrides: Record<string, unknown> = {}) {
  return {
    tool: 'code',
    taskId: 't1',
    state: 'blocked',
    pauseReason: 'approval_required',
    count: 1,
    approvals: [APPROVAL],
    ...overrides,
  };
}

function stateBody(state = 'blocked', pauseReason: string | null = 'approval_required') {
  return {
    run: {
      runId: 'r2',
      taskId: 't1',
      tool: 'code',
      state,
      pauseReason,
      errorCode: null,
      errorMessage: null,
      startedAt: NOW - 300_000,
      updatedAt: NOW,
      completedAt: null,
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A continuation stream: every frame rides one `agent` event, as the route emits it. */
function agentStream(frames: Record<string, unknown>[]): Response {
  const text = frames
    .map((frame) => `event: agent\ndata: ${JSON.stringify({ tool: 'code', chatId: 'c1', ...frame })}\n\n`)
    .join('');
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
  );
}

type Call = [url: string, init: RequestInit | undefined];

/**
 * A fetch stub for the three reads and two writes this panel makes.
 *
 * Typed as `(input: string, init) => …` because the client only ever passes a path,
 * and coercing `RequestInfo | URL` to a string for a comparison is the coercion the
 * lint rules exist to stop.
 */
function stubFetch(routes: {
  approvals?: () => Response;
  state?: () => Response;
  continue?: () => Response;
  approve?: () => Response;
}) {
  const calls: Call[] = [];
  const mock = vi.fn((input: string, init: RequestInit | undefined) => {
    calls.push([input, init]);
    if (input.endsWith('/approvals')) return Promise.resolve(routes.approvals?.() ?? json(approvalsBody()));
    if (input.endsWith('/continue')) {
      if (routes.continue === undefined) throw new Error(`unexpected call: ${input}`);
      return Promise.resolve(routes.continue());
    }
    if (input.endsWith('/approve')) {
      if (routes.approve === undefined) throw new Error(`unexpected call: ${input}`);
      return Promise.resolve(routes.approve());
    }
    if (input.endsWith('/state')) return Promise.resolve(routes.state?.() ?? json(stateBody('running', null)));
    throw new Error(`unexpected call: ${input}`);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

function callsTo(calls: Call[], suffix: string): Call[] {
  return calls.filter(([url]) => url.endsWith(suffix));
}

function bodiesTo(calls: Call[], suffix: string): Record<string, unknown>[] {
  return callsTo(calls, suffix).map(([, init]) => {
    const body = init?.body;
    if (typeof body !== 'string') throw new Error(`${suffix} was called without a string body`);
    return JSON.parse(body) as Record<string, unknown>;
  });
}

function renderPanel(props: Partial<Parameters<typeof ParkedTask>[0]> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ParkedTask tool="code" taskId="t1" state="blocked" pauseReason="approval_required" {...props} />
    </QueryClientProvider>,
  );
  return queryClient;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the parked-task panel', () => {
  it('shows the held call and keeps its arguments verbatim behind a deliberate reveal', async () => {
    stubFetch({});
    renderPanel();

    expect(await screen.findByText('bash')).toBeInTheDocument();
    // The arguments are not rendered as a preview: the whole point is that a
    // person sees the call they are authorising, in the form it will run.
    expect(screen.queryByText(APPROVAL.arguments)).toBeNull();
    expect(screen.getByText(/The call is hidden/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show the call' }));
    expect(screen.getByText(APPROVAL.arguments)).toBeInTheDocument();
    expect(screen.getByText(/refused by the project layer, matching rm -rf/)).toBeInTheDocument();
  });

  it('allows once and continues in one call, then reports the frames the run sent', async () => {
    const { calls } = stubFetch({
      continue: () =>
        agentStream([
          { channel: 'started', tool: 'code', mode: 'act', dir: '/repo', continued: true },
          { channel: 'result', ok: true, summary: 'removed the build directory' },
        ]),
      state: () => json(stateBody('complete', null)),
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Allow once and continue' }));

    await waitFor(() => {
      expect(bodiesTo(calls, '/continue')).toEqual([{ approvalId: 'a1', decision: 'allow_once' }]);
    });
    // The decision goes to `/continue`, not to `/approve`: recording a decision and
    // leaving the task parked is the state this panel exists to end.
    expect(callsTo(calls, '/approve')).toHaveLength(0);

    expect(await screen.findByText(/started code in act at \/repo \(continuing the parked run\)/)).toBeInTheDocument();
    expect(screen.getByText('finished: removed the build directory')).toBeInTheDocument();
    expect(screen.getByText(/records r2 as complete/)).toBeInTheDocument();
  });

  it('denies through /approve and never opens a continuation stream', async () => {
    const { calls } = stubFetch({
      approve: () => json({ tool: 'code', taskId: 't1', approvalId: 'a1', state: 'deny', applied: true, continuable: false }),
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Deny and stop the run' }));

    await waitFor(() => {
      expect(bodiesTo(calls, '/approve')).toEqual([{ approvalId: 'a1', decision: 'deny' }]);
    });
    // A denial finishes the run server-side, so there is nothing to continue — a
    // client that streamed anyway would be displaying a run that does not exist.
    expect(callsTo(calls, '/continue')).toHaveLength(0);
    // The sentence names the state the run reached, which is the fact that makes
    // "there is nothing left to continue" true rather than a guess.
    expect(await screen.findByText(/Denied, and the run was finished as/)).toBeInTheDocument();
    expect(screen.getByText('stopped')).toBeInTheDocument();
  });

  it('refuses a bare continue while a prompt is outstanding instead of posting it', async () => {
    const { calls } = stubFetch({});
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Continue this task' }));

    expect(await screen.findByText(/The held call needs your decision first/)).toBeInTheDocument();
    expect(callsTo(calls, '/continue')).toHaveLength(0);
  });

  it('continues with no decision when nothing is pending', async () => {
    const { calls } = stubFetch({
      approvals: () => json(approvalsBody({ count: 0, approvals: [] })),
      continue: () => agentStream([{ channel: 'result', ok: true, summary: 'nothing left to do' }]),
      state: () => json(stateBody('complete', null)),
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Continue this task' }));

    await waitFor(() => {
      expect(bodiesTo(calls, '/continue')).toEqual([{}]);
    });
    expect(await screen.findByText('finished: nothing left to do')).toBeInTheDocument();
  });

  it('says which refusal happened when another window got there first', async () => {
    stubFetch({
      continue: () =>
        json(
          {
            error: {
              code: 'conflict',
              message: 'This task is already being continued.',
              retryable: false,
              details: { taskId: 't1', runId: 'r1', state: 'running', reason: 'already_claimed' },
            },
          },
          409,
        ),
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Allow once and continue' }));

    expect(
      await screen.findByText(/already being continued — another window or an earlier click got there first/),
    ).toBeInTheDocument();
  });

  it('re-reads the run when the stream ends without a result, and says what it found', async () => {
    stubFetch({
      // A stream that closes after the park frame: no `result` ever arrives, which is
      // precisely the case a client must not treat as "finished".
      continue: () =>
        agentStream([{ channel: 'task_parked', state: 'blocked', reason: 'approval_required', detail: 'bash needs approval' }]),
      state: () => json(stateBody('blocked', 'approval_required')),
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Allow once and continue' }));

    expect(await screen.findByText(/parked as blocked \(approval_required\) — bash needs approval/)).toBeInTheDocument();
    expect(
      await screen.findByText(/The stream ended \(socket-closed\) without a result, so the run was re-read: r2 is blocked, parked on approval required\./),
    ).toBeInTheDocument();
  });
});

describe('the continuation log', () => {
  const agent = (data: Record<string, unknown>): AgentSseEvent => ({
    type: 'agent',
    data: { tool: 'code', chatId: 'c1', ...data } as AgentSseEvent['data'],
  }) as AgentSseEvent;

  it('joins streamed text into one line and keeps every other frame', () => {
    const entries = logEntries([
      agent({ channel: 'partial', text: 'Hel' }),
      agent({ channel: 'partial', text: 'lo ' }),
      agent({ channel: 'partial', text: 'there' }),
      agent({ channel: 'stopped', reason: 'cancelled' }),
    ]);

    expect(entries).toEqual([
      { channel: 'partial', text: 'Hello there' },
      { channel: 'stopped', text: 'stopped: cancelled' },
    ]);
  });

  it('renders the channel name for a frame whose payload says nothing it recognises', () => {
    // The decoder accepts any payload with a known channel, so a channel whose fields
    // drifted must still be visible as itself rather than as an empty line.
    expect(logEntries([agent({ channel: 'subagent_started' })])).toEqual([
      { channel: 'subagent_started', text: 'subagent ? started' },
    ]);
    expect(logEntries([agent({ channel: 'task_parked' })])).toEqual([{ channel: 'task_parked', text: 'parked' }]);
  });

  it('renders an error frame with its code and message', () => {
    // The shape `sendError` puts on the wire (docs/API.md §1.23) — the run's error,
    // not the HTTP envelope. `api/sse/events.test.ts` decodes this exact payload.
    const event = {
      type: 'error',
      data: { runId: null, code: 'provider_unavailable', message: 'no provider could be reached', retryable: true },
    } as unknown as AgentSseEvent;

    expect(logEntries([event])).toEqual([
      { channel: 'error', text: 'error: provider_unavailable — no provider could be reached' },
    ]);
  });
});
