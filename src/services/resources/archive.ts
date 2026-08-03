/**
 * Shared URL-fetch and zip-extraction helpers used by both skill intake and
 * resource detection.
 *
 * Skill intake (`services/skills/intake.ts`) writes the extracted entries to
 * disk. Resource detection (`services/resources/detect.ts`) keeps them in
 * memory. Both call the same fetch + GitHub-rewrite + unzip logic here so the
 * two paths cannot drift apart.
 *
 * This module only fetches and unpacks. Deciding what the bytes *mean* is the
 * classifier's job in `detect.ts`, deliberately kept separate so it can be
 * tested against in-memory fixtures with no network.
 */
import AdmZip from 'adm-zip';

import { AppError } from '../../util/errors.ts';

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 2_000;

export interface ArchiveEntry {
  /** POSIX-style relative path, no leading slash. */
  name: string;
  /** Raw file bytes. */
  data: Buffer;
}

export interface FetchedArchive {
  /** Resolved URL that was actually fetched (after GitHub rewrite). */
  resolvedUrl: string;
  entries: ArchiveEntry[];
}

/**
 * Fetches a URL and returns its contents as a flat list of in-memory entries.
 *
 * - GitHub repo/tree links are rewritten to the codeload zip.
 * - A zip response is unpacked (GitHub wrapper directory stripped).
 * - A non-zip response is returned as a single entry named after the URL path,
 *   defaulting to `SKILL.md` so a raw gist of instructions is recognised.
 *
 * Throws `AppError('bad_request', ...)` for invalid URLs, unreachable hosts,
 * non-2xx responses, oversized archives, and unreadable zips.
 */
export async function fetchArchive(rawUrl: string): Promise<FetchedArchive> {
  const url = parseUrl(rawUrl);
  const target = githubArchiveUrl(url) ?? url;

  let response: Response;
  try {
    response = await fetch(target.href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Hyperion-resource-detect' },
    });
  } catch (error) {
    throw new AppError('bad_request', `Could not reach ${target.href}.`, { cause: error });
  }
  if (!response.ok) {
    throw new AppError('bad_request', `${target.href} returned HTTP ${response.status}.`);
  }

  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > MAX_ARCHIVE_BYTES) {
    throw new AppError(
      'bad_request',
      `Response is ${Math.round(data.length / 1024 / 1024)} MB, over the ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)} MB limit.`,
    );
  }

  const looksZip = data.subarray(0, 2).toString('latin1') === 'PK';
  if (!looksZip) {
    const base = pathBasename(target.pathname) || 'SKILL.md';
    const name = /\.[A-Za-z0-9]+$/.test(base) ? base : `${base}.md`;
    return { resolvedUrl: target.href, entries: [{ name, data }] };
  }

  return { resolvedUrl: target.href, entries: unzipEntries(data) };
}

/**
 * Validates and parses a URL string.
 * Throws `AppError('bad_request', ...)` for non-parseable or non-http(s) URLs.
 */
export function parseUrl(rawUrl: string): URL {
  const url = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError('bad_request', `"${rawUrl}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AppError('bad_request', 'Only http(s) URLs can be fetched.');
  }
  return parsed;
}

/** `github.com/o/r` and `github.com/o/r/tree/branch` → the codeload zip. */
export function githubArchiveUrl(url: URL): URL | null {
  if (url.hostname !== 'github.com') return null;
  const parts = url.pathname.split('/').filter((p) => p !== '');
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/, '');
  if (!owner || !repo) return null;
  if (parts[2] === 'archive') return null; // already an archive link
  const branch = parts[2] === 'tree' && parts[3] ? parts.slice(3).join('/') : 'HEAD';
  return new URL(`https://codeload.github.com/${owner}/${repo}/zip/${branch}`);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pathBasename(pathname: string): string {
  const parts = pathname.split('/').filter((p) => p !== '');
  return parts[parts.length - 1] ?? '';
}

/**
 * Unpacks a zip buffer into in-memory entries, stripping the GitHub wrapper
 * directory and refusing traversal paths.
 */
function unzipEntries(data: Buffer): ArchiveEntry[] {
  let zip: AdmZip;
  try {
    zip = new AdmZip(data);
  } catch (error) {
    throw new AppError('bad_request', 'The archive could not be read.', { cause: error });
  }

  const all = zip.getEntries();
  if (all.length > MAX_ARCHIVE_ENTRIES) {
    throw new AppError(
      'bad_request',
      `The archive has ${all.length} entries, more than the ${MAX_ARCHIVE_ENTRIES} allowed.`,
    );
  }

  const fileEntries = all.filter((e) => !e.isDirectory);
  const prefix = commonPrefix(fileEntries.map((e) => e.entryName));
  const out: ArchiveEntry[] = [];

  for (const entry of fileEntries) {
    let name = entry.entryName;
    if (prefix && name.startsWith(prefix)) name = name.slice(prefix.length);
    const safe = normalizePath(name);
    if (safe === null) continue;
    out.push({ name: safe, data: entry.getData() });
  }
  return out;
}

function commonPrefix(names: string[]): string | null {
  if (names.length === 0) return null;
  const first = names[0] ?? '';
  const slash = first.indexOf('/');
  if (slash === -1) return null;
  const candidate = first.slice(0, slash + 1);
  return names.every((n) => n.startsWith(candidate)) ? candidate : null;
}

function normalizePath(raw: string): string | null {
  const unified = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (unified === '' || unified.includes('\0')) return null;
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) return null;
  const segments: string[] = [];
  for (const seg of unified.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    segments.push(seg);
  }
  return segments.length > 0 ? segments.join('/') : null;
}
