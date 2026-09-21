/**
 * Backup encryption: a passphrase-protected archive container (Prompt 1.29).
 *
 * The archive itself is a zip of the database snapshot, the skills tree and
 * (optionally) attachments. This file wraps that zip in a single authenticated
 * container so an archive can leave the machine — emailed to yourself, dropped
 * in a cloud folder, left on a USB stick — without being readable by whoever
 * finds it. It is the same question 1.37 asked about provider traffic and the
 * export service already asked about `secret.key`: the artifact's usual journey
 * is *further than the machine that made it*.
 *
 * **The construction, and why each part is what it is.**
 *
 *   * **Argon2id** derives the key. It is the password-hashing function the
 *     requirement names, and it is the right family for the job: the input is a
 *     human passphrase, so the defense that matters is making a guess cost
 *     memory as well as time. `scrypt` (already in Node) is the near neighbour,
 *     but adding a WASM Argon2id is cheap and the requirement is explicit —
 *     `hash-wasm` ships the algorithm as WASM with no native build, no
 *     postinstall, and no per-platform binary to get wrong.
 *   * **AES-256-GCM** encrypts the bytes, in one pass, with a 96-bit random
 *     nonce. GCM is authenticated: a flipped bit in the ciphertext fails the tag
 *     check and the archive is refused rather than silently decrypted into
 *     garbage that then *restores* garbage. That property is the whole reason to
 *     prefer it over CTR/CBC here, where the payload is a database.
 *   * **The KDF cost parameters live in the header**, not in this file's
 *     defaults. A default raised in a future version must not make yesterday's
 *     archives undecryptable, and a user on slow hardware must be able to write
 *     an archive that a faster machine can still read.
 *
 * **What is deliberately not here.**
 *
 *   * No passphrase storage of any kind. The passphrase arrives with a request,
 *     is used, and is dropped; it is never written to the archive, the manifest,
 *     the settings table or a log line. A backup feature that keeps the key
 *     beside the lock is a backup feature whose encryption means nothing.
 *   * No key file as an alternative to a passphrase. `secret.key` is already
 *     handled by the export's `includeKeys` switch, which is about *including*
 *     credentials, not about protecting the archive.
 *   * No compression. The payload is already a zip, so there is nothing to gain
 *     and a second layer would only be a place to get things wrong.
 *
 * **Container layout** (all integers big-endian; version 1):
 *
 * ```
 *   0    8   magic  "HYPBAK01"
 *   8    1   kdf id          1 = argon2id
 *   9    1   cipher id       1 = aes-256-gcm
 *   10   2   reserved (0)
 *   12   4   argon2 memory in KiB
 *   16   4   argon2 iterations
 *   20   1   argon2 parallelism
 *   21   1   argon2 output length in bytes
 *   22   2   reserved (0)
 *   24  16   salt
 *   40  12   nonce
 *   52   4   ciphertext length
 *   56   n   ciphertext
 *   56+n 16  GCM tag
 * ```
 *
 * The length field is redundant (readers can use the file size) but it makes a
 * truncated file detectable *before* the KDF runs, which matters more than it
 * sounds: deriving a key at 64 MiB costs a second or two, and a corrupt upload
 * should not buy that.
 */

import crypto from 'node:crypto';

import { argon2id } from 'hash-wasm';

import { AppError } from '../../util/errors.ts';

export const ENCRYPTED_MAGIC = 'HYPBAK01';
const KDF_ARGON2ID = 1;
const CIPHER_AES_256_GCM = 1;
const HEADER_BYTES = 56;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Default cost. 64 MiB / 3 iterations / 1 lane is the current Argon2id
 * recommendation for a passphrase-protected archive on a workstation: enough to
 * make an offline guessing campaign expensive, small enough that a backup on a
 * laptop takes a noticeable moment rather than a coffee break. Callers may lower
 * it (tests do), and what was used is recorded in the header.
 */
export const DEFAULT_ARGON2 = {
  memoryKiB: 65_536,
  iterations: 3,
  parallelism: 1,
} as const;

export interface Argon2Params {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export interface EncryptOptions {
  /** Override the KDF cost. Recorded in the header, never inferred on read. */
  params?: Partial<Argon2Params>;
}

/** True when the first bytes say this is one of our containers. */
export function isEncryptedArchive(bytes: Buffer): boolean {
  return (
    bytes.length >= HEADER_BYTES + TAG_BYTES &&
    bytes.subarray(0, ENCRYPTED_MAGIC.length).toString('latin1') === ENCRYPTED_MAGIC
  );
}

function refuse(message: string, details?: Record<string, unknown>): never {
  throw new AppError('bad_request', message, details ? { details } : undefined);
}

/**
 * The passphrase is required, and is checked before anything expensive happens.
 * An empty or whitespace-only passphrase is refused rather than accepted: it
 * would produce an archive that looks encrypted and is not protected by
 * anything a person could not guess in one attempt.
 */
function requirePassphrase(passphrase: string): string {
  if (typeof passphrase !== 'string' || passphrase.trim() === '') {
    refuse('A passphrase is required to encrypt or open a protected backup.');
  }
  return passphrase;
}

async function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: Argon2Params,
): Promise<Buffer> {
  const key = await argon2id({
    password: passphrase,
    salt: new Uint8Array(salt),
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    hashLength: KEY_BYTES,
    outputType: 'binary',
  });
  return Buffer.from(key);
}

/**
 * Wrap `plaintext` (the archive zip) in an encrypted container.
 *
 * The result is self-describing: everything a reader needs except the passphrase
 * travels in the header, so an archive written today opens on a build that has
 * since changed its defaults.
 */
export async function encryptArchive(
  plaintext: Buffer,
  passphrase: string,
  options: EncryptOptions = {},
): Promise<Buffer> {
  const secret = requirePassphrase(passphrase);
  if (plaintext.length === 0) refuse('There is nothing to encrypt: the archive is empty.');

  const params: Argon2Params = {
    memoryKiB: options.params?.memoryKiB ?? DEFAULT_ARGON2.memoryKiB,
    iterations: options.params?.iterations ?? DEFAULT_ARGON2.iterations,
    parallelism: options.params?.parallelism ?? DEFAULT_ARGON2.parallelism,
  };
  if (params.memoryKiB < 8 || params.iterations < 1 || params.parallelism < 1) {
    refuse('Argon2id parameters must be at least 8 KiB, 1 iteration and 1 lane.');
  }

  const salt = crypto.randomBytes(SALT_BYTES);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const key = await deriveKey(secret, salt, params);

  const header = Buffer.alloc(HEADER_BYTES);
  header.write(ENCRYPTED_MAGIC, 0, 'latin1');
  header.writeUInt8(KDF_ARGON2ID, 8);
  header.writeUInt8(CIPHER_AES_256_GCM, 9);
  header.writeUInt32BE(params.memoryKiB, 12);
  header.writeUInt32BE(params.iterations, 16);
  header.writeUInt8(params.parallelism, 20);
  header.writeUInt8(KEY_BYTES, 21);
  salt.copy(header, 24);
  nonce.copy(header, 40);
  header.writeUInt32BE(plaintext.length, 52);

  // The header is authenticated as additional data: a reader that trusts the
  // cost parameters to derive a key must not be reading parameters an attacker
  // edited, or a lower memory cost could be substituted for a brute-force run.
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  key.fill(0);
  return Buffer.concat([header, ciphertext, tag]);
}

export interface DecryptResult {
  plaintext: Buffer;
  params: Argon2Params;
}

/**
 * Open a container. Every failure mode — wrong passphrase, edited ciphertext,
 * truncated file, a zip that was never encrypted — arrives as one 400 with a
 * message that says which of them is likely, because the alternative is a
 * restore that proceeds on garbage.
 */
export async function decryptArchive(
  container: Buffer,
  passphrase: string,
): Promise<DecryptResult> {
  const secret = requirePassphrase(passphrase);

  if (container.length < HEADER_BYTES + TAG_BYTES) {
    refuse('This file is too small to be an encrypted backup.');
  }
  if (container.subarray(0, ENCRYPTED_MAGIC.length).toString('latin1') !== ENCRYPTED_MAGIC) {
    refuse(
      'This file is not an encrypted Hyperion backup. If it is a plain .zip archive, restore it without a passphrase.',
    );
  }
  const kdf = container.readUInt8(8);
  const cipherId = container.readUInt8(9);
  if (kdf !== KDF_ARGON2ID || cipherId !== CIPHER_AES_256_GCM) {
    refuse(
      `This archive was written with a key-derivation or cipher this build does not know ` +
        `(kdf ${kdf}, cipher ${cipherId}). A newer build of Hyperion is needed to open it.`,
    );
  }

  const params: Argon2Params = {
    memoryKiB: container.readUInt32BE(12),
    iterations: container.readUInt32BE(16),
    parallelism: container.readUInt8(20),
  };
  const ciphertextLength = container.readUInt32BE(52);
  if (container.length !== HEADER_BYTES + ciphertextLength + TAG_BYTES) {
    refuse(
      'This encrypted backup is incomplete: its length does not match the header. ' +
        'A truncated download is the usual cause — copy the file again.',
    );
  }

  const salt = container.subarray(24, 40);
  const nonce = container.subarray(40, 52);
  const header = container.subarray(0, HEADER_BYTES);
  const ciphertext = container.subarray(HEADER_BYTES, HEADER_BYTES + ciphertextLength);
  const tag = container.subarray(container.length - TAG_BYTES);

  const key = await deriveKey(secret, salt, params);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { plaintext, params };
  } catch {
    // Deliberately one message for both causes: the tag covers the ciphertext and
    // the header, so "wrong passphrase" and "edited archive" are indistinguishable
    // here by construction, and pretending otherwise would be a guess. What the
    // message must not do is leak the passphrase or any derived material.
    refuse(
      'Could not open this encrypted backup: the passphrase is wrong, or the file has been ' +
        'modified since it was written.',
    );
  } finally {
    key.fill(0);
  }
}
