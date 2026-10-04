import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChangedFiles } from './ChangedFiles';

/**
 * The changed-file list, rendered (the session panel's first slice).
 *
 * What is worth testing is not that rows appear, but the three claims the panel
 * makes and could get wrong: the counts are the patch's counts, a refusal from
 * the backend arrives as a refusal rather than as an empty list, and a file that
 * changed nothing visible is not shown as a file that changed nothing at all.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const diffBody = (patch: string, baseCommit = 'abcdef1234567890') => ({
  taskId: 'task-1',
  baseCommit,
  patch,
});

const MODIFIED_PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  '-one',
  '-two',
  '+one',
  '+two',
  '+three',
  '',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n');

function renderPanel(onSelect = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ChangedFiles taskId="task-1" selectedPath={null} onSelect={onSelect} />
    </QueryClientProvider>,
  );
  return onSelect;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the changed-file list', () => {
  it('lists every file with its own counts, and totals in the header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(diffBody(MODIFIED_PATCH)))),
    );
    renderPanel();

    const list = await screen.findByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    // The counts come from the patch, per file — not from the totals divided up.
    expect(within(rows[0]!).getByText('src/a.ts')).toBeDefined();
    expect(within(rows[0]!).getByText('+3')).toBeDefined();
    expect(within(rows[0]!).getByText('−2')).toBeDefined();

    // A binary file has no line counts at all, and saying "0 +0 −0" would read as
    // "nothing happened", which is exactly what a binary change is not.
    expect(within(rows[1]!).getByText('binary')).toBeDefined();
    expect(within(rows[1]!).queryByText('+0')).toBeNull();

    expect(screen.getByText('2 files · +3 −2')).toBeDefined();
    // The base commit is named, because the list is scoped to it — never to a step.
    expect(screen.getByText(/against abcdef123456/)).toBeDefined();
  });

  it('shows the backend’s refusal as a refusal, never as an empty change list', async () => {
    // A direct-mode task: the exporter's 400, in its own words.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(json(
          {
            error: {
              code: 'bad_request',
              message: 'This task works directly in its project directory, so it has no base commit to diff against.',
              retryable: false,
            },
          },
          400,
        )),
      ),
    );
    renderPanel();

    // Wait for the failure to land — the point is what shows *instead* of a list.
    expect(await screen.findByRole('alert')).toBeDefined();
    // The distinction the panel exists to keep: nothing here may read as "no changes".
    expect(screen.queryByText(/No changes against/)).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('says a task has no changes when it truly has none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(diffBody('')))),
    );
    renderPanel();

    expect(await screen.findByText('No changes against the base commit.')).toBeDefined();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('hands the clicked path to the surface, which is what fills ?file=', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(diffBody(MODIFIED_PATCH)))),
    );
    const onSelect = renderPanel();

    await userEvent.click(await screen.findByText('src/a.ts'));
    expect(onSelect).toHaveBeenCalledWith('src/a.ts');
  });
});
