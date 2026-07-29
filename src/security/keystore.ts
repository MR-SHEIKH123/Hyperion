/**
 * Encryption for credentials at rest (provider API keys, skill tokens, MCP
 * tokens).
 *
 * AES-256-GCM, which is authenticated: tampering with stored ciphertext is
 * detected on decrypt rather than silently yielding garbage.
 *
 * The master key lives in a file **outside the database** (~/AIStudio/secret.key)
 * with owner-only permissions. Keeping it beside the ciphertext in SQLite would
 * make the encryption decorative — anyone who copied the DB would have both
 * halves. Losing the key file means stored credentials are unrecoverable and
 * must be re-entered, which is the intended trade-off.
 *
 * Storage format: `v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>`. The version
 * prefix means the algorithm can change later without ambiguity about how any
 * given existing value was encrypted.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { env } from '../config/env.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('keystore');

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const PREFIX = 'v1';

let cachedKey: Buffer | null = null;

/**
 * Tighten permissions on the key file.
 *
 * chmod is essentially cosmetic on Windows, so icacls is used there to strip
 * inherited ACLs and grant only the current user. Best-effort: an unusual
 * environment should not prevent the app from starting, but it is logged.
 */
function restrictPermissions(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* non-POSIX filesystem */
  }

  if (os.platform() !== 'win32') return;

  try {
    const user = process.env.USERNAME ?? os.userInfo().username;
    // /inheritance:r drops inherited ACEs, so only the explicit grant remains.
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], {
      stdio: 'ignore',
    });
  } catch {
    log.warn(
      `could not tighten Windows ACLs on ${file} — verify it is not readable by other accounts`,
    );
  }
}

/** Load the master key, generating it on first run. */
export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const file = env.paths.secretKey;

  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const key = Buffer.from(raw, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `Encryption key at ${file} is ${key.length} bytes, expected ${KEY_BYTES}. ` +
          'Refusing to continue: the file is corrupt, and overwriting it would make ' +
          'every stored credential permanently undecryptable. Move it aside manually ' +
          'if you accept re-entering your API keys.',
      );
    }
    cachedKey = key;
    return key;
  }

  const key = crypto.randomBytes(KEY_BYTES);
  // wx: fail if it appeared between the check and the write, rather than
  // clobbering a key another process just created.
  fs.writeFileSync(file, key.toString('base64'), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  restrictPermissions(file);
  log.info(`generated new encryption key at ${file}`);

  cachedKey = key;
  return key;
}

/** Encrypt a plaintext credential for storage. */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getMasterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    PREFIX,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a stored credential.
 *
 * Throws on tampering or a mismatched key. Callers that must not fail hard
 * should use `tryDecrypt`.
 */
export function decrypt(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('Malformed encrypted value (expected v1:iv:tag:ciphertext)');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getMasterKey(),
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Decrypt, returning null instead of throwing.
 *
 * Used on paths where one unreadable credential (e.g. after the key file was
 * replaced) should degrade that single provider rather than break a listing of
 * all of them.
 */
export function tryDecrypt(stored: string | null | undefined): string | null {
  if (!stored) return null;
  try {
    return decrypt(stored);
  } catch (error) {
    log.warn('failed to decrypt a stored credential', error);
    return null;
  }
}

/**
 * Last 4 characters of a credential, for display.
 *
 * This is the ONLY part of a key that may ever reach the frontend. Short
 * secrets are masked entirely rather than revealing most of themselves.
 */
export function keyHint(plaintext: string): string {
  const trimmed = plaintext.trim();
  return trimmed.length < 8 ? '****' : trimmed.slice(-4);
}

/** Reset the cached key. Tests only. */
export function resetKeyCache(): void {
  cachedKey = null;
}
