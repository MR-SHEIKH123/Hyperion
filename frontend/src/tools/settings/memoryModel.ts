/**
 * The pure half of the Memory section (Settings 2.5, slice 3a). The two
 * numbers mirror `src/services/memory/index.ts` — the add bound and the
 * per-batch file cap live in the service, and a client that invented
 * looser ones would send writes the route refuses for reasons the user
 * only learns afterwards.
 */
export const MEMORY_MAX_CHARS = 4000;
export const MEMORY_IMPORT_MAX_FILES = 50;

export function validateMemoryText(text: string): string | null {
  if (text.trim().length === 0) return 'Write the memory first — an empty one stores nothing.';
  if (text.length > MEMORY_MAX_CHARS) return `At most ${MEMORY_MAX_CHARS} characters fit in one memory.`;
  return null;
}

export function formatMemoryDate(iso: string | null): string {
  if (iso === null) return 'date not recorded';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * The one sentence the section never lets the user misread, from
 * `docs/CONTRACTS.md` ("What mem0 does and does not do"): the store is
 * append-shaped from the user's side — no merging, no updating, no expiry.
 */
export const MEMORY_NO_MERGE_LINE =
  'Stored memories are not merged, updated, or expired automatically: a changed preference is stored beside the old one, near-duplicates persist, and nothing prunes this store but you — delete one, or delete all.';
