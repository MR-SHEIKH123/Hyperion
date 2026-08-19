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
 * True when `text` contains **nothing** that this module recognises as a
 * credential — i.e. redacting it would change nothing.
 *
 * Read the name as "this text already looks redacted", not as "this text
 * contains a secret". The comment here previously said the opposite of what the
 * code does, which is a live trap: the obvious instinct when writing an
 * outbound check is to reach for this as "does this contain a secret", and that
 * is exactly backwards — it would wave through every payload that *does* carry
 * one. `test/secrets.test.ts` pins the true behaviour.
 *
 * For control flow, use `findSensitive` instead. It answers the question
 * directly, and says what it found.
 */
export function looksRedacted(text: string): boolean {
  return redactSecrets(text) === text;
}

// --- detection (Part 1.23) -------------------------------------------------

/**
 * Which rule recognised a credential. Named rather than numbered so the UI can
 * word the warning usefully — "an Authorization header" reads very differently
 * from "a field called `password`" — and so a false positive can be described
 * precisely in a bug report.
 */
export type SecretKind =
  | 'vendor_prefixed_key'
  | 'bare_prefixed_key'
  | 'auth_scheme'
  | 'named_secret_field'
  | 'named_secret_query';

export interface SecretFinding {
  kind: SecretKind;
  /**
   * Character offset of the match within the scanned text. Enough for the UI to
   * point at the offending span; deliberately not the matched text itself.
   */
  index: number;
  /** Length of the match, so a caller can highlight it without re-scanning. */
  length: number;
}

/**
 * Detection is a separate function from masking, on purpose.
 *
 * `redactSecrets` answers "make this safe to log" and throws the evidence away
 * in the process — after masking, nothing knows what was hit or where. The
 * outbound safety layer needs the opposite: leave the text alone and report
 * precisely what was found, so the user can be shown the finding and decide.
 * Collapsing the two would force a choice between mangling a user's prompt and
 * telling them nothing.
 */
const DETECTORS: readonly { kind: SecretKind; pattern: RegExp }[] = [
  { kind: 'named_secret_field', pattern: NAMED_SECRET_JSON },
  { kind: 'named_secret_query', pattern: NAMED_SECRET_QUERY },
  { kind: 'auth_scheme', pattern: AUTH_SCHEME },
  { kind: 'vendor_prefixed_key', pattern: PREFIXED_KEY },
  { kind: 'bare_prefixed_key', pattern: BARE_PREFIXED_KEY },
];

/**
 * Every credential-shaped span in `text`, ordered by position.
 *
 * The matched text is **never** returned. A finding travels to the frontend so
 * the user can act on it, and a payload describing the secret verbatim would
 * publish the very thing being protected — the same reasoning that keeps
 * upstream error bodies in `AppError.privateDetails`.
 *
 * Each pattern is matched with a fresh `RegExp`: the module-level ones carry the
 * `g` flag, so `lastIndex` persists between calls and a shared instance would
 * skip matches depending on what was scanned before it.
 */
export function findSensitive(text: string): SecretFinding[] {
  if (text === '') return [];

  const findings: SecretFinding[] = [];
  for (const { kind, pattern } of DETECTORS) {
    const scanner = new RegExp(pattern.source, pattern.flags);
    for (let match = scanner.exec(text); match !== null; match = scanner.exec(text)) {
      findings.push({ kind, index: match.index, length: match[0].length });
      // A zero-length match cannot happen with these patterns, but guarding is
      // cheaper than an infinite loop if one is ever relaxed.
      if (match[0].length === 0) scanner.lastIndex += 1;
    }
  }
  return findings.sort((a, b) => a.index - b.index);
}

/** True when `text` contains at least one credential-shaped span. */
export function containsSensitive(text: string): boolean {
  return findSensitive(text).length > 0;
}
