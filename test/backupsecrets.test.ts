/**
 * A default backup is not a credential store.
 *
 * `exportBackup` documents the guarantee plainly: `secret.key` is left out
 * because the database holds API keys encrypted with it, so "a leaked backup
 * exposes conversations but not credentials". The MCP config file walked
 * straight around that. `mcp_config.json` is included unconditionally, and the
 * registry materialises a remote server's token into it as a literal
 * `Authorization: Bearer ...` header (`registry.ts::toEntry`) — so an archive
 * exported with the default `includeKeys=false` contained a working credential
 * in the clear, in the artifact most likely to be copied to a cloud folder or
 * a USB stick.
 *
 * The fix is structural rather than a redaction pass. Nothing in the file's
 * format marks which value is a secret — the same slot holds a workspace path
 * and a bearer token — so the honest rule is: with the key, include it; without
 * the key, do not ship a file that can hold one. The registry lives in the
 * database (`processManager.ts` and `listServers()` both read the table, and
 * `POST /api/mcp/sync` regenerates the file from it), so the servers still
 * travel in the archive.
 *
 * Everything here is asserted against the archive's own bytes, because that is
 * what leaves the machine.
 */

import './helpers.ts';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

import { cleanupHome, freshDb, testHome } from './helpers.ts';

const { createServer } = await import('../src/services/mcp/registry.ts');
const { exportBackup, DB_ENTRY, MCP_ENTRY } = await import('../src/services/backup/export.ts');
const { env } = await import('../src/config/env.ts');
const AdmZip = (await import('adm-zip')).default;

/** A string that cannot turn up in the archive by coincidence. */
const TOKEN = 'sk-mcp-probe-9f13ce4a';

before(async () => {
  await freshDb();
  createServer({
    name: 'remote-thing',
    type: 'remote',
    url: 'https://mcp.example.com/sse',
    token: TOKEN,
  });
});

after(async () => {
  await cleanupHome();
});

describe('an archive exported without keys', () => {
  test('does not contain the MCP token, in any file it ships', async () => {
    const result = exportBackup();

    const raw = fs.readFileSync(result.file);
    assert.equal(
      raw.includes(TOKEN),
      false,
      'the bearer token is inside the archive that promised not to carry credentials',
    );

    const zip = new AdmZip(result.file);
    assert.equal(zip.getEntry(MCP_ENTRY), null, 'mcp_config.json should not be included');
    for (const entry of zip.getEntries()) {
      assert.equal(
        entry.getData().toString('utf8').includes(TOKEN),
        false,
        `${entry.entryName} carries the token`,
      );
    }

    assert.equal(result.manifest.contents.mcpConfig, false);
    assert.equal(result.manifest.contents.encryptionKey, false);
  });

  test('omits the file from the archive, not from the machine', async () => {
    // The omission is a decision about what leaves, not a reading of what is
    // there: the live file keeps the token the process manager needs.
    const live = fs.readFileSync(env.paths.mcpConfig, 'utf8');
    assert.match(live, new RegExp(TOKEN), 'the fixture did not materialise the token');
  });

  test('says in the manifest that the file was left out', async () => {
    const result = exportBackup();

    assert.match(result.manifest.warning ?? '', /mcp_config\.json/);
  });

  test('still carries the server, in the database where the registry lives', async () => {
    const result = exportBackup();
    const zip = new AdmZip(result.file);
    const entry = zip.getEntry(DB_ENTRY);
    assert.ok(entry, 'the archive must contain the database');

    const extracted = path.join(testHome, `mcp-check-${String(Date.now())}.db`);
    fs.writeFileSync(extracted, entry.getData());

    const { openDatabase } = await import('../src/db/adapter.ts');
    const copy = openDatabase(extracted);
    try {
      const row = copy
        .prepare<{ name: string; token_enc: string | null }>(
          'SELECT name, token_enc FROM mcp_servers',
        )
        .get();

      assert.equal(row?.name, 'remote-thing');
      assert.equal(
        row?.token_enc?.includes(TOKEN) ?? false,
        false,
        'the stored token must be ciphertext, not the token itself',
      );
    } finally {
      copy.close();
    }
  });
});

describe('an archive exported with keys', () => {
  test('includes the config file, token and all, because that is what was asked for', async () => {
    const result = exportBackup({ includeKeys: true });

    const zip = new AdmZip(result.file);
    const entry = zip.getEntry(MCP_ENTRY);
    assert.ok(entry, 'includeKeys restores full fidelity');
    assert.match(entry.getData().toString('utf8'), new RegExp(TOKEN));

    assert.equal(result.manifest.contents.mcpConfig, true);
    assert.equal(result.manifest.contents.encryptionKey, true);
    assert.match(result.manifest.warning ?? '', /secret\.key/);
    assert.equal(
      result.manifest.warning?.includes('mcp_config.json') ?? false,
      false,
      'nothing was left out, so nothing should be warned about',
    );
  });
});
