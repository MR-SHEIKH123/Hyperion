import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  exportBackupToDownload,
  getBackupDestinations,
  inspectArchive,
  listBackups,
  listRestores,
  restoreArchive,
  type ArchiveSource,
  type ExportOutcome,
} from '../../api/backup';
import { Button } from '../../design-system/components/Button/Button';
import { Dialog } from '../../design-system/components/Dialog/Dialog';
import type {
  ArchiveInspectionWire,
  BackupFileWire,
  RestoreAuditEntryWire,
  RestoreResultWire,
} from '../../contracts/wire/backup';
import { describeApiError } from './ProvidersSection';
import {
  DESTINATION_FAILURE_LINE,
  EXPORT_KEYS_LINE,
  RESTORE_REPLACES_LINE,
  formatBytes,
  formatDateTime,
} from './dataModel';
import styles from './DataView.module.css';

/**
 * Backup, restore, and where archives go (Settings 2.5, slice 3b).
 *
 * The restore control cannot be reached in one click from anywhere: an
 * archive must be inspected first, the inspection drives the
 * confirmation, and the confirmation names the replacement. The route
 * itself requires no `confirm` field — the gate is this flow, stated
 * plainly rather than dressed up as a server rule.
 */

export function InspectionView({ inspection }: { inspection: ArchiveInspectionWire }) {
  const manifest = inspection.manifest;
  return (
    <div>
      {inspection.problems.length > 0 ? (
        <p className={styles.warning} role="alert">
          This archive cannot be restored: {inspection.problems.join(' ')}
        </p>
      ) : null}
      {inspection.warnings.map((warning) => (
        <p key={warning} className={styles.warning}>
          {warning}
        </p>
      ))}
      <p className={styles.fact}>
        {inspection.encrypted ? 'Passphrase-protected archive. ' : 'Unprotected archive. '}
        {manifest === null
          ? 'No readable manifest; the counts below were read from the archive itself.'
          : `Created ${formatDateTime(manifest.createdAt)} by ${manifest.app}. Contents: ${manifest.contents.database ? 'database, ' : ''}${manifest.contents.skills} skills, ${manifest.contents.attachments} attachments${manifest.contents.encryptionKey ? ', and the encryption key' : ''}.`}
      </p>
      {manifest?.warning !== undefined ? <p className={styles.warning}>{manifest.warning}</p> : null}
      {inspection.diff.tables.length > 0 ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Table</th>
              <th scope="col" className={styles.num}>Now</th>
              <th scope="col" className={styles.num}>In archive</th>
              <th scope="col" className={styles.num}>Change</th>
            </tr>
          </thead>
          <tbody>
            {inspection.diff.tables.slice(0, 12).map((row) => (
              <tr key={row.table}>
                <td className={styles.mono}>{row.table}</td>
                <td className={styles.num}>{row.current}</td>
                <td className={styles.num}>{row.archive}</td>
                <td className={styles.num}>{row.delta > 0 ? `+${row.delta}` : row.delta}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {inspection.diff.tables.length > 12 ? (
        <p className={styles.note}>…and {inspection.diff.tables.length - 12} more tables with no row-count change shown.</p>
      ) : null}
      {inspection.diff.onlyInArchive.length > 0 ? (
        <p className={styles.note}>Only in the archive: {inspection.diff.onlyInArchive.join(', ')}.</p>
      ) : null}
      {inspection.diff.onlyHere.length > 0 ? (
        <p className={styles.note}>
          Only here (left as they are): {inspection.diff.onlyHere.join(', ')}.
        </p>
      ) : null}
      {inspection.diff.missingFromArchive.length > 0 ? (
        <p className={styles.note}>
          Migrations this archive has not been through: {inspection.diff.missingFromArchive.join(', ')}.
        </p>
      ) : null}
    </div>
  );
}

const OUTCOME_LABELS: Record<RestoreAuditEntryWire['outcome'], string> = {
  dry_run: 'Dry run',
  restored: 'Restored',
  refused: 'Refused',
};

export function RestoreHistory({ restores }: { restores: readonly RestoreAuditEntryWire[] }) {
  if (restores.length === 0) return <p className={styles.fact}>No restores have been attempted on this machine.</p>;
  return (
    <ul className={styles.list}>
      {restores.map((entry) => (
        <li key={entry.id} className={styles.entry}>
          <p className={styles.fact}>
            {OUTCOME_LABELS[entry.outcome]} — {entry.filename ?? 'uploaded archive'} ({formatBytes(entry.bytes)})
          </p>
          <div className={styles.entryMeta}>
            <span>{formatDateTime(entry.createdAt)}</span>
            {entry.encrypted ? <span>passphrase-protected</span> : null}
            {entry.preRestoreBackup !== null ? <span>snapshot: {entry.preRestoreBackup}</span> : null}
          </div>
          {entry.detail !== null ? <p className={styles.note}>{entry.detail}</p> : null}
        </li>
      ))}
    </ul>
  );
}

export function BackupSection() {
  const queryClient = useQueryClient();
  const backupsQuery = useQuery({ queryKey: ['data', 'backups'], queryFn: ({ signal }) => listBackups(signal) });
  const destinationsQuery = useQuery({
    queryKey: ['data', 'destinations'],
    queryFn: ({ signal }) => getBackupDestinations(signal),
  });
  const restoresQuery = useQuery({ queryKey: ['data', 'restores'], queryFn: ({ signal }) => listRestores(signal) });

  // Export state. The passphrase lives here and nowhere else, and is
  // dropped as soon as the export settles, success or failure.
  const [includeKeys, setIncludeKeys] = useState(false);
  const [includeAttachments, setIncludeAttachments] = useState(true);
  const [alsoUpload, setAlsoUpload] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [exportPending, setExportPending] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportOutcome, setExportOutcome] = useState<ExportOutcome | null>(null);

  // Restore state.
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [namedBackup, setNamedBackup] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [inspection, setInspection] = useState<ArchiveInspectionWire | null>(null);
  const [inspectPending, setInspectPending] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restorePending, setRestorePending] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResultWire | null>(null);

  const inspectionClean = inspection !== null && inspection.problems.length === 0;
  const source: ArchiveSource | null =
    pickedFile !== null ? { file: pickedFile } : namedBackup !== '' ? { filename: namedBackup } : null;
  const sourceLabel = pickedFile !== null ? pickedFile.name : namedBackup;

  const invalidateData = () => {
    void queryClient.invalidateQueries({ queryKey: ['data'] });
  };

  const runExport = async () => {
    setExportPending(true);
    setExportError(null);
    setExportOutcome(null);
    try {
      const outcome = await exportBackupToDownload({
        includeKeys,
        includeAttachments,
        ...(passphrase !== '' ? { passphrase } : {}),
        ...(alsoUpload ? { uploadToS3: true } : {}),
      });
      setExportOutcome(outcome);
      invalidateData();
    } catch (error) {
      setExportError(describeApiError(error));
    } finally {
      setPassphrase('');
      setExportPending(false);
    }
  };

  // Monotonic token for the inspect request in flight. Switching the
  // archive (or inspecting again) invalidates the previous request: a
  // slow answer for archive A must never land after the user moved to B
  // and arm B's restore with A's inspection.
  const inspectSeq = useRef(0);
  // Bumped to remount the file input empty when a named backup takes over
  // as the source — otherwise the input goes on displaying the last file
  // picked while the selection is actually the named archive.
  const [fileInputEpoch, setFileInputEpoch] = useState(0);

  const chooseSource = (next: ArchiveSource | null) => {
    inspectSeq.current += 1;
    if (next === null) {
      setPickedFile(null);
      setNamedBackup('');
    } else if ('file' in next) {
      setPickedFile(next.file);
      setNamedBackup('');
    } else {
      setNamedBackup(next.filename);
      setPickedFile(null);
      setFileInputEpoch((epoch) => epoch + 1);
    }
    // A stale inspection must never arm the restore for a different archive.
    setInspection(null);
    setRestoreResult(null);
  };

  const runInspect = async () => {
    if (source === null) return;
    const seq = ++inspectSeq.current;
    setInspectPending(true);
    setInspectError(null);
    setRestoreResult(null);
    try {
      const result = await inspectArchive(source, restorePassphrase === '' ? undefined : restorePassphrase);
      if (inspectSeq.current !== seq) return;
      setInspection(result);
    } catch (error) {
      if (inspectSeq.current !== seq) return;
      setInspection(null);
      setInspectError(describeApiError(error));
    } finally {
      if (inspectSeq.current === seq) setInspectPending(false);
    }
  };

  const runRestore = async (dryRun: boolean) => {
    if (source === null) return;
    setRestorePending(true);
    setRestoreError(null);
    try {
      const result = await restoreArchive(source, {
        dryRun,
        includeAttachments: true,
        ...(restorePassphrase !== '' ? { passphrase: restorePassphrase } : {}),
      });
      setRestoreResult(result);
      setConfirmRestore(false);
      invalidateData();
    } catch (error) {
      setRestoreError(describeApiError(error));
    } finally {
      setRestorePassphrase('');
      setRestorePending(false);
    }
  };

  const s3 = destinationsQuery.data?.s3;

  return (
    <div className={styles.panels}>
      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Export a backup</h3>
        <p className={styles.note}>{EXPORT_KEYS_LINE}</p>
        <label className={styles.checkField}>
          <input type="checkbox" checked={includeKeys} onChange={(event) => setIncludeKeys(event.target.checked)} />
          <span>Include provider API keys</span>
        </label>
        <label className={styles.checkField}>
          <input
            type="checkbox"
            checked={includeAttachments}
            onChange={(event) => setIncludeAttachments(event.target.checked)}
          />
          <span>Include attachments</span>
        </label>
        <div className={styles.field}>
          <label htmlFor="backup-passphrase">Passphrase (optional)</label>
          <input
            id="backup-passphrase"
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
          <p className={styles.note}>
            Set one and the download is an encrypted <span className={styles.mono}>.hypbak</span> file; leave it empty
            for a plain archive. It is sent in the request body, never in a URL, and is forgotten as soon as the export
            finishes.
          </p>
        </div>
        <label className={styles.checkField}>
          <input type="checkbox" checked={alsoUpload} onChange={(event) => setAlsoUpload(event.target.checked)} />
          <span>
            Also upload to the S3 destination
            {s3 !== undefined && !s3.configured ? ' (not configured below — the export will say so)' : ''}
          </span>
        </label>
        <div className={styles.actions}>
          <Button variant="primary" onClick={() => void runExport()} disabled={exportPending}>
            {exportPending ? 'Building archive…' : 'Export backup'}
          </Button>
        </div>
        {exportError !== null ? (
          <p className={styles.panelError} role="alert">
            {exportError}
          </p>
        ) : null}
        {exportOutcome !== null ? (
          <p className={styles.fact} role="status">
            Downloaded {exportOutcome.filename} ({formatBytes(exportOutcome.bytes)}).
            {exportOutcome.s3Key !== null ? ` Also uploaded to S3 as ${exportOutcome.s3Key}.` : ''}
          </p>
        ) : null}
        {backupsQuery.isPending ? (
          <p className={styles.fact}>Reading archives on disk…</p>
        ) : backupsQuery.isError ? (
          <p className={styles.panelError} role="alert">
            The archives on disk could not be listed. {describeApiError(backupsQuery.error)}
          </p>
        ) : backupsQuery.data.backups.length === 0 ? (
          <p className={styles.fact}>No archives on disk yet. The first export will appear here.</p>
        ) : (
          <ul className={styles.list}>
            {backupsQuery.data.backups.map((backup: BackupFileWire) => (
              <li key={backup.filename} className={styles.entry}>
                <div className={styles.entryMeta}>
                  <span className={styles.mono}>{backup.filename}</span>
                  <span>
                    {formatBytes(backup.bytes)} · {formatDateTime(backup.createdAt)}
                  </span>
                  <Button
                    variant="quiet"
                    onClick={() => chooseSource({ filename: backup.filename })}
                  >
                    Restore this…
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {destinationsQuery.data !== undefined ? (
          <p className={styles.note}>
            Archives are written to <span className={styles.mono}>{destinationsQuery.data.local.directory}</span>
            {destinationsQuery.data.local.mirror !== null
              ? ` and mirrored to ${destinationsQuery.data.local.mirror}`
              : ''}
            . {DESTINATION_FAILURE_LINE}
          </p>
        ) : null}
      </div>

      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Restore from a backup</h3>
        <p className={styles.warning}>{RESTORE_REPLACES_LINE}</p>
        <div className={styles.field}>
          <label htmlFor="restore-file">Archive file</label>
          <input
            key={fileInputEpoch}
            id="restore-file"
            type="file"
            accept=".zip,.hypbak"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) chooseSource({ file });
            }}
          />
          <p className={styles.note}>
            Or pick an archive already on disk from the export list above
            {namedBackup !== '' ? (
              <>
                {' '}
                — currently selected: <span className={styles.mono}>{namedBackup}</span>
              </>
            ) : (
              ''
            )}
            .
          </p>
        </div>
        <div className={styles.field}>
          <label htmlFor="restore-passphrase">Passphrase (protected archives only)</label>
          <input
            id="restore-passphrase"
            type="password"
            autoComplete="off"
            value={restorePassphrase}
            onChange={(event) => setRestorePassphrase(event.target.value)}
          />
        </div>
        <div className={styles.actions}>
          <Button onClick={() => void runInspect()} disabled={source === null || inspectPending}>
            {inspectPending ? 'Inspecting…' : 'Inspect archive'}
          </Button>
          <Button onClick={() => void runRestore(true)} disabled={!inspectionClean || restorePending}>
            Dry run
          </Button>
          <Button variant="primary" onClick={() => setConfirmRestore(true)} disabled={!inspectionClean || restorePending}>
            Restore…
          </Button>
        </div>
        {inspection === null ? (
          <p className={styles.note}>
            Inspect an archive first: restore stays unavailable until its contents are on screen.
          </p>
        ) : null}
        {inspectError !== null ? (
          <p className={styles.panelError} role="alert">
            {inspectError}
          </p>
        ) : null}
        {inspection !== null ? <InspectionView inspection={inspection} /> : null}
        {restoreError !== null ? (
          <p className={styles.panelError} role="alert">
            {restoreError}
          </p>
        ) : null}
        {restoreResult !== null ? (
          <p className={styles.fact} role="status">
            {restoreResult.dryRun
              ? 'Dry run complete — nothing was changed.'
              : restoreResult.restored
                ? `Restored. Snapshot of the previous data: ${restoreResult.preRestoreBackup ?? 'none'}.${
                    restoreResult.restartRequired ? ' Restart Hyperion to run on the restored database.' : ''
                  }`
                : 'The restore did not run.'}
          </p>
        ) : null}
        <h4 className={styles.panelTitle}>Restore history</h4>
        {restoresQuery.isPending ? (
          <p className={styles.fact}>Reading the restore history…</p>
        ) : restoresQuery.isError ? (
          <p className={styles.panelError} role="alert">
            The restore history could not be read. {describeApiError(restoresQuery.error)}
          </p>
        ) : (
          <RestoreHistory restores={restoresQuery.data.restores} />
        )}
      </div>

      <Dialog open={confirmRestore} title="Restore this archive?" onClose={() => setConfirmRestore(false)}>
        <div className={styles.confirmBody}>
          <p>
            Restoring <strong>{sourceLabel}</strong> replaces the current database with the archive’s. Chats, settings,
            and usage recorded since the archive was made will be gone; a snapshot of the current database is taken
            first and named in the restore history.
          </p>
          {inspection !== null && inspection.diff.tables.length > 0 ? (
            <p>
              The archive would change {inspection.diff.tables.filter((row) => row.delta !== 0).length} table
              {inspection.diff.tables.filter((row) => row.delta !== 0).length === 1 ? '' : 's'} by row count, as shown
              in the inspection above. Hyperion needs a restart afterwards.
            </p>
          ) : null}
          {restoreError !== null ? (
            <p className={styles.panelError} role="alert">
              {restoreError}
            </p>
          ) : null}
          <div className={styles.confirmActions}>
            <Button onClick={() => setConfirmRestore(false)} disabled={restorePending}>
              Keep current data
            </Button>
            <Button variant="primary" onClick={() => void runRestore(false)} disabled={restorePending}>
              {restorePending ? 'Restoring…' : 'Replace current data'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
