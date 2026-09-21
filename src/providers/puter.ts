/**
 * Puter support — the fifth provider type (Prompt 1 addendum 1.38).
 *
 * Puter (puter.com) serves an OpenAI-compatible surface — `GET /v1/models` and
 * `POST /v1/chat/completions` under `/puterai/openai/v1` — so nothing here is
 * protocol: `adapterFor` routes type 'puter' to the stock `openAiAdapter`, exactly
 * as it does for 'colibri'. What lives here is what is *not* interchangeable with
 * every other provider, and it is one thing: **the credential is an auth token,
 * not a vendor API key.**
 *
 * That difference is not cosmetic, and it is the reason this type exists rather
 * than the user being told to pick `remote` and paste a key.
 *
 *   * A vendor key is issued by the company that runs the endpoint and is meant
 *     to live until it is rotated. A Puter auth token is taken from a signed-in
 *     Puter session, so it **expires**, and the fix when it does is to paste a
 *     fresh one rather than to wait for a provider to recover.
 *   * Because it expires, a 401 from this endpoint is a *configuration* fact, and
 *     the surface has to say so. Nothing here special-cases it: 1.36's table
 *     already classifies 401/403 as `auth` and pauses the provider for an hour,
 *     which is exactly the right shape for a dead token — do not keep retrying the
 *     same credential, and do not report it as a provider outage.
 *   * It is a credential like any other in storage: encrypted at rest, hinted by
 *     its last four characters, never returned by any route. `keyHint` takes the
 *     hint from whatever was pasted rather than assuming a prefix, which matters
 *     because a Puter token does not look like `sk-…`.
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
 * Shown where a Puter provider is configured.
 *
 * Written to answer the two questions a user actually has — where does the token
 * come from, and what happens when it stops working — because both are unusual
 * compared to every other provider in this app.
 */
export const PUTER_TOKEN_NOTE = [
  'Puter is configured with an auth token from a signed-in Puter session, not',
  'with a vendor API key. There is no key to create on a billing page: the token',
  'comes from your own Puter session, and you paste it here once.',
  '',
  '  - It expires. That is normal rather than a fault, and it is why an expired',
  '    token is reported as a configuration problem — the fix is to paste a fresh',
  '    one, not to wait for Puter to recover.',
  '  - A rejected token pauses this provider for an hour rather than being',
  '    retried on every request. Requests keep working through any other provider',
  '    you have configured, and failover order is unchanged.',
  '  - Puter is remote. Everything sent to it leaves this machine and is counted',
  '    as such, and the pre-send credential scan applies.',
  '',
  'The token is stored encrypted, like every other credential here, and is never',
  'returned by any endpoint.',
].join('\n');

/** Machine-readable form, so a settings screen can render it without parsing prose. */
export interface PuterAdvisory {
  type: 'puter';
  defaultBaseUrl: string;
  /** The credential kind, so a form can label the field correctly. */
  credential: 'auth_token';
  /** `remote` by type: never `local`, whatever URL is configured. */
  egress: 'remote';
  note: string;
}

export function puterAdvisory(): PuterAdvisory {
  return {
    type: 'puter',
    defaultBaseUrl: PUTER_DEFAULT_BASE_URL,
    credential: 'auth_token',
    egress: 'remote',
    note: PUTER_TOKEN_NOTE,
  };
}
