import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Composer } from './Composer';
import type { ModelSelection } from './useModelSelection';

const model: ModelSelection = {
  ready: true,
  models: [{ id: 'model-a', label: 'Model A' }],
  activeProviderName: 'Test Provider',
  activeProviderId: 'p1',
  selectedId: 'model-a',
  preferred: null,
  setSelectedId: () => {},
  error: null,
};

describe('Composer', () => {
  it('keeps the draft when the send is refused before any stream opens', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('busy'));
    render(<Composer model={model} phase="idle" notice={null} onSend={onSend} onStop={() => {}} />);

    const input = screen.getByLabelText('Message');
    await userEvent.type(input, 'important question');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('important question', 'model-a');
    // The refusal must not eat the user's text.
    expect(input).toHaveValue('important question');
  });

  it('clears the draft on an accepted send', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer model={model} phase="idle" notice={null} onSend={onSend} onStop={() => {}} />);

    const input = screen.getByLabelText('Message');
    await userEvent.type(input, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('');
  });

  it('does not send while a run is live and shows stop instead', () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(<Composer model={model} phase="running" notice={null} onSend={onSend} onStop={onStop} />);

    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeEnabled();
  });
});
