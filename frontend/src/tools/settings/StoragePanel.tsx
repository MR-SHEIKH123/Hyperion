import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { deleteAsset, getCleanupLog, getStorageStats, listAssets, runCleanup, setAssetPinned } from '../../api/storage';
import { Button } from '../../design-system/components/Button/Button';
import { Dialog } from '../../design-system/components/Dialog/Dialog';
import type { AssetWire, CleanupResultWire } from '../../contracts/wire/storage';
import { describeApiError } from './ProvidersSection';
import { formatBytes, formatDateTime } from './dataModel';
import styles from './DataView.module.css';

/**
 * Storage totals, the retention sweep, and the asset list (Settings 2.5,
 * slice 3b). The sweep's real run is gated on its own dry run: the
 * preview is what the confirmation names, so "Run cleanup" stays
 * unavailable until a preview is on screen — the route supports dryRun,
 * so the UI uses it. Asset deletion confirms by filename. No worktree UI
 * lives here; that belongs to Code recovery.
 */

export function CleanupResultView({ result }: { result: CleanupResultWire }) {
  return (
    <div>
      <p className={styles.fact} role="status">
        {result.dryRun ? 'Dry run — nothing was removed. ' : 'Cleanup ran. '}
        {result.chatsDeleted} chat{result.chatsDeleted === 1 ? '' : 's'} and {result.assetsDeleted} asset
        {result.assetsDeleted === 1 ? '' : 's'} ({formatBytes(result.bytesFreed)} freed)
        {result.dryRun ? ' would be removed' : ' removed'} under a {result.assetTtlDays}-day asset /{' '}
        {result.chatTtlDays}-day chat retention.
      </p>
      {result.detail.assets.length > 0 ? (
        <ul className={styles.list}>
          {result.detail.assets.slice(0, 10).map((asset) => (
            <li key={asset.id} className={styles.entry}>
              <div className={styles.entryMeta}>
                <span className={styles.mono}>{asset.filename}</span>
                <span>
                  {formatBytes(asset.bytes)} · {asset.reason === 'expired' ? 'expired' : 'file already missing'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {result.detail.assets.length > 10 ? (
        <p className={styles.note}>…and {result.detail.assets.length - 10} more assets.</p>
      ) : null}
      {result.snapshotsCleared > 0 ? (
        <p className={styles.note}>
          {result.snapshotsCleared} leftover conversation snapshot{result.snapshotsCleared === 1 ? '' : 's'} cleared —
          expected to be zero in normal operation, so a non-zero count means a process ended mid-run earlier.
        </p>
      ) : null}
    </div>
  );
}

export function AssetList({
  assets,
  pendingId,
  onTogglePin,
  onDelete,
}: {
  assets: readonly AssetWire[];
  pendingId: string | null;
  onTogglePin: (asset: AssetWire) => void;
  onDelete: (asset: AssetWire) => void;
}) {
  if (assets.length === 0) return <p className={styles.fact}>No stored files.</p>;
  return (
    <ul className={styles.list}>
      {assets.map((asset) => (
        <li key={asset.id} className={styles.entry}>
          <p className={styles.fact}>
            <span className={styles.mono}>{asset.filename}</span>{' '}
            {asset.missing ? <span className={`${styles.badge} ${styles.badgeBad}`}>File missing</span> : null}{' '}
            {asset.pinned ? <span className={styles.badge}>Pinned</span> : null}{' '}
            {asset.brandApproved ? <span className={styles.badge}>Brand approved</span> : null}
          </p>
          <div className={styles.entryMeta}>
            <span>
              {formatBytes(asset.bytes)} · {asset.origin} · {formatDateTime(asset.createdAt)}
              {asset.tool !== null ? ` · from ${asset.tool}` : ''}
            </span>
            <span className={styles.actions}>
              <Button variant="quiet" disabled={pendingId === asset.id} onClick={() => onTogglePin(asset)}>
                {asset.pinned ? 'Unpin' : 'Pin'}
              </Button>
              <Button variant="quiet" disabled={pendingId === asset.id} onClick={() => onDelete(asset)}>
                Delete…
              </Button>
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function StorageSection() {
  const queryClient = useQueryClient();
  const statsQuery = useQuery({ queryKey: ['data', 'storage-stats'], queryFn: ({ signal }) => getStorageStats(signal) });
  const assetsQuery = useQuery({ queryKey: ['data', 'assets'], queryFn: ({ signal }) => listAssets(signal) });
  const logQuery = useQuery({ queryKey: ['data', 'cleanup-log'], queryFn: ({ signal }) => getCleanupLog(signal) });

  const [preview, setPreview] = useState<CleanupResultWire | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [cleanupPending, setCleanupPending] = useState(false);
  const [assetPendingId, setAssetPendingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AssetWire | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const invalidateStorage = () => {
    void queryClient.invalidateQueries({ queryKey: ['data'] });
  };

  const runPreview = async () => {
    setPreviewPending(true);
    setActionError(null);
    try {
      setPreview(await runCleanup(true));
    } catch (error) {
      setPreview(null);
      setActionError(describeApiError(error));
    } finally {
      setPreviewPending(false);
    }
  };

  const runRealCleanup = async () => {
    setCleanupPending(true);
    setActionError(null);
    try {
      const result = await runCleanup(false);
      setPreview(result);
      setConfirmCleanup(false);
      invalidateStorage();
    } catch (error) {
      setActionError(describeApiError(error));
    } finally {
      setCleanupPending(false);
    }
  };

  const togglePin = async (asset: AssetWire) => {
    setAssetPendingId(asset.id);
    setActionError(null);
    try {
      await setAssetPinned(asset.id, !asset.pinned);
      invalidateStorage();
    } catch (error) {
      setActionError(describeApiError(error));
    } finally {
      setAssetPendingId(null);
    }
  };

  const confirmDeleteAsset = async () => {
    if (deleteTarget === null) return;
    setAssetPendingId(deleteTarget.id);
    setDeleteError(null);
    try {
      const result = await deleteAsset(deleteTarget.id);
      setDeleteTarget(null);
      setActionError(
        result.deleted
          ? `Deleted ${deleteTarget.filename} (${formatBytes(result.bytesFreed)} freed).`
          : `The backend reports ${deleteTarget.filename} was not deleted.`,
      );
      invalidateStorage();
    } catch (error) {
      setDeleteError(describeApiError(error));
    } finally {
      setAssetPendingId(null);
    }
  };

  const stats = statsQuery.data;

  return (
    <div className={styles.panels}>
      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Storage</h3>
        {statsQuery.isPending ? (
          <p className={styles.fact}>Reading storage…</p>
        ) : statsQuery.isError ? (
          <p className={styles.panelError} role="alert">
            Storage could not be read. {describeApiError(statsQuery.error)}
          </p>
        ) : stats !== undefined ? (
          <>
            <p className={styles.fact}>
              {stats.assets.count} stored file{stats.assets.count === 1 ? '' : 's'} using{' '}
              {formatBytes(stats.assets.bytes)}; {stats.assets.pinned} pinned, {stats.assets.missing} whose file is
              missing on disk. {stats.chats.count} chat{stats.chats.count === 1 ? '' : 's'} ({stats.chats.pinned}{' '}
              pinned).
            </p>
            {stats.byTool.length > 0 ? (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Tool</th>
                    <th scope="col" className={styles.num}>Files</th>
                    <th scope="col" className={styles.num}>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byTool.map((row) => (
                    <tr key={row.key}>
                      <td>{row.key}</td>
                      <td className={styles.num}>{row.count}</td>
                      <td className={styles.num}>{formatBytes(row.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </>
        ) : null}
        {actionError !== null ? (
          <p className={styles.fact} role="status">
            {actionError}
          </p>
        ) : null}
      </div>

      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Cleanup</h3>
        <p className={styles.note}>
          The retention sweep removes expired chats and files. Preview it first — the real run stays unavailable until
          a dry run is on screen, and the confirmation names what the dry run found.
        </p>
        <div className={styles.actions}>
          <Button onClick={() => void runPreview()} disabled={previewPending}>
            {previewPending ? 'Previewing…' : 'Preview cleanup (dry run)'}
          </Button>
          <Button variant="primary" onClick={() => setConfirmCleanup(true)} disabled={preview === null || cleanupPending}>
            Run cleanup…
          </Button>
        </div>
        {preview !== null ? <CleanupResultView result={preview} /> : null}
        <h4 className={styles.panelTitle}>Previous sweeps</h4>
        {logQuery.isPending ? (
          <p className={styles.fact}>Reading the cleanup log…</p>
        ) : logQuery.isError ? (
          <p className={styles.panelError} role="alert">
            The cleanup log could not be read. {describeApiError(logQuery.error)}
          </p>
        ) : logQuery.data.entries.length === 0 ? (
          <p className={styles.fact}>No sweeps recorded.</p>
        ) : (
          <ul className={styles.list}>
            {logQuery.data.entries.slice(0, 8).map((entry) => (
              <li key={entry.id} className={styles.entry}>
                <div className={styles.entryMeta}>
                  <span>{formatDateTime(entry.ranAt)}</span>
                  <span>
                    {entry.dryRun ? 'dry run · ' : ''}
                    {entry.chatsDeleted} chats, {entry.assetsDeleted} files, {formatBytes(entry.bytesFreed)} freed
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Stored files</h3>
        {assetsQuery.isPending ? (
          <p className={styles.fact}>Reading stored files…</p>
        ) : assetsQuery.isError ? (
          <p className={styles.panelError} role="alert">
            Stored files could not be listed. {describeApiError(assetsQuery.error)}
          </p>
        ) : (
          <>
            <p className={styles.note}>
              {assetsQuery.data.total} file{assetsQuery.data.total === 1 ? '' : 's'},{' '}
              {formatBytes(assetsQuery.data.totalBytes)} in total. Pinned files are exempt from cleanup.
            </p>
            <AssetList
              assets={assetsQuery.data.assets}
              pendingId={assetPendingId}
              onTogglePin={(asset) => void togglePin(asset)}
              onDelete={setDeleteTarget}
            />
          </>
        )}
      </div>

      <Dialog open={confirmCleanup} title="Run cleanup?" onClose={() => setConfirmCleanup(false)}>
        <div className={styles.confirmBody}>
          <p>
            The dry run above found {preview?.chatsDeleted ?? 0} chat{(preview?.chatsDeleted ?? 0) === 1 ? '' : 's'}{' '}
            and {preview?.assetsDeleted ?? 0} file{(preview?.assetsDeleted ?? 0) === 1 ? '' : 's'} to remove (
            {formatBytes(preview?.bytesFreed ?? 0)}). Removed chats and files cannot be recovered; pinned files are
            kept. Counts may have shifted since the preview — run the preview again to refresh them.
          </p>
          <div className={styles.confirmActions}>
            <Button onClick={() => setConfirmCleanup(false)} disabled={cleanupPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void runRealCleanup()} disabled={cleanupPending}>
              {cleanupPending ? 'Cleaning…' : 'Run cleanup'}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={deleteTarget !== null} title="Delete this file?" onClose={() => setDeleteTarget(null)}>
        <div className={styles.confirmBody}>
          <p>
            Delete <strong className={styles.mono}>{deleteTarget?.filename}</strong> ({formatBytes(deleteTarget?.bytes ?? 0)})?
            The stored file and its record are removed; anything that referenced it will show it as missing. This
            cannot be undone.
          </p>
          {deleteError !== null ? (
            <p className={styles.panelError} role="alert">
              {deleteError}
            </p>
          ) : null}
          <div className={styles.confirmActions}>
            <Button onClick={() => setDeleteTarget(null)} disabled={assetPendingId !== null}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void confirmDeleteAsset()} disabled={assetPendingId !== null}>
              {assetPendingId !== null ? 'Deleting…' : 'Delete file'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
