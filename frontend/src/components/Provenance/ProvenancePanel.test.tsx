import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  KnowledgeSourceList,
  ProvenancePanel,
  VersionTimeline,
} from './ProvenancePanel';
import type { ArtifactVersion, RunKnowledgeSource } from '../../contracts/wire/provenance';

const version = (over: Partial<ArtifactVersion> = {}): ArtifactVersion => ({
  id: 'v3',
  artifactKey: 'plan.md',
  tool: 'code',
  version: 3,
  label: 'present',
  inline: true,
  bytes: 42,
  sha256: 'a'.repeat(64),
  createdAt: 1_766_000_000_000,
  parentVersion: 2,
  ...over,
});

const source = (over: Partial<RunKnowledgeSource> = {}): RunKnowledgeSource => ({
  sourceId: 'src-1',
  label: 'House style',
  filename: 'style.md',
  bytes: 120,
  sha256: 'b'.repeat(64),
  usedAt: 1_766_000_000_000,
  ...over,
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The request as a label: the client only passes paths, but the global's type is wider. */
function pathOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provenance, rendered', () => {
  it('states the version chain, including the first version that has no parent', () => {
    render(<VersionTimeline versions={[version(), version({ id: 'v1', version: 1, parentVersion: null })]} />);

    // Two things at once: which version replaced which, and that "no parent" is a
    // beginning rather than an unknown.
    expect(screen.getAllByText(/replaced v2/).length).toBe(1);
    // The distinction the backend's derivation buys: a null parent reads as a
    // beginning, in those words, and never as an unknown.
    expect(screen.getAllByText(/first version/).length).toBe(1);
    // Both rows are the same fixture but for their version, so the size appears
    // twice; the assertion that matters is presence, not uniqueness.
    expect(screen.getAllByText(/42 bytes/).length).toBe(2);
    // The digest is shown abbreviated; the full value is not needed to identify a
    // version beside its number.
    expect(screen.getAllByText(/aaaaaaaa…/).length).toBe(2);
  });

  it('says a stored-as-file version is one, rather than implying inline content', () => {
    render(<VersionTimeline versions={[version({ inline: false })]} />);
    expect(screen.getByText(/stored as a file/)).toBeInTheDocument();
  });

  it('explains an empty timeline instead of showing a blank', () => {
    render(<VersionTimeline versions={[]} />);
    // A version is written on write, so an unedited file has none — that is not
    // the same as "no history exists".
    expect(screen.getByText(/A version is written before each edit/)).toBeInTheDocument();
  });

  it('shows the sources actually used, and admits a missing digest', () => {
    render(
      <KnowledgeSourceList
        sources={[source(), source({ sourceId: 'src-2', label: null, filename: 'raw.csv', sha256: null })]}
      />,
    );

    expect(screen.getByText('House style')).toBeInTheDocument();
    // A source with no label falls back to its filename, rather than rendering blank.
    expect(screen.getByText('raw.csv')).toBeInTheDocument();
    expect(screen.getByText(/digest not recorded/)).toBeInTheDocument();
  });

  it('says no evidence was used in as many words', () => {
    render(<KnowledgeSourceList sources={[]} />);
    expect(screen.getByText(/No knowledge sources were used as evidence/)).toBeInTheDocument();
  });

  it('renders each half of the panel independently, and shows a failure as one', async () => {
    // The two reads come from different routes and different stores: a version
    // timeline that fails must not take the knowledge list down with it, and a
    // failed read must never render as "none".
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = pathOf(input);
        if (url.startsWith('/api/artifacts/versions')) {
          return Promise.resolve(json({ error: { code: 'internal_error', message: 'boom', retryable: true } }, 500));
        }
        return Promise.resolve(json({ run: { runId: 'r1', taskId: 't1', state: 'complete', startedAt: 1, updatedAt: 2 }, knowledgeSources: [source()] }));
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ProvenancePanel artifactKey="plan.md" taskId="t1" />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(await screen.findByText('House style')).toBeInTheDocument();
    // The empty-timeline copy must not appear on a failure — that is the exact
    // confusion this test exists for.
    expect(screen.queryByText(/A version is written before each edit/)).not.toBeInTheDocument();
  });
});
