import { useId, useRef, useState } from 'react';

import { Button } from '../../design-system/components/Button/Button';
import type {
  ColibriAdvisoryWire,
  ColibriProbeWire,
  LocalDetectionWire,
  ProviderTypeWire,
  ProviderWire,
  PuterAdvisoryWire,
} from '../../contracts/wire/providers';
import {
  emptyProviderForm,
  providerFormFrom,
  validateProviderForm,
  type ProviderFormErrors,
  type ProviderFormValues,
  PROVIDER_TYPES,
  PROVIDER_TYPE_LABELS,
} from './providerModel';
import styles from './ProviderForm.module.css';

export interface AdvisoryState<T> {
  data: T | null;
  error: boolean;
}

export interface ProviderFormProps {
  mode: 'create' | 'edit';
  /** Present in edit mode; the type is then fixed (the route cannot change it). */
  provider?: ProviderWire;
  /** Backend advisories, fetched by the caller; rendered, never reworded. */
  puterAdvisory: AdvisoryState<PuterAdvisoryWire>;
  colibriAdvisory: AdvisoryState<ColibriAdvisoryWire>;
  onDetectLocal: (baseUrl?: string) => Promise<LocalDetectionWire>;
  onProbeColibri: (baseUrl?: string) => Promise<ColibriProbeWire>;
  /** Returns null on success, or the plain-words failure to show in the form. */
  onSubmit: (values: ProviderFormValues) => Promise<string | null>;
  onCancel: () => void;
  submitting: boolean;
}

type ProbeState =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; text: string }
  | { kind: 'failed'; text: string };

/**
 * Add / edit provider. Secrets live only in this component's state: the API
 * key and the proxy (which can carry a password) are password inputs, are
 * never prefilled from the backend (it only ever sends a hint / a redacted
 * proxy), are cleared on success, and die with the component on close. On a
 * failed submit the typed value stays so a typo elsewhere can be fixed — the
 * failure text itself never contains it.
 */
export function ProviderForm(props: ProviderFormProps) {
  const { mode, provider } = props;
  const [values, setValues] = useState<ProviderFormValues>(() =>
    mode === 'edit' && provider !== undefined ? providerFormFrom(provider) : emptyProviderForm(),
  );
  const [errors, setErrors] = useState<ProviderFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' });
  const idPrefix = useId();
  const fieldRefs = useRef<Partial<Record<string, HTMLElement | null>>>({});
  const set = <K extends keyof ProviderFormValues>(key: K, value: ProviderFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const fieldError = (field: keyof ProviderFormErrors) =>
    errors[field] === undefined ? null : (
      <p className={styles.fieldError} id={`${idPrefix}-${field}-error`} role="alert">
        {errors[field]}
      </p>
    );
  const describedBy = (field: keyof ProviderFormErrors, hintId?: string) =>
    [errors[field] === undefined ? null : `${idPrefix}-${field}-error`, hintId].filter(Boolean).join(' ') || undefined;

  const runDetect = async () => {
    setProbe({ kind: 'working' });
    try {
      const result = await props.onDetectLocal(values.baseUrl.trim() === '' ? undefined : values.baseUrl.trim());
      if (result.detected) {
        set('baseUrl', result.baseUrl);
        setProbe({
          kind: 'done',
          text: `Detected at ${result.baseUrl} — ${result.models.length} model${result.models.length === 1 ? '' : 's'} available. The base URL has been filled in.`,
        });
      } else {
        setProbe({
          kind: 'done',
          text: `Not detected. ${result.reason ?? 'No local provider answered.'} You can still type the base URL yourself.`,
        });
      }
    } catch {
      setProbe({ kind: 'failed', text: 'Detection could not be run — the request itself failed. Nothing was changed.' });
    }
  };

  const runProbe = async () => {
    setProbe({ kind: 'working' });
    try {
      const result = await props.onProbeColibri(values.baseUrl.trim() === '' ? undefined : values.baseUrl.trim());
      if (result.detected) {
        set('baseUrl', result.baseUrl);
        setProbe({
          kind: 'done',
          text: `Colibrì answered at ${result.baseUrl} — ${result.models.length} model${result.models.length === 1 ? '' : 's'} found. Probing registers nothing; saving this form creates the provider.`,
        });
      } else {
        setProbe({
          kind: 'done',
          text: `Colibrì did not answer. ${result.reason ?? ''} The default address is ${result.defaultBaseUrl}.`.trim(),
        });
      }
    } catch {
      setProbe({ kind: 'failed', text: 'The probe could not be run — the request itself failed. Nothing was changed.' });
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextErrors = validateProviderForm(values, mode);
    setErrors(nextErrors);
    const firstInvalid = Object.keys(nextErrors)[0];
    if (firstInvalid !== undefined) {
      fieldRefs.current[firstInvalid]?.focus();
      return;
    }
    setSubmitError(null);
    const failure = await props.onSubmit(values);
    if (failure !== null) {
      setSubmitError(failure);
      return;
    }
    // Success: secrets leave component state before the caller closes us.
    setValues((current) => ({ ...current, apiKey: '', egressProxy: '' }));
  };

  const type = values.type;
  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      <div className={styles.field}>
        <label htmlFor={`${idPrefix}-name`}>Name</label>
        <input
          id={`${idPrefix}-name`}
          ref={(node) => {
            fieldRefs.current.name = node;
          }}
          value={values.name}
          onChange={(event) => set('name', event.target.value)}
          aria-describedby={describedBy('name')}
          autoComplete="off"
        />
        {fieldError('name')}
      </div>

      <div className={styles.field}>
        <label htmlFor={`${idPrefix}-type`}>Type</label>
        {mode === 'edit' ? (
          <>
            <input id={`${idPrefix}-type`} value={PROVIDER_TYPE_LABELS[type]} disabled readOnly />
            <p className={styles.hint}>The type cannot be changed. To switch, delete this provider and add a new one.</p>
          </>
        ) : (
          <select
            id={`${idPrefix}-type`}
            value={type}
            onChange={(event) => {
              set('type', event.target.value as ProviderTypeWire);
              setProbe({ kind: 'idle' });
            }}
          >
            {PROVIDER_TYPES.map((option) => (
              <option key={option} value={option}>
                {PROVIDER_TYPE_LABELS[option]}
              </option>
            ))}
          </select>
        )}
      </div>

      {type === 'puter' ? (
        <section className={styles.advisory} aria-label="Puter advisory from the backend">
          {props.puterAdvisory.data !== null ? (
            <>
              <p>{props.puterAdvisory.data.note}</p>
              <ul className={styles.advisoryList}>
                <li>Credential to paste below: an auth token ({props.puterAdvisory.data.credential}).</li>
                {props.puterAdvisory.data.requiresPaidPlan ? <li>A paid Puter plan is required.</li> : null}
                <li>
                  Model catalogue:{' '}
                  <a href={props.puterAdvisory.data.catalogueUrl} target="_blank" rel="noreferrer">
                    {props.puterAdvisory.data.catalogueUrl}
                  </a>
                </li>
                <li>Leaving the base URL empty uses {props.puterAdvisory.data.defaultBaseUrl}.</li>
              </ul>
            </>
          ) : (
            <p>
              {props.puterAdvisory.error
                ? 'The Puter advisory could not be loaded. The form still works — check the Puter model catalogue before pasting a token.'
                : 'Loading the Puter advisory…'}
            </p>
          )}
        </section>
      ) : null}

      {type === 'colibri' ? (
        <section className={styles.advisory} aria-label="Colibrì advisory from the backend">
          {props.colibriAdvisory.data !== null ? (
            <p>{props.colibriAdvisory.data.caveat}</p>
          ) : (
            <p>
              {props.colibriAdvisory.error
                ? 'The Colibrì advisory could not be loaded. Enabling a Colibrì provider will still ask you to acknowledge that inference can be extremely slow.'
                : 'Loading the Colibrì advisory…'}
            </p>
          )}
        </section>
      ) : null}

      {type === 'opencodex' ? (
        <p className={styles.hint} role="note">
          opencodex is meant to front a local proxy. If that proxy listens beyond loopback it requires its own API
          key — paste it as the API key below and it travels as the Authorization header.
        </p>
      ) : null}

      <div className={styles.field}>
        <label htmlFor={`${idPrefix}-baseUrl`}>Base URL</label>
        <input
          id={`${idPrefix}-baseUrl`}
          ref={(node) => {
            fieldRefs.current.baseUrl = node;
          }}
          value={values.baseUrl}
          onChange={(event) => set('baseUrl', event.target.value)}
          aria-describedby={describedBy('baseUrl')}
          placeholder={type === 'local' ? 'http://localhost:11434' : 'https://…'}
          autoComplete="off"
          spellCheck={false}
        />
        {fieldError('baseUrl')}
        {type === 'local' && mode === 'create' ? (
          <div className={styles.probeRow}>
            <Button onClick={() => void runDetect()} disabled={probe.kind === 'working'}>
              {probe.kind === 'working' ? 'Detecting…' : 'Detect Ollama on this machine'}
            </Button>
            <span className={styles.probeNote}>One check, only when you press it — this page never scans in the background.</span>
          </div>
        ) : null}
        {type === 'colibri' ? (
          <div className={styles.probeRow}>
            <Button onClick={() => void runProbe()} disabled={probe.kind === 'working'}>
              {probe.kind === 'working' ? 'Probing…' : 'Probe for Colibrì'}
            </Button>
            <span className={styles.probeNote}>Probing registers nothing.</span>
          </div>
        ) : null}
        {probe.kind === 'done' || probe.kind === 'failed' ? (
          <p className={styles.probeResult} role="status">
            {probe.text}
          </p>
        ) : null}
      </div>

      <div className={styles.field}>
        <label htmlFor={`${idPrefix}-apiKey`}>API key{type === 'puter' ? ' (auth token)' : ''}</label>
        <input
          id={`${idPrefix}-apiKey`}
          type="password"
          value={values.apiKey}
          onChange={(event) => {
            set('apiKey', event.target.value);
            if (event.target.value !== '') set('removeApiKey', false);
          }}
          autoComplete="off"
          spellCheck={false}
          placeholder={mode === 'edit' ? 'Paste a new key to replace the stored one' : 'Paste the key — stored encrypted'}
          disabled={values.removeApiKey}
        />
        <p className={styles.hint}>
          {mode === 'edit' && provider !== undefined
            ? provider.hasKey
              ? `A key is stored${provider.apiKeyHint === null ? '' : ` (${provider.apiKeyHint})`}. It is never shown again — leave this empty to keep it, paste to replace it.`
              : 'No key is stored.'
            : 'Stored encrypted. It is only ever sent to this provider’s base URL, and never shown again after saving.'}
        </p>
        {mode === 'edit' && provider?.hasKey ? (
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={values.removeApiKey}
              onChange={(event) => set('removeApiKey', event.target.checked)}
            />
            Remove the stored key
          </label>
        ) : null}
      </div>

      <div className={styles.field}>
        <label htmlFor={`${idPrefix}-egressProxy`}>Egress proxy (optional)</label>
        <input
          id={`${idPrefix}-egressProxy`}
          type="password"
          value={values.egressProxy}
          onChange={(event) => {
            set('egressProxy', event.target.value);
            if (event.target.value !== '') set('removeEgressProxy', false);
          }}
          aria-describedby={describedBy('egressProxy', `${idPrefix}-proxy-hint`)}
          autoComplete="off"
          spellCheck={false}
          placeholder="http://127.0.0.1:8080"
          disabled={values.removeEgressProxy}
        />
        {fieldError('egressProxy')}
        <p className={styles.hint} id={`${idPrefix}-proxy-hint`}>
          {mode === 'edit' && provider !== undefined && provider.egressProxy !== null
            ? `Currently configured as ${provider.egressProxy} (the stored address is only ever shown in that redacted form). Leave this empty to keep it, paste to replace it. `
            : ''}
          A proxy changes the route traffic takes. It does not make this provider anonymous, and it does not give
          zero data retention. Because a proxy address can contain a password, this field is treated as a secret.
        </p>
        {mode === 'edit' && provider?.egressProxy !== null && provider !== undefined ? (
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={values.removeEgressProxy}
              onChange={(event) => set('removeEgressProxy', event.target.checked)}
            />
            Remove the egress proxy
          </label>
        ) : null}
      </div>

      <div className={styles.fieldRow}>
        <div className={styles.field}>
          <label htmlFor={`${idPrefix}-priority`}>Priority (optional)</label>
          <input
            id={`${idPrefix}-priority`}
            value={values.priority}
            onChange={(event) => set('priority', event.target.value)}
            aria-describedby={describedBy('priority')}
            inputMode="numeric"
            autoComplete="off"
          />
          {fieldError('priority')}
        </div>
        <div className={styles.field}>
          <label htmlFor={`${idPrefix}-maxContextTokens`}>Max context tokens (optional)</label>
          <input
            id={`${idPrefix}-maxContextTokens`}
            ref={(node) => {
              fieldRefs.current.maxContextTokens = node;
            }}
            value={values.maxContextTokens}
            onChange={(event) => set('maxContextTokens', event.target.value)}
            aria-describedby={describedBy('maxContextTokens', `${idPrefix}-maxcontext-hint`)}
            inputMode="numeric"
            autoComplete="off"
          />
          {fieldError('maxContextTokens')}
        </div>
      </div>
      <p className={styles.hint} id={`${idPrefix}-maxcontext-hint`}>
        Some local providers silently truncate a conversation at a small default context. If you know the model’s
        real window, set it here; leave it empty to use what the provider reports.
        {mode === 'edit' ? ' Clearing the field removes the override.' : ''}
      </p>

      {mode === 'create' ? (
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={values.enabled}
            onChange={(event) => set('enabled', event.target.checked)}
          />
          Enable now — this becomes the active provider, and the provider that is active now moves to standby.
        </label>
      ) : null}
      {mode === 'create' && type === 'colibri' && values.enabled ? (
        <div className={styles.field}>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={values.acknowledgeSlow}
              onChange={(event) => set('acknowledgeSlow', event.target.checked)}
              aria-describedby={describedBy('acknowledgeSlow')}
            />
            I understand Colibrì inference can be extremely slow — much slower than normal chat.
          </label>
          {fieldError('acknowledgeSlow')}
        </div>
      ) : null}

      {submitError !== null ? (
        <p className={styles.submitError} role="alert">
          {submitError}
        </p>
      ) : null}

      <div className={styles.actions}>
        <Button variant="quiet" onClick={props.onCancel} disabled={props.submitting}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={props.submitting}>
          {props.submitting ? 'Saving…' : mode === 'create' ? 'Add provider' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

export default ProviderForm;
