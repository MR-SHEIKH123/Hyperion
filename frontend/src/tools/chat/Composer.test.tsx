import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderPrivacy } from '../../components/PrivacyIndicator/PrivacyIndicator';
import { Composer } from './Composer';
import type { ModelSelection } from './useModelSelection';

const privacy: ProviderPrivacy = {
  providerName: 'Test Provider',
  egress: 'remote',
  zdrStatus: 'zdr_requested',
  zdrRequirement: 'prefer',
  redactionCheckEnabled: true,
};

const model: ModelSelection = {
  ready: true,
  privacy,
  models: [{ id: 'model-a', label: 'Model A' }],
  activeProviderName: 'Test Provider',
  activeProviderId: 'p1',
  selectedId: 'model-a',
  preferred: null,
  setSelectedId: () => {},
  error: null,
};

const base = { model, phase: 'idle' as const, notice: null, onStop: () => {}, privacy };

describe('Composer', () => {
  it('keeps the draft when the send is refused before any stream opens', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('busy'));
    render(<Composer {...base} onSend={onSend} />);

    const input = screen.getByLabelText('Message');
    await userEvent.type(input, 'important question');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('important question', 'model-a');
    // The refusal must not eat the user's text.
    expect(input).toHaveValue('important question');
  });

  it('clears the draft on an accepted send', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer {...base} onSend={onSend} />);

    const input = screen.getByLabelText('Message');
    await userEvent.type(input, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('');
  });

  it('does not send while a run is live and shows stop instead', () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(<Composer {...base} phase="running" onSend={onSend} onStop={onStop} />);

    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeEnabled();
  });

  it('states the egress and retention facts at the point of send', () => {
    render(<Composer {...base} onSend={vi.fn()} />);

    // A remote provider must say so next to the send control, not only in
    // Settings (Prompt 1.39 B).
    const line = screen.getByLabelText(/Requests leave this machine/);
    expect(line).toHaveAttribute('data-egress', 'remote');
    expect(line).toHaveTextContent('Remote · zero-data-retention requested · zero-data-retention preferred');
  });

  it('renders no privacy line it cannot back with data', () => {
    render(<Composer {...base} onSend={vi.fn()} privacy={null} />);

    expect(screen.queryByText(/Remote|Local|Egress unknown/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });
});
