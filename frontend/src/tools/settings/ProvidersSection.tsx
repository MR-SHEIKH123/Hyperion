import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../api/errors';
import {
  createProvider,
  deleteProvider,
  detectLocal,
  disableProvider,
  enableProvider,
  getColibriAdvisory,
  getProviderModels,
  getProviders,
  getPuterAdvisory,
  probeColibri,
  setProviderZdr,
  testProvider,
  updateProvider,
  type ProviderZdrInput,
} from '../../api/providers';
import { Button } from '../../design-system/components/Button/Button';
import { Dialog } from '../../design-system/components/Dialog/Dialog';
import type { ConnectionTestWire, ProviderWire } from '../../contracts/wire/providers';
import { ProviderForm } from './ProviderForm';
import { ProviderList, type ModelsPanelState } from './ProviderList';
import { ProviderZdrEditor } from './ProviderZdrEditor';
import { activeProviderOf, buildCreateInput, buildUpdateInput, type ProviderFormValues } from './providerModel';
import styles from './ProvidersSection.module.css';

/**
 * Plain words for a failed call, keeping the two failures the brief insists
 * stay separate: the backend said no (its message and code, quoted), or the
 * answer could not be trusted (validation failed on the way in). Neither is
 * ever dressed up as the other, and neither echoes anything the user typed —
 * least of all a key or a proxy address.
 */
export function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_response')
      return 'The backend answered, but its response failed validation against this frontend’s contract. Nothing was changed based on that answer.';
    if (error.code === 'network_error') return 'Hyperion could not be reached. Check that the backend is running, then try again.';
    const caveat =
      error.details !== undefined && typeof error.details['caveat'] === 'string' ? ` ${error.details['caveat']}` : '';
    return `The backend refused: ${error.message} (${error.code}).${caveat}`;
  }
  return 'Something went wrong in this page. Nothing was sent.';
}

type FormState = { mode: 'create' } | { mode: 'edit'; provider: ProviderWire } | null;
type ConfirmState = { kind: 'enable' | 'disable' | 'delete'; provider: ProviderWire } | null;

export function ProvidersSection() {
  const queryClient = useQueryClient();
  const providersQuery = useQuery({
    queryKey: ['providers', 'list'],
    queryFn: ({ signal }) => getProviders(signal),
  });
  const [form, setForm] = useState<FormState>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [enableAck, setEnableAck] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // The enable confirmation names the provider it will demote. That name is
  // only ever taken from a fresh read taken when the dialog opens — the list
  // the page happens to be showing may predate another tab, a failover, or a
  // test having refreshed a provider's health since it loaded.
  const [confirmRead, setConfirmRead] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [confirmProviders, setConfirmProviders] = useState<ProviderWire[] | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [zdrProvider, setZdrProvider] = useState<ProviderWire | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [zdrBusy, setZdrBusy] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, ConnectionTestWire>>({});
  const [modelsPanels, setModelsPanels] = useState<Record<string, ModelsPanelState>>({});

  const colibriContext = form !== null || confirm?.provider.type === 'colibri';
  const puterAdvisoryQuery = useQuery({
    queryKey: ['providers', 'puter-advisory'],
    queryFn: ({ signal }) => getPuterAdvisory(signal),
    enabled: form !== null,
  });
  const colibriAdvisoryQuery = useQuery({
    queryKey: ['providers', 'colibri-advisory'],
    queryFn: ({ signal }) => getColibriAdvisory(signal),
    enabled: colibriContext,
  });

  const invalidateProviders = () => void queryClient.invalidateQueries({ queryKey: ['providers'] });

  const providers = providersQuery.data?.providers ?? [];
  const active = activeProviderOf(providers);

  // --- form submit -----------------------------------------------------------

  const submitForm = async (values: ProviderFormValues): Promise<string | null> => {
    if (form === null) return 'The form is no longer open.';
    setFormBusy(true);
    try {
      if (form.mode === 'create') {
        const created = await createProvider(buildCreateInput(values));
        invalidateProviders();
        if (values.enabled && values.type === 'colibri') {
          try {
            await enableProvider(created.provider.id, { acknowledgeSlow: true });
          } catch (error) {
            setForm(null);
            setNotice(`Provider added, but enabling it failed. ${describeApiError(error)}`);
            invalidateProviders();
            return null;
          }
        }
        setNotice(values.enabled ? `“${created.provider.name}” added and enabled.` : `“${created.provider.name}” added.`);
      } else {
        const updated = await updateProvider(form.provider.id, buildUpdateInput(values));
        invalidateProviders();
        setNotice(`“${updated.provider.name}” saved.`);
      }
      setForm(null);
      return null;
    } catch (error) {
      return describeApiError(error);
    } finally {
      setFormBusy(false);
    }
  };

  // --- row actions -----------------------------------------------------------

  const readForConfirm = () => {
    setConfirmRead('loading');
    setConfirmProviders(null);
    void providersQuery
      .refetch()
      .then((result) => {
        // A failed refetch still carries the previous data on the result, so
        // `isError` — not missing data — is what says the read did not land.
        if (result.isError || result.data === undefined) {
          setConfirmRead('error');
        } else {
          setConfirmProviders(result.data.providers);
          setConfirmRead('ready');
        }
      })
      .catch(() => setConfirmRead('error'));
  };

  const openConfirm = (kind: 'enable' | 'disable' | 'delete', provider: ProviderWire) => {
    setActionError(null);
    setEnableAck(false);
    setConfirm({ kind, provider });
    // Enabling demotes whoever is active; re-read before naming them. The
    // other confirmations name only the row they were opened from.
    if (kind === 'enable') readForConfirm();
  };

  const runConfirm = async () => {
    if (confirm === null) return;
    const { kind, provider } = confirm;
    setActionPending(true);
    setActionError(null);
    try {
      if (kind === 'enable') {
        const result = await enableProvider(provider.id, provider.type === 'colibri' ? { acknowledgeSlow: true } : {});
        setNotice(
          result.activeProviderName === null
            ? `“${provider.name}” is enabled.`
            : `“${result.activeProviderName}” is now the active provider.`,
        );
      } else if (kind === 'disable') {
        const result = await disableProvider(provider.id);
        setNotice(
          result.activeProviderName === null
            ? `“${provider.name}” disabled — no provider is active now.`
            : `“${provider.name}” disabled. “${result.activeProviderName}” is the active provider.`,
        );
      } else {
        await deleteProvider(provider.id);
        setModelsPanels((current) => {
          const next = { ...current };
          delete next[provider.id];
          return next;
        });
        setTestResults((current) => {
          const next = { ...current };
          delete next[provider.id];
          return next;
        });
        setNotice(`“${provider.name}” deleted.`);
      }
      invalidateProviders();
      setConfirm(null);
    } catch (error) {
      setActionError(describeApiError(error));
    } finally {
      setActionPending(false);
    }
  };

  const runTest = async (provider: ProviderWire) => {
    setTestingId(provider.id);
    try {
      const result = await testProvider(provider.id);
      setTestResults((current) => ({ ...current, [provider.id]: result }));
      // A successful test refreshes the backend's model cache; the row facts follow.
      invalidateProviders();
    } catch (error) {
      setTestResults((current) => ({
        ...current,
        [provider.id]: { ok: false, message: describeApiError(error) },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const fetchModels = async (provider: ProviderWire, refresh: boolean) => {
    setModelsPanels((current) => ({ ...current, [provider.id]: { status: 'loading' } }));
    try {
      const data = await getProviderModels(provider.id, refresh);
      setModelsPanels((current) => ({ ...current, [provider.id]: { status: 'ready', data } }));
      invalidateProviders();
    } catch (error) {
      setModelsPanels((current) => ({
        ...current,
        [provider.id]: { status: 'error', message: describeApiError(error) },
      }));
    }
  };

  const toggleModels = (provider: ProviderWire) => {
    if (modelsPanels[provider.id] !== undefined) {
      setModelsPanels((current) => {
        const next = { ...current };
        delete next[provider.id];
        return next;
      });
      return;
    }
    void fetchModels(provider, false);
  };

  const submitZdr = async (input: ProviderZdrInput): Promise<string | null> => {
    if (zdrProvider === null) return 'The editor is no longer open.';
    setZdrBusy(true);
    try {
      const result = await setProviderZdr(zdrProvider.id, input);
      invalidateProviders();
      setNotice(`ZDR updated for “${result.provider.name}”.`);
      setZdrProvider(null);
      return null;
    } catch (error) {
      return describeApiError(error);
    } finally {
      setZdrBusy(false);
    }
  };

  // --- render ----------------------------------------------------------------

  const confirmProvider = confirm?.provider ?? null;
  // Once the fresh read lands, it — not the page's list — says who is active.
  const demoted =
    confirmProvider !== null && confirmRead === 'ready' && confirmProviders !== null
      ? (confirmProviders.find((provider) => provider.enabled && provider.id !== confirmProvider.id) ?? null)
      : null;
  const targetNowActive =
    confirmRead === 'ready' &&
    confirmProviders !== null &&
    confirmProvider !== null &&
    confirmProviders.some((provider) => provider.id === confirmProvider.id && provider.enabled);
  const enableNeedsAck = confirmProvider?.type === 'colibri';

  return (
    <section aria-labelledby="providers-heading">
      <div className={styles.header}>
        <div>
          <h2 id="providers-heading">Providers</h2>
          <p className={styles.intro}>
            The model providers Hyperion can run on. One is active at a time; enabling a provider moves the
            current one to standby.
          </p>
        </div>
        <Button variant="primary" onClick={() => setForm({ mode: 'create' })}>
          Add a provider
        </Button>
      </div>

      {notice !== null ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}

      {providersQuery.isPending ? (
        <p role="status">Loading providers…</p>
      ) : providersQuery.isError ? (
        <div className={styles.errorBox} role="alert">
          <p>The provider list could not be loaded. {describeApiError(providersQuery.error)}</p>
          <Button onClick={() => void providersQuery.refetch()}>Try again</Button>
        </div>
      ) : providers.length === 0 ? (
        <div className={styles.empty}>
          <p>No providers yet. Add your first provider to give Chat and Code something to run on.</p>
          <Button variant="primary" onClick={() => setForm({ mode: 'create' })}>
            Add your first provider
          </Button>
        </div>
      ) : (
        <>
          {active === null ? (
            <p className={styles.notice} role="note">
              No provider is enabled — Chat and Code have nothing to run on. Enable one below.
            </p>
          ) : null}
          <ProviderList
            providers={providers}
            testingId={testingId}
            testResults={testResults}
            modelsPanels={modelsPanels}
            onEnable={(provider) => openConfirm('enable', provider)}
            onDisable={(provider) => openConfirm('disable', provider)}
            onDelete={(provider) => openConfirm('delete', provider)}
            onEdit={(provider) => setForm({ mode: 'edit', provider })}
            onEditZdr={(provider) => setZdrProvider(provider)}
            onTest={(provider) => void runTest(provider)}
            onToggleModels={toggleModels}
            onRefreshModels={(provider) => void fetchModels(provider, true)}
          />
        </>
      )}

      <Dialog
        open={form !== null}
        title={form?.mode === 'edit' ? `Edit ${form.provider.name}` : 'Add a provider'}
        onClose={() => setForm(null)}
      >
        {form !== null ? (
          <ProviderForm
            key={form.mode === 'edit' ? form.provider.id : 'create'}
            mode={form.mode}
            {...(form.mode === 'edit' ? { provider: form.provider } : {})}
            puterAdvisory={{ data: puterAdvisoryQuery.data ?? null, error: puterAdvisoryQuery.isError }}
            colibriAdvisory={{ data: colibriAdvisoryQuery.data ?? null, error: colibriAdvisoryQuery.isError }}
            onDetectLocal={(baseUrl) => detectLocal(baseUrl)}
            onProbeColibri={(baseUrl) => probeColibri(baseUrl)}
            onSubmit={submitForm}
            onCancel={() => setForm(null)}
            submitting={formBusy}
          />
        ) : null}
      </Dialog>

      <Dialog
        open={zdrProvider !== null}
        title={zdrProvider === null ? 'Zero data retention' : `Zero data retention — ${zdrProvider.name}`}
        onClose={() => setZdrProvider(null)}
      >
        {zdrProvider !== null ? (
          <ProviderZdrEditor
            key={zdrProvider.id}
            provider={zdrProvider}
            onSubmit={submitZdr}
            onCancel={() => setZdrProvider(null)}
            submitting={zdrBusy}
          />
        ) : null}
      </Dialog>

      <Dialog
        open={confirm !== null}
        title={
          confirm === null
            ? ''
            : confirm.kind === 'enable'
              ? `Enable ${confirm.provider.name}?`
              : confirm.kind === 'disable'
                ? `Disable ${confirm.provider.name}?`
                : `Delete ${confirm.provider.name}?`
        }
        onClose={() => setConfirm(null)}
      >
        {confirm !== null && confirmProvider !== null ? (
          <div className={styles.confirmBody}>
            {confirm.kind === 'enable' && confirmRead === 'loading' ? (
              <p role="status">Checking which provider is currently active…</p>
            ) : confirm.kind === 'enable' && confirmRead === 'error' ? (
              <>
                <p role="alert">
                  The current active provider could not be confirmed — the provider list could not be re-read
                  just now. Rather than name a provider from a possibly stale list, this confirmation is
                  paused. Nothing has been enabled.
                </p>
                <div className={styles.confirmActions}>
                  <Button onClick={readForConfirm}>Try the check again</Button>
                </div>
              </>
            ) : confirm.kind === 'enable' ? (
              <>
                {targetNowActive ? (
                  <p>“{confirmProvider.name}” is already the active provider — there is nothing to change.</p>
                ) : (
                  <p>
                    “{confirmProvider.name}” becomes the active provider — the one Chat and Code run on.
                    {demoted !== null ? (
                      <>
                        {' '}
                        “{demoted.name}” is active now and will be moved to standby: it stays configured with
                        its key and models, and can be enabled again at any time.
                      </>
                    ) : null}
                  </p>
                )}
                {enableNeedsAck ? (
                  <>
                    {colibriAdvisoryQuery.data !== undefined ? (
                      <p>{colibriAdvisoryQuery.data.caveat}</p>
                    ) : (
                      <p>Colibrì runs on this machine and its inference can be extremely slow.</p>
                    )}
                    <label className={styles.ack}>
                      <input
                        type="checkbox"
                        checked={enableAck}
                        onChange={(event) => setEnableAck(event.target.checked)}
                      />
                      I understand Colibrì inference can be extremely slow — much slower than normal chat.
                    </label>
                  </>
                ) : null}
              </>
            ) : confirm.kind === 'disable' ? (
              <p>
                “{confirmProvider.name}” is the active provider. Disabling it leaves no provider active — Chat
                and Code will have nothing to run on until you enable one.
              </p>
            ) : (
              <p>
                “{confirmProvider.name}” will be removed, with its stored key, its model cache and its settings.
                This cannot be undone.
              </p>
            )}
            {actionError !== null ? (
              <p className={styles.actionError} role="alert">
                {actionError}
              </p>
            ) : null}
            <div className={styles.confirmActions}>
              <Button variant="quiet" onClick={() => setConfirm(null)} disabled={actionPending}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => void runConfirm()}
                disabled={
                  actionPending ||
                  (confirm.kind === 'enable' &&
                    (confirmRead !== 'ready' || targetNowActive || (enableNeedsAck && !enableAck)))
                }
              >
                {actionPending
                  ? 'Working…'
                  : confirm.kind === 'enable'
                    ? 'Enable'
                    : confirm.kind === 'disable'
                      ? 'Disable'
                      : 'Delete'}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}

export default ProvidersSection;
