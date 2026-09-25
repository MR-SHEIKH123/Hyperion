/**
 * Long-term memory, backed by mem0 (`mem0ai/oss`) in fully self-hosted mode.
 *
 * Design rules this file exists to enforce:
 *
 *  1. **Off by default, and off means off.** The `plugins.memory.enabled`
 *     setting gates every entry point. When it is false there is no retrieval
 *     *and* no storage -- not even a deferred background write. A user who
 *     turns the toggle off gets a system that behaves as if this file were
 *     never imported.
 *
 *  2. **Never fatal.** Memory is an enhancement to a turn, not part of its
 *     contract. Every operation is wrapped so that a missing native binding, a
 *     stopped Ollama, or a corrupt vector file degrades to "no memories" rather
 *     than failing the user's message. `getMemory()` therefore caches its
 *     *failure* as well as its success: a broken install must not re-attempt a
 *     multi-second import on every single turn.
 *
 *  3. **Guarded dynamic import.** `mem0ai/oss` statically imports
 *     `better-sqlite3` at module scope, so merely *loading* the package can
 *     throw when the native binding was not built (npm's `allow-scripts` gate).
 *     That is why the import lives inside a try/catch and never at the top of
 *     this file.
 *
 *  4. **Local models only.** mem0's own `ollama` provider lazily requires the
 *     `ollama` npm peer, which is not installed. We instead point mem0's
 *     OpenAI-compatible provider (the `openai` package is one of mem0's hard
 *     dependencies) at Ollama's `/v1` shim with a dummy key. Same trick for the
 *     embedder. Nothing leaves the machine.
 *
 * Storage lives under `~/Hyperion/memory/` so it is covered by the same backup
 * and cleanup story as the rest of the app.
 */
import path from 'node:path';

import { env } from '../../config/env.ts';
import { isTemporaryChat } from '../../db/temporaryChats.ts';
import { MEMORY_PLUGIN_ID, isPluginAvailableTo } from '../plugins/availability.ts';
import { getBoolSetting, setSetting } from '../../db/settings.ts';
import type { ToolName } from '../../types/core.ts';
import { AppError } from '../../util/errors.ts';
import { createLogger } from '../../util/logger.ts';

// mem0 phones PostHog on every add/search unless told not to: its telemetry
// defaults on, and `add()` awaits the POST. Rule 4 above says nothing leaves
// the machine, so the default here is off. mem0 reads this variable at its own
// module load, which happens inside `getMemory()`'s dynamic import — long
// after this line runs, including in the MCP server child, which imports this
// module too. An explicit setting in the environment is respected either way.
process.env.MEM0_TELEMETRY ??= 'false';

const log = createLogger('memory');

/** Settings key for the Memory plugin toggle. Untyped KV, so no migration. */
export const MEMORY_ENABLED_KEY = 'plugins.memory.enabled';

/**
 * Single-user app, so every memory belongs to the same owner. mem0 still wants
 * an identity to scope adds/searches by, and hard-coding it keeps the stored
 * rows portable if a real multi-user notion ever appears.
 */
const USER_ID = 'local';

/**
 * The slice of mem0's `Memory` class we actually use, declared locally rather
 * than imported. Keeps this module type-checkable even though the real import
 * is dynamic and optional, and stops mem0's 2.5k-line ambient types from
 * becoming part of our compile surface.
 */
interface MemoryItem {
  id: string;
  memory: string;
  hash?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  score?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

interface SearchResult {
  results: MemoryItem[];
}

interface Mem0Message {
  role: string;
  content: string;
}

interface Mem0Client {
  add(messages: Mem0Message[], config: Record<string, unknown>): Promise<SearchResult>;
  search(query: string, config: Record<string, unknown>): Promise<SearchResult>;
  getAll(config: Record<string, unknown>): Promise<SearchResult>;
  delete(memoryId: string): Promise<{ message: string }>;
  deleteAll(config: Record<string, unknown>): Promise<{ message: string }>;
}

/** Public, frontend-facing view of a stored memory. */
export interface MemoryEntry {
  id: string;
  memory: string;
  createdAt: string | null;
  updatedAt: string | null;
  score: number | null;
  tool: string | null;
  chatId: string | null;
}

export interface MemoryStatus {
  /** The user-facing toggle. */
  enabled: boolean;
  /** Whether the mem0 backend actually loaded. False while disabled. */
  available: boolean;
  /** Why the backend is unavailable, when it is. */
  error: string | null;
  llmModel: string;
  embedModel: string;
  retrieveLimit: number;
  storeDir: string;
}

// --- toggle -----------------------------------------------------------------

/** Is the Memory plugin on? Defaults to OFF: memory is opt-in. */
export function memoryEnabled(): boolean {
  return getBoolSetting(MEMORY_ENABLED_KEY, false);
}

/** Flip the toggle. Turning it off does not delete anything already stored. */
export function setMemoryEnabled(on: boolean): void {
  setSetting(MEMORY_ENABLED_KEY, on);
  log.info(`memory plugin ${on ? 'enabled' : 'disabled'}`);
}

// --- lazy backend -----------------------------------------------------------

let client: Mem0Client | null = null;
let loadError: string | null = null;
let loading: Promise<Mem0Client | null> | null = null;

function memoryConfig(): Record<string, unknown> {
  // Ollama's OpenAI-compatible surface. The key is required by the SDK but
  // ignored by Ollama, hence the placeholder.
  const openAiCompatible = {
    apiKey: 'ollama',
    baseURL: `${env.ollamaUrl}/v1`,
  };

  return {
    llm: {
      provider: 'openai',
      config: { ...openAiCompatible, model: env.memoryLlmModel },
    },
    embedder: {
      provider: 'openai',
      config: {
        ...openAiCompatible,
        model: env.memoryEmbedModel,
        embeddingDims: env.memoryEmbedDims,
      },
    },
    vectorStore: {
      provider: 'memory',
      config: {
        collectionName: 'hyperion',
        dimension: env.memoryEmbedDims,
        dbPath: path.join(env.paths.memory, 'vectors.db'),
      },
    },
    historyStore: {
      provider: 'sqlite',
      config: { historyDbPath: path.join(env.paths.memory, 'history.db') },
    },
  };
}

/**
 * Resolve the mem0 client, constructing it at most once.
 *
 * Returns `null` -- never throws -- when the plugin is off or the backend
 * cannot load. A load failure is remembered so the expensive import is not
 * retried on every turn; restart the process after fixing the install.
 */
export async function getMemory(): Promise<Mem0Client | null> {
  if (!memoryEnabled()) return null;
  if (client) return client;
  if (loadError !== null) return null;
  if (loading) return loading;

  loading = (async (): Promise<Mem0Client | null> => {
    try {
      // Dynamic + guarded: `mem0ai/oss` pulls in better-sqlite3 at module
      // scope, so this import itself is a failure point.
      const mod = (await import('mem0ai/oss')) as unknown as {
        Memory: new (config?: unknown) => Mem0Client;
      };
      const instance = new mod.Memory(memoryConfig());
      client = instance;
      log.info('mem0 backend ready', {
        llm: env.memoryLlmModel,
        embedder: env.memoryEmbedModel,
        dir: env.paths.memory,
      });
      return instance;
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
      log.warn('mem0 backend unavailable; memory features are inert', error);
      return null;
    } finally {
      loading = null;
    }
  })();

  return loading;
}

/** Drop the cached client and any remembered failure. Used by tests. */
export function resetMemory(): void {
  client = null;
  loadError = null;
  loading = null;
}

// --- per-turn integration ---------------------------------------------------

function toEntry(item: MemoryItem): MemoryEntry {
  const meta = item.metadata ?? {};
  const tool = typeof meta.tool === 'string' ? meta.tool : null;
  const chatId = typeof meta.chatId === 'string' ? meta.chatId : null;
  return {
    id: item.id,
    memory: item.memory,
    createdAt: item.createdAt ?? null,
    updatedAt: item.updatedAt ?? null,
    score: typeof item.score === 'number' ? item.score : null,
    tool,
    chatId,
  };
}

/**
 * Retrieve the facts worth knowing for this turn and format them as a system
 * block, or `null` when there is nothing useful to add.
 *
 * Deliberately a *set*, not a dump: capped at `HYPERION_MEMORY_RETRIEVE_LIMIT`
 * so memory can never crowd out the actual conversation in a small local
 * model's context window.
 */
export async function recallForTurn(prompt: string, tool: ToolName): Promise<string | null> {
  if (!memoryEnabled()) return null;
  // The same per-tool decision the writer makes (1.34): a tool that may not use
  // Memory must not receive memories either, and the answer is a quiet `null` —
  // the caller has a prompt to build, not an error to render.
  if (!isPluginAvailableTo(MEMORY_PLUGIN_ID, tool)) return null;
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return null;

  try {
    const mem = await getMemory();
    if (!mem) return null;

    const found = await mem.search(trimmed, {
      topK: env.memoryRetrieveLimit,
      filters: { user_id: USER_ID },
    });
    const facts = found.results
      .map((item) => item.memory?.trim())
      .filter((text): text is string => typeof text === 'string' && text.length > 0)
      .slice(0, env.memoryRetrieveLimit);

    if (facts.length === 0) return null;

    log.debug(`recalled ${facts.length} memories for ${tool}`);
    return [
      'Relevant facts remembered from earlier sessions with this user:',
      ...facts.map((fact) => `- ${fact}`),
      'Use them only when they apply to the current request. Do not mention this list.',
    ].join('\n');
  } catch (error) {
    log.warn('memory recall failed; continuing without it', error);
    return null;
  }
}

/**
 * Why a turn was or was not handed to the extractor. Returned rather than void so
 * the decision is observable — a caller cannot re-open the incognito hole by
 * ignoring a `void`.
 */
export type RememberOutcome = 'queued' | 'disabled' | 'temporary' | 'empty' | 'unavailable';

/**
 * Hand a completed exchange to mem0's extraction flow.
 *
 * Fire-and-forget on purpose: this is called after the assistant message is
 * already persisted and billed, so a slow or broken memory write must not
 * delay the `done` event or fail a turn that genuinely succeeded.
 *
 * **A temporary chat is refused here, in the writer.** Memory is a store the
 * storage layer's temporary-chat guard does not reach: `chats.ts` filters
 * temporary ids out of every write that goes through it, but a memory row is not
 * a chat row, so an incognito exchange was being extracted into facts on disk —
 * durable, retrievable, injected into later turns, and carrying the private
 * chat's id as metadata. That is the failure `temporaryChats.ts` warns about,
 * where "the one that forgot would persist the transcript with no visible
 * symptom": incognito was promised, and the promise held for the transcript while
 * this path quietly kept the substance.
 *
 * Recall is deliberately *not* skipped — reading memories into an incognito turn
 * records nothing new, and the promise is about what is written. Spending is not
 * skipped either; `usage_log` takes an anonymous row, which is the one write
 * whose absence would be a bypass.
 */
export function rememberTurn(
  prompt: string,
  reply: string,
  meta: { tool: ToolName; chatId: string },
): RememberOutcome {
  if (!memoryEnabled()) return 'disabled';
  // Per-tool availability (1.34). Distinct from the plugin switch above because
  // the user's sentence is different: the plugin is on, this tool may not use it.
  if (!isPluginAvailableTo(MEMORY_PLUGIN_ID, meta.tool)) return 'unavailable';
  // Before the emptiness check and before `getMemory()`: nothing about a private
  // conversation — not even the id it was asked to store as metadata — may reach
  // the extractor, and loading the backend for a turn that will be discarded
  // would itself be work the user did not ask for.
  if (isTemporaryChat(meta.chatId)) return 'temporary';
  const userText = prompt.trim();
  const assistantText = reply.trim();
  // Nothing meaningful was exchanged, so there is nothing to learn.
  if (userText.length === 0 || assistantText.length === 0) return 'empty';

  void (async () => {
    try {
      const mem = await getMemory();
      if (!mem) return;
      await mem.add(
        [
          { role: 'user', content: userText },
          { role: 'assistant', content: assistantText },
        ],
        { userId: USER_ID, metadata: { tool: meta.tool, chatId: meta.chatId } },
      );
      log.debug(`stored memories from ${meta.tool} turn`, { chatId: meta.chatId });
    } catch (error) {
      log.warn('memory write failed; turn is unaffected', error);
    }
  })();

  return 'queued';
}

// --- direct writes (Prompt 1, item 1.21) ------------------------------------

/**
 * The bounds on a pasted import, named here because they are the contract, not
 * an implementation detail: the route reports what it dropped rather than
 * silently keeping the first page of a long paste.
 *
 * Each chunk is a separate extraction pass through the local model, so the
 * limits are about the user's time as much as about storage. 100 chunks is
 * already a long wait; a paste larger than that is answered honestly — the
 * first 100 are imported and the response says how many were left out.
 */
export const MEMORY_IMPORT_MAX_CHUNKS = 100;
export const MEMORY_IMPORT_MAX_CHARS = 20_000;
/** One memory, added by hand. Long enough for a paragraph, bounded so a paste is not smuggled through it. */
export const MEMORY_MAX_CHARS = 4_000;

/**
 * The split both importers share: blank lines separate memories, single
 * newlines inside a paragraph are kept. Private because the *bounded* entry
 * points (`chunkImportText`, `chunkImportFiles`) are the contract — an
 * unbounded splitter handed out on its own would let a caller skip the bounds.
 */
function splitImportPieces(input: string): string[] {
  return input
    .split(/\n\s*\n+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}

/**
 * Split pasted text into the units that will be stored.
 *
 * Blank lines separate memories, which is what a pasted list or a set of notes
 * already looks like: one fact per line, or one per paragraph. Single newlines
 * inside a paragraph are kept — they are part of the text, and a memory that is
 * a short list is more useful stored whole than shredded into fragments.
 *
 * Pure and exported so the rule can be tested without a memory backend: the
 * whole point of the bounds is that they are checkable without one.
 *
 * The split itself lives in `splitImportPieces`, shared with the multi-file
 * importer below: one rule for what counts as a memory, however the text
 * arrived.
 */
export function chunkImportText(
  input: string,
  options: { maxChunks?: number; maxChars?: number } = {},
): { chunks: string[]; dropped: number } {
  const maxChunks = options.maxChunks ?? MEMORY_IMPORT_MAX_CHUNKS;
  const maxChars = options.maxChars ?? MEMORY_IMPORT_MAX_CHARS;

  const pieces = splitImportPieces(input);

  const kept: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const piece of pieces) {
    const cost = piece.length + (kept.length > 0 ? 1 : 0);
    if (kept.length >= maxChunks || used + cost > maxChars) {
      dropped += 1;
      continue;
    }
    kept.push(piece);
    used += cost;
  }
  return { chunks: kept, dropped };
}

export type AddMemoryOutcome = 'stored' | 'disabled' | 'unavailable' | 'empty';

/**
 * Store one memory the user wrote themselves.
 *
 * Deliberately *not* the turn extractor's path: a fact the user typed is stored
 * as written rather than re-derived by the model from a conversation, because a
 * deliberate add that came back reworded (or not at all) would be a worse
 * answer than "nothing was stored". The extraction step is therefore the
 * backend's, not ours — the text goes in as a user message and mem0 decides what
 * to keep, which is the same contract the plugin already has.
 *
 * The temporary-chat guard is not needed here (there is no chat), and the
 * toggle is checked before the backend is loaded, so an add against a disabled
 * plugin costs nothing and says so.
 */
export async function addMemory(text: string): Promise<AddMemoryOutcome> {
  if (!memoryEnabled()) return 'disabled';
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'empty';
  const mem = await getMemory();
  if (!mem) return 'unavailable';
  try {
    await mem.add([{ role: 'user', content: trimmed }], {
      userId: USER_ID,
      metadata: { tool: 'settings', source: 'manual' },
    });
    log.debug('stored a manually added memory', { chars: trimmed.length });
    return 'stored';
  } catch (error) {
    log.warn('manual memory add failed', error);
    return 'unavailable';
  }
}

export interface ImportOutcome {
  /** Chunks the backend accepted. */
  imported: number;
  /** Chunks the bounds left out, or the backend refused. */
  dropped: number;
  /** Chunks the splitter found, before the bounds applied. */
  found: number;
  /** Set when the run stopped early because the backend went away. */
  error: string | null;
}

/**
 * Import pasted text as memories, chunk by chunk.
 *
 * Chunks are added **sequentially on purpose**. They are independent writes, but
 * mem0's extraction is a local-model round trip and firing 100 of them at once
 * against one Ollama instance queues them all anyway while making the failure
 * mode (which chunk failed?) unreadable. Sequential keeps the counts honest and
 * lets the loop stop at the first backend error — reporting what did land
 * instead of claiming the whole paste went in.
 */
export async function importMemories(
  input: string,
  options: { maxChunks?: number; maxChars?: number } = {},
): Promise<ImportOutcome> {
  if (!memoryEnabled()) return { imported: 0, dropped: 0, found: 0, error: 'disabled' };
  const { chunks, dropped } = chunkImportText(input, options);
  if (chunks.length === 0) return { imported: 0, dropped, found: 0, error: null };

  const mem = await getMemory();
  if (!mem) return { imported: 0, dropped, found: chunks.length, error: 'unavailable' };

  let imported = 0;
  for (const chunk of chunks) {
    try {
      await mem.add([{ role: 'user', content: chunk }], {
        userId: USER_ID,
        metadata: { tool: 'settings', source: 'import' },
      });
      imported += 1;
    } catch (error) {
      log.warn('memory import stopped early', error);
      return {
        imported,
        dropped: dropped + (chunks.length - imported),
        found: chunks.length,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  log.info(`imported ${imported} memories`, { dropped });
  return { imported, dropped, found: chunks.length, error: null };
}

/** More files than this in one import is a script, not an import (mirrors 1.28 profiles). */
export const MEMORY_IMPORT_MAX_FILES = 50;

/**
 * Filenames are echoed in results, never written to disk, so the only bound is
 * a reporting one: past this a name is truncated data, not an identifier.
 */
export const MEMORY_IMPORT_MAX_FILENAME_CHARS = 255;

export interface MemoryImportFile {
  name: string;
  buffer: Buffer;
}

export interface FileImportOutcome {
  /** The filename as uploaded, so the caller can match results to files. */
  name: string;
  imported: number;
  dropped: number;
  found: number;
  /** Human reason this file contributed nothing, or the backend error that stopped the run on it. */
  error: string | null;
}

export interface FilesImportOutcome extends ImportOutcome {
  files: FileImportOutcome[];
}

/**
 * Split each file's text into the units that will be stored, under one shared
 * budget.
 *
 * The 100-chunk / 20 000-character bounds exist to cap extraction cost per
 * import *run*, so a batch of files shares them in upload order rather than
 * each file getting its own hundred extractions. Pieces past the budget count
 * as dropped on their file — said out loud, like the single-text importer,
 * never silently truncated.
 *
 * Pure and exported for the same reason as `chunkImportText`: the bounds are
 * checkable without a backend.
 */
export function chunkImportFiles(
  files: readonly { name: string; text: string }[],
  options: { maxChunks?: number; maxChars?: number } = {},
): {
  chunks: { file: number; text: string }[];
  files: { name: string; found: number; dropped: number }[];
} {
  const maxChunks = options.maxChunks ?? MEMORY_IMPORT_MAX_CHUNKS;
  const maxChars = options.maxChars ?? MEMORY_IMPORT_MAX_CHARS;

  const chunks: { file: number; text: string }[] = [];
  const perFile: { name: string; found: number; dropped: number }[] = [];
  let used = 0;
  files.forEach((file, index) => {
    const pieces = splitImportPieces(file.text);
    let dropped = 0;
    for (const piece of pieces) {
      const cost = piece.length + (chunks.length > 0 ? 1 : 0);
      if (chunks.length >= maxChunks || used + cost > maxChars) {
        dropped += 1;
        continue;
      }
      chunks.push({ file: index, text: piece });
      used += cost;
    }
    perFile.push({ name: file.name, found: pieces.length, dropped });
  });
  return { chunks, files: perFile };
}

/**
 * Import uploaded files as memories: the folder half of the import route.
 *
 * Shape mirrors the 1.28 profile import deliberately — same 50-file batch cap
 * enforced here in the service as a 400 (a multer-level limit would surface as
 * a 500 asserting a server fault for a client error, the S17 lesson), same
 * per-file reporting, same policy-before-bytes order — because a folder picker
 * will POST here exactly the way it POSTs there.
 *
 * Per-file validity, in order: the name fits the reporting bound, the bytes
 * are text (a NUL byte means binary, the same test knowledge intake uses),
 * the decoded text fits one file's 20 000 characters. Anything else is a
 * per-file `error`, never a failed batch: one README must not refuse forty
 * notes. Files that pass share the single-text importer's chunk budget
 * (`chunkImportFiles`) and its write path — sequential `mem.add` calls with
 * identical metadata, stopping at the first backend error with the failed
 * chunk and everything after it counted as dropped. A batch with nothing
 * valid to store never loads the backend, so an all-invalid batch is a 200
 * with reasons rather than a storage error.
 */
export async function importMemoryFiles(
  files: readonly MemoryImportFile[],
  options: { maxChunks?: number; maxChars?: number } = {},
): Promise<FilesImportOutcome> {
  if (files.length > MEMORY_IMPORT_MAX_FILES) {
    throw new AppError(
      'bad_request',
      `At most ${MEMORY_IMPORT_MAX_FILES} files may be imported at once.`,
      { details: { field: 'files', count: files.length } },
    );
  }
  const outcomes: FileImportOutcome[] = files.map((file) => ({
    name: file.name,
    imported: 0,
    dropped: 0,
    found: 0,
    error: null,
  }));
  if (!memoryEnabled()) {
    return { imported: 0, dropped: 0, found: 0, error: 'disabled', files: outcomes };
  }

  const decoded: { name: string; text: string }[] = [];
  const order: number[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    if (file.name.length > MEMORY_IMPORT_MAX_FILENAME_CHARS) {
      outcomes[index]!.error =
        `The filename is ${file.name.length} characters; at most ${MEMORY_IMPORT_MAX_FILENAME_CHARS} fit in a result.`;
      continue;
    }
    if (file.buffer.includes(0)) {
      outcomes[index]!.error = 'The file is not text, so it contributed no memories.';
      continue;
    }
    const text = file.buffer.toString('utf8');
    if (text.length > MEMORY_IMPORT_MAX_CHARS) {
      outcomes[index]!.error =
        `The file is ${text.length} characters; one file holds at most ${MEMORY_IMPORT_MAX_CHARS}.`;
      continue;
    }
    decoded.push({ name: file.name, text });
    order.push(index);
  }

  const { chunks, files: budgeted } = chunkImportFiles(decoded, options);
  for (let position = 0; position < budgeted.length; position += 1) {
    const original = order[position]!;
    outcomes[original]!.found = budgeted[position]!.found;
    outcomes[original]!.dropped = budgeted[position]!.dropped;
  }
  const dropEveryKeptChunk = (): void => {
    for (const chunk of chunks) outcomes[order[chunk.file]!]!.dropped += 1;
  };
  const summed = (): ImportOutcome => ({
    imported: outcomes.reduce((total, outcome) => total + outcome.imported, 0),
    dropped: outcomes.reduce((total, outcome) => total + outcome.dropped, 0),
    found: outcomes.reduce((total, outcome) => total + outcome.found, 0),
    error: null,
  });

  if (chunks.length === 0) {
    return { ...summed(), files: outcomes };
  }

  const mem = await getMemory();
  if (!mem) {
    dropEveryKeptChunk();
    return { ...summed(), error: 'unavailable', files: outcomes };
  }

  let position = 0;
  for (const chunk of chunks) {
    const original = order[chunk.file]!;
    try {
      await mem.add([{ role: 'user', content: chunk.text }], {
        userId: USER_ID,
        metadata: { tool: 'settings', source: 'import' },
      });
      outcomes[original]!.imported += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('memory file import stopped early', error);
      for (let rest = position; rest < chunks.length; rest += 1) {
        outcomes[order[chunks[rest]!.file]!]!.dropped += 1;
      }
      outcomes[original]!.error = message;
      return { ...summed(), error: message, files: outcomes };
    }
    position += 1;
  }
  const result = summed();
  log.info(`imported ${result.imported} memories from ${files.length} files`, { dropped: result.dropped });
  return { ...result, files: outcomes };
}

// --- management surface (Settings UI) --------------------------------------

/**
 * List stored memories, optionally ranked against a query.
 *
 * Throws only if the backend is present but misbehaving; an absent backend
 * yields an empty list so Settings can still render.
 */
export async function listMemories(options: {
  query?: string | undefined;
  limit?: number | undefined;
}): Promise<MemoryEntry[]> {
  const mem = await getMemory();
  if (!mem) return [];

  const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 200) : 50;
  const query = options.query?.trim();

  const result = query
    ? await mem.search(query, { topK: limit, filters: { user_id: USER_ID } })
    : await mem.getAll({ topK: limit, filters: { user_id: USER_ID } });

  return result.results.slice(0, limit).map(toEntry);
}

/** Forget one fact. Returns false when the backend is unavailable. */
export async function deleteMemory(id: string): Promise<boolean> {
  const mem = await getMemory();
  if (!mem) return false;
  await mem.delete(id);
  log.info('deleted memory', { id });
  return true;
}

/** Forget everything for this user. Returns false when unavailable. */
export async function clearMemories(): Promise<boolean> {
  const mem = await getMemory();
  if (!mem) return false;
  await mem.deleteAll({ userId: USER_ID });
  log.info('cleared all memories');
  return true;
}

/**
 * Snapshot for the Settings panel. Never throws, and never *starts* the
 * backend: it only reports whether an already-attempted load succeeded, so
 * polling this endpoint while the toggle is off stays free.
 */
export function memoryStatus(): MemoryStatus {
  const enabled = memoryEnabled();
  return {
    enabled,
    available: enabled && client !== null,
    error: loadError,
    llmModel: env.memoryLlmModel,
    embedModel: env.memoryEmbedModel,
    retrieveLimit: env.memoryRetrieveLimit,
    storeDir: env.paths.memory,
  };
}
