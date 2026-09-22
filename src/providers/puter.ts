/**
 * Puter support — the fifth provider type (Prompt 1 addendum 1.38).
 *
 * Puter (puter.com) serves an OpenAI-compatible surface
 * (`POST /puterai/openai/v1/chat/completions`), so the *protocol* is stock:
 * streaming goes through `openAiAdapter.stream` unchanged. Three things are not
 * interchangeable, and this file is where they are stated:
 *
 *   1. **The credential is an auth token, not a vendor API key.** It is minted
 *      from the Puter dashboard, it is named, it is shown once, and it is
 *      revocable at any time under Settings → Security → Manage sessions
 *      (Puter's own dashboard code creates it as a labelled `access_token`
 *      session). Expiry is **opt-in** — the dialog offers Never / 7 days / 30
 *      days / 90 days, with Never first — so a token does not "just expire": it
 *      either has an expiry the user chose, or someone revoked it. Either way a
 *      401 is a *configuration* fact rather than an outage, and 1.36's table
 *      already classifies 401/403 as `auth` and pauses the provider for the hour
 *      instead of retrying a dead credential on every request.
 *   2. **The model catalogue is not the chat endpoint.** Every other
 *      OpenAI-compatible provider here answers `GET {base}/models`;
 *      `https://api.puter.com/puterai/openai/v1/models` is not Puter's catalogue.
 *      Puter publishes it, unauthenticated, at
 *      `GET /puterai/chat/models/details` (with `/puterai/chat/models` as the
 *      documented fallback), and that payload is *richer* than an OpenAI model
 *      list: it carries `context` — the context window — along with provider,
 *      name and per-model cost. `puterAdapter.listModels` reads it, so the model
 *      picker fills and 1.28's context ceiling is judged against a real window
 *      rather than the assumed default.
 *   3. **The compatible endpoint requires a paid Puter plan.** The same models are
 *      available to every account through `puter.ai.*`, but `/puterai/openai/v1/*`
 *      answers a free account with `402 subscription_required`; an exhausted
 *      monthly usage credit answers `402 insufficient_funds`, and requests over
 *      the window answer `429 too_many_requests` (30 per 10s and 3 concurrent on
 *      a free plan, 200 and 20 on a paid one). Both 402s are turned into a
 *      message that names the actual condition — a plan that does not include the
 *      endpoint is not something a retry fixes.
 *
 * The credential is stored like every other one: encrypted at rest, hinted by its
 * last four characters, never returned by any route. `keyHint` takes the hint
 * from whatever was pasted rather than assuming a prefix, which matters because a
 * Puter token does not look like `sk-…`. A minted access token can use the whole
 * Puter API but is rejected by the account-management endpoints (password, email,
 * 2FA, session-cookie sync, minting further tokens), so a token pasted into this
 * app cannot be escalated into account control.
 *
 * Puter is **remote**, always, and classified by type rather than by URL: it is a
 * hosted service, so the credential scan runs on everything sent to it and the
 * exposure summary counts its traffic as having left the machine.
 *
 * Registered manually only, and never auto-enabled: `detectAndRegisterLocal`
 * stays exclusive to type 'local' (Ollama).
 */

/** Puter's documented endpoint. A suggestion for a form to pre-fill, never an assumption. */
export const PUTER_DEFAULT_BASE_URL = 'https://api.puter.com/puterai/openai/v1';

/**
 * Where Puter's model catalogue lives, relative to the chat base URL.
 *
 * A function rather than a constant because it is *derived from whatever base URL
 * the provider has*, not assumed: the catalogue is a sibling of the OpenAI surface
 * under the same origin. A provider pointed at a proxy (which is what a
 * compatibility shim like `opencode-puter-auth serve --openai` is) does not have
 * that shape, gets `null`, and keeps the ordinary `GET {base}/models` listing.
 */
export function puterCatalogueUrls(baseUrl: string): { details: string; summary: string } | null {
  const match = /^(.+?)\/puterai\/openai\/v1\/?$/.exec(baseUrl.trim());
  if (match === null) return null;
  const stem = match[1];
  return {
    details: `${stem}/puterai/chat/models/details`,
    summary: `${stem}/puterai/chat/models`,
  };
}

/** The catalogue URL for the documented default, for a settings screen to show. */
export const PUTER_CATALOGUE_URL = 'https://api.puter.com/puterai/chat/models/details';

/**
 * Shown where a Puter provider is configured.
 *
 * Rewritten after checking Puter's own documentation and dashboard source rather
 * than from memory, because the first version of this note asserted that the token
 * "expires" — and expiry is opt-in (Never is the default option in the create
 * dialog). It also omitted the fact that decides whether the provider works at
 * all: the OpenAI-compatible endpoint requires a paid plan.
 */
export const PUTER_TOKEN_NOTE = [
  'Puter is configured with an auth token from your Puter account, not with a',
  'vendor API key. Create it at puter.com/dashboard ("Create token"); it is shown',
  'once, and it can be revoked at any time under Settings → Security → Manage',
  'sessions. An expiry is optional — the dialog offers Never, 7, 30 or 90 days — so',
  'if this stops working, a revoked or expired token is the first thing to check',
  'rather than a Puter outage.',
  '',
  '  - A rejected token is reported as a configuration problem and pauses this',
  '    provider for an hour rather than being retried on every request. Paste a',
  '    fresh token to clear it.',
  '  - The OpenAI-compatible endpoint Puter exposes (/puterai/openai/v1) requires a',
  '    paid Puter plan. On a free account every request answers 402',
  '    subscription_required — that is the plan, not your token, and not something',
  '    a retry fixes. The same models are free through Puter\'s own SDK.',
  '  - Requests are metered against that account\'s monthly usage credit (a spent',
  '    credit answers 402 insufficient_funds) and rate limited per window (30',
  '    requests per 10s and 3 at once on a free plan, 200 and 20 on a paid one).',
  '  - Puter is remote. Everything sent to it leaves this machine and is counted as',
  '    such, and the pre-send credential scan applies.',
  '',
  'The token is stored encrypted, like every other credential here, and is never',
  'returned by any endpoint. It can use the whole Puter API but cannot change your',
  'account\'s password, email, 2FA or sessions — Puter refuses those for a minted',
  'token — so it cannot be escalated into account control.',
].join('\n');

/** Machine-readable form, so a settings screen can render it without parsing prose. */
export interface PuterAdvisory {
  type: 'puter';
  defaultBaseUrl: string;
  /** The credential kind, so a form can label the field correctly. */
  credential: 'auth_token';
  /** `remote` by type: never `local`, whatever URL is configured. */
  egress: 'remote';
  /**
   * Where the model list actually comes from. A machine-readable field because a
   * settings screen that showed `{base}/models` would be describing a route Puter
   * does not have.
   */
  catalogueUrl: string;
  /**
   * True because the OpenAI-compatible surface is a paid-plan feature: a free
   * account gets `402 subscription_required`. A form can warn before the token is
   * pasted instead of after the first failed request.
   */
  requiresPaidPlan: true;
  note: string;
}

export function puterAdvisory(): PuterAdvisory {
  return {
    type: 'puter',
    defaultBaseUrl: PUTER_DEFAULT_BASE_URL,
    credential: 'auth_token',
    egress: 'remote',
    catalogueUrl: PUTER_CATALOGUE_URL,
    requiresPaidPlan: true,
    note: PUTER_TOKEN_NOTE,
  };
}
