import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  colibriAdvisoryFixture,
  localProviderFixture,
  providerModelsFixture,
  providersFixture,
  puterAdvisoryFixture,
} from '../../dev-harness/fixtures/providers';
import type { ProviderWire } from '../../contracts/wire/providers';
import { ProvidersSection } from './ProvidersSection';
import { SettingsTool } from './SettingsTool';

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
  providers?: ProviderWire[];
  listResponse?: () => Response;
  /** Answers for successive GET /api/providers calls; the last one repeats. */
  listResponses?: Array<() => Response>;
  createResponse?: (body: Record<string, unknown>) => Response;
  testResult?: Record<string, unknown>;
  advisoriesFail?: boolean;
}

const listBody = (providers: ProviderWire[]) => ({
  providers,
  activeProviderId: providers.find((provider) => provider.enabled)?.id ?? null,
  activeProviderName: providers.find((provider) => provider.enabled)?.name ?? null,
  providerCount: providers.length,
  hasAnyProvider: providers.length > 0,
});

const byId = (id: string) => providersFixture.find((provider) => provider.id === id) ?? localProviderFixture;

function stubApi(options: StubOptions = {}) {
  const calls: Call[] = [];
  let listCall = 0;
  const providers = options.providers ?? providersFixture;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ method, url, body });

      if (method === 'GET' && url === '/api/providers') {
        if (options.listResponses !== undefined) {
          const respond = options.listResponses[Math.min(listCall, options.listResponses.length - 1)] as () => Response;
          listCall += 1;
          return Promise.resolve(respond());
        }
        return Promise.resolve(options.listResponse?.() ?? json(listBody(providers)));
      }
      if (method === 'GET' && url.endsWith('/advisory'))
        return Promise.resolve(
          options.advisoriesFail === true
            ? envelope('internal_error', 'advisory down', 500)
            : json(url.includes('puter') ? puterAdvisoryFixture : colibriAdvisoryFixture),
        );
      if (method === 'POST' && url === '/api/providers') {
        if (options.createResponse !== undefined) return Promise.resolve(options.createResponse(body ?? {}));
        return Promise.resolve(
          json(
            {
              provider: {
                ...localProviderFixture,
                id: 'provider-new',
                name: typeof body?.['name'] === 'string' ? body['name'] : 'New',
                type: typeof body?.['type'] === 'string' ? body['type'] : 'remote',
                baseUrl: typeof body?.['baseUrl'] === 'string' ? body['baseUrl'] : '',
                hasKey: typeof body?.['apiKey'] === 'string',
                enabled: body?.['enabled'] === true,
              },
            },
            201,
          ),
        );
      }
      if (method === 'POST' && url === '/api/providers/detect-local')
        return Promise.resolve(
          json({ detected: true, baseUrl: 'http://localhost:11434', models: [{ id: 'llama3.1:8b' }], attempts: 1 }),
        );
      if (method === 'POST' && url === '/api/providers/colibri/probe')
        return Promise.resolve(
          json({ detected: false, baseUrl: 'http://127.0.0.1:8471/v1', models: [], reason: 'Nothing answered.', defaultBaseUrl: colibriAdvisoryFixture.defaultBaseUrl }),
        );
      const enable = /^\/api\/providers\/([^/]+)\/enable$/.exec(url);
      if (method === 'POST' && enable !== null) {
        const provider = byId(enable[1] ?? '');
        return Promise.resolve(
          json({ provider, activeProviderId: provider.id, activeProviderName: provider.name, providerCount: 4, hasAnyProvider: true }),
        );
      }
      const disable = /^\/api\/providers\/([^/]+)\/disable$/.exec(url);
      if (method === 'POST' && disable !== null)
        return Promise.resolve(
          json({ provider: byId(disable[1] ?? ''), activeProviderId: null, activeProviderName: null, providerCount: 4, hasAnyProvider: true }),
        );
      const models = /^\/api\/providers\/([^/]+)\/models/.exec(url);
      if (method === 'GET' && models !== null) return Promise.resolve(json(providerModelsFixture));
      const test = /^\/api\/providers\/([^/]+)\/test$/.exec(url);
      if (method === 'POST' && test !== null)
        return Promise.resolve(json(options.testResult ?? { ok: true, message: 'Connected. 3 models available.', modelCount: 3 }));
      const remove = /^\/api\/providers\/[^/]+$/.exec(url);
      if (method === 'DELETE' && remove !== null) return Promise.resolve(new Response(null, { status: 204 }));
      const patch = /^\/api\/providers\/[^/]+$/.exec(url);
      if (method === 'PATCH' && patch !== null) return Promise.resolve(json({ provider: localProviderFixture }));
      const zdr = /^\/api\/providers\/([^/]+)\/zdr$/.exec(url);
      if (method === 'PUT' && zdr !== null) return Promise.resolve(json({ provider: byId(zdr[1] ?? '') }));
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
        <ProvidersSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider list', () => {
  it('renders the backend’s own facts per row', async () => {
    stubApi();
    renderSection();
    expect(await screen.findByText('Ollama on this machine')).toBeInTheDocument();

    const local = within(rowOf('Ollama on this machine'));
    expect(local.getByText('Active')).toBeInTheDocument();
    expect(local.getByText('Runs locally')).toBeInTheDocument();
    expect(local.getByText('Healthy')).toBeInTheDocument();
    expect(local.getByText(/ZDR not applicable/)).toBeInTheDocument();

    const remote = within(rowOf('Hosted endpoint'));
    expect(remote.getByText('Standby')).toBeInTheDocument();
    expect(remote.getByText('Remote')).toBeInTheDocument();
    expect(remote.getByText(/Last error/)).toHaveTextContent('Upstream answered 429 (rate limited).');
    expect(remote.getByText(/Cooling down until/)).toHaveTextContent('rate limit');
    expect(remote.getByText(/ZDR requested/)).toBeInTheDocument();
    // The proxy line discloses the redacted form and refuses the two claims a proxy cannot make.
    expect(remote.getByText(/Egress proxy: configured \(http:\/\/user:\*\*\*@proxy\.example\.test:8080\)/)).toBeInTheDocument();
    expect(remote.getByText(/does not make this provider anonymous/)).toBeInTheDocument();
    expect(remote.getByText(/12 known/)).toBeInTheDocument();
    expect(remote.getByText(/32,768 tokens \(override\)/)).toBeInTheDocument();
  });

  it('shows the first-run empty state', async () => {
    stubApi({ providers: [] });
    renderSection();
    expect(await screen.findByText(/No providers yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add your first provider' })).toBeInTheDocument();
  });

  it('says when providers exist but none is enabled', async () => {
    stubApi({ providers: providersFixture.map((provider) => ({ ...provider, enabled: false })) });
    renderSection();
    expect(await screen.findByText(/No provider is enabled — Chat and Code have nothing to run on/)).toBeInTheDocument();
  });

  it('separates a backend refusal from a response that failed validation', async () => {
    stubApi({ listResponse: () => envelope('internal_error', 'The registry file is unreadable.', 500) });
    const first = renderSection();
    expect(await screen.findByText(/The backend refused: The registry file is unreadable\. \(internal_error\)/)).toBeInTheDocument();
    first.unmount();

    stubApi({
      listResponse: () => json({ providers: [{ id: 'x' }], activeProviderId: null, activeProviderName: null, providerCount: 1, hasAnyProvider: true }),
    });
    renderSection();
    expect(await screen.findByText(/failed validation against this frontend’s contract/)).toBeInTheDocument();
  });

  it('shows per-provider models with reported and unreported context lengths', async () => {
    stubApi();
    renderSection();
    await screen.findByText('Ollama on this machine');
    await userEvent.click(within(rowOf('Ollama on this machine')).getByRole('button', { name: 'Show models' }));
    expect(await screen.findByText('llama3.1:8b')).toBeInTheDocument();
    expect(screen.getByText(/131,072 tokens of context \(as reported\)/)).toBeInTheDocument();
    expect(screen.getByText(/context length not reported/)).toBeInTheDocument();
  });

  it('explains a 402 in the provider’s own words and does not retry it', async () => {
    stubApi({ testResult: { ok: false, message: 'Puter answered 402 (payment required).', code: 'provider_error' } });
    renderSection();
    await screen.findByText('Puter account');
    const row = rowOf('Puter account');
    await userEvent.click(within(row).getByRole('button', { name: 'Test connection' }));
    expect(await within(row).findByText(/Connection failed\. Puter answered 402 \(payment required\)\./)).toBeInTheDocument();
    expect(within(row).getByText(/That is not retried automatically/)).toBeInTheDocument();
  });
});

describe('enable, disable, delete', () => {
  it('names the provider that will be demoted, from the backend’s list, before enabling', async () => {
    const calls = stubApi();
    renderSection();
    await screen.findByText('Hosted endpoint');
    await userEvent.click(within(rowOf('Hosted endpoint')).getByRole('button', { name: 'Enable' }));
    const dialog = screen.getByRole('dialog', { name: 'Enable Hosted endpoint?' });
    expect(await within(dialog).findByText(/is active now and will be moved to standby/)).toBeInTheDocument();
    expect(dialog).toHaveTextContent('“Ollama on this machine” is active now and will be moved to standby');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(screen.getByText(/“Hosted endpoint” is now the active provider\./)).toBeInTheDocument());
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/enable'))).toBe(true);
  });

  it('requires the Colibrì acknowledgement before enabling, and sends it', async () => {
    const calls = stubApi();
    renderSection();
    await screen.findByText('Colibrì (sovereign node)');
    await userEvent.click(within(rowOf('Colibrì (sovereign node)')).getByRole('button', { name: 'Enable' }));
    const dialog = screen.getByRole('dialog', { name: 'Enable Colibrì (sovereign node)?' });
    const confirm = within(dialog).getByRole('button', { name: 'Enable' });
    expect(confirm).toBeDisabled();
    await userEvent.click(await within(dialog).findByLabelText(/I understand Colibrì inference can be extremely slow/));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/enable') && call.body?.['acknowledgeSlow'] === true)).toBe(true),
    );
  });

  it('names the provider that is active at dialog time, not the one from page load', async () => {
    // The page loads with Ollama active. By the time the dialog opens, a fresh
    // read says Colibrì is the active one (another tab, a failover) — the
    // confirmation must name Colibrì, because that is who would be demoted.
    const staleList = providersFixture;
    const freshList = providersFixture.map((provider) => ({
      ...provider,
      enabled: provider.id === 'provider-colibri',
    }));
    stubApi({ listResponses: [() => json(listBody(staleList)), () => json(listBody(freshList))] });
    renderSection();
    await screen.findByText('Hosted endpoint');
    await userEvent.click(within(rowOf('Hosted endpoint')).getByRole('button', { name: 'Enable' }));
    const dialog = screen.getByRole('dialog', { name: 'Enable Hosted endpoint?' });
    expect(await within(dialog).findByText(/“Colibrì \(sovereign node\)” is active now/)).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('“Ollama on this machine” is active now');
  });

  it('pauses the enable confirmation when the fresh read fails, naming nobody', async () => {
    stubApi({
      listResponses: [
        () => json(listBody(providersFixture)),
        () => envelope('internal_error', 'The registry file is unreadable.', 500),
      ],
    });
    renderSection();
    await screen.findByText('Hosted endpoint');
    await userEvent.click(within(rowOf('Hosted endpoint')).getByRole('button', { name: 'Enable' }));
    const dialog = screen.getByRole('dialog', { name: 'Enable Hosted endpoint?' });
    expect(await within(dialog).findByText(/could not be confirmed/)).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('is active now and will be moved to standby');
    expect(within(dialog).getByRole('button', { name: 'Enable' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Try the check again' })).toBeInTheDocument();
  });

  it('deletes only after confirmation', async () => {
    const calls = stubApi();
    renderSection();
    await screen.findByText('Puter account');
    await userEvent.click(within(rowOf('Puter account')).getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Puter account?' });
    expect(dialog).toHaveTextContent('cannot be undone');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByText(/“Puter account” deleted\./)).toBeInTheDocument());
    expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
  });
});

describe('add-provider form, by type', () => {
  const openAdd = async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Add a provider' }));
    return screen.getByRole('dialog', { name: 'Add a provider' });
  };

  it('renders the Puter advisory from the backend instead of hard-coded copy', async () => {
    stubApi();
    renderSection();
    await screen.findByText('Ollama on this machine');
    const dialog = await openAdd();
    await userEvent.selectOptions(within(dialog).getByLabelText('Type'), 'puter');
    expect(await within(dialog).findByText(/Mint an auth token in your Puter account/)).toBeInTheDocument();
    expect(within(dialog).getByText('A paid Puter plan is required.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/API key \(auth token\)/)).toBeInTheDocument();
  });

  it('says so when the advisory cannot be loaded, and the form still works', async () => {
    stubApi({ advisoriesFail: true });
    renderSection();
    await screen.findByText('Ollama on this machine');
    const dialog = await openAdd();
    await userEvent.selectOptions(within(dialog).getByLabelText('Type'), 'colibri');
    expect(await within(dialog).findByText(/The Colibrì advisory could not be loaded/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Base URL')).toBeEnabled();
  });

  it('detects Ollama only when pressed and fills the base URL it found', async () => {
    const calls = stubApi();
    renderSection();
    await screen.findByText('Ollama on this machine');
    const dialog = await openAdd();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Detect Ollama on this machine' }));
    expect(await within(dialog).findByText(/Detected at http:\/\/localhost:11434 — 1 model available/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Base URL')).toHaveValue('http://localhost:11434');
    expect(calls.filter((call) => call.url === '/api/providers/detect-local')).toHaveLength(1);
  });

  it('explains the opencodex non-loopback key from the backend’s note', async () => {
    stubApi();
    renderSection();
    await screen.findByText('Ollama on this machine');
    const dialog = await openAdd();
    await userEvent.selectOptions(within(dialog).getByLabelText('Type'), 'opencodex');
    expect(within(dialog).getByText(/listens beyond loopback it requires its own API key/)).toBeInTheDocument();
  });

  it('requires the acknowledgement to create an enabled Colibrì, then enables in two steps', async () => {
    const calls = stubApi();
    renderSection();
    await screen.findByText('Ollama on this machine');
    const dialog = await openAdd();
    await userEvent.selectOptions(within(dialog).getByLabelText('Type'), 'colibri');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Colibrì two');
    await userEvent.type(within(dialog).getByLabelText('Base URL'), 'http://127.0.0.1:8471/v1');
    await userEvent.click(within(dialog).getByLabelText(/Enable now/));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    expect(await within(dialog).findByText(/Tick the acknowledgement/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByLabelText(/I understand Colibrì inference can be extremely slow/));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a provider' })).not.toBeInTheDocument());
    const create = calls.find((call) => call.method === 'POST' && call.url === '/api/providers');
    expect(create?.body?.['enabled']).toBe(false);
    const enable = calls.find((call) => call.method === 'POST' && call.url.endsWith('/enable'));
    expect(enable?.body).toEqual({ acknowledgeSlow: true });
  });

  it('mirrors route validation and shows server refusals in plain words', async () => {
    stubApi({ createResponse: () => envelope('bad_request', 'baseUrl must be a valid http(s) URL.') });
    renderSection();
    await screen.findByText('Ollama on this machine');
    const dialog = await openAdd();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    expect(await within(dialog).findByText('Give the provider a name.')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Broken');
    await userEvent.type(within(dialog).getByLabelText('Base URL'), 'https://api.example.test');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    expect(await within(dialog).findByText(/The backend refused: baseUrl must be a valid http\(s\) URL\. \(bad_request\)/)).toBeInTheDocument();
  });
});

describe('secrets', () => {
  const SECRET = 'sk-live-SECRET-do-not-print';

  const fillKeyedForm = async (dialog: HTMLElement) => {
    await userEvent.selectOptions(within(dialog).getByLabelText('Type'), 'remote');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Keyed');
    await userEvent.type(within(dialog).getByLabelText('Base URL'), 'https://api.example.test');
    await userEvent.type(within(dialog).getByLabelText('API key'), SECRET);
    await userEvent.type(within(dialog).getByLabelText(/Egress proxy/), 'http://user:proxy-pass@127.0.0.1:8080');
  };

  it('sends the key once, then leaves nothing secret-shaped in storage or the DOM', async () => {
    const calls = stubApi();
    renderSection();
    await screen.findByText('Ollama on this machine');
    await userEvent.click(screen.getByRole('button', { name: 'Add a provider' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a provider' });
    await fillKeyedForm(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Sanity: the secret really was sent, once, in the create body.
    const create = calls.find((call) => call.method === 'POST' && call.url === '/api/providers');
    expect(create?.body?.['apiKey']).toBe(SECRET);
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain('proxy-pass');
    expect(localStorage.length === 0 ? '' : Object.values(localStorage).join('')).not.toContain(SECRET);
    expect(sessionStorage.length === 0 ? '' : Object.values(sessionStorage).join('')).not.toContain(SECRET);
  });

  it('never echoes the key in an error, and unmount takes it out of the DOM', async () => {
    stubApi({ createResponse: () => envelope('bad_request', 'baseUrl is unreachable from here.') });
    renderSection();
    await screen.findByText('Ollama on this machine');
    await userEvent.click(screen.getByRole('button', { name: 'Add a provider' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a provider' });
    await fillKeyedForm(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    // Mutation-check: if the failure path put the key into its message, this
    // assertion fails — the alert renders right here and is read verbatim.
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('baseUrl is unreachable from here.');
    expect(alert.textContent).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain(SECRET);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
  });
});

describe('keyboard operation', () => {
  it('opens the dialog, closes it with Escape, and restores focus', async () => {
    stubApi();
    renderSection();
    await screen.findByText('Ollama on this machine');
    const add = screen.getByRole('button', { name: 'Add a provider' });
    await userEvent.click(add);
    const dialog = screen.getByRole('dialog', { name: 'Add a provider' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Name')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(add).toHaveFocus();
  });
});

describe('Settings shell', () => {
  it('routes every section to its live surface; none names a future slice', async () => {
    // An all-404 stub: each section renders its own honest error state,
    // which is still a live section — the assertion is that the shell
    // itself no longer parks any section behind a "not built yet" panel.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'not_found', message: 'No stub.', retryable: false } }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/settings/agents']}>
          <Routes>
            <Route path="/settings/*" element={<SettingsTool />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Agents and permissions' })).toBeInTheDocument();
    expect(screen.queryByText(/not built yet|arrives with Settings/)).not.toBeInTheDocument();
    for (const label of ['Providers', 'Safety and limits', 'Memory and data', 'Agents and permissions']) {
      expect(screen.getAllByRole('link', { name: new RegExp(label) }).length).toBeGreaterThan(0);
    }
  });
});
