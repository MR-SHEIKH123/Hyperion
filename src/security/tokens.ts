/**
 * Opaque bearer tokens: minted, and compared, in one place.
 *
 * Two features hand a caller a secret it must present again — the process
 * ownership token (S3) and the interactive terminal session token (S17) — and both
 * need the same two operations. They live here rather than beside either caller for
 * the reason the second one exists at all: a token checked with a comparison that
 * returns early on the first differing byte can be recovered one byte at a time by
 * whoever can measure the difference. `timingSafeEqual` is the only correct
 * primitive, and having exactly one call site means the second feature cannot
 * accidentally be built with `===`.
 *
 * Tokens are hex, not base64url: a hex string has no `+` or `/` to escape in a
 * header, and its length is exactly twice the entropy in bytes, which makes "is
 * this the right shape?" checkable by a reader without decoding anything.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 bytes: 256 bits, well past guessing and still one short line in a header. */
const TOKEN_BYTES = 32;

export function mintToken(bytes: number = TOKEN_BYTES): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Compare a stored token against one a caller presented.
 *
 * `unknown` rather than `string` on purpose: the presented value arrives from a
 * request, so a caller that forgot to check for `undefined` gets a refusal instead
 * of `Buffer.from(undefined)` — the shape of the value must never be able to turn
 * an authentication into a crash, or a crash into a pass.
 *
 * A length mismatch is answered without comparing, because the length of a token
 * this process minted is not a secret: every token is the same length, so a
 * different length is already a refusal.
 */
export function tokensMatch(stored: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || presented === '') return false;
  const expected = Buffer.from(stored, 'utf8');
  const actual = Buffer.from(presented, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
