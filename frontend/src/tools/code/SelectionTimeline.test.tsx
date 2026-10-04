import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SelectionTimeline } from './SelectionTimeline';

import type { recoveryReportSchema } from '../../contracts/wire/tasks';
import type { z } from 'zod';

type RecoveryReport = z.infer<typeof recoveryReportSchema>;

/**
 * The rail's two columns (the session panel's fourth slice).
 *
 * The load-bearing claim is the one the plan is explicit about: the version stack
 * and the step list are **not joined**, so nothing here may read as "content as of
 * step k" — and every absence says which absence it is.
 */

const report = (overrides: Partial<RecoveryReport> = {}): RecoveryReport => ({
  run: {
    runId: 'run-1',
    taskId: 'task-1',
    tool: 'code',
    state: 'complete',
    pauseReason: null,
    errorCode: null,
    errorMessage: null,
    startedAt: 1,
    updatedAt: 2,
    completedAt: 2,
  },
  interrupted: false,
  stop: null,
  partial: {
    steps: [
      {
        runId: 'run-1',
        step: 3,
        mode: 'act',
        kind: 'tool',
        profile: null,
        provenance: null,
        toolName: 'execute_command',
        ok: true,
        detail: 'npm test',
        tokensIn: 10,
        tokensOut: 5,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        createdAt: Date.now() - 60_000,
      },
    ],
    summary: {
      steps: 9,
      toolCalls: 4,
      failures: 1,
      compressions: 0,
      tokensIn: 100,
      tokensOut: 50,
      complete: true,
    },
    omitted: 8,
    lastStepAt: Date.now() - 60_000,
    conversation: { durable: true, messages: 3 },
  },
  worktree: null,
  actions: {
    resume: { possible: false, reason: null },
    discard: { possible: false, name: null, requiresForce: false, reason: null },
  },
  ...overrides,
});

const versionsOf = (count: number) => ({
  isPending: false,
  isError: false,
  data: Array.from({ length: count }, (_, index) => ({
    id: `av-${String(index)}`,
    artifactKey: 'src/a.ts',
    tool: 'code',
    version: index + 1,
    label: `edit ${String(index + 1)}`,
    bytes: 10,
    sha256: 'a'.repeat(64),
    inline: true,
    parentVersion: index === 0 ? null : index,
    createdAt: 1,
  })),
});

function renderRail(overrides: Partial<Parameters<typeof SelectionTimeline>[0]> = {}) {
  const props = {
    taskId: 'task-1' as string | null,
    file: 'src/a.ts' as string | null,
    versions: { isPending: false, isError: false, data: [] },
    onRetryVersions: vi.fn(),
    steps: { isPending: false, isError: false, data: report() },
    onRetrySteps: vi.fn(),
    ...overrides,
  };
  render(<SelectionTimeline {...props} />);
  return props;
}

describe('the selection timeline', () => {
  it('renders both columns, and says they are not joined', () => {
    renderRail({ versions: versionsOf(2) });

    expect(screen.getByRole('heading', { name: 'Versions' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Steps' })).toBeDefined();
    expect(screen.getByRole('list', { name: 'Version timeline' })).toBeDefined();
    expect(screen.getByRole('list', { name: 'Run steps' })).toBeDefined();

    // The claim the component exists to avoid making.
    expect(screen.getByText(/not joined/)).toBeDefined();
    expect(screen.getByText(/content as of step k/)).toBeDefined();
    expect(screen.queryByText(/as of step 3/)).toBeNull();
  });

  it('states the tail bound instead of showing a bounded list as the whole run', () => {
    renderRail();

    expect(screen.getByText('9 steps · 4 tool calls · 1 failures')).toBeDefined();
    expect(screen.getByText(/Showing the last 1 of 9 steps; 8 earlier steps are not listed\./)).toBeDefined();
  });

  it('names each absence rather than rendering an empty box', () => {
    renderRail({ file: null, taskId: null });

    expect(screen.getByText(/Name a file with/)).toBeDefined();
    expect(screen.getByText('Select a task to see the steps its run recorded.')).toBeDefined();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('says why the steps are not shown until a file is named', () => {
    // The surface does not make the recovery read until a file is selected (it runs
    // a worktree check for every caller), so this column must not look empty for a
    // reason the reader cannot see.
    renderRail({ file: null });

    expect(screen.getByText(/Select a changed file to read the run's steps beside its versions\./)).toBeDefined();
  });

  it('renders a failed read as a failure with a retry, never as an empty list', () => {
    renderRail({
      versions: { isPending: false, isError: true, data: undefined },
      steps: { isPending: false, isError: true, data: undefined },
    });

    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('says a run recorded no steps when it has none', () => {
    renderRail({
      steps: {
        isPending: false,
        isError: false,
        data: report({
          partial: { ...report().partial, steps: [], omitted: 0, summary: { ...report().partial.summary, steps: 0 } },
        }),
      },
    });

    expect(screen.getByText('No steps are recorded for this run.')).toBeDefined();
  });
});
