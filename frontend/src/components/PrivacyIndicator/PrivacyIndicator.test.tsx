import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PrivacyIndicator, type ProviderPrivacy } from './PrivacyIndicator';

function privacy(overrides: Partial<ProviderPrivacy> = {}): ProviderPrivacy {
  return {
    providerName: 'Ollama (this machine)',
    egress: 'local',
    zdrStatus: 'local_no_egress',
    zdrRequirement: 'off',
    redactionCheckEnabled: true,
    ...overrides,
  };
}

describe('PrivacyIndicator', () => {
  it('says a local provider does not leave the machine, and says why there is nothing to disclose', () => {
    render(<PrivacyIndicator privacy={privacy()} />);
    const line = screen.getByLabelText(/Requests go to a provider on this machine/);
    expect(line).toHaveAttribute('data-egress', 'local');
    expect(line).toHaveTextContent('Local · no egress · redaction check on');
    expect(line.getAttribute('aria-label')).toBe(
      'Requests go to a provider on this machine and do not leave it. Provider: Ollama (this machine). Nothing leaves this machine, so there is no retention to disclose. The pre-send redaction check is on.',
    );
  });

  it('says a remote provider sends requests off the machine and names it', () => {
    render(
      <PrivacyIndicator
        privacy={privacy({ providerName: 'OpenAI', egress: 'remote', zdrStatus: 'zdr_requested' })}
      />,
    );
    const line = screen.getByLabelText(/Requests leave this machine/);
    expect(line).toHaveAttribute('data-egress', 'remote');
    expect(line).toHaveTextContent('Remote · zero-data-retention requested');
    expect(line.getAttribute('aria-label')).toContain('Provider: OpenAI.');
    expect(line.getAttribute('aria-label')).toContain(
      'Zero-data-retention has been requested but not confirmed.',
    );
  });

  it('renders the standing requirement beside the recorded status, and claims no verdict of its own', () => {
    render(
      <PrivacyIndicator
        privacy={privacy({ egress: 'remote', zdrStatus: 'zdr_not_applied', zdrRequirement: 'require' })}
      />,
    );
    const line = screen.getByLabelText(/Zero-data-retention is required/);
    expect(line).toHaveTextContent(
      'Remote · zero-data-retention not applied · zero-data-retention required',
    );
    // The pair is shown; whether it is met is the backend's answer to give
    // (docs/CONTRACTS.md, zdr.ts). No "met"/"unmet" wording may appear here.
    expect(line.getAttribute('aria-label')).toContain('Zero-data-retention is not applied.');
    expect(line.getAttribute('aria-label')).not.toMatch(/\bmet\b|\bunmet\b|satisfied|eligible/i);
  });

  it('fails closed in words when the type cannot be classified', () => {
    render(<PrivacyIndicator privacy={privacy({ egress: 'unknown', zdrStatus: 'egress_unknown' })} />);
    const line = screen.getByLabelText(/cannot be classified/);
    expect(line).toHaveTextContent('Egress unknown');
    expect(line.getAttribute('aria-label')).toContain('treat requests as leaving this machine');
  });

  it('renders the absence of a provider as a state, not as an unknown', () => {
    render(<PrivacyIndicator privacy={privacy({ providerName: null, zdrStatus: null })} />);
    const line = screen.getByLabelText(/No provider is active/);
    expect(line).toHaveAttribute('data-zdr', 'none');
    expect(line).toHaveTextContent('no provider active');
  });

  it('does not present a preference as a guarantee', () => {
    render(<PrivacyIndicator privacy={privacy({ zdrRequirement: 'prefer' })} />);
    expect(screen.getByLabelText(/Zero-data-retention is preferred/)).toHaveTextContent(
      'zero-data-retention preferred',
    );
  });
});
