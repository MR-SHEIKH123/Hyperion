import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { AppShell } from '../shell/AppShell';
import { ToolPlaceholder } from '../shell/ToolPlaceholder';

function withProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>;
}

describe('app shell', () => {
  it('renders the eight tools with the current one marked', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'ok',
            checkedAt: Date.now(),
            uptimeSec: 1,
            components: {
              providers: {
                status: 'ok',
                detail: 'No providers configured.',
                total: 0,
                active: null,
                failoverCandidates: 0,
                healthy: 0,
                degraded: 0,
                unhealthy: 0,
                unknown: 0,
              },
              mcp: { status: 'ok', detail: 'No MCP servers.', managed: true, total: 0, running: 0, errored: 0 },
              errors: { status: 'ok', detail: 'No server errors in the last hour.', windowMs: 3600000, count: 0 },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    render(
      withProviders(
        <MemoryRouter initialEntries={['/design']}>
          <AppShell />
        </MemoryRouter>,
      ),
    );

    expect(screen.getByText('Hyperion')).toBeInTheDocument();
    for (const tool of ['Chat', 'Code', 'Cowork', 'Design', 'Playground', 'Plugins', 'Skills', 'Settings']) {
      expect(screen.getByRole('link', { name: new RegExp(tool) })).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: /Design/ })).toHaveAttribute('aria-current', 'page');
  });
});

describe('tool placeholder', () => {
  it('derives the current tool without coupling navigation to feature code', () => {
    render(
      <MemoryRouter initialEntries={['/code']}>
        <ToolPlaceholder />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Code' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/not built in this frontend milestone/i);
  });
});
