/**
 * Memory: the two write routes item 1.21 asked for, and the bounds on them.
 *
 * The plugin is opt-in and its backend (`mem0ai/oss`) is a guarded dynamic
 * import, so the paths a test can drive without a model are exactly the paths a
 * user hits first: a disabled plugin, an empty body, a paste too large to look
 * at. Those are the ones that must not answer `200 {}` — a silent no-op is the
 * failure mode a write route can have that a read route cannot, and it is
 * invisible until someone goes looking for a memory that was never stored.
 *
 * The splitter is tested directly and exhaustively, because the bounds are the
 * contract: what counts as one memory, what is dropped, and what is said about
 * it. The backend-dependent path (a paste that actually reaches mem0) cannot run
 * here — a sandbox has no Ollama — and this file says so rather than pretending
 * otherwise.
 *
 * The suite drives the real app over HTTP, because the failure being pinned is a
 * status code and an envelope.
 */

import './helpers.ts';

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

// The memory module is imported dynamically below, so deleting the variable
// here pins the case the test asserts: unset in the environment means off.
delete process.env.MEM0_TELEMETRY;

const { createApp } = await import('../src/http/app.ts');
const {
  MEMORY_IMPORT_MAX_CHARS,
  MEMORY_IMPORT_MAX_FILES,
  MEMORY_IMPORT_MAX_FILENAME_CHARS,
  MEMORY_MAX_CHARS,
  chunkImportFiles,
  chunkImportText,
} = await import('../src/services/memory/index.ts');

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

interface FileResult {
  name: string;
  imported: number;
  dropped: number;
  found: number;
  error: string | null;
}

interface Envelope {
  error?: { code: string; message: string; details?: Record<string, unknown> };
  stored?: boolean;
  imported?: number;
  dropped?: number;
  found?: number;
  files?: FileResult[];
}

async function post(path: string, payload: unknown): Promise<{ status: number; body: Envelope }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function postFiles(
  path: string,
  files: { name: string; content: string | Uint8Array }[],
  fields: Record<string, string> = {},
): Promise<{ status: number; body: Envelope }> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const file of files) {
    form.append('files', new Blob([file.content]), file.name);
  }
  const res = await fetch(`${base}${path}`, { method: 'POST', body: form });
  return { status: res.status, body: (await res.json()) as Envelope };
}

describe('the memory write routes', () => {
  test('a disabled plugin is a capability answer, not a silent no-op', async () => {
    // Memory defaults to off, which is the state a fresh install is in.
    const added = await post('/api/memory', { text: 'I prefer tabs.' });
    assert.equal(added.status, 403);
    assert.equal(added.body.error?.code, 'capability_disabled');
    assert.equal(added.body.stored, undefined, 'nothing may look stored');

    const imported = await post('/api/memory/import', { text: 'one\n\ntwo' });
    assert.equal(imported.status, 403);
    assert.equal(imported.body.error?.code, 'capability_disabled');
  });

  test('an empty body is a validation answer on both routes', async () => {
    const { setMemoryEnabled } = await import('../src/services/memory/index.ts');
    setMemoryEnabled(true);
    try {
      for (const path of ['/api/memory', '/api/memory/import']) {
        const empty = await post(path, { text: '   \n  ' });
        assert.equal(empty.status, 400, path);
        assert.equal(empty.body.error?.code, 'bad_request');

        const missing = await post(path, {});
        assert.equal(missing.status, 400, path);
        assert.equal(missing.body.error?.code, 'bad_request');
      }
    } finally {
      setMemoryEnabled(false);
    }
  });

  test('a paste larger than the route will read is refused with the number', async () => {
    const { setMemoryEnabled } = await import('../src/services/memory/index.ts');
    setMemoryEnabled(true);
    try {
      const over = await post('/api/memory', { text: 'x'.repeat(MEMORY_MAX_CHARS + 1) });
      assert.equal(over.status, 400);
      assert.equal(over.body.error?.code, 'bad_request');
      assert.match(over.body.error?.message ?? '', new RegExp(String(MEMORY_MAX_CHARS)));
      assert.equal(over.body.error?.details?.field, 'text');

      const huge = await post('/api/memory/import', { text: 'x'.repeat(MEMORY_IMPORT_MAX_CHARS * 5 + 1) });
      assert.equal(huge.status, 400);
      assert.equal(huge.body.error?.code, 'bad_request');
    } finally {
      setMemoryEnabled(false);
    }
  });

  test('a single memory through the add route is bounded to a paragraph, not a paste', () => {
    // The route's bound is the splitter's cousin: an add is one memory, so it is
    // capped where the import caps a *chunk* rather than where it caps a paste.
    assert.ok(MEMORY_MAX_CHARS < MEMORY_IMPORT_MAX_CHARS);
  });
});

describe('import chunking', () => {
  test('a blank line separates memories, and one line is one memory', () => {
    const { chunks, dropped } = chunkImportText('I use a Mac.\n\nMy timezone is Asia/Dhaka.');
    assert.deepEqual(chunks, ['I use a Mac.', 'My timezone is Asia/Dhaka.']);
    assert.equal(dropped, 0);
  });

  test('line breaks inside a paragraph stay part of it', () => {
    // A memory that is a short list is more useful stored whole than shredded.
    const { chunks } = chunkImportText('Deploys happen on:\n- Monday\n- Thursday');
    assert.deepEqual(chunks, ['Deploys happen on:\n- Monday\n- Thursday']);
  });

  test('whitespace-only pieces are not memories', () => {
    assert.deepEqual(chunkImportText('\n\n  \n\n').chunks, []);
  });

  test('the chunk bound keeps the first memories and reports the rest as dropped', () => {
    const text = Array.from({ length: 130 }, (_, index) => `fact ${index + 1}`).join('\n\n');
    const { chunks, dropped } = chunkImportText(text, { maxChunks: 100 });
    assert.equal(chunks.length, 100);
    assert.equal(chunks[0], 'fact 1');
    assert.equal(chunks[99], 'fact 100');
    assert.equal(dropped, 30, 'what was left out is counted, not silently cut');
  });

  test('the character bound stops the list where it runs out of room, and says how many pieces were left', () => {
    const { chunks, dropped } = chunkImportText('aaaa\n\nbbbb\n\ncccc', { maxChars: 10 });
    assert.deepEqual(chunks, ['aaaa', 'bbbb']);
    assert.equal(dropped, 1);
  });

  test('one enormous piece is dropped rather than truncated', () => {
    // Truncating would store a memory the user did not write, which is worse than
    // storing nothing and saying so.
    const { chunks, dropped } = chunkImportText('x'.repeat(50), { maxChars: 10 });
    assert.deepEqual(chunks, []);
    assert.equal(dropped, 1);
  });
});

describe('import files', () => {
  test('a disabled plugin is a capability answer for uploads too', async () => {
    const res = await postFiles('/api/memory/import', [{ name: 'notes.txt', content: 'one\n\ntwo' }]);
    assert.equal(res.status, 403);
    assert.equal(res.body.error?.code, 'capability_disabled');
  });

  test('a batch of only-invalid files answers 200 with per-file reasons, without touching the backend', async () => {
    // The backend is down in this sandbox (no Ollama), which is exactly what
    // makes this case meaningful: any backend touch would surface as a
    // storage_error, so a 200 proves invalid files short-circuit before it.
    const { setMemoryEnabled } = await import('../src/services/memory/index.ts');
    setMemoryEnabled(true);
    try {
      const res = await postFiles('/api/memory/import', [
        { name: 'photo.png', content: new Uint8Array([137, 80, 78, 71, 0, 13]) },
        { name: 'huge.txt', content: 'x'.repeat(MEMORY_IMPORT_MAX_CHARS + 1) },
        { name: 'empty.txt', content: '   \n  ' },
      ]);
      assert.equal(res.status, 200);
      assert.equal(res.body.imported, 0);
      assert.equal(res.body.files?.length, 3);
      assert.match(res.body.files?.[0]?.error ?? '', /not text/);
      assert.match(res.body.files?.[1]?.error ?? '', /at most 20000/);
      assert.equal(res.body.files?.[2]?.error, null);
      assert.deepEqual(
        res.body.files?.map((file) => file.name),
        ['photo.png', 'huge.txt', 'empty.txt'],
      );
    } finally {
      setMemoryEnabled(false);
    }
  });

  test('more files than the batch cap is refused before anything is read', async () => {
    const { setMemoryEnabled } = await import('../src/services/memory/index.ts');
    setMemoryEnabled(true);
    try {
      const files = Array.from({ length: MEMORY_IMPORT_MAX_FILES + 1 }, (_, index) => ({
        name: `note-${index}.txt`,
        content: 'a fact',
      }));
      const res = await postFiles('/api/memory/import', files);
      assert.equal(res.status, 400);
      assert.equal(res.body.error?.code, 'bad_request');
      assert.match(res.body.error?.message ?? '', /50/);
      assert.equal(res.body.error?.details?.count, MEMORY_IMPORT_MAX_FILES + 1);
    } finally {
      setMemoryEnabled(false);
    }
  });

  test('text and files together are refused rather than half-stored', async () => {
    const { setMemoryEnabled } = await import('../src/services/memory/index.ts');
    setMemoryEnabled(true);
    try {
      const res = await postFiles(
        '/api/memory/import',
        [{ name: 'notes.txt', content: 'one\n\ntwo' }],
        { text: 'one\n\ntwo' },
      );
      assert.equal(res.status, 400);
      assert.equal(res.body.error?.code, 'bad_request');
      assert.match(res.body.error?.message ?? '', /either text or files/);
    } finally {
      setMemoryEnabled(false);
    }
  });

  test('a multipart body with no files says so instead of complaining about text', async () => {
    const { setMemoryEnabled } = await import('../src/services/memory/index.ts');
    setMemoryEnabled(true);
    try {
      const res = await postFiles('/api/memory/import', []);
      assert.equal(res.status, 400);
      assert.equal(res.body.error?.code, 'bad_request');
      assert.match(res.body.error?.message ?? '', /No files were uploaded/);
    } finally {
      setMemoryEnabled(false);
    }
  });

  test('an over-long filename is a per-file error, not a refused batch', async () => {
    const { setMemoryEnabled } = await import('../src/services/memory/index.ts');
    setMemoryEnabled(true);
    try {
      const res = await postFiles('/api/memory/import', [
        { name: `${'n'.repeat(MEMORY_IMPORT_MAX_FILENAME_CHARS + 1)}.txt`, content: 'a fact' },
      ]);
      assert.equal(res.status, 200);
      assert.equal(res.body.imported, 0);
      assert.match(res.body.files?.[0]?.error ?? '', /255/);
    } finally {
      setMemoryEnabled(false);
    }
  });

  test('valid files against a dead backend report storage_error with the per-file breakdown attached', async () => {
    const { setMemoryEnabled } = await import('../src/services/memory/index.ts');
    setMemoryEnabled(true);
    try {
      const res = await postFiles('/api/memory/import', [{ name: 'notes.txt', content: 'one\n\ntwo' }]);
      assert.equal(res.status, 500);
      assert.equal(res.body.error?.code, 'storage_error');
      assert.equal(res.body.error?.details?.found, 2);
      const files = res.body.error?.details?.files as FileResult[] | undefined;
      assert.equal(files?.length, 1);
      assert.equal(files?.[0]?.name, 'notes.txt');
      assert.equal(files?.[0]?.found, 2);
      assert.equal(files?.[0]?.dropped, 2);
    } finally {
      setMemoryEnabled(false);
    }
  });
});

describe('mem0 telemetry', () => {
  test('is off unless the environment explicitly opts in', async () => {
    // mem0's own default phones PostHog from inside `add()`; Hyperion's
    // local-first rule says nothing leaves the machine, so importing the
    // memory module defaults the variable to off. An explicit `true` in the
    // runner's environment survives (the line above only covers the unset
    // case), and that survival is itself the documented behaviour.
    await import('../src/services/memory/index.ts');
    assert.equal(process.env.MEM0_TELEMETRY, 'false');
  });
});

describe('import file chunking', () => {
  test('files share one chunk budget in upload order', () => {
    const first = Array.from({ length: 60 }, (_, index) => `first ${index + 1}`).join('\n\n');
    const second = Array.from({ length: 60 }, (_, index) => `second ${index + 1}`).join('\n\n');
    const { chunks, files } = chunkImportFiles(
      [
        { name: 'a.txt', text: first },
        { name: 'b.txt', text: second },
      ],
      { maxChunks: 100 },
    );
    assert.equal(chunks.length, 100);
    assert.equal(files[0]?.found, 60);
    assert.equal(files[0]?.dropped, 0);
    assert.equal(files[1]?.found, 60);
    assert.equal(files[1]?.dropped, 20);
    assert.equal(chunks[0]?.file, 0);
    assert.equal(chunks[59]?.file, 0);
    assert.equal(chunks[60]?.file, 1);
  });

  test('the character budget spans files too', () => {
    const { chunks, files } = chunkImportFiles(
      [
        { name: 'a.txt', text: 'aaaa\n\nbbbb' },
        { name: 'b.txt', text: 'cccc' },
      ],
      { maxChars: 10 },
    );
    assert.deepEqual(chunks.map((chunk) => chunk.text), ['aaaa', 'bbbb']);
    assert.equal(files[1]?.found, 1);
    assert.equal(files[1]?.dropped, 1);
  });

  test('empty files contribute a zero row, not an error', () => {
    const { chunks, files } = chunkImportFiles([
      { name: 'empty.txt', text: '  \n\n ' },
      { name: 'full.txt', text: 'a fact' },
    ]);
    assert.deepEqual(chunks, [{ file: 1, text: 'a fact' }]);
    assert.deepEqual(files[0], { name: 'empty.txt', found: 0, dropped: 0 });
  });
});
