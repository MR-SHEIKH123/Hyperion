import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { AttentionList } from './AttentionList';

import type { AttentionItem, AttentionQueue } from '../contracts/wire/attention';

const NOW = 1_700_000_000_000;

function item(overrides: Partial<AttentionItem>): AttentionItem {
  return {
    id: 'approval:a1',
    kind: 'approval_required',
    tool: 'code',
    title: 'bash needs a decision',
    detail: 'The project rules deny this command.',
    createdAt: NOW - 4 * 60_000,
    taskId: 'task-1',
    resolve: { method: 'POST', path: '/api/code/tasks/task-1/approve' },
    ...overrides,
  };
}

function queue(overrides: Partial<AttentionQueue> = {}): AttentionQueue {
  return {
    generatedAt: NOW,
    total: 2,
    counts: { approval_required: 1, plan_ready: 1 },
    items: [
      item({}),
      item({
        id: 'plan:run-2',
        kind: 'plan_ready',
        tool: 'code',
        title: 'Code task has a plan ready',
        detail: 'Move the parser into src/parser/',
        taskId: 'task-2',
        runId: 'run-2',
        resolve: undefined,
      }),
    ],
    sources: [
      { source: 'pending_approvals', status: 'ok', count: 1 },
      { source: 'mcp', status: 'unavailable', count: 0, reason: 'the MCP process manager is not managed by this process' },
      { source: 'spending', status: 'empty', count: 0 },
    ],
    ...overrides,
  };
}

function view(props: Partial<React.ComponentProps<typeof AttentionList>> = {}) {
  return render(
    <MemoryRouter>
      <AttentionList queue={queue()} now={NOW} {...props} />
    </MemoryRouter>,
  );
}

describe('the attention list', () => {
  it('renders the server order and never re-sorts it', () => {
    view();
    const list = screen.getByRole('list', { name: 'Items waiting on you' });
    const headings = within(list)
      .getAllByRole('heading', { level: 2 })
      .map((node) => node.textContent);
    expect(headings).toEqual(['bash needs a decision', 'Code task has a plan ready']);
  });

  it('labels each destination with its item, so a screen reader hears which row it opens', () => {
    view();
    const link = screen.getByRole('link', {
      name: 'Decision needed: bash needs a decision — Open in Code',
    });
    expect(link).toHaveAttribute('href', '/code?task=task-1');
  });

  it('moves focus between rows with the arrow keys and Home/End', () => {
    view();
    const first = screen.getByRole('link', { name: /bash needs a decision/ });
    const second = screen.getByRole('link', { name: /plan ready/ });

    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);

    // The clamp at the end matters: a list of two must not lose focus off the end.
    fireEvent.keyDown(second, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(second, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'End' });
    expect(document.activeElement).toBe(second);
  });

  it('offers a decision only where there is something to decide', () => {
    view({ onDecide: vi.fn() });
    expect(screen.getByRole('group', { name: /Decide bash needs a decision/ })).toBeInTheDocument();
    // A plan is not a permission prompt; it must not grow Allow/Deny buttons.
    expect(screen.queryByRole('group', { name: /Decide Code task has a plan ready/ })).toBeNull();
  });

  it('reports the decision and the row it belongs to', () => {
    const onDecide = vi.fn();
    view({ onDecide });
    const group = screen.getByRole('group', { name: /Decide bash needs a decision/ });
    fireEvent.click(within(group).getByRole('button', { name: 'Deny' }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide.mock.calls[0]?.[0]).toMatchObject({ id: 'approval:a1' });
    expect(onDecide.mock.calls[0]?.[1]).toBe('deny');
  });

  it('disables only the row being answered', () => {
    view({ onDecide: vi.fn(), decidingId: 'approval:a1' });
    const group = screen.getByRole('group', { name: /Decide bash needs a decision/ });
    for (const label of ['Allow once', 'Allow for this task', 'Deny']) {
      expect(within(group).getByRole('button', { name: label })).toBeDisabled();
    }
  });

  it('says which sources could not be read, and why', () => {
    view();
    const source = screen.getByText('MCP servers').closest('li');
    expect(source).toHaveAttribute('data-status', 'unavailable');
    expect(within(source as HTMLElement).getByText('not readable')).toBeInTheDocument();
    expect(
      within(source as HTMLElement).getByText(/not managed by this process/),
    ).toBeInTheDocument();
  });

  it('distinguishes an empty queue from an unread one', () => {
    view({
      queue: queue({
        total: 0,
        items: [],
        counts: {},
        sources: [
          { source: 'pending_approvals', status: 'empty', count: 0 },
          { source: 'mcp', status: 'unavailable', count: 0, reason: 'not managed' },
        ],
      }),
    });
    expect(screen.getByRole('status')).toHaveTextContent('No approvals, no paused runs, no plans waiting.');
    expect(screen.getByRole('status')).toHaveTextContent('1 source(s) could not be read');
  });

  it('says that a link cannot show the item yet instead of leaving the row silent', () => {
    // The fixture's two items are Code items, whose surface now exists: no row
    // should claim the workspace is missing, and the links should be real.
    const { container } = view();
    expect(screen.queryByText(/Code workspace is not built yet/)).toBeNull();
    expect(container.querySelectorAll('a[href^="/code?task="]').length).toBe(2);
  });

  it('still warns when a destination genuinely cannot show the item', () => {
    view({
      queue: queue({
        items: [item({ tool: 'cowork' })],
        total: 1,
        counts: { approval_required: 1 },
      }),
    });
    expect(screen.getByText(/Cowork workspace is not built yet/)).toBeInTheDocument();
  });
});
