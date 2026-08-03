/**
 * Secret redaction for text that is about to be written to a log.
 *
 * Provider error bodies are the motivating case. An OpenAI-compatible gateway
 * that rejects a request routinely echoes back the key it was handed —
 * `Incorrect API key provided: sk-proj-...` — and that body is the single most
 * useful clue for diagnosing a misconfigured provider. It is worth keeping, but
 * not worth keeping verbatim: a log file outlives the request, gets rotated into
 * backups and gets pasted into bug reports.
 *
 * **This is defence in depth, not the control.** The control is that upstream
 * bodies are never serialized to the frontend at all — see
 * `AppError.privateDetails`, which `toJSON()` deliberately omits. Pattern
 * matching cannot recognise every credential format that exists, so nothing
 * should rely on this function alone to keep a secret safe.
 */

const PLACEHOLDER = '[redacted]';

/**
 * Vendor prefixes distinctive enough to identify a credential on sight, where
 * the prefix is followed by a separator: `sk-`, `ghp_`, `glpat-` and friends.
 * The prefix is preserved in the output so a log still says *what kind* of key
 * was rejected, which is most of the diagnostic value.
 */
const PREFIXED_KEY =
  /\b(sk|pk|rk|ghp|gho|ghu|ghs|ghr|gsk|xai|hf|glpat|shpat|dop_v1|sq0atp|sq0csp|xoxb|xoxp|xapp)[-_][A-Za-z0-9_-]{8,}/gi;

/** Prefixes that run straight into the secret with no separator. */
const BARE_PREFIXED_KEY =
  /\b(AIza[A-Za-z0-9_-]{10,}|A[SK]IA[A-Z0-9]{12,}|ya29\.[A-Za-z0-9._-]{10,})/g;

/** `Authorization: Bearer <token>` and its siblings, in any casing. */
const AUTH_SCHEME = /\b(bearer|basic|token)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** A JSON field whose *name* declares the value a secret. */
const NAMED_SECRET_JSON =
  /("[\w-]*(?:api[_-]?key|apikey|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|credential)[\w-]*"\s*:\s*)"[^"]*"/gi;

/** The same idea in a query string or form body. */
const NAMED_SECRET_QUERY =
  /\b([\w-]*(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd)[\w-]*=)([^&\s"']+)/gi;

/**
 * Mask anything that looks like a credential, leaving the surrounding text
 * readable. Returns the input unchanged when it is empty.
 */
export function redactSecrets(text: string): string {
  if (text === '') return text;

  return text
    .replace(NAMED_SECRET_JSON, `$1"${PLACEHOLDER}"`)
    .replace(NAMED_SECRET_QUERY, `$1${PLACEHOLDER}`)
    .replace(AUTH_SCHEME, `$1$2${PLACEHOLDER}`)
    .replace(PREFIXED_KEY, `$1-${PLACEHOLDER}`)
    .replace(BARE_PREFIXED_KEY, PLACEHOLDER);
}

/**
 * True when `text` still contains something that looks like a credential.
 * Intended for assertions and defensive checks rather than control flow.
 */
export function looksRedacted(text: string): boolean {
  return redactSecrets(text) === text;
}
