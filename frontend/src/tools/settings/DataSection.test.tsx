import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assetsFixture,
  cleanupDryRunFixture,
  emptyUsageFixture,
  exposureFixture,
  inspectionFixture,
  pricesFixture,
  s3ConfiguredFixture,
  s3TestReportFixture,
  storageStatsFixture,
  usageSummaryFixture,
  backupFilesFixture,
} from '../../dev-harness/fixtures/data';
import { BackupSection } from './BackupPanel';
import { S3Section } from './S3Panel';
import { StorageSection } from './StoragePanel';
import { UsageSection } from './UsagePanel';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const envelope = (code: string, message: string, status = 400) =>
  json({ error: { code, message, retryable: false } }, status);

interface Call {
  method: string;
  url: string;
  body: unknown;
}

type Handler = (body: Record<string, unknown>) => Response;

function stubDataApi(overrides: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const routes: Record<string, Handler> = {
    'GET /api/backup': () => json({ backups: backupFilesFixture }),
    'GET /api/backup/destinations': () =>
      json({ local: { directory: '/home/user/Hyperion/Hyperion/backups', mirror: null }, s3: s3ConfiguredFixture }),
    'GET /api/backup/restores': () => json({ restores: [] }),
    'POST /api/backup/inspect': () => json({ inspection: inspectionFixture }),
    'POST /api/backup/import': () =>
      json({
        restored: true,
        dryRun: false,
        inspection: inspectionFixture,
        preRestoreBackup: 'pre-restore.zip',
        filesWritten: { database: true, mcpConfig: false, skills: 3, attachments: 12 },
        restartRequired: true,
      }),
    'PUT /api/backup/destinations/s3': () => json({ s3: s3ConfiguredFixture }),
    'POST /api/backup/destinations/s3/test': () => json(s3TestReportFixture),
    'GET /api/storage/stats': () => json(storageStatsFixture),
    'GET /api/storage/assets': () =>
      json({ assets: assetsFixture, total: assetsFixture.length, totalBytes: 1_984_000, limit: 200, offset: 0 }),
    'GET /api/storage/cleanup/log': () => json({ entries: [] }),
    'POST /api/storage/cleanup': (body) =>
      json(body['dryRun'] === true ? cleanupDryRunFixture : { ...cleanupDryRunFixture, dryRun: false }),
    'GET /api/usage': () => json(usageSummaryFixture),
    'GET /api/usage/exposure-summary': () => json(exposureFixture),
    'GET /api/usage/prices': () => json({ prices: pricesFixture }),
    'PUT /api/usage/prices': (body) => json({ price: body }),
    'DELETE /api/usage/prices': () => json({ deleted: true }),
    ...overrides,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : (init?.body ?? undefined);
      calls.push({ method, url, body });
      const handler = routes[`${method} ${url}`];
      if (handler === undefined) return Promise.resolve(envelope('not_found', `No stub for ${method} ${url}`, 404));
      return Promise.resolve(handler(body as Record<string, unknown>));
    }),
  );
  return calls;
}

function renderSection(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

const SECRET = 'S3CR3T-fixture-value-9f2';

function expectSecretNowhere(secret: string, field: HTMLElement) {
  expect((field as HTMLInputElement).value).toBe('');
  expect(document.body.textContent ?? '').not.toContain(secret);
  for (const store of [localStorage, sessionStorage]) {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index)!;
      expect(store.getItem(key) ?? '').not.toContain(secret);
    }
  }
}

describe('Backup and restore', () => {
  it('keeps restore disabled until an inspection is on screen, then confirms the replacement', async () => {
    const calls = stubDataApi();
    renderSection(<BackupSection />);
    expect(await screen.findByRole('button', { name: 'Restore…' })).toBeDisabled();
    await screen.findByText('hyperion-2026-10-17.zip');
    await userEvent.click(screen.getAllByRole('button', { name: 'Restore this…' })[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Inspect archive' }));
    expect(await screen.findByText(/Passphrase-protected archive/)).toBeInTheDocument();
    const restore = screen.getByRole('button', { name: 'Restore…' });
    expect(restore).toBeEnabled();
    await userEvent.click(restore);
    const dialog = screen.getByRole('dialog', { name: 'Restore this archive?' });
    expect(dialog).toHaveTextContent(/replaces the current database/);
    expect(calls.some((call) => call.url === '/api/backup/import')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace current data' }));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/backup/import')).toBe(true));
    expect(await screen.findByText(/Restored\. Snapshot of the previous data: pre-restore\.zip/)).toBeInTheDocument();
  });

  it('clears the export passphrase after a failed export and never puts it in a URL or error', async () => {
    const calls = stubDataApi({
      'POST /api/backup/export': () => envelope('conflict', 'S3 backup destination is not configured.', 409),
    });
    renderSection(<BackupSection />);
    await screen.findByText(/No archives on disk yet|hyperion-2026-10-17/);
    const field = screen.getByLabelText(/Passphrase \(optional\)/);
    await userEvent.type(field, 'p4ss phrase');
    await userEvent.click(screen.getByRole('button', { name: 'Export backup' }));
    expect(await screen.findByText(/S3 backup destination is not configured/)).toBeInTheDocument();
    expect((field as HTMLInputElement).value).toBe('');
    expect(document.body.textContent ?? '').not.toContain('p4ss phrase');
    const exportCall = calls.find((call) => call.url.startsWith('/api/backup/export'))!;
    expect(exportCall.url).toBe('/api/backup/export');
    expect((exportCall.body as Record<string, unknown>)['passphrase']).toBe('p4ss phrase');
  });
});

describe('S3 destination', () => {
  it('sends only the secret when only the secret was typed, and clears it on success', async () => {
    const calls = stubDataApi();
    renderSection(<S3Section />);
    expect(await screen.findByText(/A secret is stored/)).toBeInTheDocument();
    const field = screen.getByLabelText('Secret access key');
    await userEvent.type(field, SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Save destination' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT')!;
    expect(put.body).toEqual({ secretAccessKey: SECRET });
    await waitFor(() => expectSecretNowhere(SECRET, screen.getByLabelText('Secret access key')));
  });

  it('clears the secret after a failed save and keeps it out of the rendered error', async () => {
    stubDataApi({
      'PUT /api/backup/destinations/s3': () => envelope('bad_request', 'S3 bucket must be a valid bucket name.'),
    });
    renderSection(<S3Section />);
    await screen.findByText(/A secret is stored/);
    const field = screen.getByLabelText('Secret access key');
    await userEvent.type(field, SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Save destination' }));
    expect(await screen.findByText(/S3 bucket must be a valid bucket name/)).toBeInTheDocument();
    await waitFor(() => expectSecretNowhere(SECRET, screen.getByLabelText('Secret access key')));
  });

  it('reports a failed delete step as a warning, not a failure', async () => {
    stubDataApi();
    renderSection(<S3Section />);
    await screen.findByText(/A secret is stored/);
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/answered the full round trip/)).toBeInTheDocument();
    const deleteRow = screen.getByText(/Delete the probe object/).closest('li')!;
    expect(deleteRow).toHaveTextContent('Warning');
    expect(deleteRow).toHaveTextContent(/left behind/);
    expect(screen.getAllByText('Passed')).toHaveLength(2);
  });
});

describe('Storage and cleanup', () => {
  it('gates the real cleanup on a dry-run preview and a confirmation naming the counts', async () => {
    const calls = stubDataApi();
    renderSection(<StorageSection />);
    expect(await screen.findByRole('button', { name: 'Run cleanup…' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Preview cleanup (dry run)' }));
    expect(await screen.findByText(/Dry run — nothing was removed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run cleanup…' }));
    const dialog = screen.getByRole('dialog', { name: 'Run cleanup?' });
    expect(dialog).toHaveTextContent(/found 4 chats and 11 files/);
    expect(
      calls.some(
        (call) => call.url === '/api/storage/cleanup' && (call.body as Record<string, unknown>)['dryRun'] === false,
      ),
    ).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run cleanup' }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.url === '/api/storage/cleanup' && (call.body as Record<string, unknown>)['dryRun'] === false,
        ),
      ).toBe(true),
    );
  });

  it('requires a confirmation naming the file before deleting an asset', async () => {
    const calls = stubDataApi();
    renderSection(<StorageSection />);
    const row = (await screen.findByText('render.webp')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Delete…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this file?' });
    expect(dialog).toHaveTextContent('render.webp');
    expect(dialog).toHaveTextContent(/cannot be undone/);
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/storage/assets/ast-2')).toBe(true),
    );
  });

  it('marks a missing file and a pin without colour alone', async () => {
    stubDataApi();
    renderSection(<StorageSection />);
    const missing = (await screen.findByText('render.webp')).closest('li')!;
    expect(missing).toHaveTextContent('File missing');
    const pinned = screen.getByText('logo-final.png').closest('li')!;
    expect(pinned).toHaveTextContent('Pinned');
  });
});

describe('Usage', () => {
  it('stands every cost beside its unpriced count and never calls silence zero', async () => {
    stubDataApi();
    renderSection(<UsageSection />);
    expect((await screen.findAllByText(/\$14\.20/)).length).toBeGreaterThan(1);
    expect(screen.getAllByText(/37 requests have no recorded price/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Cache reads: Not reported/)).toBeInTheDocument();
  });

  it('says nothing was recorded instead of a zero spend', async () => {
    stubDataApi({ 'GET /api/usage': () => json(emptyUsageFixture) });
    renderSection(<UsageSection />);
    expect((await screen.findAllByText('Nothing was recorded.')).length).toBeGreaterThan(0);
    // Any literal $0.00 that does appear must stand beside its unpriced
    // explanation — a bare zero is the one rendering that would lie.
    for (const zero of screen.queryAllByText('$0.00')) {
      expect(zero.closest('tr, p')?.textContent ?? '').toMatch(/no recorded price|Nothing was recorded/);
    }
  });

  it('validates a price as the route does before sending anything', async () => {
    const calls = stubDataApi();
    renderSection(<UsageSection />);
    await screen.findAllByText(/\$14\.20/);
    await userEvent.click(screen.getByRole('button', { name: 'Add a price…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save price' }));
    expect(await screen.findByText('Model is required.')).toBeInTheDocument();
    expect(screen.getByText('Input price is required.')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    await userEvent.type(screen.getByLabelText('Model ID'), 'wire-unpriced');
    await userEvent.type(screen.getByLabelText(/Input, USD per 1M/), 'l0ts');
    await userEvent.click(screen.getByRole('button', { name: 'Save price' }));
    expect(await screen.findByText('Input price must be a number.')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    await userEvent.clear(screen.getByLabelText(/Input, USD per 1M/));
    await userEvent.type(screen.getByLabelText(/Input, USD per 1M/), '2.5');
    await userEvent.type(screen.getByLabelText(/Output, USD per 1M/), '7');
    await userEvent.click(screen.getByRole('button', { name: 'Save price' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT')!;
    expect(put.body).toEqual({ modelId: 'wire-unpriced', providerId: null, inputPer1mUsd: 2.5, outputPer1mUsd: 7 });
  });
});
