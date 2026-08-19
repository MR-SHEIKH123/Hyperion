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
 * Map a provider type onto its egress class.
 *
 * `opencodex` is remote. It is easy to assume otherwise from the name — it is a
 * self-hosted-looking, hand-registered generation service — but the adapter
 * talks to it over HTTP at a base URL the user supplies, which may be anywhere.
 * `colibri` is the mirror image: a local runtime whose replies take minutes, so
 * its distinct type is about scheduling, not about where the bytes go.
 */
export function classifyProviderType(type: ProviderType | null | undefined): EgressClass {
  switch (type) {
    case 'local':
    case 'colibri':
      return 'local';
    case 'remote':
    case 'opencodex':
      return 'remote';
    default:
      // Covers both null (provider deleted) and a type this build does not know,
      // which is possible after a downgrade: migration 013 stores the type as
      // free text precisely so a new provider type cannot break the log.
      return 'unknown';
  }
}

/** True when a request to this provider type leaves the machine. */
export function isEgress(type: ProviderType | null | undefined): boolean {
  return classifyProviderType(type) === 'remote';
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
  providerType: ProviderType | null | undefined;
  /** The user has seen the finding and asked to send anyway. */
  acknowledged?: boolean;
  /** False when the feature toggle is off; the scan is then skipped entirely. */
  enabled: boolean;
}

export function assertOutboundSafe(input: OutboundGateInput): SensitiveReport | null {
  if (!input.enabled) return null;
  // A local model is not egress. Scanning it would cost time and produce
  // warnings about text that never left the machine.
  if (!isEgress(input.providerType)) return null;

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
        providerClass: classifyProviderType(input.providerType),
      },
    },
  );
}
