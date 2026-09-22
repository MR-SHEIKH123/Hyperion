import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PersistenceProvider } from '../../state/persistence/PersistenceProvider';
import { PersistenceStore, type StorageLike } from '../../state/persistence/storage';
import CodeTool from './CodeTool';

/**
 * The Code surface, end to end through the frame (1.39 A3).
 *
 * What is worth testing here is not that a frame renders — that is the frame's own
 * test — but the three things the surface is responsible for getting right: it
 * shows the *lane* rather than a task history it cannot have, it never renders a
 * missing figure as a zero, and a dropped read is named as a dropped read instead
 * of as an empty result.
 */

class MemoryStorage implements StorageLike {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const NOW = 1_766_000_000_000;

const lane = {
  running: 1,
  limit: 2,
  queued: 3,
  active: [
    { id: 'slot-1', taskId: 'task-1', label: 'Fix the parser', startedAt: NOW - 60_000, worktree: '/tmp/wt-1' },
    { id: 'slot-2', taskId: null, label: null, startedAt: NOW - 5_000, worktree: null },
  ],
  held: [
    { taskId: 'task-9', worktree: '/tmp/wt-9', branch: 'hyperion/held', heldSince: NOW - 900_000, state: 'paused' },
  ],
};

const taskState = {
  run: {
    runId: 'run-1',
    taskId: 'task-1',
    tool: 'code',
    state: 'paused',
    pauseReason: 'Waiting for approval of `rm -rf dist`',
    errorCode: null,
    errorMessage: null,
    startedAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
    completedAt: null,
  },
  usage: { requests: 4, runs: 1, tokensIn: 1_200, tokensOut: 800, costUsd: 0.0321, priced: true, unpricedRequests: 0 },
};

const recovery = {
  run: { ...taskState.run, state: 'interrupted', pauseReason: null, completedAt: NOW - 1_000 },
  interrupted: true,
  stop: { code: 'internal_error', message: 'the process ended while this run was live', at: NOW - 1_000 },
  partial: {
    steps: [
      { runId: 'run-1', step: 1, mode: 'act', kind: 'tool_call', profile: null, provenance: null,
        toolName: 'edit_file', ok: true, detail: 'src/parser.ts', tokensIn: 10, tokensOut: 5,
        reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null, createdAt: NOW - 30_000 },
    ],
    summary: { steps: 1, toolCalls: 1, failures: 0, compressions: 0, tokensIn: 10, tokensOut: 5, complete: true },
    omitted: 0,
    lastStepAt: NOW - 30_000,
    conversation: { durable: false, messages: 0 },
  },
  worktree: { name: 'wt-task-1', dir: '/tmp/wt-task-1', taskId: 'task-1', lastModified: NOW - 20_000,
    risk: 'uncommitted changes', checked: true },
  actions: {
    resume: { possible: true, reason: null },
    discard: { possible: true, name: 'wt-task-1', requiresForce: true, reason: null },
  },
};

const versions = {
  artifactKey: 'src/parser.ts',
  versions: [
    { id: 'v2', artifactKey: 'src/parser.ts', tool: 'code', version: 2, label: 'present', inline: true, bytes: 40, sha256: 'b'.repeat(64), createdAt: NOW - 1_000, parentVersion: 1 },
    { id: 'v1', artifactKey: 'src/parser.ts', tool: 'code', version: 1, label: 'present', inline: true, bytes: 30, sha256: 'a'.repeat(64), createdAt: NOW - 2_000, parentVersion: null },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function describeRequest(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

interface Routes_ {
  lane?: Response;
  task?: Response;
  versions?: Response;
  recovery?: Response;
}

function stubFetch(overrides: Routes_ = {}) {
  const mock = vi.fn((input: RequestInfo | URL) => {
    const path = describeRequest(input);
    if (path === '/api/code/tasks') return Promise.resolve(overrides.lane ?? json(lane));
    if (path === '/api/code/tasks/task-1/state') return Promise.resolve(overrides.task ?? json(taskState));
    if (path === '/api/code/tasks/task-1/recovery') return Promise.resolve(overrides.recovery ?? json(recovery));
    if (path.startsWith('/api/artifacts/versions')) return Promise.resolve(overrides.versions ?? json(versions));
    return Promise.resolve(json({ error: { code: 'not_found', message: `${path} is not stubbed`, retryable: false } }, 404));
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function renderTool(entries: string[] = ['/code'], store = new PersistenceStore(new MemoryStorage())) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <PersistenceProvider store={store}>
        <MemoryRouter initialEntries={entries}>
          <Routes>
            <Route path="/code/*" element={<CodeTool />} />
          </Routes>
        </MemoryRouter>
      </PersistenceProvider>
    </QueryClientProvider>,
  );
  return { result, store, client };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Code surface', () => {
  it('shows the lane live, and names parked tasks apart from running ones', async () => {
    stubFetch();
    renderTool();

    const running = await screen.findByRole('list', { name: 'Running code tasks' });
    expect(within(running).getByRole('link', { name: 'Fix the parser' })).toHaveAttribute('href', '/code?task=task-1');
    // A slot with no task id yet is shown as unnamed, not as a link to nowhere.
    expect(within(running).getByText('A task with no id yet')).toBeInTheDocument();

    const parked = screen.getByRole('list', { name: 'Parked code tasks' });
    expect(within(parked).getByRole('link', { name: 'task-9' })).toBeInTheDocument();
    expect(within(parked).getByText(/paused/)).toBeInTheDocument();

    // Capacity, not a count of history: the lane says how full it is.
    expect(screen.getByText('1 of 2 lane slots running · 3 queued')).toBeInTheDocument();
  });

  it('says the lane is empty rather than showing an empty list', async () => {
    stubFetch({ lane: json({ running: 0, limit: 2, queued: 0, active: [], held: [] }) });
    renderTool();
    expect(await screen.findByText('Nothing is running on the Code lane right now.')).toBeInTheDocument();
  });

  it('reports a lane it could not read as a failure, not as an empty lane', async () => {
    stubFetch({ lane: json({ error: { code: 'storage_error', message: 'db closed', retryable: true } }, 500) });
    renderTool();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Nothing is running on the Code lane right now.')).toBeNull();
  });

  it('deep-links a wildcard link into the task, its state and its versions', async () => {
    stubFetch();
    renderTool(['/code?task=task-1&file=src/parser.ts']);

    // The state arrives through the same machine the stream will feed.
    expect(await screen.findByText(/Waiting for approval/)).toBeInTheDocument();
    expect(await screen.findByText('task-1')).toBeInTheDocument();

    // Versions belong to the file, and the frame hosts them in its own panel.
    const timeline = await screen.findByRole('list', { name: 'Version timeline' });
    const rows = within(timeline).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // The derived parent, rendered as the fact it is: v1 has none, v2 replaced it.
    expect(rows[0]).toHaveTextContent('replaced v1');
    expect(rows[1]).toHaveTextContent('first version');

    const mock = vi.mocked(globalThis.fetch);
    expect(mock.mock.calls.map((call) => describeRequest(call[0]))).toContain('/api/artifacts/versions?key=src%2Fparser.ts');
  });

  it('never renders an unpriced or unrecorded figure as zero', async () => {
    stubFetch({
      task: json({
        run: { ...taskState.run, state: 'running', pauseReason: null },
        usage: { requests: 0, runs: 0, tokensIn: 0, tokensOut: 0, costUsd: null, priced: false, unpricedRequests: 0 },
      }),
    });
    renderTool(['/code?task=task-1']);

    expect(await screen.findByText(/nothing was recorded, which is not the same as free/)).toBeInTheDocument();
    expect(screen.getByText(/unpriced — no price row matched this model/)).toBeInTheDocument();
    expect(screen.queryByText('$0.0000')).toBeNull();
  });

  it('keeps a file version history when only the file is named', async () => {
    stubFetch();
    renderTool(['/code?file=src/parser.ts']);
    expect(await screen.findByRole('list', { name: 'Version timeline' })).toBeInTheDocument();
    // No task named: nothing is invented for one.
    expect(screen.getByText('No task is selected. Pick one from the lane, or open a link from the Attention Center.')).toBeInTheDocument();
  });

  it('clears a selection without leaving the surface', async () => {
    stubFetch();
    renderTool(['/code?task=task-1&file=src/parser.ts']);
    await screen.findByRole('list', { name: 'Version timeline' });

    await userEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    await waitFor(() => expect(screen.getByText(/Name a file with/)).toBeInTheDocument());
    // A cleared selection must not keep querying the file it just dropped.
    const mock = vi.mocked(globalThis.fetch);
    const versionCalls = mock.mock.calls.filter((call) => describeRequest(call[0]).startsWith('/api/artifacts/versions'));
    expect(versionCalls.length).toBe(1);
  });

  it('offers the recovery verbs for an interrupted run, and reads nothing extra for a live one', async () => {
    stubFetch({
      task: json({
        run: { ...taskState.run, state: 'interrupted', pauseReason: null, completedAt: NOW - 1_000 },
        usage: taskState.usage,
      }),
    });
    const first = renderTool(['/code?task=task-1']);

    // The panel is the surface's answer to its own banner: the state alone said
    // "interrupted", and this says what survived and what can be done about it.
    expect(await screen.findByRole('heading', { name: 'What the run left' })).toBeInTheDocument();
    expect(screen.getByText(/the process ended while this run was live/)).toBeInTheDocument();
    expect(screen.getByText(/is still on disk/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard the leftover checkout' })).toBeInTheDocument();
    first.result.unmount();

    // A run that is merely paused is not a recovery case, so the read is not made
    // at all — a screen that asked anyway would spawn git work per poll.
    stubFetch();
    renderTool(['/code?task=task-1']);
    await screen.findByText(/Waiting for approval/);
    expect(screen.queryByRole('heading', { name: 'What the run left' })).toBeNull();
    const mock = vi.mocked(globalThis.fetch);
    expect(mock.mock.calls.some((call) => describeRequest(call[0]).endsWith('/recovery'))).toBe(false);
  });

  it('hands an interrupted run to the composer when resume is asked for', async () => {
    stubFetch({
      task: json({
        run: { ...taskState.run, state: 'interrupted', pauseReason: null, completedAt: NOW - 1_000 },
        usage: taskState.usage,
      }),
    });
    renderTool(['/code?task=task-1']);

    // Resume is a re-run of the *same* task id, so the only fact that crosses from
    // the recovery panel to the composer is that id — the panel does not start
    // anything itself, and the composer still needs an instruction the user writes.
    const panel = await screen.findByRole('heading', { name: 'What the run left' });
    await userEvent.click(within(panel.closest('section') as HTMLElement).getByRole('button', { name: 'Resume in the composer' }));
    expect(screen.getByLabelText('Task id')).toHaveValue('task-1');
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    // And the handoff is visible: the composer region takes focus, because a filled
    // field the user has to go looking for is only half a gesture. (The composer is not
    // foldable today, so `focusPanel` focuses rather than expands here — it is the same
    // call either way, and the fold case is the frame's own test.)
    expect(document.getElementById('region-composer')).toHaveFocus();

    expect(fetch).not.toHaveBeenCalledWith('/api/code/run-task', expect.anything());
  });

  it('remembers the panel layout it was resized to, and reopens at that width', async () => {
    stubFetch();
    const storage = new MemoryStorage();
    const first = renderTool(['/code'], new PersistenceStore(storage));
    await screen.findByRole('list', { name: 'Running code tasks' });

    // A resize is a keystroke on the separator (the frame's own keyboard path).
    const separator = screen.getByRole('separator', { name: 'Resize navigation panels' });
    expect(separator).toHaveAttribute('aria-valuenow', '280');
    await userEvent.type(separator, '{ArrowRight}');

    await waitFor(() =>
      expect(first.store.snapshot().projects['active']?.panelLayouts['code']).toEqual({
        sizes: { left: 296, right: 340 },
        collapsed: [],
      }),
    );
    expect(first.store.snapshot().projects['active']?.lastTool).toBe('code');

    // The reopen: a second mount over the same storage, as a reload would be.
    first.result.unmount();
    renderTool(['/code'], new PersistenceStore(storage));
    expect(await screen.findByRole('separator', { name: 'Resize navigation panels' })).toHaveAttribute(
      'aria-valuenow',
      '296',
    );
  });
});
