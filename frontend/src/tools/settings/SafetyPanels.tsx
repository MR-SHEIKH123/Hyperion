import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '../../design-system/components/Button/Button';
import type {
  LimitsWire,
  NetworkEgressWire,
  RedactionCheckWire,
  ReloadConfigWire,
  ToolAccessModeWire,
  ZdrPolicyWire,
} from '../../contracts/wire/settings';
import type { ZdrRequirementWire } from '../../contracts/wire/providers';
import { formatTime } from './providerModel';
import {
  formatUsd,
  hasLimitsChanges,
  limitsFormFrom,
  validateLimitsForm,
  TOOL_ACCESS_OPTIONS,
  ZDR_REQUIREMENT_OPTIONS,
  type LimitsFormValues,
} from './safetyModel';
import styles from './SafetyPanels.module.css';

/**
 * The Safety and limits panels, presentational on purpose — the same split
 * as the provider list. The dev harness renders these with fixtures and no
 * network; the section wires them to the real queries. Copy states what the
 * backend states (enforcement labels included) and does not upgrade any of
 * it: a command-prefix match is not called a sandbox, and an advisory mode
 * is not called enforced.
 */

function Panel(props: { title: string; children: ReactNode; error?: string | null }) {
  return (
    <article className={styles.panel}>
      <h3 className={styles.panelTitle}>{props.title}</h3>
      {props.children}
      {props.error !== null && props.error !== undefined ? (
        <p className={styles.panelError} role="alert">
          {props.error}
        </p>
      ) : null}
    </article>
  );
}

export function EgressPanel(props: {
  data: NetworkEgressWire;
  pending: boolean;
  error: string | null;
  onToggle: (enabled: boolean) => void;
}) {
  const { data } = props;
  return (
    <Panel title="Network egress from commands" error={props.error}>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={data.enabled}
          disabled={props.pending}
          onChange={(event) => props.onToggle(event.target.checked)}
        />
        Allow commands to reach the network
      </label>
      <p className={styles.fact}>
        {data.enabled
          ? data.effective
            ? 'On, and effective.'
            : 'On, but not effective: network egress also requires code execution, which is currently off. That capability is not part of this section, and this panel will not pretend the switch did anything until it is on.'
          : 'Off. Commands cannot reach the network.'}
      </p>
      <p className={styles.note}>
        Enforcement is a command-prefix match: the start of a command string is checked for known network tools.
        It is not a sandbox, a firewall, or a network namespace, and a determined command can defeat it — the
        backend names it <code>command_prefix_match</code> so nobody builds a stronger claim on it.
      </p>
    </Panel>
  );
}

export function RedactionPanel(props: {
  data: RedactionCheckWire;
  pending: boolean;
  error: string | null;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <Panel title="Outbound data check" error={props.error}>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={props.data.enabled}
          disabled={props.pending}
          onChange={(event) => props.onToggle(event.target.checked)}
        />
        Scan what is sent to remote providers for credential-shaped text
      </label>
      <p className={styles.fact}>
        {props.data.enabled ? 'On.' : 'Off — the backend default, because a false positive blocks a send you asked for.'}{' '}
        Applies to remote providers only; a provider running on this machine is not scanned.
      </p>
      <p className={styles.note}>
        The check is a pattern match (<code>pattern_match</code>): vendor-prefixed keys, authorization values and{' '}
        <code>api_key=</code>-shaped fields. A match refuses the send rather than rewriting it, and the refusal
        names rule kinds and offsets, never the matched text. It cannot recognise a secret that looks like
        ordinary text.
      </p>
    </Panel>
  );
}

export function ZdrPanel(props: {
  data: ZdrPolicyWire;
  pending: boolean;
  error: string | null;
  onChange: (requirement: ZdrRequirementWire) => void;
}) {
  const name = useId();
  return (
    <Panel title="Zero data retention policy" error={props.error}>
      <fieldset className={styles.radioGroup} disabled={props.pending}>
        <legend className={styles.legend}>Standing requirement for remote providers</legend>
        {ZDR_REQUIREMENT_OPTIONS.map((option) => (
          <label key={option.value} className={styles.radio}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={props.data.requirement === option.value}
              onChange={() => props.onChange(option.value)}
            />
            <span>
              <strong>{option.label}.</strong> {option.description}
            </span>
          </label>
        ))}
      </fieldset>
      <p className={styles.note}>
        Local providers are always eligible — nothing leaves the machine. Enforcement is provider selection (
        <code>provider_selection</code>), not a network control. What each provider is recorded as supporting
        lives with the provider itself, under <Link to="/settings/providers">Providers</Link>.
      </p>
    </Panel>
  );
}

export function ToolAccessPanel(props: {
  mode: ToolAccessModeWire;
  pending: boolean;
  error: string | null;
  onChange: (mode: ToolAccessModeWire) => void;
}) {
  const name = useId();
  return (
    <Panel title="Tool access mode" error={props.error}>
      <fieldset className={styles.radioGroup} disabled={props.pending}>
        <legend className={styles.legend}>How tool definitions reach the model</legend>
        {TOOL_ACCESS_OPTIONS.map((option) => (
          <label key={option.value} className={styles.radio}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={props.mode === option.value}
              onChange={() => props.onChange(option.value)}
            />
            <span>
              <strong>{option.label}.</strong> {option.description}
            </span>
          </label>
        ))}
      </fieldset>
      <p className={styles.note}>
        Advisory only: agents read this when deciding what to load. Nothing in the backend enforces it, and this
        panel will not describe it as enforced.
      </p>
    </Panel>
  );
}

export function LimitsPanel(props: {
  data: LimitsWire;
  pending: boolean;
  error: string | null;
  /** Returns null on success, or the plain-words failure to show. */
  onSave: (values: LimitsFormValues) => Promise<string | null>;
}) {
  const { data } = props;
  const [values, setValues] = useState<LimitsFormValues>(() => limitsFormFrom(data));
  const [errors, setErrors] = useState<Partial<Record<keyof LimitsFormValues, string>>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const idPrefix = useId();
  const { spend } = data;
  const set = (key: keyof LimitsFormValues, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextErrors = validateLimitsForm(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    if (!hasLimitsChanges(values, data)) {
      setSaveError('Nothing changed — the values already match what the backend reports.');
      return;
    }
    setSaveError(null);
    const failure = await props.onSave(values);
    if (failure !== null) setSaveError(failure);
  };

  const fieldError = (field: keyof LimitsFormValues) =>
    errors[field] === undefined ? null : (
      <p className={styles.fieldError} id={`${idPrefix}-${field}-error`} role="alert">
        {errors[field]}
      </p>
    );

  return (
    <Panel title="Spending cap and runaway ceilings" error={props.error}>
      <dl className={styles.facts}>
        <div>
          <dt>Spent today</dt>
          <dd>{formatUsd(spend.spentUsd)}</dd>
        </div>
        <div>
          <dt>Daily cap</dt>
          <dd>{spend.capUsd === null ? 'No cap set' : formatUsd(spend.capUsd)}</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd>{spend.remainingUsd === null ? '—' : formatUsd(spend.remainingUsd)}</dd>
        </div>
        <div>
          <dt>Window resets</dt>
          <dd>{formatTime(spend.windowResetsAt)}</dd>
        </div>
      </dl>
      {spend.capReached ? (
        <p className={styles.warning} role="note">
          The cap is reached: autonomous work (scheduled tasks, subagent spawns) is refused until the window
          resets. Work you start yourself is never blocked by this cap.
        </p>
      ) : null}
      {spend.unpricedRequestsToday > 0 ? (
        <p className={styles.note}>
          {spend.unpricedRequestsToday} request{spend.unpricedRequestsToday === 1 ? '' : 's'} today had no price
          row, so the spend figure cannot include them. The total is honest about that gap rather than folding
          them in as zero.
        </p>
      ) : null}

      <form className={styles.limitsForm} onSubmit={(event) => void submit(event)} noValidate>
        <div className={styles.field}>
          <label htmlFor={`${idPrefix}-cap`}>Daily spend cap (USD)</label>
          <input
            id={`${idPrefix}-cap`}
            value={values.dailySpendCapUsd}
            onChange={(event) => set('dailySpendCapUsd', event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            placeholder="No cap"
            aria-describedby={errors.dailySpendCapUsd === undefined ? undefined : `${idPrefix}-dailySpendCapUsd-error`}
          />
          {fieldError('dailySpendCapUsd')}
          <p className={styles.note}>Empty means no cap. Zero clears an existing cap — it does not refuse everything.</p>
        </div>
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label htmlFor={`${idPrefix}-tokenCeiling`}>Tokens per task</label>
            <input
              id={`${idPrefix}-tokenCeiling`}
              value={values.tokenCeiling}
              onChange={(event) => set('tokenCeiling', event.target.value)}
              inputMode="numeric"
              autoComplete="off"
              aria-describedby={errors.tokenCeiling === undefined ? undefined : `${idPrefix}-tokenCeiling-error`}
            />
            {fieldError('tokenCeiling')}
          </div>
          <div className={styles.field}>
            <label htmlFor={`${idPrefix}-iterationCeiling`}>Iterations per task</label>
            <input
              id={`${idPrefix}-iterationCeiling`}
              value={values.iterationCeiling}
              onChange={(event) => set('iterationCeiling', event.target.value)}
              inputMode="numeric"
              autoComplete="off"
              aria-describedby={errors.iterationCeiling === undefined ? undefined : `${idPrefix}-iterationCeiling-error`}
            />
            {fieldError('iterationCeiling')}
          </div>
          <div className={styles.field}>
            <label htmlFor={`${idPrefix}-subagentLimit`}>Subagents per task</label>
            <input
              id={`${idPrefix}-subagentLimit`}
              value={values.subagentLimit}
              onChange={(event) => set('subagentLimit', event.target.value)}
              inputMode="numeric"
              autoComplete="off"
              aria-describedby={errors.subagentLimit === undefined ? undefined : `${idPrefix}-subagentLimit-error`}
            />
            {fieldError('subagentLimit')}
          </div>
        </div>
        <p className={styles.note}>
          Ceilings stop a runaway task cleanly mid-run (recorded as stopped, not errored). Defaults the backend
          restores when unset: 2,000,000 tokens, 100 iterations, 5 subagents.
        </p>
        {saveError !== null ? (
          <p className={styles.panelError} role="alert">
            {saveError}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button variant="primary" type="submit" disabled={props.pending}>
            {props.pending ? 'Saving…' : 'Save limits'}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

export function ReloadPanel(props: {
  pending: boolean;
  result: ReloadConfigWire | null;
  error: string | null;
  onReload: (project: string) => void;
}) {
  const [project, setProject] = useState('.');
  const idPrefix = useId();
  const permissionCount = props.result === null ? 0 : Object.keys(props.result.permissions).length;
  return (
    <Panel title="Reload configuration" error={props.error}>
      <p className={styles.note}>
        Re-reads the on-disk configuration for a project and reports whether it parses. Settings are not cached
        and project files are read per task, so this clears nothing — its value is surfacing a malformed{' '}
        <code>.hyperion/permissions.json</code> or a broken profile here, instead of halfway through the next
        run.
      </p>
      <div className={styles.reloadRow}>
        <div className={styles.field}>
          <label htmlFor={`${idPrefix}-project`}>Project (path under the projects root)</label>
          <input
            id={`${idPrefix}-project`}
            value={project}
            onChange={(event) => setProject(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Button variant="primary" onClick={() => props.onReload(project.trim() === '' ? '.' : project.trim())} disabled={props.pending}>
          {props.pending ? 'Re-reading…' : 'Re-read configuration'}
        </Button>
      </div>
      {props.result !== null ? (
        <div role="status">
          <p className={styles.fact}>
            Configuration for “{props.result.project}” validated. {props.result.profiles.length} profile
            {props.result.profiles.length === 1 ? '' : 's'} loaded, {permissionCount} permission rule
            {permissionCount === 1 ? '' : 's'} in force
            {props.result.defaultAgentProfile === null
              ? ', no default agent profile set.'
              : `, default agent profile “${props.result.defaultAgentProfile}”.`}
          </p>
          {props.result.profiles.length > 0 ? (
            <p className={styles.note}>Profiles: {props.result.profiles.map((profile) => profile.name).join(', ')}.</p>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
