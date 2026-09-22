/**
 * The encrypted-backup container (Prompt 1.29).
 *
 * These are unit-level tests over the container itself: bytes in, bytes out.
 * The route-level behaviour — that a passphrase is demanded, that the plaintext
 * zip is not left on disk beside the protected one, that a restore without a
 * passphrase is refused rather than attempted on ciphertext — is asserted in
 * `backup.test.ts` against the real app.
 *
 * Low Argon2id parameters are used throughout: correctness does not depend on
 * the cost, and a suite that spends three seconds per case on key derivation
 * would be a suite people turn off. The *header* carrying the parameters is
 * itself a case, because that is what makes the low-cost tests meaningful.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import test, { after } from 'node:test';

const { cleanupHome } = await import('./helpers.ts');
const { encryptArchive, decryptArchive, isEncryptedArchive, ENCRYPTED_MAGIC } = await import(
  '../src/services/backup/crypto.ts'
);

const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 };
const PASSPHRASE = 'correct horse battery staple';

after(async () => {
  await cleanupHome();
});

test('a protected archive round-trips, and the bytes are not the input', async () => {
  const zip = Buffer.from('PK\u0003\u0004 pretend this is an archive with a database in it');
  const container = await encryptArchive(zip, PASSPHRASE, { params: FAST });

  assert.ok(isEncryptedArchive(container));
  assert.ok(
    !container.includes(zip),
    'the plaintext must not appear anywhere in the container',
  );
  assert.ok(
    !container.includes(Buffer.from(PASSPHRASE)),
    'the passphrase must not appear in the file it protects',
  );

  const { plaintext, params } = await decryptArchive(container, PASSPHRASE);
  assert.deepEqual(plaintext, zip);
  assert.deepEqual(params, FAST);
});

test('the cost parameters travel in the header, not in this build defaults', async () => {
  const zip = Buffer.from('payload');
  const container = await encryptArchive(zip, PASSPHRASE, {
    params: { memoryKiB: 128, iterations: 2, parallelism: 1 },
  });

  assert.equal(container.subarray(0, 8).toString('latin1'), ENCRYPTED_MAGIC);
  assert.equal(container.readUInt8(8), 1, 'kdf id');
  assert.equal(container.readUInt8(9), 1, 'cipher id');
  assert.equal(container.readUInt32BE(12), 128);
  assert.equal(container.readUInt32BE(16), 2);
  assert.equal(container.readUInt8(20), 1);

  // An archive written with a cost this build would no longer choose still opens.
  const opened = await decryptArchive(container, PASSPHRASE);
  assert.deepEqual(opened.params, { memoryKiB: 128, iterations: 2, parallelism: 1 });
});

test('two archives of the same input differ: salt and nonce are fresh each time', async () => {
  const zip = Buffer.from('identical payload');
  const first = await encryptArchive(zip, PASSPHRASE, { params: FAST });
  const second = await encryptArchive(zip, PASSPHRASE, { params: FAST });

  assert.ok(!first.equals(second));
  assert.ok(!first.subarray(24, 40).equals(second.subarray(24, 40)), 'salt');
  assert.ok(!first.subarray(40, 52).equals(second.subarray(40, 52)), 'nonce');
  // And neither is a deterministic function of the passphrase alone.
  assert.ok(!first.subarray(56).equals(second.subarray(56)));
});

test('the wrong passphrase is refused, and says nothing about the real one', async () => {
  const container = await encryptArchive(Buffer.from('payload'), PASSPHRASE, { params: FAST });

  await assert.rejects(
    () => decryptArchive(container, 'correct horse battery stapl'),
    (error: unknown) => {
      const appError = error as { code?: string; message: string };
      assert.equal(appError.code, 'bad_request');
      assert.match(appError.message, /passphrase is wrong, or the file has been modified/);
      assert.ok(!appError.message.includes(PASSPHRASE));
      return true;
    },
  );
});

test('an edited ciphertext fails the tag instead of decrypting into garbage', async () => {
  const container = await encryptArchive(Buffer.from('a database snapshot'), PASSPHRASE, {
    params: FAST,
  });
  container.writeUInt8(container.readUInt8(60) ^ 0x01, 60);

  await assert.rejects(
    () => decryptArchive(container, PASSPHRASE),
    /passphrase is wrong, or the file has been modified/,
  );
});

test('an edited cost parameter is caught by authenticating the header', async () => {
  const container = await encryptArchive(Buffer.from('a database snapshot'), PASSPHRASE, {
    params: FAST,
  });
  // Lower the recorded memory cost, the substitution a brute-force attempt wants.
  container.writeUInt32BE(8, 12);

  await assert.rejects(() => decryptArchive(container, PASSPHRASE), /passphrase is wrong/);
});

test('a truncated file is refused before any key is derived', async () => {
  const container = await encryptArchive(Buffer.from('a database snapshot'), PASSPHRASE, {
    params: FAST,
  });

  // Header intact, tail missing: the length field is what makes this cheap.
  await assert.rejects(
    () => decryptArchive(container.subarray(0, container.length - 4), PASSPHRASE),
    /incomplete: its length does not match the header/,
  );
  await assert.rejects(() => decryptArchive(container.subarray(0, 40), PASSPHRASE), /too small/);
  // A well-formed container whose trailing bytes are gone entirely.
  await assert.rejects(() => decryptArchive(container.subarray(0, 56), PASSPHRASE), /too small|incomplete/);
});

test('a plain zip is refused with the instruction that helps', async () => {
  // Long enough that the magic check is what refuses it, not the size check.
  const zip = Buffer.concat([
    Buffer.from('PK\u0003\u0004 an ordinary archive'),
    Buffer.alloc(256, 0x20),
  ]);
  assert.equal(isEncryptedArchive(zip), false);
  await assert.rejects(
    () => decryptArchive(zip, PASSPHRASE),
    /not an encrypted Hyperion backup.*restore it without a passphrase/s,
  );
});

test('an unknown kdf or cipher names the version problem instead of failing obscurely', async () => {
  const container = await encryptArchive(Buffer.from('payload'), PASSPHRASE, { params: FAST });
  container.writeUInt8(9, 9);
  await assert.rejects(
    () => decryptArchive(container, PASSPHRASE),
    /key-derivation or cipher this build does not know/,
  );
});

test('an empty passphrase is refused at write time, not at read time', () => {
  return assert.rejects(
    () => encryptArchive(Buffer.from('payload'), '   ', { params: FAST }),
    /A passphrase is required/,
  );
});

test('encrypting nothing is refused rather than writing a 60-byte file', async () => {
  await assert.rejects(
    () => encryptArchive(Buffer.alloc(0), PASSPHRASE, { params: FAST }),
    /nothing to encrypt/,
  );
});
