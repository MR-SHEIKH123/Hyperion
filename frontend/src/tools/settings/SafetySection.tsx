import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getLimits,
  getNetworkEgress,
  getRedactionCheck,
  getToolAccessMode,
  getZdrPolicy,
  reloadConfig,
  setNetworkEgress,
  setRedactionCheck,
  setToolAccessMode,
  setZdrRequirement,
  updateLimits,
} from '../../api/settings';
import { Button } from '../../design-system/components/Button/Button';
import type { ReloadConfigWire } from '../../contracts/wire/settings';
import type { ZdrRequirementWire } from '../../contracts/wire/providers';
import { describeApiError } from './ProvidersSection';
import { EgressPanel, LimitsPanel, RedactionPanel, ReloadPanel, ToolAccessPanel, ZdrPanel } from './SafetyPanels';
import { buildLimitsUpdate, type LimitsFormValues } from './safetyModel';
import styles from './SafetyPanels.module.css';

type PanelKey = 'egress' | 'redaction' | 'zdr' | 'toolAccess' | 'limits';

/**
 * Safety and limits (Settings 2.5, slice 2): network egress, the outbound
 * data check, the standing ZDR policy, the spending cap and ceilings, the
 * tool-access mode, and Reload Config. Each control is its own typed route
 * and its own honest state — a panel that cannot load says so without
 * taking the others down, and a write response (a subset of the read) is
 * merged into what is displayed rather than replacing the constants only
 * the GET carries.
 */
export function SafetySection() {
  const queryClient = useQueryClient();
  const egressQuery = useQuery({ queryKey: ['settings', 'network-egress'], queryFn: ({ signal }) => getNetworkEgress(signal) });
  const redactionQuery = useQuery({ queryKey: ['settings', 'redaction-check'], queryFn: ({ signal }) => getRedactionCheck(signal) });
  const zdrQuery = useQuery({ queryKey: ['settings', 'zdr'], queryFn: ({ signal }) => getZdrPolicy(signal) });
  const toolAccessQuery = useQuery({ queryKey: ['settings', 'tool-access-mode'], queryFn: ({ signal }) => getToolAccessMode(signal) });
  const limitsQuery = useQuery({ queryKey: ['settings', 'limits'], queryFn: ({ signal }) => getLimits(signal) });

  const [busy, setBusy] = useState<Partial<Record<PanelKey, boolean>>>({});
  const [panelErrors, setPanelErrors] = useState<Partial<Record<PanelKey, string | null>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadPending, setReloadPending] = useState(false);
  const [reloadResult, setReloadResult] = useState<ReloadConfigWire | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);

  const runPanel = async (key: PanelKey, action: () => Promise<string>): Promise<boolean> => {
    setBusy((current) => ({ ...current, [key]: true }));
    setPanelErrors((current) => ({ ...current, [key]: null }));
    try {
      setNotice(await action());
      return true;
    } catch (error) {
      setPanelErrors((current) => ({ ...current, [key]: describeApiError(error) }));
      return false;
    } finally {
      setBusy((current) => ({ ...current, [key]: false }));
    }
  };

  const toggleEgress = async (enabled: boolean) => {
    await runPanel('egress', async () => {
      const result = await setNetworkEgress(enabled);
      queryClient.setQueryData(['settings', 'network-egress'], (old: typeof result | undefined) =>
        old === undefined ? result : { ...old, ...result },
      );
      return result.effective
        ? 'Network egress is on and effective.'
        : enabled
          ? 'Network egress is stored on, but not effective while code execution is off.'
          : 'Network egress is off.';
    });
  };

  const toggleRedaction = async (enabled: boolean) => {
    await runPanel('redaction', async () => {
      const result = await setRedactionCheck(enabled);
      queryClient.setQueryData(['settings', 'redaction-check'], (old: typeof result | undefined) =>
        old === undefined ? result : { ...old, ...result },
      );
      return result.enabled ? 'The outbound data check is on.' : 'The outbound data check is off.';
    });
  };

  const changeZdr = async (requirement: ZdrRequirementWire) => {
    await runPanel('zdr', async () => {
      const result = await setZdrRequirement(requirement);
      queryClient.setQueryData(['settings', 'zdr'], (old: typeof result | undefined) =>
        old === undefined ? result : { ...old, ...result },
      );
      return `The ZDR policy is now “${result.requirement}”.`;
    });
  };

  const changeToolAccess = async (mode: 'always_loaded' | 'load_when_needed') => {
    await runPanel('toolAccess', async () => {
      const result = await setToolAccessMode(mode);
      queryClient.setQueryData(['settings', 'tool-access-mode'], result);
      return `Tool access mode is now “${result.mode.replaceAll('_', ' ')}”.`;
    });
  };

  const saveLimits = async (values: LimitsFormValues): Promise<string | null> => {
    if (limitsQuery.data === undefined) return 'The current limits have not loaded yet.';
    const update = buildLimitsUpdate(values, limitsQuery.data);
    let failure: string | null = null;
    await runPanel('limits', async () => {
      const result = await updateLimits(update);
      queryClient.setQueryData(['settings', 'limits'], result);
      return result.updated === undefined ? 'Limits saved.' : `Limits saved (${result.updated.join(', ')}).`;
    }).then((ok) => {
      if (!ok) failure = 'The limits could not be saved — see the panel message above.';
    });
    return failure;
  };

  const runReload = async (project: string) => {
    setReloadPending(true);
    setReloadError(null);
    try {
      const result = await reloadConfig(project === '.' ? undefined : project);
      setReloadResult(result);
    } catch (error) {
      setReloadResult(null);
      setReloadError(describeApiError(error));
    } finally {
      setReloadPending(false);
    }
  };

  const slot = (
    label: string,
    query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => Promise<unknown> },
    children: ReactNode,
  ) =>
    query.isPending ? (
      <p role="status">Loading {label}…</p>
    ) : query.isError ? (
      <article className={styles.panel}>
        <p className={styles.panelError} role="alert">
          {label} could not be loaded. {describeApiError(query.error)}
        </p>
        <Button onClick={() => void query.refetch()}>Try again</Button>
      </article>
    ) : (
      children
    );

  return (
    <section aria-labelledby="safety-heading">
      <h2 id="safety-heading">Safety and limits</h2>
      <p className={styles.intro}>
        What may leave this machine, what is checked before it does, and the limits that keep a runaway task from
        spending or looping without bound. Each control states how it is actually enforced — none of these is a
        sandbox.
      </p>
      {notice !== null ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}
      <div className={styles.panels}>
        {slot(
          'network egress',
          egressQuery,
          egressQuery.data === undefined ? null : (
            <EgressPanel
              data={egressQuery.data}
              pending={busy.egress === true}
              error={panelErrors.egress ?? null}
              onToggle={(enabled) => void toggleEgress(enabled)}
            />
          ),
        )}
        {slot(
          'the outbound data check',
          redactionQuery,
          redactionQuery.data === undefined ? null : (
            <RedactionPanel
              data={redactionQuery.data}
              pending={busy.redaction === true}
              error={panelErrors.redaction ?? null}
              onToggle={(enabled) => void toggleRedaction(enabled)}
            />
          ),
        )}
        {slot(
          'the ZDR policy',
          zdrQuery,
          zdrQuery.data === undefined ? null : (
            <ZdrPanel
              data={zdrQuery.data}
              pending={busy.zdr === true}
              error={panelErrors.zdr ?? null}
              onChange={(requirement) => void changeZdr(requirement)}
            />
          ),
        )}
        {slot(
          'limits',
          limitsQuery,
          limitsQuery.data === undefined ? null : (
            <LimitsPanel
              key={limitsQuery.dataUpdatedAt}
              data={limitsQuery.data}
              pending={busy.limits === true}
              error={panelErrors.limits ?? null}
              onSave={saveLimits}
            />
          ),
        )}
        {slot(
          'the tool-access mode',
          toolAccessQuery,
          toolAccessQuery.data === undefined ? null : (
            <ToolAccessPanel
              mode={toolAccessQuery.data.mode}
              pending={busy.toolAccess === true}
              error={panelErrors.toolAccess ?? null}
              onChange={(mode) => void changeToolAccess(mode)}
            />
          ),
        )}
        <ReloadPanel pending={reloadPending} result={reloadResult} error={reloadError} onReload={(project) => void runReload(project)} />
      </div>
    </section>
  );
}

export default SafetySection;
