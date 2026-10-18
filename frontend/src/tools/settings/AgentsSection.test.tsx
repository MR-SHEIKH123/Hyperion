import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  builtinProfilesFixture,
  importOutcomeFixture,
  permissionsFixture,
  profilesFixture,
  projectAgentsFixture,
  projectCommandsFixture,
} from '../../dev-harness/fixtures/agents';
import { AgentsSection } from './AgentsSection';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const envelope = (code: string, message: string, status = 400) =>
  json({ error: { code, message, retryable: false } }, status);

interface Call {
  method: string;
  url: string;
  body: unknown;
  form?: FormData;
}

function stubAgentsApi(overrides: Record<string, (call: Call) => Response> = {}) {
  const calls: Call[] = [];
  const routes: Record<string, (call: Call) => Response> = {
    'GET /api/settings/agent-profiles?includeHidden=true': () =>
      json({ count: profilesFixture.length, defaultProfile: 'reviewer', profiles: profilesFixture }),
    'GET /api/settings/agents': () =>
      json({
        defaultAgentProfile: 'reviewer',
        resolvedFor: { ask: 'ask', plan: 'plan', act: 'reviewer' },
        builtin: builtinProfilesFixture,
      }),
    'PUT /api/settings/agents': (call) =>
      json({ defaultAgentProfile: (call.body as Record<string, unknown>)['defaultAgentProfile'] || null }),
    'GET /api/code/rules': () =>
      json({
        source: 'hyperion',
        scopeEnforced: false,
        count: 1,
        matchedCount: 0,
        rules: [
          { name: 'No force pushes', description: null, path: '.hyperion/rules/git.md', scope: null, matched: false },
        ],
      }),
    'GET /api/code/agents': () => json({ count: projectAgentsFixture.length, agents: projectAgentsFixture }),
    'GET /api/code/commands': () =>
      json({ count: projectCommandsFixture.length, commands: projectCommandsFixture }),
    'POST /api/code/agents/import': () => json(importOutcomeFixture),
    ...overrides,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? 'GET';
      const isForm = init?.body instanceof FormData;
      const call: Call = {
        method,
        url,
        body: isForm ? undefined : typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        ...(isForm ? { form: init!.body as FormData } : {}),
      };
      calls.push(call);
      const key = `${method} ${url}`;
      const handler =
        routes[key] ?? (url.startsWith('/api/code/permissions') ? () => json(permissionsFixture) : undefined);
      if (handler === undefined) return Promise.resolve(envelope('not_found', `No stub for ${key}`, 404));
      return Promise.resolve(handler(call));
    }),
  );
  return calls;
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AgentsSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Default profile', () => {
  it('shows what ask and plan resolve to regardless of the stored default', async () => {
    stubAgentsApi();
    renderSection();
    expect(await screen.findByText(/Stored default: “reviewer”, used by Act runs/)).toBeInTheDocument();
    expect(screen.getByText(/Ask always resolves to ask/)).toBeInTheDocument();
  });

  it('clears the default with the empty-string spelling the route requires', async () => {
    const calls = stubAgentsApi();
    renderSection();
    await screen.findByText(/Stored default: “reviewer”/);
    await userEvent.selectOptions(screen.getByLabelText('Default for Act runs'), '');
    await userEvent.click(screen.getByRole('button', { name: 'Save default' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ defaultAgentProfile: '' });
    expect(await screen.findByText(/Stored default cleared/)).toBeInTheDocument();
  });
});

describe('Profiles', () => {
  it('lists hidden and subagent-only profiles with badges instead of hiding them', async () => {
    stubAgentsApi();
    renderSection();
    const owl = (await screen.findByText('Hidden from run pickers')).closest('li')!;
    expect(owl).toHaveTextContent('night-owl');
    const fetcher = screen.getByText('Subagent only').closest('li')!;
    expect(fetcher).toHaveTextContent('fetcher');
  });
});

describe('Profile import', () => {
  it('imports directly under skip, per-file results shown, no confirm field sent', async () => {
    const calls = stubAgentsApi();
    renderSection();
    await screen.findByText('Hidden from run pickers');
    const input = screen.getByLabelText('Profile files (.md)');
    await userEvent.upload(input, [
      new File(['# New'], 'new-helper.md', { type: 'text/markdown' }),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText(/Filed 2 of 4 into Wire project/)).toBeInTheDocument();
    expect(screen.getByText('notes.txt').closest('li')).toHaveTextContent('Invalid');
    const importCall = calls.find((call) => call.url === '/api/code/agents/import')!;
    expect(importCall.form!.get('onConflict')).toBe('skip');
    expect(importCall.form!.get('confirm')).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('requires a confirmation naming the files overwrite would replace', async () => {
    const calls = stubAgentsApi();
    renderSection();
    await screen.findByText('Hidden from run pickers');
    const input = screen.getByLabelText('Profile files (.md)');
    // reviewer.md collides with the listed .hyperion/agents/reviewer.md.
    await userEvent.upload(input, [
      new File(['# Reviewer v2'], 'reviewer.md', { type: 'text/markdown' }),
      new File(['# Fresh'], 'fresh.md', { type: 'text/markdown' }),
    ]);
    await userEvent.click(screen.getByRole('radio', { name: /Replace the existing file/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Import (overwrite)…' }));
    const dialog = screen.getByRole('dialog', { name: 'Replace existing profiles?' });
    expect(dialog).toHaveTextContent('reviewer.md');
    expect(dialog).toHaveTextContent(/replaces the profile “reviewer”/);
    expect(dialog).toHaveTextContent(/contents are lost/);
    // The gate: nothing has been sent yet.
    expect(calls.some((call) => call.url === '/api/code/agents/import')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace and import' }));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/code/agents/import')).toBe(true));
    const importCall = calls.find((call) => call.url === '/api/code/agents/import')!;
    expect(importCall.form!.get('onConflict')).toBe('overwrite');
    expect(importCall.form!.get('confirm')).toBe('true');
  });

  it('shows the no-active-project refusal in the backend’s own words', async () => {
    stubAgentsApi({
      'POST /api/code/agents/import': () =>
        json(
          { error: { code: 'conflict', message: 'Open a project before importing agent profiles.', retryable: false } },
          409,
        ),
    });
    renderSection();
    await screen.findByText('Hidden from run pickers');
    await userEvent.upload(screen.getByLabelText('Profile files (.md)'), [
      new File(['# X'], 'x.md', { type: 'text/markdown' }),
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText(/Open a project before importing agent profiles\./)).toBeInTheDocument();
    expect(screen.queryByText(/Filed \d+ of/)).not.toBeInTheDocument();
  });
});

describe('Permissions view', () => {
  it('renders the layers in evaluation order and offers no edit control', async () => {
    stubAgentsApi();
    renderSection();
    const headings = await screen.findAllByRole('heading', { level: 4 });
    const layerHeadings = headings.map((heading) => heading.textContent ?? '').filter((text) => /builtin|profile|project/.test(text));
    expect(layerHeadings[0]).toMatch(/^builtin/);
    expect(layerHeadings[1]).toMatch(/^profile/);
    expect(layerHeadings[2]).toMatch(/^project/);
    expect(screen.getByText(/There is no edit control here/)).toBeInTheDocument();
    expect(screen.getByText(/git \*/).closest('li')).toHaveTextContent('allow');
  });

  it('links to Reload Config in Safety and limits instead of duplicating it', async () => {
    stubAgentsApi();
    renderSection();
    const link = await screen.findByRole('link', { name: /Reload Config in Safety and limits/ });
    expect(link).toHaveAttribute('href', '/settings/safety');
    expect(screen.queryByRole('button', { name: /Reload/ })).not.toBeInTheDocument();
  });
});
