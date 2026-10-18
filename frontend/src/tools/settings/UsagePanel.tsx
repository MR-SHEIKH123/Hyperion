import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { deletePrice, getExposureSummary, getUsageSummary, listPrices, savePrice } from '../../api/usage';
import { Button } from '../../design-system/components/Button/Button';
import type { ModelPriceWire, UsageBucketWire } from '../../contracts/wire/usage';
import { describeApiError } from './ProvidersSection';
import {
  costSummary,
  formatCount,
  formatTokens,
  formatUsd,
  reportedOrNot,
  unpricedNote,
  validatePriceField,
} from './dataModel';
import styles from './DataView.module.css';

/**
 * Usage, exposure, and prices (Settings 2.5, slice 3b).
 *
 * The honesty rules come from the backend and are kept literally: a
 * bucket with no requests reads "Nothing was recorded" (never $0.00,
 * never "free"); every cost figure stands beside its unpriced-request
 * count; cache and duration measures that no row reported read "Not
 * reported", not zero. The chart is inline SVG — bars for daily cost,
 * shaded differently on days where some requests had no price — with
 * the exact numbers in the table under it.
 */

export function BucketRows({ buckets, labelHeader }: { buckets: readonly UsageBucketWire[]; labelHeader: string }) {
  if (buckets.length === 0) return <p className={styles.fact}>Nothing was recorded.</p>;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th scope="col">{labelHeader}</th>
          <th scope="col" className={styles.num}>Requests</th>
          <th scope="col" className={styles.num}>Tokens in / out</th>
          <th scope="col">Cost</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((bucket) => (
          <tr key={bucket.key}>
            <td>{bucket.key}</td>
            <td className={styles.num}>{formatCount(bucket.requests)}</td>
            <td className={styles.num}>
              {formatTokens(bucket.tokensIn)} / {formatTokens(bucket.tokensOut)}
            </td>
            <td>
              {costSummary(bucket)}
              {unpricedNote(bucket) !== null ? <span className={styles.note}> {unpricedNote(bucket)}</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DailyChart({ days }: { days: readonly UsageBucketWire[] }) {
  if (days.length === 0) return null;
  const width = 760;
  const height = 160;
  const pad = 8;
  const max = Math.max(...days.map((day) => day.costUsd), 0);
  const barWidth = (width - pad * 2) / days.length;
  const summary = `Daily cost for ${days.length} day${days.length === 1 ? '' : 's'}; highest day ${max > 0 ? formatUsd(max) : 'unrecorded'}.`;
  return (
    <div className={styles.chartWrap}>
      <svg className={styles.chart} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
        {days.map((day, index) => {
          const barHeight = max > 0 ? Math.max(2, (day.costUsd / max) * (height - 30)) : 2;
          return (
            <rect
              key={day.key}
              className={day.unpricedRequests > 0 ? styles.chartBarUnpriced : styles.chartBar}
              x={pad + index * barWidth + 1}
              y={height - 20 - barHeight}
              width={Math.max(1, barWidth - 2)}
              height={barHeight}
            >
              <title>{`${day.key}: ${costSummary(day)}${day.unpricedRequests > 0 ? ` (${day.unpricedRequests} unpriced)` : ''}`}</title>
            </rect>
          );
        })}
        <line x1={pad} y1={height - 20} x2={width - pad} y2={height - 20} stroke="currentColor" strokeWidth="1" />
      </svg>
      <p className={styles.note}>
        Daily cost. Bars on days with unpriced requests are shaded as a warning: part of that day’s cost is unrecorded,
        so the bar is a floor, not the total.
      </p>
    </div>
  );
}

interface PriceDraft {
  modelId: string;
  providerId: string;
  inputPer1mUsd: string;
  outputPer1mUsd: string;
}

const EMPTY_DRAFT: PriceDraft = { modelId: '', providerId: '', inputPer1mUsd: '', outputPer1mUsd: '' };

export function PriceForm({
  initial,
  pending,
  error,
  onSubmit,
}: {
  initial: PriceDraft;
  pending: boolean;
  error: string | null;
  onSubmit: (price: { modelId: string; providerId: string | null; inputPer1mUsd: number; outputPer1mUsd: number }) => void;
}) {
  const [draft, setDraft] = useState<PriceDraft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = () => {
    const next: Record<string, string> = {};
    if (draft.modelId.trim() === '') next['modelId'] = 'Model is required.';
    const inputError = validatePriceField(draft.inputPer1mUsd, 'Input price');
    if (inputError !== null) next['inputPer1mUsd'] = inputError;
    const outputError = validatePriceField(draft.outputPer1mUsd, 'Output price');
    if (outputError !== null) next['outputPer1mUsd'] = outputError;
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    onSubmit({
      modelId: draft.modelId.trim(),
      providerId: draft.providerId.trim() === '' ? null : draft.providerId.trim(),
      inputPer1mUsd: Number(draft.inputPer1mUsd),
      outputPer1mUsd: Number(draft.outputPer1mUsd),
    });
  };

  return (
    <div>
      <div className={styles.grid2}>
        <div className={styles.field}>
          <label htmlFor="price-model">Model ID</label>
          <input
            id="price-model"
            value={draft.modelId}
            onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
          />
          {errors['modelId'] !== undefined ? <p className={styles.panelError}>{errors['modelId']}</p> : null}
        </div>
        <div className={styles.field}>
          <label htmlFor="price-provider">Provider ID (blank = all providers)</label>
          <input
            id="price-provider"
            value={draft.providerId}
            onChange={(event) => setDraft({ ...draft, providerId: event.target.value })}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="price-input">Input, USD per 1M tokens</label>
          <input
            id="price-input"
            inputMode="decimal"
            value={draft.inputPer1mUsd}
            onChange={(event) => setDraft({ ...draft, inputPer1mUsd: event.target.value })}
          />
          {errors['inputPer1mUsd'] !== undefined ? (
            <p className={styles.panelError}>{errors['inputPer1mUsd']}</p>
          ) : null}
        </div>
        <div className={styles.field}>
          <label htmlFor="price-output">Output, USD per 1M tokens</label>
          <input
            id="price-output"
            inputMode="decimal"
            value={draft.outputPer1mUsd}
            onChange={(event) => setDraft({ ...draft, outputPer1mUsd: event.target.value })}
          />
          {errors['outputPer1mUsd'] !== undefined ? (
            <p className={styles.panelError}>{errors['outputPer1mUsd']}</p>
          ) : null}
        </div>
      </div>
      {error !== null ? (
        <p className={styles.panelError} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button variant="primary" onClick={submit} disabled={pending}>
          {pending ? 'Saving…' : 'Save price'}
        </Button>
      </div>
    </div>
  );
}

export function UsageSection() {
  const queryClient = useQueryClient();
  const usageQuery = useQuery({ queryKey: ['data', 'usage'], queryFn: ({ signal }) => getUsageSummary(signal) });
  const exposureQuery = useQuery({
    queryKey: ['data', 'exposure'],
    queryFn: ({ signal }) => getExposureSummary(signal),
  });
  const pricesQuery = useQuery({ queryKey: ['data', 'prices'], queryFn: ({ signal }) => listPrices(signal) });

  const [editing, setEditing] = useState<PriceDraft | null>(null);
  const [pricePending, setPricePending] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [priceNotice, setPriceNotice] = useState<string | null>(null);

  const submitPrice = async (price: {
    modelId: string;
    providerId: string | null;
    inputPer1mUsd: number;
    outputPer1mUsd: number;
  }) => {
    setPricePending(true);
    setPriceError(null);
    try {
      const saved = await savePrice(price);
      setPriceNotice(
        `Price saved for ${saved.price.modelId}${saved.price.providerId === null ? ' (all providers)' : ''}. Costs are recomputed from stored prices when usage is recorded; earlier unpriced requests stay unpriced in these figures.`,
      );
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ['data', 'prices'] });
    } catch (error) {
      setPriceError(describeApiError(error));
    } finally {
      setPricePending(false);
    }
  };

  const removePrice = async (price: ModelPriceWire) => {
    setPriceError(null);
    try {
      const result = await deletePrice({ modelId: price.modelId, providerId: price.providerId });
      setPriceNotice(result.deleted ? `Price for ${price.modelId} removed.` : `No price for ${price.modelId} was stored.`);
      void queryClient.invalidateQueries({ queryKey: ['data', 'prices'] });
    } catch (error) {
      setPriceError(describeApiError(error));
    }
  };

  const totals = usageQuery.data?.totals;
  const exposure = exposureQuery.data;

  return (
    <div className={styles.panels}>
      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Usage</h3>
        {usageQuery.isPending ? (
          <p className={styles.fact}>Reading usage…</p>
        ) : usageQuery.isError ? (
          <p className={styles.panelError} role="alert">
            Usage could not be read. {describeApiError(usageQuery.error)}
          </p>
        ) : totals !== undefined ? (
          <>
            <p className={styles.fact}>
              {costSummary(totals)}
              {totals.requests > 0 ? (
                <>
                  {' '}
                  across {formatCount(totals.requests)} requests ({formatTokens(totals.tokensIn)} tokens in,{' '}
                  {formatTokens(totals.tokensOut)} out).
                </>
              ) : null}
            </p>
            {unpricedNote(totals) !== null ? <p className={styles.warning}>{unpricedNote(totals)}</p> : null}
            <p className={styles.note}>
              Cache reads: {reportedOrNot(totals.cacheReadTokens, formatTokens)} · cache hit rate:{' '}
              {reportedOrNot(totals.cacheHitRate, (value) => `${Math.round(value * 100)}%`)} · mean duration:{' '}
              {reportedOrNot(totals.meanDurationMs, (value) => `${formatCount(value)} ms`)} · slowest:{' '}
              {reportedOrNot(totals.slowestDurationMs, (value) => `${formatCount(value)} ms`)}.
            </p>
            <DailyChart days={usageQuery.data.byDay} />
            <BucketRows buckets={usageQuery.data.byDay} labelHeader="Day" />
            <h4 className={styles.panelTitle}>By provider</h4>
            <BucketRows buckets={usageQuery.data.byProvider} labelHeader="Provider" />
            <h4 className={styles.panelTitle}>By model</h4>
            <BucketRows buckets={usageQuery.data.byModel} labelHeader="Model" />
          </>
        ) : null}
      </div>

      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Where the work went</h3>
        {exposureQuery.isPending ? (
          <p className={styles.fact}>Reading exposure…</p>
        ) : exposureQuery.isError ? (
          <p className={styles.panelError} role="alert">
            Exposure could not be read. {describeApiError(exposureQuery.error)}
          </p>
        ) : exposure !== undefined ? (
          <>
            <BucketRows buckets={exposure.byClass} labelHeader="Destination" />
            {exposure.hasUnclassified ? (
              <p className={styles.warning}>
                Some requests could not be classified — their provider is gone or predates classification. They are
                counted in the unknown row, never quietly treated as local.
              </p>
            ) : null}
            {exposure.hasPreferenceUnmet ? (
              <p className={styles.warning}>
                Some requests were served by a provider that fell short of a “prefer” zero-retention policy while it
                was in force. The rows below say which status applied.
              </p>
            ) : null}
            <h4 className={styles.panelTitle}>By retention status</h4>
            {exposure.byZdrStatus.length === 0 ? (
              <p className={styles.fact}>Nothing was recorded.</p>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col" className={styles.num}>Requests</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {exposure.byZdrStatus.map((bucket) => (
                    <tr key={bucket.key}>
                      <td>
                        {bucket.key === 'unrecorded' ? 'Unrecorded (before the policy existed)' : bucket.key}{' '}
                        {bucket.preferenceUnmet ? <span className={`${styles.badge} ${styles.badgeWarn}`}>Policy unmet</span> : null}
                      </td>
                      <td className={styles.num}>{formatCount(bucket.requests)}</td>
                      <td>
                        {costSummary(bucket)}
                        {unpricedNote(bucket) !== null ? (
                          <span className={styles.note}> {unpricedNote(bucket)}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : null}
      </div>

      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Model prices</h3>
        <p className={styles.note}>
          Prices are yours to record — nothing is bundled or guessed. A request whose model has no price is counted as
          unpriced beside every cost figure until a price exists; saving one does not rewrite history.
        </p>
        {priceNotice !== null ? (
          <p className={styles.fact} role="status">
            {priceNotice}
          </p>
        ) : null}
        {pricesQuery.isPending ? (
          <p className={styles.fact}>Reading prices…</p>
        ) : pricesQuery.isError ? (
          <p className={styles.panelError} role="alert">
            Prices could not be read. {describeApiError(pricesQuery.error)}
          </p>
        ) : pricesQuery.data.prices.length === 0 ? (
          <p className={styles.fact}>No prices recorded. Costs will show as unpriced until one is added.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Provider</th>
                <th scope="col" className={styles.num}>In / 1M</th>
                <th scope="col" className={styles.num}>Out / 1M</th>
                <th scope="col"> </th>
              </tr>
            </thead>
            <tbody>
              {pricesQuery.data.prices.map((price) => (
                <tr key={`${price.modelId}:${price.providerId ?? ''}`}>
                  <td className={styles.mono}>{price.modelId}</td>
                  <td>{price.providerId ?? 'All providers'}</td>
                  <td className={styles.num}>{formatUsd(price.inputPer1mUsd)}</td>
                  <td className={styles.num}>{formatUsd(price.outputPer1mUsd)}</td>
                  <td>
                    <span className={styles.actions}>
                      <Button
                        variant="quiet"
                        onClick={() =>
                          setEditing({
                            modelId: price.modelId,
                            providerId: price.providerId ?? '',
                            inputPer1mUsd: String(price.inputPer1mUsd),
                            outputPer1mUsd: String(price.outputPer1mUsd),
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button variant="quiet" onClick={() => void removePrice(price)}>
                        Remove
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {priceError !== null && editing === null ? (
          <p className={styles.panelError} role="alert">
            {priceError}
          </p>
        ) : null}
        {editing === null ? (
          <div className={styles.actions}>
            <Button onClick={() => setEditing(EMPTY_DRAFT)}>Add a price…</Button>
          </div>
        ) : (
          <PriceForm
            key={`${editing.modelId}:${editing.providerId}`}
            initial={editing}
            pending={pricePending}
            error={priceError}
            onSubmit={(price) => void submitPrice(price)}
          />
        )}
      </div>
    </div>
  );
}
