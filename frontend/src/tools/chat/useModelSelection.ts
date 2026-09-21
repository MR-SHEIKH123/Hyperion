import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getActiveModels, getActiveProvider } from '../../api/providers';
import type { ProviderPrivacy } from '../../components/PrivacyIndicator/PrivacyIndicator';
import type { ModelWire } from '../../contracts/wire/providers';

/**
 * Model picker data: the live model list of the active provider (docs/API.md
 * §3). One provider is active at a time, so there is exactly one list to pick
 * from; with no active provider the composer is disabled and says so.
 */
export interface ModelSelection {
  ready: boolean;
  /**
   * The active provider's egress and retention facts, straight from
   * `GET /api/providers/active` (Prompt 1.39 B). The composer renders them at
   * the point of send; `null` means the query has not answered yet.
   */
  privacy: ProviderPrivacy | null;
  models: ModelWire[];
  activeProviderName: string | null;
  activeProviderId: string | null;
  selectedId: string | null;
  /** Persisted preference (chat.modelId) when present and still offered. */
  preferred: string | null;
  setSelectedId: (id: string) => void;
  error: string | null;
}

export function useModelSelection(preferred: string | null): ModelSelection {
  const modelsQuery = useQuery({
    queryKey: ['providers', 'active', 'models'],
    queryFn: ({ signal }) => getActiveModels(signal),
    retry: false,
    refetchInterval: 60_000,
  });
  const providerQuery = useQuery({
    queryKey: ['providers', 'active'],
    queryFn: ({ signal }) => getActiveProvider(signal),
    retry: false,
    refetchInterval: 60_000,
  });

  const models = useMemo<ModelWire[]>(() => modelsQuery.data?.models ?? [], [modelsQuery.data?.models]);
  const activeProvider = providerQuery.data?.provider ?? null;
  const active = providerQuery.data;
  const privacy = useMemo<ProviderPrivacy | null>(
    () =>
      active === undefined
        ? null
        : {
            providerName: active.provider?.name ?? null,
            egress: active.egress,
            zdrStatus: active.zdr.status,
            zdrRequirement: active.zdr.requirement,
            redactionCheckEnabled: active.redactionCheckEnabled,
          },
    [active],
  );

  const [override, setOverride] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Follow the preference until the user picks something else; when the model
  // list changes (provider switch), fall back to the first offered model.
  useEffect(() => {
    if (override !== null) return;
    const preferredOk = preferred !== null && models.some((m) => m.id === preferred);
    if (preferredOk) {
      setSelectedId(preferred);
    } else {
      setSelectedId(models[0]?.id ?? null);
    }
  }, [preferred, models, override]);

  const choose = (id: string) => {
    setOverride(id);
    setSelectedId(id);
  };

  return {
    ready: !modelsQuery.isPending && !providerQuery.isPending,
    privacy,
    models,
    activeProviderName: activeProvider?.name ?? null,
    activeProviderId: activeProvider?.id ?? null,
    selectedId,
    preferred,
    setSelectedId: choose,
    error:
      modelsQuery.isError
        ? 'Could not load the model list from the active provider.'
        : providerQuery.data?.provider === null
          ? 'No provider is active — add and enable one in Settings.'
          : null,
  };
}
