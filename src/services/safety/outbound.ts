/**
 * The outbound data safety layer (Part 1.23).
 *
 * Hyperion runs on the user's own machine, and much of what it can reach is
 * private by construction — a repository, a notes folder, a terminal's output. A
 * local model consumes that material without any of it leaving the machine. A
 * hosted gateway does not: everything in the request body crosses the network,
 * is logged by somebody else, and cannot be recalled.
 *
 * Two things follow, and this module is both of them:
 *
 *   1. **Classification.** Every usage row records which *kind* of provider
 *      served it, so the user can be shown how much of their traffic actually
 *      left the machine rather than having to reason about provider names.
 *   2. **Detection.** Before a payload goes to a remote provider, it is scanned
 *      for credential-shaped text and the user is told what was found.
 *
 * Three deliberate decisions, each of which is easy to get wrong:
 *
 * **It never rewrites the payload.** Silently masking part of a prompt would
 * change the question the user asked and hide that it happened; the model would
 * answer about `[redacted]` and the user would never know why the reply made no
 * sense. Detection reports; the user decides.
 *
 * **It is off by default.** The check is a heuristic over regexes, and a false
 * positive interrupts real work. A safety feature that fires on ordinary prompts
 * gets switched off entirely, which is strictly worse than one the user turned on
 * deliberately.
 *
 * **It applies to remote providers only.** A local model is not egress, and
 * warning about a secret in a prompt that never leaves `127.0.0.1` teaches the
 * user to dismiss the warning.
 */

import { findSensitive } from '../../util/redact.ts';
import { AppError } from '../../util/errors.ts';

import type { ChatMessage, ProviderType } from '../../types/core.ts';
import type { SecretKind } from '../../util/redact.ts';

/**
 * Whether a request to this provider leaves the machine.
 *
 * `unknown` is a real answer, not a placeholder. A usage row whose provider has
 * since been deleted has no type to report, and folding those rows into either
 * bucket would state something untrue about egress — understating it if they
 * land in `local`, overstating it if they land in `remote`. The summary reports
 * the bucket separately and lets the user see the gap.
 */
export type EgressClass = 'local' | 'remote' | 'unknown';

/**
 * A provider as far as egress is concerned: what it declares itself to be, the
 * URL it will actually be called at, and any proxy the bytes go through first.
 *
 * All three are needed. The type alone cannot answer the question this module
 * exists to answer, because two of the four types — `local` and `colibri` —
 * *claim* locality and nothing used to check the claim against where the bytes
 * go. And the URL alone is not enough once a proxy is configured: a request to
 * `127.0.0.1:11434` through a proxy in another country never touches this
 * machine's loopback at all, so "local" would be false for exactly the reason
 * 019 exists (Part 1.37).
 */
export interface EgressSubject {
  type: ProviderType | null | undefined;
  /** Absent, null or unparseable is treated as "not this machine". */
  baseUrl?: string | null;
  /** The provider's configured egress proxy, if any. Credentials are allowed. */
  egressProxy?: string | null;
}

/**
 * Map a provider type onto its egress class.
 *
 * `opencodex` is remote. It is easy to assume otherwise from the name — it is a
 * self-hosted-looking, hand-registered generation service — but the adapter
 * talks to it over HTTP at a base URL the user supplies, which may be anywhere.
 * `colibri` is the mirror image: a local runtime whose replies take minutes, so
 * its distinct type is about scheduling, not about where the bytes go.
 *
 * `puter` is remote for the plain reason the others are not: the service is
 * hosted, and the only thing that makes it a separate type is the *credential*
 * (an expiring session token, not a vendor key). Egress does not care about
 * that, so it is filed with `remote` rather than given a rule of its own.
 */
export function classifyProviderType(type: ProviderType | null | undefined): EgressClass {
  switch (type) {
    case 'local':
    case 'colibri':
      return 'local';
    case 'remote':
    case 'opencodex':
    // Puter is a hosted service: remote by declaration, and no URL could change
    // that. Listed with the type rather than after the URL check, because the
    // type *is* the answer here — a Puter provider reached over a tunnel is still
    // Puter (Part 1.38).
    case 'puter':
      return 'remote';
    default:
      // Covers both null (provider deleted) and a type this build does not know,
      // which is possible after a downgrade: migration 013 stores the type as
      // free text precisely so a new provider type cannot break the log.
      return 'unknown';
  }
}

/**
 * Whether a *hostname* names this machine.
 *
 * Deliberately literal: `localhost`, anything under `.localhost` (RFC 6761),
 * the IPv6 loopback, and the 127/8 block. No DNS resolution — a name that
 * happens to resolve to loopback (`127.0.0.1.nip.io`) is still a name handed to
 * a resolver, and the answer can change under us; treating it as local would be
 * a locality claim this process cannot check.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return false;
  // The whole /8, not just .1: 127.0.0.2 is this machine too.
  return octets[0] === 127;
}

function isLoopbackUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string' || url.trim() === '') return false;
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The egress class of a provider whose record is in hand. **Prefer this over
 * `classifyProviderType`**: the type-only mapping cannot see the URL, and for a
 * local-typed provider that is the whole question.
 *
 * A type that claims locality is verified against the URL, because the claim is
 * only true when that URL is this machine. Anything else — a LAN address, a
 * hostname, an unreadable URL — is `remote`, and every surface that asks
 * (the credential scan, the retention policy, the exposure summary) then says so.
 *
 * A declared *remote* type is never downgraded, not even pointed at 127.0.0.1.
 * `opencodex` is a local proxy that forwards to upstream vendors and a `remote`
 * provider may be anything at all; calling either local would *skip* the scan,
 * and understating egress is the one direction this module refuses to fail in.
 *
 * A type this build does not recognise stays `unknown` whatever its URL: not
 * knowing what a provider is cannot be improved by looking at its address.
 */
export function egressClassFor(provider: EgressSubject | null | undefined): EgressClass {
  const declared = classifyProviderType(provider?.type ?? null);
  if (declared !== 'local') return declared;
  if (!isLoopbackUrl(provider?.baseUrl)) return 'remote';
  // Both the type and the URL say this machine — but a proxy the traffic has to
  // reach first can still take it off the machine, and saying `local` then would
  // be the same class of mistake 019 fixed, one hop further out.
  return proxyLeavesMachine(provider) ? 'remote' : 'local';
}

/** True when a request to this provider leaves the machine. */
export function isEgress(provider: EgressSubject | null | undefined): boolean {
  return egressClassFor(provider) === 'remote';
}

// --- egress proxy (Part 1.37) ----------------------------------------------

/**
 * A per-provider proxy, parsed and canonicalised.
 *
 * `url` is the value the transport dials and may contain credentials. Everything
 * else here is what the rest of the process is allowed to see: `authority` is
 * `host:port` with no userinfo, and it is what gets stamped into the audit
 * column, compared for the local/remote question, and shown to the user.
 */
export interface EgressProxy {
  /** The URL as configured, minus a trailing slash. Credentials included. */
  url: string;
  scheme: 'http' | 'https';
  host: string;
  port: number;
  /** `host:port`, never credentials. The only form a read path may use. */
  authority: string;
  /** True when the configured URL carried a userinfo component. */
  hasCredentials: boolean;
  /** The URL as it may be shown or exported: `user:***@host:port` at most. */
  redacted: string;
}

/**
 * Parse a configured proxy URL.
 *
 * Throws `bad_request` rather than returning null for anything unusable, because
 * every caller of this function is a write path: silently storing a proxy the
 * transport cannot dial would produce exactly the failure 1.37 warns about — a
 * provider that looks local, is reported as proxied, and is neither.
 *
 * Only `http` and `https` are accepted. A SOCKS URL would be a *different*
 * transport, and accepting one that `undici` cannot dial would turn a typo into
 * "traffic went direct while the user believed it did not" — the one direction
 * this module refuses to fail in.
 */
export function parseEgressProxy(raw: string | null | undefined): EgressProxy | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError('bad_request', `Could not read the egress proxy URL "${trimmed}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(
      'bad_request',
      `The egress proxy must be an http or https URL; "${parsed.protocol}//" is not supported`,
    );
  }
  if (parsed.hostname === '') {
    throw new AppError('bad_request', 'The egress proxy URL has no host');
  }

  const scheme = parsed.protocol === 'https:' ? 'https' : 'http';
  const port = parsed.port === '' ? (scheme === 'https' ? 443 : 80) : Number(parsed.port);
  const hasCredentials = parsed.username !== '' || parsed.password !== '';
  const authority = `${parsed.hostname}:${String(port)}`;

  return {
    // A path on a proxy URL is meaningless to a CONNECT tunnel and would be
    // silently ignored, so it is dropped here rather than stored and ignored.
    url: `${scheme}://${hasCredentials ? `${parsed.username}:${parsed.password}@` : ''}${authority}`,
    scheme,
    host: parsed.hostname,
    port,
    authority,
    hasCredentials,
    // Only the *user* survives, and only so a reader can tell the proxy is
    // authenticated: which account it authenticates as is a fact about the path
    // the traffic takes, while the password is a credential and is never echoed.
    redacted: `${scheme}://${hasCredentials ? `${parsed.username}:***@` : ''}${authority}`,
  };
}

/** Parse without throwing: for read paths that must not fail on a stale row. */
export function tryEgressProxy(raw: string | null | undefined): EgressProxy | null {
  try {
    return parseEgressProxy(raw);
  } catch {
    return null;
  }
}

/**
 * The proxy as it may be shown or exported.
 *
 * Computed at parse time, from the parsed URL, rather than by string surgery on
 * the dial URL later: a redactor that runs on a string has to find the password
 * again, and every way of finding it is a way of missing it.
 */
export function redactEgressProxy(proxy: EgressProxy): string {
  return proxy.redacted;
}

/**
 * Whether a configured proxy sends traffic off this machine.
 *
 * Same literal loopback test as a provider URL, for the same reason: a proxy
 * hostname that merely resolves to loopback is still a name handed to a resolver.
 */
export function proxyLeavesMachine(provider: EgressSubject | null | undefined): boolean {
  const proxy = tryEgressProxy(provider?.egressProxy);
  return proxy !== null && !isLoopbackHost(proxy.host);
}

// --- detection -------------------------------------------------------------

export interface SensitiveHit {
  /** Index into the scanned message array, so the UI can point at the turn. */
  messageIndex: number;
  role: string;
  kind: SecretKind;
  /** Offset within that message's content. Never the matched text itself. */
  index: number;
  length: number;
}

export interface SensitiveReport {
  /** True when at least one hit was found. */
  flagged: boolean;
  hits: SensitiveHit[];
  /** Distinct rule names, for a one-line summary without walking `hits`. */
  kinds: SecretKind[];
}

/**
 * Scan an outbound message array for credential-shaped text.
 *
 * Pure and synchronous: it takes the messages and returns a report, touching no
 * database, no settings and no provider. That is what lets the same function be
 * called from the chat orchestrator and from the agent loop without either one
 * having to know how the other decides to act on the result — and it is why the
 * call sites sit *outside* `router.stream()`. A check buried in the router would
 * run on every internal failover retry of a payload already approved, and would
 * have no way to report anything but an exception.
 */
export function scanForSensitive(messages: readonly ChatMessage[]): SensitiveReport {
  const hits: SensitiveHit[] = [];

  for (const [messageIndex, message] of messages.entries()) {
    for (const finding of findSensitive(message.content)) {
      hits.push({
        messageIndex,
        role: message.role,
        kind: finding.kind,
        index: finding.index,
        length: finding.length,
      });
    }
  }

  return { flagged: hits.length > 0, hits, kinds: distinctKinds(hits) };
}

function distinctKinds(hits: readonly { kind: SecretKind }[]): SecretKind[] {
  const seen = new Set<SecretKind>();
  for (const hit of hits) seen.add(hit.kind);
  return [...seen];
}

/** Human wording for each rule, so the warning says something actionable. */
const KIND_LABELS: Record<SecretKind, string> = {
  vendor_prefixed_key: 'an API key with a recognisable vendor prefix',
  bare_prefixed_key: 'a cloud provider key',
  auth_scheme: 'an Authorization header value',
  named_secret_field: 'a field whose name declares it a secret',
  named_secret_query: 'a secret in a query string or form body',
};

export function describeKinds(kinds: readonly SecretKind[]): string {
  const described = kinds.map((kind) => KIND_LABELS[kind]);
  if (described.length <= 1) return described[0] ?? 'credential-shaped text';
  return `${described.slice(0, -1).join(', ')} and ${described[described.length - 1]}`;
}

/**
 * The gate. Refuses a remote send whose payload looks like it carries a
 * credential, unless the user has already acknowledged this send.
 *
 * The refusal is a 409 `redaction_flagged` carrying the findings, never a silent
 * rewrite and never a bare 400 — the frontend needs to know *what* was found so
 * it can show the user the span and offer to send anyway. `details` carries only
 * offsets and rule names; the matched text stays out of it, because an error
 * body that quotes the secret publishes it to every log that records the
 * response.
 */
export interface OutboundGateInput {
  messages: readonly ChatMessage[];
  /**
   * The provider the request is about to go to — its type *and* its URL. A type
   * that claims locality is only local if that URL is this machine, so passing
   * the type alone would wave through exactly the case this gate is for. Null
   * means we cannot say, and an unclassifiable provider is not gated.
   */
  provider: EgressSubject | null | undefined;
  /** The user has seen the finding and asked to send anyway. */
  acknowledged?: boolean;
  /** False when the feature toggle is off; the scan is then skipped entirely. */
  enabled: boolean;
}

export function assertOutboundSafe(input: OutboundGateInput): SensitiveReport | null {
  if (!input.enabled) return null;
  // A local model is not egress. Scanning it would cost time and produce
  // warnings about text that never left the machine — which is why "local" has
  // to be established from the URL and not taken from the type's word for it.
  const providerClass = egressClassFor(input.provider);
  if (providerClass !== 'remote') return null;

  const report = scanForSensitive(input.messages);
  if (!report.flagged) return report;

  // Acknowledgement is checked *after* the scan so the report is still returned
  // to the caller, which logs it. An acknowledged send is a decision worth
  // recording, not one worth forgetting.
  if (input.acknowledged === true) return report;

  throw new AppError(
    'redaction_flagged',
    `This request appears to contain ${describeKinds(report.kinds)}, and the selected provider is remote. ` +
      'Review it, or resend with acknowledgeSensitive to send it anyway.',
    {
      retryable: false,
      details: {
        kinds: report.kinds,
        hits: report.hits,
        providerClass,
      },
    },
  );
}
