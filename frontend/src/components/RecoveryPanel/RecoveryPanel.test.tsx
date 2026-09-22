import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecoveryPanel } from './RecoveryPanel';

/**
 * The recovery panel (1.31) — what an interrupted run left, and the three verbs.
 *
 * What is worth testing is not that rows render, but the four rules the panel is
 * responsible for: a bounded step list never reads as a complete one, a checkout
 * whose risk check did not run is never called empty, a destructive call asks
 * first and only then sends `force`, and the resume verb is named as *available
 * but not actioned here* rather than shown as a button that does nothing.
 */

const NOW = 1_766_000_000_000;

const report = {
  run: {
    runId: 'run-1',
    taskId: 'task-1',
    tool: 'code',
    state: 'interrupted',
    pauseReason: null,
    errorCode: null,
    errorMessage: null,
    startedAt: NOW - 600_000,
    updatedAt: NOW - 300_000,
    completedAt: NOW - 300_000,
  },
  interrupted: true,
  stop: { code: null, message: null, at: null },
  partial: {
    steps: [
      {
        runId: 'run-1',
        step: 47,
        mode: 'act',
        kind: 'tool_call',
        profile: null,
        provenance: 'project:src/**',
        toolName: 'edit_file',
        ok: true,
        detail: 'src/parser.ts (12 lines)',
        tokensIn: 120,
        tokensOut: 40,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        createdAt: NOW - 320_000,
      },
      {
        runId: 'run-1',
        step: 48,
        mode: 'act',
        kind: 'tool_call',
        profile: null,
        provenance: null,
        toolName: 'run_command',
        ok: false,
        detail: 'exit 1: npm test',
        tokensIn: null,
        tokensOut: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        createdAt: NOW - 310_000,
      },
    ],
    summary: {
      steps: 50,
      toolCalls: 44,
      failures: 1,
      compressions: 2,
      tokensIn: 90_000,
      tokensOut: 12_000,
      complete: false,
    },
    omitted: 48,
    lastStepAt: NOW - 310_000,
    conversation: { durable: false, messages: 0 },
  },
  worktree: {
    name: 'wt-task-1',
    dir: '/worktrees/wt-task-1',
    taskId: 'task-1',
    lastModified: NOW - 300_000,
    risk: 'uncommitted changes in src/parser.ts',
    checked: true,
  },
  actions: {
    resume: { possible: true, reason: null },
    discard: { possible: true, name: 'wt-task-1', requiresForce: true, reason: null },
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function describeRequest(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function stubFetch(overrides: { report?: Response; discard?: Response } = {}) {
  // What each call actually sent: the point of the force assertion is the body,
  // not that a request happened at all.
  const sent: { path: string; body: string | null }[] = [];
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = describeRequest(input);
    sent.push({ path, body: typeof init?.body === 'string' ? init.body : null });
    if (path === '/api/code/tasks/task-1/recovery') {
      return Promise.resolve(overrides.report ?? json(report));
    }
    if (path.startsWith('/api/storage/worktrees/')) {
      return Promise.resolve(
        overrides.discard ??
          json({ name: 'wt-task-1', dir: '/worktrees/wt-task-1', method: 'git', lostReason: null }),
      );
    }
    return Promise.resolve(json({ error: { code: 'not_found', message: `${path} is not stubbed`, retryable: false } }, 404));
  });
  vi.stubGlobal('fetch', mock);
  return { mock, sent };
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RecoveryPanel tool="code" taskId="task-1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the recovery panel', () => {
  it('shows what the run left, and never lets a bounded list read as complete', async () => {
    stubFetch();
    renderPanel();

    // The row carries a stop with no code and no message, so the panel says that
    // rather than inventing a cause out of an empty pair of columns.
    expect(await screen.findByText(/Nothing was recorded about why it ended/)).toBeInTheDocument();

    // Totals are over every step; the list is the tail, and `omitted` says so.
    const steps = screen.getByRole('list', { name: 'Recorded steps' });
    expect(steps).toHaveTextContent('#47');
    expect(steps).toHaveTextContent('edit_file');
    expect(steps).toHaveTextContent('exit 1: npm test');
    expect(screen.getByText(/…and 48 earlier steps not shown/)).toBeInTheDocument();
    expect(screen.getByText(/50 steps · 44 tool calls · 1 failure/)).toBeInTheDocument();

    // A token total computed from partial counts is a floor, and says so.
    expect(screen.getByText(/90,000 in \/ 12,000 out, at least/)).toBeInTheDocument();

    // A conversation that did not survive is stated, not glossed over.
    expect(screen.getByText(/own words did not survive the restart/)).toBeInTheDocument();
  });

  it('answers a run that is not interrupted instead of erroring', async () => {
    stubFetch({
      report: json({
        ...report,
        interrupted: false,
        run: { ...report.run, state: 'complete' },
      }),
    });
    renderPanel();

    expect(await screen.findByText('Nothing to recover')).toBeInTheDocument();
    expect(screen.getByText(/ended on its own terms/)).toBeInTheDocument();
    // Nothing about a recovery is offered for a run that has none to make.
    expect(screen.queryByRole('button', { name: /Discard/ })).toBeNull();
  });

  it('asks before a destructive call and only then sends force', async () => {
    const { mock, sent } = stubFetch();
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Discard the leftover checkout' }));

    // The confirm names what would be lost, from the backend's own risk check.
    const confirm = await screen.findByRole('alert');
    expect(confirm).toHaveTextContent('wt-task-1');
    expect(confirm).toHaveTextContent('uncommitted changes in src/parser.ts');
    // Nothing has been sent yet: the first click is a question.
    expect(mock.mock.calls.every((call) => !describeRequest(call[0]).includes('discard'))).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Yes, discard it' }));

    await waitFor(() => {
      const discard = sent.find((entry) => entry.path.includes('/discard'));
      expect(discard).toBeDefined();
      // `force` is sent because the user asked twice and the check found work.
      expect(JSON.parse(discard?.body ?? 'null')).toEqual({ force: true });
    });
    // The report is re-read, so the panel stops describing a directory that is gone.
    await waitFor(() => {
      const reads = mock.mock.calls.filter((call) => describeRequest(call[0]).endsWith('/recovery'));
      expect(reads.length).toBe(2);
    });
  });

  it('does not force a discard the backend would have allowed', async () => {
    const { sent } = stubFetch({
      report: json({
        ...report,
        // Checked, and it holds nothing a removal would lose: the backend accepts
        // this without `force`, and the client must not escalate on its own.
        worktree: { ...report.worktree, risk: null, checked: true },
        actions: { ...report.actions, discard: { ...report.actions.discard, requiresForce: false } },
      }),
    });
    renderPanel();

    expect(await screen.findByText(/The check found nothing in it that a discard would lose/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Discard the leftover checkout' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, discard it' }));

    await waitFor(() => {
      const discard = sent.find((entry) => entry.path.includes('/discard'));
      expect(JSON.parse(discard?.body ?? 'null')).toEqual({ force: false });
    });
  });

  it('offers to keep it, and sends nothing, when the user backs out', async () => {
    const { sent } = stubFetch();
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Discard the leftover checkout' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep it' }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Discard the leftover checkout' })).toBeInTheDocument();
    expect(sent.some((entry) => entry.path.includes('discard'))).toBe(false);
  });

  it('reports a checkout a live task owns as in use, not as missing', async () => {
    stubFetch({
      report: json({
        ...report,
        worktree: null,
        actions: {
          resume: { possible: false, reason: 'a live run owns this task' },
          discard: { possible: false, name: null, requiresForce: false, reason: 'a task is running in this checkout right now' },
        },
      }),
    });
    renderPanel();

    expect(await screen.findByText('a task is running in this checkout right now')).toBeInTheDocument();
    // The absence and the reason are stated once each, not twice.
    expect(screen.getByText('No leftover checkout is on disk for this task.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard the leftover checkout' })).toBeNull();
    // Resume being unavailable is the backend's reason, verbatim.
    expect(screen.getByText('a live run owns this task')).toBeInTheDocument();
  });

  it('never calls a checkout empty when the risk check could not run', async () => {
    stubFetch({
      report: json({
        ...report,
        worktree: { ...report.worktree, risk: null, checked: false },
      }),
    });
    renderPanel();

    expect(await screen.findByText(/could not be checked, so a discard would be removing it unexamined/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Discard the leftover checkout' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/nothing about its contents is known/);
  });

  it('reports resume and its route when no host can start a run', async () => {
    stubFetch();
    renderPanel();

    const heading = await screen.findByRole('heading', { name: 'Resume' });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText(/starting the task again with the same id/)).toBeInTheDocument();
    expect(screen.getByText(/This surface cannot\s+start a run/)).toBeInTheDocument();
    // The honest half: no button that looks like it would start the run.
    expect(screen.queryByRole('button', { name: /Resume|Start/ })).toBeNull();
  });

  it('hands the task id to a host that can start the re-run', async () => {
    stubFetch();
    const onResume = vi.fn<(taskId: string) => void>();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    render(
      <QueryClientProvider client={client}>
        <RecoveryPanel tool="code" taskId="task-1" onResume={onResume} />
      </QueryClientProvider>,
    );

    // Resuming is a re-run with the *same* id — that is what re-attaches the leftover
    // checkout — so the id is what crosses the boundary, not a fresh one.
    await userEvent.click(await screen.findByRole('button', { name: 'Resume in the composer' }));
    expect(onResume).toHaveBeenCalledWith('task-1');
    // And the panel says what the re-run needs that a continuation would not: an
    // instruction, because an interrupted run has no stored conversation to replay.
    expect(screen.getByText(/it needs an instruction/)).toBeInTheDocument();
  });

  it('reports a refused discard instead of swallowing it', async () => {
    stubFetch({
      discard: json(
        { error: { code: 'conflict', message: 'wt-task-1 holds work; pass force to remove it.', retryable: false } },
        409,
      ),
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Discard the leftover checkout' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Yes, discard it' }));

    expect(await screen.findByText('wt-task-1 holds work; pass force to remove it.')).toBeInTheDocument();
  });

  it('treats a dropped read as a failure, not as nothing to recover', async () => {
    stubFetch({
      report: json({ error: { code: 'storage_error', message: 'db closed', retryable: true } }, 500),
    });
    renderPanel();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing to recover/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload this section' })).toBeInTheDocument();
  });
});
