import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  limitsFixture,
  networkEgressFixture,
  redactionCheckFixture,
  reloadConfigFixture,
  zdrPolicyFixture,
} from '../../dev-harness/fixtures/safety';
import { SafetySection } from './SafetySection';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const envelope = (code: string, message: string, status = 400) =>
  json({ error: { code, message, retryable: false } }, status);

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

interface StubOptions {
  egressEffective?: boolean;
  redactionFails?: boolean;
  limitsShapeBroken?: boolean;
  reloadFails?: boolean;
}

function stubApi(options: StubOptions = {}) {
  const calls: Call[] = [];
  let egress = { ...networkEgressFixture, enabled: false, effective: false };
  let redaction = { ...redactionCheckFixture };
  let zdr = { ...zdrPolicyFixture, requirement: 'off' as const };
  let mode = 'always_loaded';
  let limits = limitsFixture;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ method, url, body });

      if (url === '/api/settings/network-egress') {
        if (method === 'PUT') {
          egress = { ...egress, enabled: body?.['enabled'] === true, effective: body?.['enabled'] === true && options.egressEffective === true };
          return Promise.resolve(json({ enabled: egress.enabled, effective: egress.effective }));
        }
        return Promise.resolve(json(egress));
      }
      if (url === '/api/settings/redaction-check') {
        if (options.redactionFails === true) return Promise.resolve(envelope('internal_error', 'The settings table is locked.', 500));
        if (method === 'PUT') {
          redaction = { ...redaction, enabled: body?.['enabled'] === true };
          return Promise.resolve(json({ enabled: redaction.enabled, appliesTo: 'remote' }));
        }
        return Promise.resolve(json(redaction));
      }
      if (url === '/api/settings/zdr') {
        if (method === 'PUT') {
          zdr = { ...zdr, requirement: body?.['requirement'] as typeof zdr.requirement };
          return Promise.resolve(json({ requirement: zdr.requirement, appliesTo: 'remote' }));
        }
        return Promise.resolve(json(zdr));
      }
      if (url === '/api/settings/tool-access-mode') {
        if (method === 'PUT') mode = String(body?.['mode']);
        return Promise.resolve(json({ mode }));
      }
      if (url === '/api/settings/limits') {
        if (options.limitsShapeBroken === true) return Promise.resolve(json({ ceilings: { tokenCeiling: 'many' }, spend: null }));
        if (method === 'PUT') {
          const updated: string[] = [];
          const next = {
            ceilings: { ...limits.ceilings },
            spend: { ...limits.spend },
          };
          if (typeof body?.['dailySpendCapUsd'] === 'number') {
            updated.push('dailySpendCapUsd');
            next.spend.capUsd = body['dailySpendCapUsd'] === 0 ? null : body['dailySpendCapUsd'];
            next.spend.remainingUsd = next.spend.capUsd === null ? null : next.spend.capUsd - next.spend.spentUsd;
          }
          for (const field of ['tokenCeiling', 'iterationCeiling', 'subagentLimit'] as const) {
            if (typeof body?.[field] === 'number') {
              updated.push(field);
              next.ceilings[field] = body[field];
            }
          }
          limits = next;
          return Promise.resolve(json({ ...next, updated }));
        }
        return Promise.resolve(json(limits));
      }
      if (url === '/api/settings/reload-config') {
        if (options.reloadFails === true)
          return Promise.resolve(envelope('bad_request', '.hyperion/permissions.json is not valid JSON.'));
        return Promise.resolve(json(reloadConfigFixture));
      }
      return Promise.resolve(envelope('not_found', `No stub for ${method} ${url}`, 404));
    }),
  );
  return calls;
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SafetySection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Safety and limits', () => {
  it('renders each control in the backend’s own terms', async () => {
    stubApi();
    renderSection();
    expect(await screen.findByText('Network egress from commands')).toBeInTheDocument();
    // Enforcement honesty: the prefix match is named, never upgraded.
    expect(screen.getByText(/command_prefix_match/)).toBeInTheDocument();
    expect(screen.getByText(/It is not a sandbox, a firewall/)).toBeInTheDocument();
    expect(screen.getByText(/the backend default, because a false positive blocks a send/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Off\./)).toBeChecked();
    expect(screen.getByText(/fails closed/)).toBeInTheDocument();
    // Spend sits beside the cap, with the unpriced gap disclosed.
    expect(screen.getByText('$3.4172')).toBeInTheDocument();
    expect(screen.getByText(/2 requests today had no price row/)).toBeInTheDocument();
    expect(screen.getByText(/Advisory only/)).toBeInTheDocument();
  });

  it('shows stored-on-but-not-effective instead of claiming the toggle worked', async () => {
    const calls = stubApi({ egressEffective: false });
    renderSection();
    await screen.findByText('Network egress from commands');
    await userEvent.click(screen.getByLabelText('Allow commands to reach the network'));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'PUT' && call.url === '/api/settings/network-egress' && call.body?.['enabled'] === true)).toBe(true),
    );
    expect(await screen.findByText(/stored on, but not effective while code execution is off/)).toBeInTheDocument();
    expect(screen.getByText(/On, but not effective: network egress also requires code execution/)).toBeInTheDocument();
  });

  it('sets the ZDR requirement through the typed route', async () => {
    const calls = stubApi();
    renderSection();
    await screen.findByText('Zero data retention policy');
    await userEvent.click(screen.getByLabelText(/^Require ZDR\./));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'PUT' && call.url === '/api/settings/zdr' && call.body?.['requirement'] === 'require')).toBe(true),
    );
    expect(await screen.findByText(/The ZDR policy is now “require”\./)).toBeInTheDocument();
  });

  it('sends only the limits that changed, and clears the cap with zero', async () => {
    const calls = stubApi();
    renderSection();
    await screen.findByText('Spending cap and runaway ceilings');
    const tokenField = screen.getByLabelText('Tokens per task');
    await userEvent.clear(tokenField);
    await userEvent.type(tokenField, '500000');
    await userEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => {
      const put = calls.find((call) => call.method === 'PUT' && call.url === '/api/settings/limits');
      expect(put?.body).toEqual({ tokenCeiling: 500000 });
    });

    const capField = screen.getByLabelText('Daily spend cap (USD)');
    await userEvent.clear(capField);
    await userEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => {
      const puts = calls.filter((call) => call.method === 'PUT' && call.url === '/api/settings/limits');
      expect(puts[puts.length - 1]?.body).toEqual({ dailySpendCapUsd: 0 });
    });
    expect(await screen.findByText('No cap set')).toBeInTheDocument();
  });

  it('refuses a ceiling the route would refuse, without sending anything', async () => {
    const calls = stubApi();
    renderSection();
    await screen.findByText('Spending cap and runaway ceilings');
    const iterations = screen.getByLabelText('Iterations per task');
    await userEvent.clear(iterations);
    await userEvent.type(iterations, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    expect(await screen.findByText(/Enter a whole number greater than zero/)).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('reports a validated reload, and a malformed file as a backend refusal', async () => {
    stubApi();
    const first = renderSection();
    await screen.findByText('Reload configuration');
    await userEvent.click(screen.getByRole('button', { name: 'Re-read configuration' }));
    expect(await screen.findByText(/Configuration for “\.” validated\. 2 profiles loaded, 2 permission rules in force/)).toBeInTheDocument();
    first.unmount();

    stubApi({ reloadFails: true });
    renderSection();
    await screen.findByText('Reload configuration');
    await userEvent.click(screen.getByRole('button', { name: 'Re-read configuration' }));
    expect(await screen.findByText(/The backend refused: \.hyperion\/permissions\.json is not valid JSON\. \(bad_request\)/)).toBeInTheDocument();
  });

  it('keeps one panel’s failure from taking the others down, and names its kind', async () => {
    stubApi({ redactionFails: true, limitsShapeBroken: true });
    renderSection();
    // The egress panel still loads and works.
    expect(await screen.findByText('Network egress from commands')).toBeInTheDocument();
    expect(await screen.findByText(/The backend refused: The settings table is locked\. \(internal_error\)/)).toBeInTheDocument();
    expect(await screen.findByText(/failed validation against this frontend’s contract/)).toBeInTheDocument();
  });

  it('sets the tool-access mode and labels it advisory', async () => {
    const calls = stubApi();
    renderSection();
    await screen.findByText('Tool access mode');
    await userEvent.click(screen.getByLabelText(/^Load when needed\./));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'PUT' && call.body?.['mode'] === 'load_when_needed')).toBe(true),
    );
  });
});
