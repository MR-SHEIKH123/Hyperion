import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PrivacyIndicator, type ProviderPrivacy } from './PrivacyIndicator';

function privacy(overrides: Partial<ProviderPrivacy> = {}): ProviderPrivacy {
  return {
    providerName: 'Ollama (this machine)',
    egress: 'local',
    egressProxy: null,
    cooldown: null,
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
  it('names the proxy a request is tunnelled through, in both registers', () => {
    render(
      <PrivacyIndicator
        privacy={privacy({
          egress: 'remote',
          egressProxy: {
            redacted: 'http://alice:***@proxy.example.test:3128',
            authority: 'proxy.example.test:3128',
            scheme: 'http',
            hasCredentials: true,
            offMachine: true,
          },
        })}
      />,
    );
    const line = screen.getByLabelText(/tunnelled through the proxy/);
    expect(line).toHaveAttribute('data-proxy', 'proxy.example.test:3128');
    expect(line).toHaveTextContent('Remote · via proxy proxy.example.test:3128 (off this machine)');
    const label = line.getAttribute('aria-label') ?? '';
    expect(label).toContain('Requests are tunnelled through the proxy http://alice:***@proxy.example.test:3128, which is not on this machine.');
    // The frontend is handed a redacted URL, so there is no password to leak here
    // — this asserts the rendering does not reintroduce one from anywhere else.
    expect(label).not.toMatch(/hunter|password/);
  });

  it('distinguishes a proxy on this machine from one off it', () => {
    render(
      <PrivacyIndicator
        privacy={privacy({
          egressProxy: {
            redacted: 'http://127.0.0.1:3128',
            authority: '127.0.0.1:3128',
            scheme: 'http',
            hasCredentials: false,
            offMachine: false,
          },
        })}
      />,
    );
    const line = screen.getByLabelText(/which is on this machine/);
    expect(line).toHaveTextContent('Local · via proxy 127.0.0.1:3128 · no egress');
    expect(line.textContent ?? '').not.toMatch(/off this machine/);
  });

  it('discloses a cooling provider, in the backend\'s own words', () => {
    render(
      <PrivacyIndicator
        privacy={privacy({
          cooldown: {
            until: 1_790_000_000_000,
            failureClass: 'auth',
            source: 'table',
            reason: 'the credentials were rejected — waiting 60m',
          },
        })}
      />,
    );
    const line = screen.getByLabelText(/left alone for now/);
    expect(line).toHaveAttribute('data-cooldown', 'auth');
    // The chip's visible register is the short list; the sentence carries both the
    // backend's reason verbatim and the one fact a user cannot infer from it —
    // that being skipped is not being disabled.
    expect(line).toHaveTextContent('Local · cooling down · no egress');
    const label = line.getAttribute('aria-label') ?? '';
    expect(label).toContain('It is being left alone for now: the credentials were rejected — waiting 60m.');
    expect(label).toContain('this one is used again only if nothing else can serve the model');
  });

  it('says nothing about a cooldown when the provider is not cooling', () => {
    render(<PrivacyIndicator privacy={privacy()} />);
    const line = screen.getByLabelText(/Requests go to a provider on this machine/);
    expect(line).toHaveAttribute('data-cooldown', 'none');
    expect(line.textContent ?? '').not.toMatch(/cooling|left alone/);
    expect(line.getAttribute('aria-label') ?? '').not.toMatch(/left alone|waiting/);
  });

  it('says nothing about a proxy when there is none', () => {
    render(<PrivacyIndicator privacy={privacy()} />);
    const line = screen.getByLabelText(/Requests go to a provider on this machine/);
    expect(line).toHaveAttribute('data-proxy', 'none');
    expect(line.textContent ?? '').not.toMatch(/proxy/);
  });
});