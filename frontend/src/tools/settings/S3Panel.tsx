import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getBackupDestinations, saveS3Config, testS3Destination } from '../../api/backup';
import { Button } from '../../design-system/components/Button/Button';
import type { S3PublicConfigWire, S3TestReportWire } from '../../contracts/wire/backup';
import { describeApiError } from './ProvidersSection';
import { DESTINATION_FAILURE_LINE, PROBE_STEP_LABELS, S3_FIELD_LABELS, probeStepTone } from './dataModel';
import styles from './DataView.module.css';

/**
 * The S3 backup destination (Settings 2.5, slice 3b).
 *
 * Secret rules, applied literally: the stored secret is never read back
 * (the API only reports `hasSecret`), a typed secret lives in this
 * component's state and is cleared on save success, on save failure
 * (the form below is dropped and remounted from the saved config), and
 * on unmount. Only fields the user touched are sent — the route is a
 * partial update, and sending untouched fields would clear values the
 * user never meant to change. Clearing is explicit: the remove-secret
 * checkbox sends `null`, an emptied text field sends `''`, both of
 * which the route reads as "clear this field".
 */

export function S3TestReportView({ report }: { report: S3TestReportWire }) {
  return (
    <div>
      <p className={styles.fact} role="status">
        {report.ok
          ? 'The destination answered the full round trip.'
          : (report.error ?? 'The destination did not answer.')}
      </p>
      {report.missing !== undefined && report.missing.length > 0 ? (
        <p className={styles.note}>Still missing: {report.missing.map((field) => S3_FIELD_LABELS[field]).join(', ')}.</p>
      ) : null}
      <ul className={styles.steps}>
        {report.steps.map((step) => {
          const tone = probeStepTone(step);
          return (
            <li key={step.step}>
              <span
                className={`${styles.badge} ${tone === 'warning' ? styles.badgeWarn : tone === 'failure' ? styles.badgeBad : ''}`}
              >
                {tone === 'ok' ? 'Passed' : tone === 'warning' ? 'Warning' : 'Failed'}
              </span>{' '}
              {PROBE_STEP_LABELS[step.step]}
              {step.status !== undefined ? ` (HTTP ${step.status})` : ''}
              {step.error !== undefined ? ` — ${step.error}` : ''}
              {step.warning !== undefined ? ` ${step.warning}` : ''}
            </li>
          );
        })}
      </ul>
      {report.key !== undefined ? <p className={styles.note}>Probe object: {report.key}</p> : null}
    </div>
  );
}

function S3Form({ config, onSaved }: { config: S3PublicConfigWire; onSaved: () => void }) {
  // Draft values for the text fields, seeded from the redacted config.
  // The secret is NOT seeded: there is nothing to seed it from.
  const [endpoint, setEndpoint] = useState(config.endpoint ?? '');
  const [region, setRegion] = useState(config.region);
  const [bucket, setBucket] = useState(config.bucket ?? '');
  const [prefix, setPrefix] = useState(config.prefix ?? '');
  const [accessKeyId, setAccessKeyId] = useState(config.accessKeyId ?? '');
  const [secret, setSecret] = useState('');
  const [removeSecret, setRemoveSecret] = useState(false);
  const [enabled, setEnabled] = useState(config.enabled);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const touch = (field: string) => setTouched((prev) => new Set(prev).add(field));

  const save = async () => {
    const patch: Record<string, string | boolean | null> = {};
    if (touched.has('endpoint')) patch['endpoint'] = endpoint;
    if (touched.has('region')) patch['region'] = region;
    if (touched.has('bucket')) patch['bucket'] = bucket;
    if (touched.has('prefix')) patch['prefix'] = prefix;
    if (touched.has('accessKeyId')) patch['accessKeyId'] = accessKeyId;
    if (touched.has('enabled')) patch['enabled'] = enabled;
    if (removeSecret) patch['secretAccessKey'] = null;
    else if (secret !== '') patch['secretAccessKey'] = secret;
    setPending(true);
    setError(null);
    try {
      await saveS3Config(patch);
      setSecret('');
      // Remount from the saved config: cleared fields and the dirty set
      // start over from what the backend now reports.
      onSaved();
    } catch (saveError) {
      // Failure also clears the secret: the form is remounted by the
      // parent refresh, and nothing typed survives in any state.
      setSecret('');
      setError(describeApiError(saveError));
      onSaved();
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <label className={styles.checkField}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
            touch('enabled');
          }}
        />
        <span>Use this destination for automatic backups</span>
      </label>
      <div className={styles.grid2}>
        <div className={styles.field}>
          <label htmlFor="s3-endpoint">Endpoint</label>
          <input
            id="s3-endpoint"
            value={endpoint}
            placeholder="https://s3.example.com"
            onChange={(event) => {
              setEndpoint(event.target.value);
              touch('endpoint');
            }}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="s3-region">Region</label>
          <input
            id="s3-region"
            value={region}
            onChange={(event) => {
              setRegion(event.target.value);
              touch('region');
            }}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="s3-bucket">Bucket</label>
          <input
            id="s3-bucket"
            value={bucket}
            onChange={(event) => {
              setBucket(event.target.value);
              touch('bucket');
            }}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="s3-prefix">Prefix (optional)</label>
          <input
            id="s3-prefix"
            value={prefix}
            onChange={(event) => {
              setPrefix(event.target.value);
              touch('prefix');
            }}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="s3-access-key">Access key ID</label>
          <input
            id="s3-access-key"
            value={accessKeyId}
            autoComplete="off"
            onChange={(event) => {
              setAccessKeyId(event.target.value);
              touch('accessKeyId');
            }}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="s3-secret">Secret access key</label>
          <input
            id="s3-secret"
            type="password"
            autoComplete="new-password"
            value={secret}
            disabled={removeSecret}
            placeholder={config.hasSecret ? 'Stored — type a new one to replace it' : 'Not set'}
            onChange={(event) => setSecret(event.target.value)}
          />
          <p className={styles.note}>
            {config.hasSecret
              ? 'A secret is stored. It is never shown; typing a new one replaces it.'
              : 'No secret is stored.'}
          </p>
        </div>
      </div>
      {config.hasSecret ? (
        <label className={styles.checkField}>
          <input
            type="checkbox"
            checked={removeSecret}
            onChange={(event) => {
              setRemoveSecret(event.target.checked);
              if (event.target.checked) setSecret('');
            }}
          />
          <span>Remove the stored secret on save</span>
        </label>
      ) : null}
      {config.missing.length > 0 ? (
        <p className={styles.warning}>
          Not configured yet — still missing: {config.missing.map((field) => S3_FIELD_LABELS[field]).join(', ')}.
        </p>
      ) : (
        <p className={styles.fact}>Configured. Saving changes only the fields you edited.</p>
      )}
      <div className={styles.actions}>
        <Button variant="primary" onClick={() => void save()} disabled={pending}>
          {pending ? 'Saving…' : 'Save destination'}
        </Button>
      </div>
      {error !== null ? (
        <p className={styles.panelError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function S3Section() {
  const queryClient = useQueryClient();
  const destinationsQuery = useQuery({
    queryKey: ['data', 'destinations'],
    queryFn: ({ signal }) => getBackupDestinations(signal),
  });
  // Bump to remount the form from the newly saved config (which also
  // discards any secret left in local state).
  const [formEpoch, setFormEpoch] = useState(0);
  const [report, setReport] = useState<S3TestReportWire | null>(null);
  const [testPending, setTestPending] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const refresh = () => {
    setFormEpoch((epoch) => epoch + 1);
    void queryClient.invalidateQueries({ queryKey: ['data', 'destinations'] });
  };

  const runTest = async () => {
    setTestPending(true);
    setTestError(null);
    try {
      setReport(await testS3Destination());
    } catch (error) {
      setReport(null);
      setTestError(describeApiError(error));
    } finally {
      setTestPending(false);
    }
  };

  return (
    <div className={styles.panel}>
      <h3 className={styles.panelTitle}>S3 backup destination</h3>
      <p className={styles.note}>
        Finished archives can be mirrored to an S3-compatible bucket. {DESTINATION_FAILURE_LINE}
      </p>
      {destinationsQuery.isPending ? (
        <p className={styles.fact}>Reading the destination…</p>
      ) : destinationsQuery.isError ? (
        <p className={styles.panelError} role="alert">
          The destination could not be read. {describeApiError(destinationsQuery.error)}
        </p>
      ) : (
        <>
          <S3Form key={formEpoch} config={destinationsQuery.data.s3} onSaved={refresh} />
          {destinationsQuery.data.local.mirror !== null ? (
            <p className={styles.note}>
              A local mirror folder is also configured ({destinationsQuery.data.local.mirror}); it is set by the
              operator and is not editable here.
            </p>
          ) : null}
          <div className={styles.actions}>
            <Button onClick={() => void runTest()} disabled={testPending}>
              {testPending ? 'Testing…' : 'Test connection'}
            </Button>
          </div>
          {testError !== null ? (
            <p className={styles.panelError} role="alert">
              {testError}
            </p>
          ) : null}
          {report !== null ? <S3TestReportView report={report} /> : null}
        </>
      )}
    </div>
  );
}
