/**
 * Passphrase-protected backups, end to end (Prompt 1.29).
 *
 * `backupcrypto.test.ts` covers the container itself. This file covers the part
 * a user actually touches, which is where the interesting failures live:
 *
 *   1. **An export that leaves the plaintext behind has no protection at all.**
 *      The zip is built first and wrapped second, so the only thing standing
 *      between a "protected" backup and an unprotected copy of the same database
 *      is the deletion. Asserted by listing the backups directory either side of
 *      the call, not by trusting the code path.
 *   2. **A passphrase must not be able to reach a URL.** It travels in a body, and
 *      the route that takes it is a POST — asserted by the fact that the GET
 *      export still exists and takes none.
 *   3. **An unopened archive is refused, not silently treated as corrupt.** An
 *      encrypted file inspected without a passphrase is a 400 that names the
 *      missing passphrase; the wrong passphrase is the container's refusal, which
 *      deliberately cannot tell the two apart.
 *   4. **Nothing else changed.** A plain zip still inspects and restores without a
 *      passphrase, because every backup written before this feature is plain, and
 *      a restore path that cannot read yesterday's archives is not a restore path.
 *
 * The suite drives the real app over HTTP: the failure being pinned is a status
 * code, a header and a file on disk.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { cleanupHome, freshDb, testHome } from './helpers.ts';

const AdmZip = (await import('adm-zip')).default;

const { createApp } = await import('../src/http/app.ts');
const { listBackups } = await import('../src/services/backup/export.ts');
const { isEncryptedArchive } = await import('../src/services/backup/crypto.ts');

const PASSPHRASE = 'a-backup-passphrase-nobody-guesses';

let server: http.Server;
let base: string;

before(async () => {
  await freshDb();
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

interface BackupError {
  error?: { code: string; message: string; details?: Record<string, unknown> };
  inspection?: Record<string, unknown>;
  dryRun?: boolean;
  restored?: boolean;
}

async function postJson(
  path: string,
  payload: unknown,
): Promise<{ status: number; text: string; body: BackupError }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? (JSON.parse(text) as BackupError) : {} };
}

async function postUpload(
  path: string,
  bytes: Buffer,
  filename: string,
  fields: Record<string, string>,
): Promise<{ status: number; text: string; body: BackupError }> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('file', new Blob([new Uint8Array(bytes)]), filename);

  const res = await fetch(`${base}${path}`, { method: 'POST', body: form });
  const text = await res.text();
  return { status: res.status, text, body: text ? (JSON.parse(text) as BackupError) : {} };
}

/** Export through the route, returning the bytes it handed back. */
async function exportProtected(payload: Record<string, unknown> = {}): Promise<{
  bytes: Buffer;
  filename: string;
}> {
  const res = await fetch(`${base}/api/backup/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: PASSPHRASE, ...payload }),
  });
  assert.equal(res.status, 200);
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="?([^";]+)"?/.exec(disposition);
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    filename: match?.[1] ?? '',
  };
}

function backupsDir(): string {
  return path.join(testHome, 'backups');
}

function filesInBackups(): string[] {
  if (!fs.existsSync(backupsDir())) return [];
  return fs.readdirSync(backupsDir()).sort();
}

test('a protected export writes a .hypbak and removes the plaintext zip', async () => {
  const before = filesInBackups();
  const { bytes, filename } = await exportProtected();

  assert.match(filename, /\.hypbak$/);
  assert.ok(isEncryptedArchive(bytes));
  assert.ok(
    !bytes.subarray(0, 2).equals(Buffer.from('PK')),
    'the download must not be a readable zip',
  );
  assert.ok(
    !bytes.includes(Buffer.from(PASSPHRASE)),
    'the passphrase must not be inside the file it protects',
  );

  const after = filesInBackups();
  const added = after.filter((name) => !before.includes(name));
  assert.deepEqual(
    added.filter((name) => name.endsWith('.hypbak')).length,
    1,
    'exactly one protected archive was added',
  );
  assert.deepEqual(
    added.filter((name) => name.endsWith('.zip')),
    [],
    'the plaintext zip must not be left beside it',
  );

  // The listing a user would see names the protected file, not the zip it replaced.
  const listed = listBackups().map((b) => b.filename);
  assert.ok(listed.some((name) => name.endsWith('.hypbak')));
});

test('the passphrase travels in a body, so the URL export still takes none', async () => {
  // The GET route stays for an unprotected export, and passing a passphrase to it
  // does nothing: there is no parameter to put one in.
  const res = await fetch(`${base}/api/backup/export?passphrase=${encodeURIComponent(PASSPHRASE)}`);
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(isEncryptedArchive(bytes), false, 'the GET route ignores a passphrase');
  assert.ok(bytes.subarray(0, 2).equals(Buffer.from('PK')));
});

test('an encrypted archive is inspected with its passphrase and refused without one', async () => {
  const { bytes } = await exportProtected();

  const opened = await postUpload('/api/backup/inspect', bytes, 'protected.hypbak', {
    passphrase: PASSPHRASE,
  });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.inspection?.encrypted, true);
  assert.equal(opened.body.inspection?.valid, true);
  assert.ok(!opened.text.includes(PASSPHRASE), 'the passphrase never comes back in a response');

  const noPassphrase = await postUpload('/api/backup/inspect', bytes, 'protected.hypbak', {});
  assert.equal(noPassphrase.status, 400);
  assert.equal(noPassphrase.body.error?.code, 'bad_request');
  assert.match(noPassphrase.body.error?.message ?? '', /passphrase-protected/);
  assert.equal(noPassphrase.body.error?.details?.field, 'passphrase');

  const wrong = await postUpload('/api/backup/inspect', bytes, 'protected.hypbak', {
    passphrase: 'not-the-passphrase',
  });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error?.message ?? '', /passphrase is wrong, or the file has been modified/);
});

test('a plain archive still inspects without a passphrase, and says it was not protected', async () => {
  const res = await fetch(`${base}/api/backup/export`);
  assert.equal(res.status, 200);
  const zip = Buffer.from(await res.arrayBuffer());

  const inspected = await postUpload('/api/backup/inspect', zip, 'plain.zip', {});
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body.inspection?.encrypted, false);
  assert.equal(inspected.body.inspection?.valid, true);
});

test('a dry-run restore opens the protected archive and changes nothing', async () => {
  const { bytes } = await exportProtected();

  const run = await postUpload('/api/backup/import', bytes, 'protected.hypbak', {
    passphrase: PASSPHRASE,
    dryRun: 'true',
  });
  assert.equal(run.status, 200);
  assert.equal(run.body.dryRun, true);
  assert.equal(run.body.restored, false);
  assert.equal((run.body.inspection as { encrypted?: boolean } | undefined)?.encrypted, true);
  assert.ok(!run.text.includes(PASSPHRASE));

  // A restore without the passphrase is refused before anything is touched.
  const refused = await postUpload('/api/backup/import', bytes, 'protected.hypbak', {
    dryRun: 'true',
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error?.message ?? '', /passphrase-protected/);
});

test('a truncated protected archive names the truncation instead of the passphrase', async () => {
  const { bytes } = await exportProtected();
  const truncated = bytes.subarray(0, bytes.length - 32);

  const res = await postUpload('/api/backup/inspect', truncated, 'broken.hypbak', {
    passphrase: PASSPHRASE,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error?.message ?? '', /incomplete/);
});

test('the diff preview says what a restore would change, per table', async () => {
  const { bytes } = await exportProtected();
  const opened = await postUpload('/api/backup/inspect', bytes, 'protected.hypbak', {
    passphrase: PASSPHRASE,
  });

  const diff = opened.body.inspection?.diff as
    | { tables: { table: string; current: number; archive: number; delta: number }[];
        onlyInArchive: string[]; onlyHere: string[]; currentMigrations: number; archiveMigrations: number }
    | undefined;
  assert.ok(diff, 'the inspection carries a diff');
  assert.equal(diff.currentMigrations, diff.archiveMigrations, 'same schema on both sides');

  const chats = diff.tables.find((t) => t.table === 'chats');
  assert.ok(chats, 'every table is listed, including ones with no rows');
  assert.equal(chats.archive, 0);
  assert.equal(chats.delta, chats.archive - chats.current, 'delta is archive minus current');
  // The archive is read *after* the live database, so a table written in between
  // is the one case where the two could disagree; nothing writes `chats` here.
  assert.ok(diff.tables.length > 5, 'the whole schema is compared, not a sample');
});

test('the diff names rows the archive does not carry, which is what the confirm dialog needs', async () => {
  // The archive is taken *first*, then a row is written: restoring the archive
  // would lose that row, which is what the diff has to say out loud.
  const { bytes } = await exportProtected();
  const { createChat, deleteChat } = await import('../src/db/chats.ts');
  const chat = createChat({ tool: 'chat', title: 'written after the archive' });
  const opened = await postUpload('/api/backup/inspect', bytes, 'stale.hypbak', {
    passphrase: PASSPHRASE,
  });
  const diff = opened.body.inspection?.diff as
    | { tables: { table: string; current: number; archive: number; delta: number }[] }
    | undefined;

  const chats = diff?.tables.find((t) => t.table === 'chats');
  assert.ok(chats);
  assert.ok(chats.current >= 1);
  assert.equal(chats.delta, chats.archive - chats.current);
  assert.ok(chats.delta < 0, 'restoring this archive loses the newer rows');

  deleteChat(chat.id);
});

test('a table the archive has and this install does not is named, not counted', async () => {
  // Schema drift is the case counts alone cannot express: a table that exists on
  // one side only is not "zero rows", and calling it a delta would hide that the
  // restore changes the shape of this install.
  const res = await fetch(`${base}/api/backup/export`);
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));

  const { openDatabase } = await import('../src/db/adapter.ts');
  const snapshot = path.join(testHome, `drift-${Date.now()}.db`);
  fs.writeFileSync(snapshot, zip.getEntry('hyperion.db')!.getData());
  const db = openDatabase(snapshot);
  try {
    db.exec('CREATE TABLE legacy_thing (id TEXT PRIMARY KEY)');
    db.exec("INSERT INTO legacy_thing (id) VALUES ('x')");
  } finally {
    db.close();
  }
  zip.updateFile('hyperion.db', fs.readFileSync(snapshot));

  const inspected = await postUpload('/api/backup/inspect', zip.toBuffer(), 'drifted.zip', {});
  assert.equal(inspected.status, 200);
  const diff = inspected.body.inspection?.diff as
    | { tables: { table: string; current: number; archive: number }[];
        onlyInArchive: string[]; onlyHere: string[] }
    | undefined;
  assert.ok(diff);
  assert.ok(diff.onlyInArchive.includes('legacy_thing'));
  assert.deepEqual(diff.onlyHere, [], 'the archive carries every table this install has');
  const drift = diff.tables.find((t) => t.table === 'legacy_thing');
  assert.ok(drift, 'and the table appears in the count list too, with a live count of zero');
  assert.equal(drift.current, 0);
  assert.equal(drift.archive, 1);
});

test('restore attempts are audited, and the audit is readable', async () => {
  const before = (await (await fetch(`${base}/api/backup/restores`)).json()) as {
    restores: { id: number }[];
  };

  // A dry run: recorded as a question, not an attempt.
  const { bytes } = await exportProtected();
  await postUpload('/api/backup/import', bytes, 'audited.hypbak', {
    passphrase: PASSPHRASE,
    dryRun: 'true',
  });

  // A refusal: recorded too, because a near-miss is the interesting entry.
  await postUpload('/api/backup/import', bytes, 'audited.hypbak', { dryRun: 'true' });

  const after = (await (await fetch(`${base}/api/backup/restores`)).json()) as {
    restores: {
      id: number;
      filename: string | null;
      outcome: string;
      dryRun: boolean;
      restored: boolean;
      encrypted: boolean;
      sha256: string;
      detail: string | null;
    }[];
  };
  const added = after.restores.filter((r) => !before.restores.some((b) => b.id === r.id));
  assert.equal(added.length, 2, 'both attempts were recorded');

  const dryRun = added.find((r) => r.outcome === 'dry_run');
  const refused = added.find((r) => r.outcome === 'refused');
  assert.ok(dryRun, 'the dry run is recorded');
  assert.ok(refused, 'the refusal is recorded');
  assert.equal(dryRun.filename, 'audited.hypbak');
  assert.equal(dryRun.encrypted, true);
  assert.equal(dryRun.restored, false);
  assert.match(refused.detail ?? '', /passphrase-protected/);

  // A digest identifies the file, and is never of a decrypted payload.
  assert.match(dryRun.sha256, /^[0-9a-f]{64}$/);
  const raw = JSON.stringify(after);
  assert.ok(!raw.includes(PASSPHRASE), 'the passphrase is nowhere in the audit trail');
});

// Last in the file: this one really does replace the database, and every test
// above relies on the one `freshDb()` produced.
test('a real restore records itself inside the database it restored', async () => {
  const { bytes } = await exportProtected();
  const { createChat, findChat } = await import('../src/db/chats.ts');
  const doomed = createChat({ tool: 'chat', title: 'created after the archive' });

  const run = await postUpload('/api/backup/import', bytes, 'wholesale.hypbak', {
    passphrase: PASSPHRASE,
  });
  assert.equal(run.status, 200);
  assert.equal(run.body.restored, true);
  assert.equal((run.body as { restartRequired?: boolean }).restartRequired, true);

  // The database really was replaced: the row written after the archive is gone.
  assert.equal(findChat(doomed.id), null);

  // And the audit row is in the restored database, which is only possible because
  // it is written after the swap against the reopened handle.
  const listed = (await (await fetch(`${base}/api/backup/restores`)).json()) as {
    restores: {
      filename: string | null;
      outcome: string;
      restored: boolean;
      encrypted: boolean;
      preRestoreBackup: string | null;
    }[];
  };
  const record = listed.restores.find((r) => r.outcome === 'restored');
  assert.ok(record, 'the restore is in the audit trail of the database it produced');
  assert.equal(record.filename, 'wholesale.hypbak');
  assert.equal(record.restored, true);
  assert.equal(record.encrypted, true);
  assert.match(record.preRestoreBackup ?? '', /^pre-restore-\d+\.zip$/);
});

test('an empty passphrase is refused rather than producing a decorative archive', async () => {
  const previous = filesInBackups();
  // Two guards, and the outer one answers: the HTTP layer rejects a blank field
  // by name, and the container refuses an empty passphrase on its own (asserted
  // in `backupcrypto.test.ts`) for any caller that does not come through a route.
  const res = await postJson('/api/backup/export', { passphrase: '   ' });
  assert.equal(res.status, 400);
  assert.match(res.body.error?.message ?? '', /passphrase must not be empty/);
  assert.equal(res.body.error?.details?.field, 'passphrase');

  // And nothing was written for it. The suite exports real archives elsewhere,
  // so this compares against the state before the call rather than asserting the
  // directory is empty.
  const added = filesInBackups().filter((name) => !previous.includes(name));
  assert.deepEqual(added, [], 'no archive was produced');
});
