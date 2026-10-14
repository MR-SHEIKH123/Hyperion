import { useId, useState, type FormEvent } from 'react';

import { Button } from '../../design-system/components/Button/Button';
import type { ProviderWire, ZdrSupportWire } from '../../contracts/wire/providers';
import type { ProviderZdrInput } from '../../api/providers';
import styles from './ProviderForm.module.css';

export interface ProviderZdrEditorProps {
  provider: ProviderWire;
  /** Returns null on success, or the plain-words failure to show. */
  onSubmit: (input: ProviderZdrInput) => Promise<string | null>;
  onCancel: () => void;
  submitting: boolean;
}

const SUPPORT_OPTIONS: Array<{ value: ZdrSupportWire; label: string }> = [
  { value: 'unknown', label: 'Unknown — the backend has no support story recorded' },
  { value: 'supported_default', label: 'Supported, on by default' },
  { value: 'supported_opt_in', label: 'Supported, must be requested (opt-in)' },
  { value: 'not_supported', label: 'Not supported by this provider' },
  { value: 'not_applicable', label: 'Not applicable (the provider runs locally)' },
];

/**
 * The provider ZDR editor, on the backend's own model: a support claim, an
 * optional request flag that is sent with each request, and an optional human
 * confirmation. There is no boolean "ZDR toggle" on the backend and this
 * editor does not invent one — the three parts are edited as what they are.
 * Leaving the request-flag control on "leave unchanged" omits the field, so
 * the stored flag survives an edit that was only about the support claim.
 */
export function ProviderZdrEditor(props: ProviderZdrEditorProps) {
  const { provider } = props;
  const [support, setSupport] = useState<ZdrSupportWire>(provider.zdr.support);
  const [flagMode, setFlagMode] = useState<'leave' | 'none' | 'set'>(
    provider.zdr.requestFlag === null ? 'none' : 'leave',
  );
  const [flagLocation, setFlagLocation] = useState<'header' | 'body'>(provider.zdr.requestFlag?.location ?? 'header');
  const [flagKey, setFlagKey] = useState(provider.zdr.requestFlag?.key ?? '');
  const [flagValue, setFlagValue] = useState(provider.zdr.requestFlag?.value ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState(provider.zdr.confirmedNote ?? '');
  const [error, setError] = useState<string | null>(null);
  const idPrefix = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const input: ProviderZdrInput = { support };
    if (flagMode === 'none') input.requestFlag = null;
    if (flagMode === 'set') {
      if (flagKey.trim() === '' || flagValue === '') {
        setError('A request flag needs both the name it travels under and the value to send.');
        return;
      }
      input.requestFlag = { location: flagLocation, key: flagKey.trim(), value: flagValue };
    }
    if (confirmed) {
      input.confirmed = true;
      if (note.trim() !== '') input.note = note.trim();
    }
    setError(null);
    const failure = await props.onSubmit(input);
    if (failure !== null) setError(failure);
  };

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      <p className={styles.hint}>
        Zero data retention for <strong>{provider.name}</strong>, as the backend records it. This edits the claim
        and what is sent — it cannot make a provider retain less than it does; only a provider that honours the
        flag, or your own confirmation under an agreement, does that.
      </p>

      <div className={styles.field}>
        <label htmlFor={`${idPrefix}-support`}>Support</label>
        <select
          id={`${idPrefix}-support`}
          value={support}
          onChange={(event) => setSupport(event.target.value as ZdrSupportWire)}
        >
          {SUPPORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor={`${idPrefix}-flagmode`}>Request flag</label>
        <select
          id={`${idPrefix}-flagmode`}
          value={flagMode}
          onChange={(event) => setFlagMode(event.target.value as typeof flagMode)}
        >
          {provider.zdr.requestFlag !== null ? <option value="leave">Leave the current flag unchanged</option> : null}
          <option value="none">No flag is sent</option>
          <option value="set">Send a flag with each request</option>
        </select>
        {provider.zdr.requestFlag !== null ? (
          <p className={styles.hint}>
            Current flag: {provider.zdr.requestFlag.location} “{provider.zdr.requestFlag.key}”. Flag values are
            policy declarations, not credentials — the backend refuses credential-shaped values.
          </p>
        ) : null}
      </div>

      {flagMode === 'set' ? (
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label htmlFor={`${idPrefix}-flaglocation`}>Travels in</label>
            <select
              id={`${idPrefix}-flaglocation`}
              value={flagLocation}
              onChange={(event) => setFlagLocation(event.target.value as 'header' | 'body')}
            >
              <option value="header">A header</option>
              <option value="body">The request body</option>
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor={`${idPrefix}-flagkey`}>Name</label>
            <input
              id={`${idPrefix}-flagkey`}
              value={flagKey}
              onChange={(event) => setFlagKey(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. X-Zero-Retention"
            />
          </div>
          <div className={styles.field}>
            <label htmlFor={`${idPrefix}-flagvalue`}>Value sent</label>
            <input
              id={`${idPrefix}-flagvalue`}
              value={flagValue}
              onChange={(event) => setFlagValue(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. true"
            />
          </div>
        </div>
      ) : null}

      <div className={styles.field}>
        <label className={styles.checkbox}>
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          I confirm this provider honours zero data retention under our agreement
        </label>
        {provider.zdr.confirmedAt !== null ? (
          <p className={styles.hint}>
            Already confirmed {provider.zdr.confirmedAt}
            {provider.zdr.confirmedNote === null ? '' : ` — ${provider.zdr.confirmedNote}`}. Leaving this unticked
            keeps that confirmation as it is.
          </p>
        ) : null}
        {confirmed ? (
          <>
            <label htmlFor={`${idPrefix}-note`}>Confirmation note (optional)</label>
            <input
              id={`${idPrefix}-note`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              autoComplete="off"
              placeholder="e.g. DPA reference or plan name"
            />
          </>
        ) : null}
      </div>

      {error !== null ? (
        <p className={styles.submitError} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.actions}>
        <Button variant="quiet" onClick={props.onCancel} disabled={props.submitting}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={props.submitting}>
          {props.submitting ? 'Saving…' : 'Save ZDR'}
        </Button>
      </div>
    </form>
  );
}

export default ProviderZdrEditor;
