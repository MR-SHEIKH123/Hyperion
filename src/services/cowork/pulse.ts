/**
 * Cowork Pulse (1.30): on-demand public-web fetching for the Cowork agent.
 *
 * Two tiers behind one tool (`pulse.fetch`). The **free** tier queries four
 * keyless sources — Reddit, Hacker News, Polymarket, GitHub — and is **off by
 * default**: fetching is network egress the user did not type, so the switch
 * starts at `off` and the tool is unoffered until it moves. The **keyed** tier
 * is a framework in v1: the registry, the tier plumbing and the audit trail
 * are real, but no concrete keyed source ships — a future source module
 * registers an implementation and the rest already works.
 *
 * Three properties carry the design:
 *
 *   1. **The tool is the only entry.** There is deliberately no direct-fetch
 *      HTTP route and no poller or watchlist: Pulse answers a question the
 *      run is asking right now, on demand, and nothing fetches on a timer.
 *   2. **The query is scanned before it is sent.** When
 *      `redaction_check_enabled` is on, a query carrying credential-shaped
 *      text is refused with `redaction_flagged` — with Pulse's own wording,
 *      because the stock refusal offers an acknowledge-and-send-anyway that
 *      must not exist for public search APIs (see CONTRACTS.md).
 *   3. **Every fetch is recorded.** `pulse_fetches` keeps the query, the tier,
 *      the per-source outcomes (failures included) and the items, newest-first
 *      for the history route.
 *
 * SSRF is excluded by construction: source hosts are fixed constants, the tool
 * schema carries no URL field, and the endpoint override below exists only so
 * the tests can point the adapters at fake servers — no route or tool argument
 * reaches it.
 */
import { pulseTier, redactionCheckEnabled, setSetting, type PulseTier } from '../../db/settings.ts';
import { listPulseFetches, recordPulseFetch, type PulseFetchRow, type PulseItem, type PulseSourceOutcome } from '../../db/pulseFetches.ts';
import { describeKinds, scanForSensitive } from '../safety/outbound.ts';
import { createLogger } from '../../util/logger.ts';
import { AppError } from '../../util/errors.ts';

import type { ChatMessage } from '../../types/core.ts';

const log = createLogger('cowork:pulse');

export const PULSE_MAX_QUERY = 300;
export const PULSE_DEFAULT_LIMIT = 5;
export const PULSE_MAX_LIMIT = 10;
export const PULSE_SOURCE_TIMEOUT_MS = 10_000;
/** A source body past this is not a search page; stop buffering, fail the source. */
export const PULSE_MAX_BODY_BYTES = 2 * 1024 * 1024;
const TITLE_MAX = 200;
const SNIPPET_MAX = 300;

export type { PulseTier };

export interface PulseSourceInfo {
  id: string;
  label: string;
}

export interface PulseConfig {
  tier: PulseTier;
  freeSources: PulseSourceInfo[];
  keyedSources: PulseSourceInfo[];
}

// ---------------------------------------------------------------------------
// Free sources
// ---------------------------------------------------------------------------

interface FreeSource {
  id: string;
  label: string;
  endpoint: string;
}

const FREE_SOURCES: readonly FreeSource[] = [
  { id: 'reddit', label: 'Reddit', endpoint: 'https://www.reddit.com' },
  { id: 'hackernews', label: 'Hacker News', endpoint: 'https://hn.algolia.com' },
  { id: 'polymarket', label: 'Polymarket', endpoint: 'https://gamma-api.polymarket.com' },
  { id: 'github', label: 'GitHub', endpoint: 'https://api.github.com' },
];

const FREE_SOURCE_IDS = new Set(FREE_SOURCES.map((source) => source.id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function clip(text: string | null, max: number): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

function asScore(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function fetchJson(source: string, url: string, headers: Record<string, string>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(PULSE_SOURCE_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(`${source} timed out after ${PULSE_SOURCE_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`${source} is unreachable (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!res.ok) {
    throw new Error(sourceError(source, res.status));
  }
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > PULSE_MAX_BODY_BYTES) {
    throw new Error(`${source} answered with a ${(Number(declared) / 1024 / 1024).toFixed(1)} MiB body; refusing to buffer it`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > PULSE_MAX_BODY_BYTES) {
    throw new Error(`${source} answered with a ${(bytes.length / 1024 / 1024).toFixed(1)} MiB body; refusing to buffer it`);
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`${source} answered with a body that is not JSON`);
  }
}

function sourceError(source: string, status: number): string {
  if (source === 'github' && (status === 403 || status === 429)) {
    return `GitHub answered HTTP ${status} (unauthenticated search allows 10 requests/minute)`;
  }
  if (source === 'reddit' && (status === 403 || status === 429)) {
    return `Reddit answered HTTP ${status} (it rate-limits anonymous search; retry shortly)`;
  }
  return `${source} answered HTTP ${status}`;
}

function redditUrl(base: string, permalink: string | null): string | null {
  if (!permalink) return null;
  // Belt and braces: permalinks are paths, but a compromised API answering a
  // full URL must not turn into a link the user trusts as reddit.com.
  if (!permalink.startsWith('/')) return null;
  return `${base}${permalink}`;
}

async function fetchReddit(query: string, limit: number, base: string): Promise<PulseItem[]> {
  const url = `${base}/search.json?q=${encodeURIComponent(query)}&limit=${limit}&sort=relevance&type=link&raw_json=1`;
  const body = await fetchJson('reddit', url, {
    'user-agent': 'hyperion-pulse/1.0',
    accept: 'application/json',
  });
  const children = isRecord(body) && isRecord(body.data) && Array.isArray(body.data.children) ? body.data.children : [];
  const items: PulseItem[] = [];
  for (const child of children.slice(0, limit)) {
    const data = isRecord(child) ? (child.data as unknown) : null;
    if (!isRecord(data)) continue;
    const title = asText(data.title);
    if (!title) continue;
    const created = typeof data.created_utc === 'number' ? new Date(data.created_utc * 1000).toISOString() : null;
    items.push({
      source: 'reddit',
      title: clip(title, TITLE_MAX) ?? title.slice(0, TITLE_MAX),
      url: redditUrl(base, asText(data.permalink)),
      snippet: clip(asText(data.selftext), SNIPPET_MAX),
      publishedAt: created,
      score: asScore(data.score),
    });
  }
  return items;
}

async function fetchHackerNews(query: string, limit: number, base: string): Promise<PulseItem[]> {
  const url = `${base}/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}`;
  const body = await fetchJson('hackernews', url, { accept: 'application/json' });
  const hits = isRecord(body) && Array.isArray(body.hits) ? body.hits : [];
  const items: PulseItem[] = [];
  for (const hit of hits.slice(0, limit)) {
    if (!isRecord(hit)) continue;
    const title = asText(hit.title);
    if (!title) continue;
    items.push({
      source: 'hackernews',
      title: clip(title, TITLE_MAX) ?? title.slice(0, TITLE_MAX),
      url: asText(hit.url) ?? (asText(hit.objectID) ? `https://news.ycombinator.com/item?id=${hit.objectID}` : null),
      snippet: null,
      publishedAt: asText(hit.created_at),
      score: asScore(hit.points),
    });
  }
  return items;
}

async function fetchPolymarket(query: string, limit: number, base: string): Promise<PulseItem[]> {
  const url = `${base}/public-search?q=${encodeURIComponent(query)}`;
  const body = await fetchJson('polymarket', url, { accept: 'application/json' });
  const events = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.events) ? body.events : [];
  const items: PulseItem[] = [];
  for (const event of events.slice(0, limit)) {
    if (!isRecord(event)) continue;
    const title = asText(event.question) ?? asText(event.title);
    if (!title) continue;
    const slug = asText(event.slug);
    items.push({
      source: 'polymarket',
      title: clip(title, TITLE_MAX) ?? title.slice(0, TITLE_MAX),
      url: slug ? `https://polymarket.com/event/${slug}` : null,
      snippet: clip(asText(event.description), SNIPPET_MAX),
      publishedAt: asText(event.createdAt),
      score: null,
    });
  }
  return items;
}

async function fetchGitHub(query: string, limit: number, base: string): Promise<PulseItem[]> {
  const url = `${base}/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`;
  const body = await fetchJson('github', url, {
    'user-agent': 'hyperion-pulse/1.0',
    accept: 'application/vnd.github+json',
  });
  const repos = isRecord(body) && Array.isArray(body.items) ? body.items : [];
  const items: PulseItem[] = [];
  for (const repo of repos.slice(0, limit)) {
    if (!isRecord(repo)) continue;
    const title = asText(repo.full_name);
    if (!title) continue;
    items.push({
      source: 'github',
      title: clip(title, TITLE_MAX) ?? title.slice(0, TITLE_MAX),
      url: asText(repo.html_url),
      snippet: clip(asText(repo.description), SNIPPET_MAX),
      publishedAt: asText(repo.pushed_at),
      score: asScore(repo.stargazers_count),
    });
  }
  return items;
}

const FREE_FETCHERS: Readonly<Record<string, (query: string, limit: number, base: string) => Promise<PulseItem[]>>> = {
  reddit: fetchReddit,
  hackernews: fetchHackerNews,
  polymarket: fetchPolymarket,
  github: fetchGitHub,
};

// ---------------------------------------------------------------------------
// Keyed tier framework (no concrete source ships in v1)
// ---------------------------------------------------------------------------

/**
 * A credentialed Pulse source, implemented by a future module and plugged in
 * here. The framework owns everything around it — tier plumbing, the redaction
 * scan, fan-out, the audit trail — so a new source is only ever this object:
 * an id, a label, and a fetch that turns a query into items. Secrets stay with
 * the implementing module (read at fetch time); nothing credential-shaped is
 * passed in or written down.
 */
export interface KeyedPulseSource {
  id: string;
  label: string;
  fetch: (query: string, limit: number) => Promise<PulseItem[]>;
}

const keyedSources = new Map<string, KeyedPulseSource>();

function assertSourceId(id: string): void {
  if (!/^[a-z0-9-]{1,64}$/.test(id)) {
    throw new Error(`Keyed Pulse source id must be 1–64 lowercase letters, digits or hyphens (got ${JSON.stringify(id)}).`);
  }
  if (FREE_SOURCE_IDS.has(id)) {
    throw new Error(`Keyed Pulse source id ${JSON.stringify(id)} collides with a free source.`);
  }
}

export function registerKeyedSource(source: KeyedPulseSource): void {
  assertSourceId(source.id);
  if (typeof source.label !== 'string' || source.label.trim() === '') {
    throw new Error('Keyed Pulse source needs a non-empty label.');
  }
  if (typeof source.fetch !== 'function') {
    throw new Error(`Keyed Pulse source ${JSON.stringify(source.id)} has no fetch function.`);
  }
  if (keyedSources.has(source.id)) {
    throw new Error(`Keyed Pulse source ${JSON.stringify(source.id)} is already registered.`);
  }
  keyedSources.set(source.id, source);
  log.info('keyed Pulse source registered', { id: source.id });
}

/** Exists for the tests (and a future unload path); production never unregisters. */
export function unregisterKeyedSource(id: string): boolean {
  return keyedSources.delete(id);
}

export function listKeyedSources(): PulseSourceInfo[] {
  return [...keyedSources.values()].map((source) => ({ id: source.id, label: source.label }));
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function getPulseConfig(): PulseConfig {
  return {
    tier: pulseTier(),
    freeSources: FREE_SOURCES.map((source) => ({ id: source.id, label: source.label })),
    keyedSources: listKeyedSources(),
  };
}

const PULSE_PATCH_FIELDS: ReadonlySet<string> = new Set(['tier']);

/**
 * The tier is the whole write surface: unknown keys are rejected, and `tier`
 * is required — an empty PUT is a client bug, not a read.
 */
export function savePulseTier(patch: Record<string, unknown>): PulseConfig {
  for (const key of Object.keys(patch)) {
    if (!PULSE_PATCH_FIELDS.has(key)) {
      throw new AppError('bad_request', `Unknown Pulse setting: ${key}.`, { details: { field: key } });
    }
  }
  const tier = patch.tier;
  if (tier !== 'off' && tier !== 'free' && tier !== 'keyed') {
    throw new AppError('bad_request', 'Pulse tier must be one of off, free or keyed.', {
      details: { field: 'tier', allowed: ['off', 'free', 'keyed'] },
    });
  }
  setSetting('pulse_tier', tier);
  const config = getPulseConfig();
  log.info('Pulse tier updated', { tier: config.tier });
  return config;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface PulseFetchInput {
  query: string;
  limit?: number;
  sources?: string[];
}

/**
 * Test-only seam: per-source endpoint overrides pointing the adapters at fake
 * servers. No route or tool argument reaches this — production always fetches
 * the fixed hosts above.
 */
export interface PulseFetchOptions {
  endpoints?: Partial<Record<string, string>>;
}

export interface PulseFetchResult {
  query: string;
  tier: Exclude<PulseTier, 'off'>;
  items: PulseItem[];
  outcomes: PulseSourceOutcome[];
  durationMs: number;
}

function validatedInput(input: PulseFetchInput, tier: Exclude<PulseTier, 'off'>): { query: string; limit: number; sources: string[] } {
  const query = input.query.trim();
  if (query === '') {
    throw new AppError('bad_request', 'Pulse query must not be empty.', { details: { field: 'query' } });
  }
  if (query.length > PULSE_MAX_QUERY) {
    throw new AppError('bad_request', `Pulse query must be at most ${PULSE_MAX_QUERY} characters.`, {
      details: { field: 'query' },
    });
  }
  const limit = input.limit ?? PULSE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > PULSE_MAX_LIMIT) {
    throw new AppError('bad_request', `Pulse limit must be an integer from 1 to ${PULSE_MAX_LIMIT}.`, {
      details: { field: 'limit' },
    });
  }
  const available = tier === 'free' ? [...FREE_SOURCE_IDS] : [...keyedSources.keys()];
  const sources = input.sources ?? available;
  if (sources.length === 0) {
    throw new AppError('bad_request', 'Pulse sources must name at least one source.', { details: { field: 'sources' } });
  }
  for (const id of sources) {
    if (!available.includes(id)) {
      throw new AppError('bad_request', `Unknown Pulse source for the ${tier} tier: ${id}.`, {
        details: { field: 'sources', value: id, allowed: available },
      });
    }
  }
  return { query, limit, sources: [...new Set(sources)] };
}

function scanQuery(query: string): void {
  if (!redactionCheckEnabled()) return;
  const messages: ChatMessage[] = [{ role: 'user', content: query }];
  const report = scanForSensitive(messages);
  if (!report.flagged) return;
  // The code and details shape are the tree's one refusal; the wording is
  // Pulse's own, because the stock text offers an acknowledge-and-send-anyway
  // that must not exist here — a public search API is not the user's provider,
  // and no acknowledgement should post a suspected secret to one.
  throw new AppError(
    'redaction_flagged',
    `Pulse query refused: it appears to contain ${describeKinds(report.kinds)}. ` +
      'Rephrase without the credential-shaped text — Pulse queries go to public search APIs, so there is no send-anyway for this one.',
    { retryable: false, details: { kinds: report.kinds, hits: report.hits } },
  );
}

/**
 * Run one fetch: tier gate, redaction scan, parallel fan-out, audit row.
 *
 * Partial failure is the normal shape — one slow source must not erase the
 * three that answered — so per-source errors ride along in the result and only
 * a total failure (no items, nothing but errors) throws.
 */
export async function fetchPulse(input: PulseFetchInput, options: PulseFetchOptions = {}): Promise<PulseFetchResult> {
  const tier = pulseTier();
  if (tier === 'off') {
    throw new AppError('capability_disabled', 'Pulse is off. Set the Pulse tier to free or keyed to fetch.', {
      details: { tier },
    });
  }
  if (tier === 'keyed' && keyedSources.size === 0) {
    throw new AppError('capability_disabled', 'Pulse keyed tier is selected but no keyed sources are registered.', {
      details: { tier },
    });
  }

  const { query, limit, sources } = validatedInput(input, tier);
  scanQuery(query);

  const started = Date.now();
  const endpoints = options.endpoints ?? {};
  const outcomes: (PulseSourceOutcome & { items: PulseItem[] })[] = await Promise.all(
    sources.map(async (id): Promise<PulseSourceOutcome & { items: PulseItem[] }> => {
      const at = Date.now();
      try {
        const items =
          tier === 'free'
            ? await (FREE_FETCHERS[id] as (query: string, limit: number, base: string) => Promise<PulseItem[]>)(
                query,
                limit,
                endpoints[id] ?? (FREE_SOURCES.find((source) => source.id === id) as FreeSource).endpoint,
              )
            : await (keyedSources.get(id) as KeyedPulseSource).fetch(query, limit);
        return { source: id, ok: true, count: items.length, error: null, ms: Date.now() - at, items };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { source: id, ok: false, count: 0, error: message, ms: Date.now() - at, items: [] };
      }
    }),
  );
  const items = outcomes.flatMap((outcome) => outcome.items);
  const record: PulseFetchResult = {
    query,
    tier,
    items,
    outcomes: outcomes.map(({ source, ok, count, error, ms }) => ({ source, ok, count, error, ms })),
    durationMs: Date.now() - started,
  };

  // Best-effort like run provenance: a fetch that already succeeded must not
  // fail because its history row could not be written.
  try {
    recordPulseFetch({ query, tier, sources: record.outcomes, items });
  } catch (error) {
    log.warn('could not record a Pulse fetch', error);
  }

  if (items.length === 0 && outcomes.some((outcome) => !outcome.ok)) {
    const failures = outcomes
      .filter((outcome) => !outcome.ok)
      .map((outcome) => `${outcome.source}: ${outcome.error}`)
      .join('; ');
    throw new AppError('storage_error', `Pulse fetch failed: ${failures}.`, {
      details: { query, failures: outcomes.filter((outcome) => !outcome.ok) },
    });
  }
  return record;
}

/** The model's view of a fetch: one line per item, failures named, nothing else. */
export function formatPulseResult(result: PulseFetchResult): string {
  const lines = [`Pulse (${result.tier} tier): ${result.items.length} result${result.items.length === 1 ? '' : 's'} for "${result.query}".`];
  const failed = result.outcomes.filter((outcome) => !outcome.ok);
  if (failed.length > 0) {
    lines.push(`Not answered: ${failed.map((outcome) => `${outcome.source} (${outcome.error})`).join('; ')}.`);
  }
  if (result.items.length === 0) {
    lines.push('No results.');
    return lines.join('\n');
  }
  for (const item of result.items) {
    lines.push(`[${item.source}] ${item.title}${item.url ? ` — ${item.url}` : ''}`);
    if (item.snippet) lines.push(`  ${item.snippet}`);
  }
  return lines.join('\n');
}

/** The system prompt's one line on Pulse: tier, what answers, and the tool to call. */
export function pulseStatusMessage(): string {
  const tier = pulseTier();
  if (tier === 'off') {
    return 'Pulse status: off — no web fetching is available. Do not claim otherwise.';
  }
  if (tier === 'free') {
    return `Pulse status: free tier — query ${FREE_SOURCES.map((source) => source.label).join(', ')} with the pulse.fetch tool. On-demand only: fetch when the run needs the live web, not speculatively.`;
  }
  const keyed = listKeyedSources();
  if (keyed.length === 0) {
    return 'Pulse status: keyed tier selected, but no keyed sources are registered — pulse.fetch will refuse until one is.';
  }
  return `Pulse status: keyed tier — query ${keyed.map((source) => source.label).join(', ')} with the pulse.fetch tool.`;
}

export function listPulseHistory(limit: number): PulseFetchRow[] {
  return listPulseFetches(limit);
}
