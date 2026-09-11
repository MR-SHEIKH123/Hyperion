/**
 * Cowork knowledge sources — the standing reference library.
 *
 * The guarantee that matters most here is the one that is *absent* from the
 * code: nothing ages a knowledge source out. The 3-month asset sweep and the
 * 4-month chat sweep both run against a library that has been sitting untouched
 * for a simulated year, and it survives. That exemption is structural (no
 * access timestamp on the table, and `cleanup.ts` never names it), so the test
 * drives the real `runCleanup` rather than asserting on a filter that could be
 * removed without failing anything.
 */
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { cleanupHome, freshDb } from './helpers.ts';

// Imported after helpers.ts has set HYPERION_HOME.
const {
  deleteKnowledgeSource,
  findKnowledgeSource,
  knowledgeExists,
  knowledgePath,
  listKnowledgeSources,
  requireKnowledgeSource,
  saveKnowledgeSource,
} = await import('../src/services/cowork/knowledge.ts');
const { runCleanup } = await import('../src/services/storage/cleanup.ts');
const { getDb } = await import('../src/db/adapter.ts');
const { getRoot } = await import('../src/security/fsScope.ts');

const DAY = 24 * 60 * 60 * 1000;

function file(name: string, text = 'reference material'): { filename: string; buffer: Buffer } {
  return { filename: name, buffer: Buffer.from(text, 'utf8') };
}

beforeEach(async () => {
  await freshDb();
});

after(async () => {
  await cleanupHome();
});

// --- storage ---------------------------------------------------------------

test('a filed document is written inside the knowledge scope and readable back', () => {
  const source = saveKnowledgeSource({ ...file('handbook.md', '# Handbook'), label: 'Handbook' });

  assert.equal(source.label, 'Handbook');
  assert.equal(source.filename, 'handbook.md');
  assert.ok(source.id.startsWith('kns_'));

  const abs = knowledgePath(source);
  assert.ok(abs.startsWith(getRoot('knowledge')), 'stored outside the knowledge scope');
  assert.equal(fs.readFileSync(abs, 'utf8'), '# Handbook');
  assert.equal(knowledgeExists(source), true);
});

test('the label is optional and separate from the filename', () => {
  const source = saveKnowledgeSource(file('Q3-final-FINAL-v2.pdf'));
  assert.equal(source.label, null);
  assert.equal(source.filename, 'Q3-final-FINAL-v2.pdf');
});

test('the listing is newest first and advertises a file URL per source', () => {
  const first = saveKnowledgeSource(file('one.md'));
  const second = saveKnowledgeSource(file('two.md'));

  // Two inserts inside one millisecond tie on created_at — which is exactly
  // what happens on a fast machine. Force the tie so the assertion pins the
  // tie-break (later insert first) rather than the clock happening to differ.
  getDb().prepare('UPDATE knowledge_sources SET created_at = ?').run(1_000);

  const listed = listKnowledgeSources();
  assert.deepEqual(
    listed.map((s) => s.id),
    [second.id, first.id],
  );
  assert.equal(listed[0]?.url, `/api/cowork/knowledge/${second.id}/file`);
  assert.equal(listed[0]?.missing, false);
});

test('a document is stored byte-for-byte rather than re-encoded', () => {
  // Unlike a gallery image, a knowledge source is a document of record: the copy
  // on disk must be the file the user filed, not a helpfully rewritten one.
  const bytes = Buffer.from([0x00, 0x01, 0x02, 0xfd, 0xfe, 0xff]);
  const source = saveKnowledgeSource({ filename: 'raw.bin', buffer: bytes });

  assert.equal(source.bytes, bytes.length);
  assert.deepEqual(fs.readFileSync(knowledgePath(source)), bytes);
});

test('requesting a source that does not exist is not_found, not a crash', () => {
  assert.equal(findKnowledgeSource('kns_nope'), null);
  assert.throws(() => requireKnowledgeSource('kns_nope'), /does not exist/i);
});

// --- deletion --------------------------------------------------------------

test('deleting a source removes both the row and the file', () => {
  const source = saveKnowledgeSource(file('temp.md', 'throwaway'));
  const abs = knowledgePath(source);

  const bytesFreed = deleteKnowledgeSource(source.id);

  assert.equal(bytesFreed, Buffer.byteLength('throwaway'));
  assert.equal(fs.existsSync(abs), false);
  assert.equal(findKnowledgeSource(source.id), null);
});

test('deleting an unknown source is not_found rather than a silent success', () => {
  assert.throws(() => deleteKnowledgeSource('kns_gone'), /does not exist/i);
});

// --- the exemption ---------------------------------------------------------

test('a knowledge source untouched for a year survives the cleanup sweep', () => {
  const source = saveKnowledgeSource({ ...file('policy.md'), label: 'Policy' });

  // Age it as far as the schema allows. There is deliberately no
  // `last_accessed_at` to push back, so `created_at` is the only clock, and the
  // point of the test is that no sweep reads it.
  getDb()
    .prepare('UPDATE knowledge_sources SET created_at = ? WHERE id = ?')
    .run(Date.now() - 365 * DAY, source.id);

  const result = runCleanup({ now: Date.now() });

  assert.equal(result.assetsDeleted, 0);
  assert.equal(result.chatsDeleted, 0);
  assert.equal(listKnowledgeSources().length, 1);
  assert.equal(knowledgeExists(requireKnowledgeSource(source.id)), true);
});

test('a cleanup sweep with brutally short TTLs still leaves the library alone', () => {
  const source = saveKnowledgeSource(file('keep-me.md'));

  // 0-day TTLs expire everything the sweep can see. The library is not among it.
  runCleanup({ assetTtlDays: 0, chatTtlDays: 0 });

  assert.equal(findKnowledgeSource(source.id)?.id, source.id);
  assert.equal(fs.existsSync(knowledgePath(source)), true);
});

test('the cleanup engine never queries the knowledge table at all', async () => {
  // A guard against the exemption being re-implemented as a WHERE clause that a
  // later refactor could invert. The absence of the table name is the contract.
  const source = await fs.promises.readFile(
    new URL('../src/services/storage/cleanup.ts', import.meta.url),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(
    /knowledge_sources/.test(code),
    false,
    'cleanup.ts referenced knowledge_sources outside a comment',
  );
});
