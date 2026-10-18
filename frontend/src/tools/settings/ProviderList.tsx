import { Button } from '../../design-system/components/Button/Button';
import { StatusBadge } from '../../design-system/components/StatusBadge/StatusBadge';
import type {
  ConnectionTestWire,
  ProviderModelsResponseWire,
  ProviderWire,
} from '../../contracts/wire/providers';
import {
  cooldownSummary,
  formatTime,
  isPaymentFailure,
  providerLocality,
  providerStateLabel,
  zdrSummary,
  HEALTH_LABELS,
  HEALTH_TONES,
  PROVIDER_TYPE_LABELS,
} from './providerModel';
import styles from './ProviderList.module.css';

export type ModelsPanelState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ProviderModelsResponseWire };

export interface ProviderListProps {
  providers: ProviderWire[];
  testingId: string | null;
  testResults: Record<string, ConnectionTestWire>;
  modelsPanels: Record<string, ModelsPanelState>;
  onEnable: (provider: ProviderWire) => void;
  onDisable: (provider: ProviderWire) => void;
  onDelete: (provider: ProviderWire) => void;
  onEdit: (provider: ProviderWire) => void;
  onEditZdr: (provider: ProviderWire) => void;
  onTest: (provider: ProviderWire) => void;
  onToggleModels: (provider: ProviderWire) => void;
  onRefreshModels: (provider: ProviderWire) => void;
}

/**
 * The provider rows, presentational on purpose: the dev harness renders this
 * with fixtures and no network, and the section container wires the same
 * component to the real queries. Every fact on a row comes from the
 * backend's provider object — state words, health, ZDR, proxy, model count —
 * and where the backend does not expose a thing, the row says so.
 */
export function ProviderList(props: ProviderListProps) {
  return (
    <ul className={styles.list}>
      {props.providers.map((provider) => (
        <ProviderRow key={provider.id} provider={provider} {...props} />
      ))}
    </ul>
  );
}

function ProviderRow(props: ProviderListProps & { provider: ProviderWire }) {
  const { provider } = props;
  const locality = providerLocality(provider);
  const zdr = zdrSummary(provider);
  const cooldown = cooldownSummary(provider);
  const test = props.testResults[provider.id];
  const panel = props.modelsPanels[provider.id];
  const modelsOpen = panel !== undefined;

  return (
    <li className={styles.row}>
      <div className={styles.rowHeader}>
        <h3 className={styles.name}>{provider.name}</h3>
        <StatusBadge tone={provider.enabled ? 'success' : 'neutral'}>{providerStateLabel(provider)}</StatusBadge>
        <StatusBadge tone={locality === 'local' ? 'info' : locality === 'remote' ? 'warning' : 'neutral'}>
          {locality === 'local' ? 'Runs locally' : locality === 'remote' ? 'Remote' : 'Locality unknown'}
        </StatusBadge>
        <StatusBadge tone={HEALTH_TONES[provider.healthStatus]}>{HEALTH_LABELS[provider.healthStatus]}</StatusBadge>
      </div>

      <dl className={styles.facts}>
        <div>
          <dt>Type</dt>
          <dd>{PROVIDER_TYPE_LABELS[provider.type]}</dd>
        </div>
        <div>
          <dt>Base URL</dt>
          <dd className={styles.mono}>{provider.baseUrl}</dd>
        </div>
        <div>
          <dt>API key</dt>
          <dd>
            {provider.hasKey
              ? `Set${provider.apiKeyHint === null ? '' : ` (${provider.apiKeyHint})`} — never shown`
              : 'Not set'}
          </dd>
        </div>
        <div>
          <dt>Models</dt>
          <dd>
            {provider.modelCount === null ? 'Not reported' : `${provider.modelCount} known`}
            {provider.modelsFetchedAt === null ? '' : ` · fetched ${formatTime(provider.modelsFetchedAt)}`}
          </dd>
        </div>
        <div>
          <dt>Max context</dt>
          <dd>
            {provider.maxContextTokens === null
              ? 'Provider’s own window (no override)'
              : `${provider.maxContextTokens.toLocaleString()} tokens (override)`}
          </dd>
        </div>
        <div>
          <dt>Last success</dt>
          <dd>{formatTime(provider.lastSuccessAt)}</dd>
        </div>
      </dl>

      {provider.lastError !== null ? (
        <p className={styles.errorLine} role="note">
          Last error{provider.lastErrorAt === null ? '' : ` (${formatTime(provider.lastErrorAt)})`}: {provider.lastError}
        </p>
      ) : null}
      {provider.modelsError !== null ? (
        <p className={styles.errorLine} role="note">
          Model list problem: {provider.modelsError}
        </p>
      ) : null}
      {cooldown !== null ? (
        <p className={styles.cooldownLine} role="note">
          {cooldown}
        </p>
      ) : null}

      <p className={styles.zdrLine}>
        <strong>{zdr.state}.</strong> {zdr.detail}
      </p>

      <p className={styles.proxyLine}>
        {provider.egressProxy === null ? (
          <>Egress proxy: none — traffic goes straight to the base URL.</>
        ) : (
          <>
            Egress proxy: configured ({provider.egressProxy}). A proxy changes the route traffic takes; it does
            not make this provider anonymous and it does not give zero data retention.
          </>
        )}
      </p>

      <div className={styles.actions}>
        {provider.enabled ? (
          <Button onClick={() => props.onDisable(provider)}>Disable</Button>
        ) : (
          <Button variant="primary" onClick={() => props.onEnable(provider)}>
            Enable
          </Button>
        )}
        <Button onClick={() => props.onTest(provider)} disabled={props.testingId === provider.id}>
          {props.testingId === provider.id ? 'Testing…' : 'Test connection'}
        </Button>
        <Button
          onClick={() => props.onToggleModels(provider)}
          aria-expanded={modelsOpen}
          aria-controls={`models-${provider.id}`}
        >
          {modelsOpen ? 'Hide models' : 'Show models'}
        </Button>
        <Button onClick={() => props.onEdit(provider)}>Edit</Button>
        <Button onClick={() => props.onEditZdr(provider)}>ZDR…</Button>
        <Button onClick={() => props.onDelete(provider)}>Delete</Button>
      </div>

      {props.testingId === provider.id ? (
        <p className={styles.testLine} role="status">
          Testing the connection — this does not block anything else.
        </p>
      ) : null}
      {test !== undefined ? (
        <p className={styles.testLine} role="status">
          {test.ok ? (
            <>Connection OK. {test.message}</>
          ) : (
            <>
              Connection failed. {test.message}
              {isPaymentFailure(test.code, test.message)
                ? ' The provider asked for payment (HTTP 402). That is not retried automatically — check the plan or balance for this provider, then test again.'
                : ''}
            </>
          )}
        </p>
      ) : null}

      {modelsOpen ? (
        <div className={styles.modelsPanel} id={`models-${provider.id}`}>
          {panel.status === 'loading' ? (
            <p role="status">Loading the model list…</p>
          ) : panel.status === 'error' ? (
            <p role="alert">{panel.message}</p>
          ) : (
            <>
              <div className={styles.modelsHeader}>
                <p>
                  {panel.data.models.length} model{panel.data.models.length === 1 ? '' : 's'}
                  {provider.modelsFetchedAt === null
                    ? ' · fetch time not reported'
                    : ` · fetched ${formatTime(provider.modelsFetchedAt)}`}
                </p>
                <Button onClick={() => props.onRefreshModels(provider)}>Refresh models</Button>
              </div>
              {panel.data.models.length === 0 ? (
                <p>No models are known for this provider yet.</p>
              ) : (
                <ul className={styles.models}>
                  {panel.data.models.map((model) => (
                    <li key={model.id}>
                      <span className={styles.mono}>{model.id}</span>
                      {model.label === undefined || model.label === model.id ? null : <span> — {model.label}</span>}
                      <span className={styles.contextLength}>
                        {model.contextLength === undefined
                          ? ' · context length not reported'
                          : ` · ${model.contextLength.toLocaleString()} tokens of context (as reported)`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

export default ProviderList;
