import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConsoleView } from './ConsoleView';
import type { ConsoleEntry } from './consoleShim';

const entry = (kind: ConsoleEntry['kind'], text: string): ConsoleEntry => ({ kind, text });

describe('the Console panel', () => {
  it('distinguishes the two empties: no frame, and a frame that said nothing', () => {
    const { rerender } = render(
      <ConsoleView entries={[]} frameOpen={false} onClear={vi.fn()} onSendErrors={vi.fn()} />,
    );
    expect(screen.getByTestId('console-empty').textContent).toContain('No preview frame is open');
    rerender(
      <ConsoleView entries={[]} frameOpen onClear={vi.fn()} onSendErrors={vi.fn()} />,
    );
    expect(screen.getByTestId('console-empty').textContent).toContain('logged nothing yet');
  });

  it('renders accepted entries as text — markup in a log line is shown, not parsed', () => {
    const hostile = '<img src=x onerror="alert(1)">';
    render(
      <ConsoleView
        entries={[entry('log', 'ready'), entry('warn', hostile), entry('error', 'boom')]}
        frameOpen
        onClear={vi.fn()}
        onSendErrors={vi.fn()}
      />,
    );
    const list = screen.getByTestId('console-list');
    expect(list.querySelectorAll('li')).toHaveLength(3);
    expect(list.textContent).toContain(hostile);
    expect(list.querySelector('img')).toBeNull();
    expect(screen.getByTestId('console-count').textContent).toContain('3 entries');
    expect(screen.getByTestId('console-count').textContent).toContain('1 error');
  });

  it('Send-to-composer is disabled with no errors and fires the callback with them', async () => {
    const user = userEvent.setup();
    const onSendErrors = vi.fn();
    const { rerender } = render(
      <ConsoleView
        entries={[entry('log', 'fine')]}
        frameOpen
        onClear={vi.fn()}
        onSendErrors={onSendErrors}
      />,
    );
    const button = screen.getByTestId('console-send-errors');
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onSendErrors).not.toHaveBeenCalled();

    rerender(
      <ConsoleView
        entries={[entry('log', 'fine'), entry('error', 'boom')]}
        frameOpen
        onClear={vi.fn()}
        onSendErrors={onSendErrors}
      />,
    );
    expect(screen.getByTestId('console-send-errors')).not.toBeDisabled();
    await user.click(screen.getByTestId('console-send-errors'));
    expect(onSendErrors).toHaveBeenCalledTimes(1);
  });

  it('Clear empties the list through the callback the tab owns', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(
      <ConsoleView
        entries={[entry('log', 'line')]}
        frameOpen
        onClear={onClear}
        onSendErrors={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('shows the newest hundred by default and the rest on request', () => {
    const entries = Array.from({ length: 150 }, (_, index) => entry('log', `line ${index}`));
    render(
      <ConsoleView entries={entries} frameOpen onClear={vi.fn()} onSendErrors={vi.fn()} />,
    );
    const list = screen.getByTestId('console-list');
    expect(list.querySelectorAll('li')).toHaveLength(100);
    expect(list.textContent).toContain('line 149');
    expect(list.textContent).not.toContain('line 0');
    expect(screen.getByText(/50 older entries/)).toBeInTheDocument();
  });
});
