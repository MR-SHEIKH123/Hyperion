import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CodeTool from './CodeTool';

/**
 * The Code surface's start control, end to end through the API client.
 *
 * `CodeTool` is rendered rather than `StartTask` alone because the point of this
 * increment is a property of the *surface*: the composer starts a run and the progress
 * region shows that run's frames, from one hook instance. A test of the form alone
 * could not tell whether the two are the same run.
 */

const NOW = 1_700_000_000_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const RUNNING_LANE = { running: 0, limit: 2, queued: 0, active: [] };

const STATE_RUNNING = {
  run: {
    runId: 'r9',
    taskId: 'task-1',
    tool: 'code',
    state: 'running',
    pauseReason: null,
    errorCode: null,
    errorMessage: null,
    startedAt: NOW,
    updatedAt: NOW,
    completedAt: null,
  },
};

const STATE_COMPLETE = { ...STATE_RUNNING, run: { ...STATE_RUNNING.run, state: 'complete', completedAt: NOW } };

const MODELS = { providerId: 'p1', providerName: 'Local', models: [{ id: 'm1', label: 'Model One' }] };

const ACTIVE = {
  provider: { id: 'p1', name: 'Local', type: 'local', baseUrl: 'http://127.0.0.1:11434/v1' },
  egress: 'local',
  redactionCheckEnabled: false,
  egressProxy: null,
  zdr: { status: 'local_no_egress', requirement: 'off' },
};

/** A run's stream: every frame rides one `agent` event, as the route emits it. */
function agentStream(frames: Record<string, unknown>[]): Response {
  const text = frames
    .map((frame) => `event: agent\ndata: ${JSON.stringify({ tool: 'code', chatId: 'code_task-1', ...frame })}\n\n`)
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

function stubFetch(routes: {
  models?: () => Response;
  active?: () => Response;
  runTask?: (init: RequestInit | undefined) => Response;
  state?: () => Response;
}) {
  const calls: Call[] = [];
  const mock = vi.fn((input: string, init: RequestInit | undefined) => {
    calls.push([input, init]);
    if (input.endsWith('/providers/active/models')) {
      return Promise.resolve(routes.models?.() ?? json(MODELS));
    }
    if (input.endsWith('/providers/active')) return Promise.resolve(routes.active?.() ?? json(ACTIVE));
    if (input.endsWith('/code/run-task')) {
      if (routes.runTask === undefined) throw new Error('unexpected run-task call');
      return Promise.resolve(routes.runTask(init));
    }
    if (input.endsWith('/state')) return Promise.resolve(routes.state?.() ?? json(STATE_COMPLETE));
    if (input.endsWith('/code/tasks')) return Promise.resolve(json(RUNNING_LANE));
    throw new Error(`unexpected call: ${input}`);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

function bodyOf(call: Call): Record<string, unknown> {
  const body = call[1]?.body;
  if (typeof body !== 'string') throw new Error('expected a string body');
  return JSON.parse(body) as Record<string, unknown>;
}

function renderSurface(path = '/code') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/code" element={<CodeTool />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('starting a Code task from the surface', () => {
  it('posts the task, follows it into ?task=, and streams its frames into the progress region', async () => {
    const { calls } = stubFetch({
      runTask: () =>
        agentStream([
          { channel: 'started', taskId: 'task-1', mode: 'worktree', dir: '/worktrees/task-1', reason: null },
          { channel: 'result', ok: true, summary: 'renamed the module', changedFiles: ['src/a.ts'] },
        ]),
      state: () => json(STATE_COMPLETE),
    });
    renderSurface();

    const instruction = await screen.findByLabelText('Instruction');
    await userEvent.type(instruction, 'Rename the module');
    const taskIdField = screen.getByLabelText('Task id');
    const taskId = (taskIdField as HTMLInputElement).value;

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Start task' }));

    const runCall = calls.find(([url]) => url.endsWith('/code/run-task'));
    expect(runCall).toBeDefined();
    expect(bodyOf(runCall as Call)).toEqual({
      taskId,
      // The surface's own handle, exactly as the scheduler names an unattended run:
      // a correlation id the run row stores as NULL, because no such chat exists.
      chatId: `code_${taskId}`,
      modelId: 'm1',
      prompt: 'Rename the module',
      mode: 'act',
    });

    // The frames land in the progress region, and the surface follows the run it
    // started rather than leaving the user to find it: `?task=` is set, which the
    // state read for that task id is the observable consequence of.
    expect(await screen.findByText(/started code in worktree at \/worktrees\/task-1/)).toBeInTheDocument();
    expect(screen.getByText('finished: renamed the module (1 files changed)')).toBeInTheDocument();
    await waitFor(() => {
      expect(calls.some(([url]) => url.endsWith(`/api/code/tasks/${taskId}/state`))).toBe(true);
    });
  });

  // The route's own rule (`safeTaskId`), including the two conditions the first
  // version of the client's pattern missed: a leading dot or dash, and `..` anywhere.
  // A client that were looser would send these, and the user would learn about it from
  // a 400 after pressing Start.
  it.each(['not a task id', '-leading-dash', '.leading-dot', 'a..b', 'x'.repeat(101)])(
    'refuses the task id %j the route would reject, without posting anything',
    async (taskId) => {
      const { calls } = stubFetch({});
      renderSurface();

      await userEvent.type(await screen.findByLabelText('Instruction'), 'do something');
      const field = screen.getByLabelText('Task id');
      await userEvent.clear(field);
      // `type` would be a keystroke per character for the 101-character case; the
      // field is controlled, so one change event is the same input.
      await userEvent.click(field);
      await userEvent.paste(taskId);

      expect(await screen.findByText(/start with a letter or digit/)).toBeInTheDocument();
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
      expect(calls.filter(([url]) => url.endsWith('/run-task'))).toHaveLength(0);
    },
  );

  it('reports a full lane with the lane’s own numbers', async () => {
    stubFetch({
      runTask: () =>
        json(
          {
            error: {
              code: 'busy',
              message: 'The Code lane is full.',
              retryable: true,
              details: { running: 2, limit: 2, queued: 0 },
            },
          },
          409,
        ),
    });
    renderSurface();

    await userEvent.type(await screen.findByLabelText('Instruction'), 'refactor the parser');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Start task' }));

    expect(await screen.findByText(/The Code lane is full \(2 of 2 slots in use\)/)).toBeInTheDocument();
  });

  it('says there is nothing to run on when no provider offers a model', async () => {
    stubFetch({ models: () => json({ providerId: '', providerName: '', models: [] }) });
    renderSurface();

    await userEvent.type(await screen.findByLabelText('Instruction'), 'anything');
    expect(await screen.findByText(/No active provider offers a model/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
  });

  it('names a missing provider rather than a broken model list', async () => {
    // What an install with no providers actually answers: 404 `no_active_provider`
    // for the model list, and a null provider on the active read.
    stubFetch({
      models: () =>
        json({ error: { code: 'no_active_provider', message: 'No provider is enabled.', retryable: false } }, 404),
      active: () => json({ provider: null, egress: 'local', redactionCheckEnabled: false, egressProxy: null, zdr: { status: null, requirement: 'off' } }),
    });
    renderSurface();

    expect(await screen.findByText(/No provider is enabled, so there is nothing to run on/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
  });

  it('re-reads the run when the stream closes without a result, and says what it found', async () => {
    stubFetch({
      // A stream that ends after the park frame: a task that stopped to ask a
      // question must not read as one that finished.
      runTask: () =>
        agentStream([
          { channel: 'task_parked', state: 'blocked', reason: 'approval_required', detail: 'bash needs approval' },
        ]),
      state: () => json({ ...STATE_RUNNING, run: { ...STATE_RUNNING.run, state: 'blocked', pauseReason: 'approval_required' } }),
    });
    renderSurface();

    await userEvent.type(await screen.findByLabelText('Instruction'), 'delete the build directory');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Start task' }));

    expect(await screen.findByText(/parked as blocked \(approval_required\)/)).toBeInTheDocument();
    expect(
      await screen.findByText(/The stream ended \(socket-closed\) without a result, so the run was re-read: r9 is blocked, parked on approval required\./),
    ).toBeInTheDocument();
  });

  it('offers the progress region as somewhere a stream will appear, not as a dead panel', async () => {
    stubFetch({});
    renderSurface();

    expect(
      await screen.findByText(/Step-by-step progress appears here while a task started from this surface runs\./),
    ).toBeInTheDocument();
  });
});
