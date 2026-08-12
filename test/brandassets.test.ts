/**
 * Brand-approved assets — Prompt 1.22.
 *
 * Two guarantees are worth more than the rest of this file: an approved asset
 * survives a retention sweep it would otherwise have failed, and approval is a
 * separate axis from `pinned` rather than an alias for it. Both are asserted
 * against a real sweep and a real HTTP request, because the exemption lives in
 * SQL WHERE clauses in `cleanup.ts` — reading `setAssetBrandApproved` proves
 * nothing about whether the reaper honours the flag.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { after, before, describe } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

import type { Server } from 'node:http';

const { getDb } = await import('../src/db/adapter.ts');
const {
  assetPath,
  listApprovedAssets,
  listAssets,
  requireAsset,
  setAssetBrandApproved,
  setAssetPinned,
  saveAsset,
} = await import('../src/services/storage/gallery.ts');
const { runCleanup } = await import('../src/services/storage/cleanup.ts');

const DAY_MS = 24 * 60 * 60 * 1000;

let server: Server;
let base: string;

before(async () => {
  await freshDb();
  const { createApp } = await import('../src/http/app.ts');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo from listen(0)');
  }
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

/** A stored asset. Plain text, so the sharp-optional image path is not involved. */
async function makeAsset(filename: string): Promise<string> {
  const asset = await saveAsset({
    filename,
    buffer: Buffer.from(`contents of ${filename}`),
    mimeType: 'text/plain',
  });
  return asset.id;
}

/** Age an asset past the reaper's cutoff without waiting three months. */
function ageAsset(id: string, days: number): void {
  getDb()
    .prepare('UPDATE attachments SET last_accessed_at = ? WHERE id = ?')
    .run(Date.now() - days * DAY_MS, id);
}

describe('approval is its own axis, not a second name for pinning', () => {
  test('a newly stored asset is unapproved with no approval timestamp', async () => {
    const id = await makeAsset('fresh.txt');
    const asset = requireAsset(id);

    assert.equal(asset.brandApproved, false);
    assert.equal(asset.brandApprovedAt, null);
    // The migration's DEFAULT 0 is what supplies this: saveAsset's INSERT does
    // not name either column, and a test that passed only because the insert
    // listed them would hide a broken default on every pre-existing row.
    assert.equal(asset.pinned, false);
  });

  test('approving an asset does not pin it, and pinning does not approve it', async () => {
    const approved = await makeAsset('logo.txt');
    const pinned = await makeAsset('receipt.txt');

    setAssetBrandApproved(approved, true);
    setAssetPinned(pinned, true);

    assert.equal(requireAsset(approved).brandApproved, true);
    assert.equal(requireAsset(approved).pinned, false);
    assert.equal(requireAsset(pinned).pinned, true);
    assert.equal(requireAsset(pinned).brandApproved, false);
  });

  test('approval records when the decision was made', async () => {
    const before = Date.now();
    const id = await makeAsset('stamped.txt');
    const asset = setAssetBrandApproved(id, true);

    assert.equal(asset.brandApproved, true);
    assert.ok(asset.brandApprovedAt !== null, 'an approved asset carries a timestamp');
    assert.ok(asset.brandApprovedAt >= before);
    assert.ok(asset.brandApprovedAt <= Date.now());
  });

  test('revoking approval clears the timestamp rather than leaving it stale', async () => {
    const id = await makeAsset('revoked.txt');
    setAssetBrandApproved(id, true);

    const asset = setAssetBrandApproved(id, false);
    assert.equal(asset.brandApproved, false);
    // A leftover timestamp would order the approved listing by a decision the
    // user has since taken back.
    assert.equal(asset.brandApprovedAt, null);
  });

  test('omitting the flag toggles, which is what a single button sends', async () => {
    const id = await makeAsset('toggle.txt');

    assert.equal(setAssetBrandApproved(id).brandApproved, true);
    assert.equal(setAssetBrandApproved(id).brandApproved, false);
    assert.equal(setAssetBrandApproved(id).brandApprovedAt !== null, true);
  });

  test('approving an asset that does not exist is not_found, not a silent no-op', async () => {
    assert.throws(
      () => setAssetBrandApproved('ast_nope', true),
      (error: unknown) => (error as { code?: string }).code === 'not_found',
    );
  });
});

describe('the approved set is what an agent reads to find the real brand', () => {
  test('the listing holds only approved assets, newest decision first', async () => {
    const first = await makeAsset('mark-old.txt');
    const second = await makeAsset('mark-new.txt');
    await makeAsset('unrelated.txt');

    setAssetBrandApproved(first, true);
    // Move the first decision into the past so the ordering assertion cannot
    // pass by accident on two identical millisecond timestamps.
    getDb()
      .prepare('UPDATE attachments SET brand_approved_at = ? WHERE id = ?')
      .run(Date.now() - 60_000, first);
    setAssetBrandApproved(second, true);

    const approved = listApprovedAssets();
    // Scoped to this test's own assets: earlier cases leave approved rows
    // behind, and asserting on the whole listing would couple this guarantee to
    // the order the file happens to run in.
    const ids = approved.map((asset) => asset.id).filter((id) => id === first || id === second);

    assert.deepEqual(ids, [second, first]);
    assert.ok(approved.every((asset) => asset.brandApproved));
  });

  test('an unapproved asset drops straight back out of the listing', async () => {
    const id = await makeAsset('temporary-brand.txt');
    setAssetBrandApproved(id, true);
    assert.ok(listApprovedAssets().some((asset) => asset.id === id));

    setAssetBrandApproved(id, false);
    assert.ok(!listApprovedAssets().some((asset) => asset.id === id));
  });

  test('the gallery can filter on approval from the query string', async () => {
    const id = await makeAsset('filtered.txt');
    setAssetBrandApproved(id, true);

    const onlyApproved = listAssets({ brandApproved: true });
    const onlyUnapproved = listAssets({ brandApproved: false });

    assert.ok(onlyApproved.assets.every((asset) => asset.brandApproved));
    assert.ok(onlyApproved.assets.some((asset) => asset.id === id));
    assert.ok(!onlyUnapproved.assets.some((asset) => asset.id === id));
    // `total` describes the filtered set, not the table.
    assert.equal(onlyApproved.total, onlyApproved.assets.length);
  });
});

describe('the retention sweep leaves the brand alone', () => {
  test('an approved asset survives a sweep that reaps its unapproved twin', async () => {
    const approved = await makeAsset('brand-logo.txt');
    const doomed = await makeAsset('screenshot.txt');
    setAssetBrandApproved(approved, true);

    ageAsset(approved, 200);
    ageAsset(doomed, 200);

    const result = runCleanup({ assetTtlDays: 90 });
    const reaped = result.detail.assets.map((asset) => asset.id);

    assert.ok(reaped.includes(doomed), 'the sweep was actually old enough to delete something');
    assert.ok(!reaped.includes(approved));
    // Not just absent from the log — still on disk and still in the table.
    assert.equal(requireAsset(approved).brandApproved, true);
    assert.ok(fs.existsSync(assetPath(requireAsset(approved))));
  });

  test('approval alone is enough: the user need not also have pinned it', async () => {
    const id = await makeAsset('unpinned-brand.txt');
    setAssetBrandApproved(id, true);
    assert.equal(requireAsset(id).pinned, false);

    ageAsset(id, 200);
    runCleanup({ assetTtlDays: 90 });

    assert.equal(requireAsset(id).brandApproved, true);
  });

  test('an approved asset whose file vanished is kept so the loss is visible', async () => {
    const id = await makeAsset('vanished-brand.txt');
    setAssetBrandApproved(id, true);
    fs.rmSync(assetPath(requireAsset(id)));

    const result = runCleanup({ assetTtlDays: 90 });

    // The file_missing sweep ignores age, so this row would go on the next tick
    // if the exemption were missing from that second query as well.
    assert.ok(!result.detail.assets.some((asset) => asset.id === id));
    assert.equal(requireAsset(id).brandApproved, true);
  });

  test('a dry run reports the same exemption rather than a different one', async () => {
    const approved = await makeAsset('preview-brand.txt');
    const doomed = await makeAsset('preview-junk.txt');
    setAssetBrandApproved(approved, true);
    ageAsset(approved, 200);
    ageAsset(doomed, 200);

    const preview = runCleanup({ assetTtlDays: 90, dryRun: true });
    const listed = preview.detail.assets.map((asset) => asset.id);

    assert.ok(listed.includes(doomed));
    assert.ok(!listed.includes(approved));
    // A preview that removed anything would be a far worse bug than a wrong count.
    assert.equal(requireAsset(doomed).id, doomed);
  });
});

describe('the design routes over HTTP', () => {
  test('approving returns the updated asset, and the approved listing includes it', async () => {
    const id = await makeAsset('http-logo.txt');

    const res = await fetch(`${base}/api/design/assets/${id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    const payload = (await res.json()) as {
      asset: { id: string; brandApproved: boolean; brandApprovedAt: number | null; url: string };
    };

    assert.equal(res.status, 200);
    assert.equal(payload.asset.id, id);
    assert.equal(payload.asset.brandApproved, true);
    assert.ok(payload.asset.brandApprovedAt !== null);
    // The public shape, so no absolute path leaks to the frontend.
    assert.ok(!JSON.stringify(payload.asset).includes('C:\\'));
    assert.match(payload.asset.url, /^\/api\/storage\/assets\//);

    const listed = await fetch(`${base}/api/design/assets/approved`);
    const body = (await listed.json()) as { assets: { id: string }[]; total: number };
    assert.equal(listed.status, 200);
    assert.ok(body.assets.some((asset) => asset.id === id));
    assert.equal(body.total, body.assets.length);
  });

  test('unapprove is idempotent, so a double click cannot re-approve', async () => {
    const id = await makeAsset('http-revoke.txt');
    setAssetBrandApproved(id, true);

    for (const attempt of [1, 2]) {
      const res = await fetch(`${base}/api/design/assets/${id}/unapprove`, { method: 'POST' });
      const payload = (await res.json()) as { asset: { brandApproved: boolean } };
      assert.equal(res.status, 200, `attempt ${attempt}`);
      assert.equal(payload.asset.brandApproved, false, `attempt ${attempt}`);
    }
  });

  test('an unknown asset id is a 404 with the not_found code', async () => {
    const res = await fetch(`${base}/api/design/assets/ast_missing/approve`, { method: 'POST' });
    const body = (await res.json()) as { error: { code: string } };

    assert.equal(res.status, 404);
    assert.equal(body.error.code, 'not_found');
  });

  test('a non-boolean approved field is rejected by name', async () => {
    const id = await makeAsset('http-badflag.txt');
    const res = await fetch(`${base}/api/design/assets/${id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: 'yes please' }),
    });
    const body = (await res.json()) as { error: { code: string; details?: { field?: string } } };

    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'bad_request');
    assert.equal(body.error.details?.field, 'approved');
    // The asset must be untouched by a rejected request.
    assert.equal(requireAsset(id).brandApproved, false);
  });

  test('/assets/approved is not shadowed by the :id routes', async () => {
    // If Express matched `/assets/:id/approve` first this would 404 looking for
    // an asset called "approved".
    const res = await fetch(`${base}/api/design/assets/approved?limit=5`);
    assert.equal(res.status, 200);
  });

  test('the design task routes still resolve past the new mount', async () => {
    // /api/design is now mounted before the bare /api agents router, so the
    // agent's own /design/... paths have to keep working. An unknown run id is
    // legitimately a 404, so the status alone proves nothing — what separates
    // "the handler ran and found no such run" from "nothing matched this path"
    // is the message, since notFoundHandler is the only source of "No route for".
    const res = await fetch(`${base}/api/design/tasks/run_missing/state`);
    const body = (await res.json()) as { error: { code: string; message: string } };

    assert.doesNotMatch(
      body.error.message,
      /^No route for/,
      'the new /api/design mount swallowed the agents router\'s /design/tasks paths',
    );
  });
});
