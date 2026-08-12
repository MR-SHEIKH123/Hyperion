/**
 * Shared YAML front-matter and Markdown-head parsing.
 *
 * Several unrelated things in this project are "a Markdown file that describes
 * itself": SKILL.md manifests, and the per-project rule/agent/command files under
 * `.hyperion/`. They all follow the same two conventions, in this order:
 *
 *   1. YAML front matter:
 *
 *        ---
 *        name: pdf-filler
 *        description: Fills PDF forms from structured data.
 *        ---
 *
 *   2. Plain Markdown, where the first `#` heading is the name and the first
 *      non-empty paragraph after it is the description.
 *
 * The YAML subset parsed here is deliberately tiny — scalars, quoted scalars,
 * inline `[a, b]` lists and simple `- item` blocks. These manifests are a handful
 * of flat keys; pulling in a full YAML parser to read them would add a dependency
 * (and a parser attack surface) for no benefit. Anything unrecognised is ignored
 * rather than treated as an error, because a file that fails to parse should
 * still be usable — a skill stays installable with a manually typed name, and a
 * rules file still lists under its filename.
 *
 * Keys are lower-cased on the way in, so callers look up `'description'` and
 * match a file that wrote `Description:`.
 */

export function splitFrontMatter(text: string): { front: string | null; body: string } {
  // Tolerate a UTF-8 BOM and CRLF line endings.
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return { front: null, body: normalized };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { front: null, body: normalized };
  const front = normalized.slice(4, end);
  const afterMarker = normalized.indexOf('\n', end + 1);
  const body = afterMarker === -1 ? '' : normalized.slice(afterMarker + 1);
  return { front, body };
}

/** A minimal flat-YAML reader: `key: value`, `[a, b]`, and `- item` blocks. */
export function parseSimpleYaml(front: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const lines = front.split('\n');
  let currentKey: string | null = null;
  let currentList: string[] = [];

  const flush = (): void => {
    if (currentKey && currentList.length > 0) out[currentKey] = currentList;
    currentKey = null;
    currentList = [];
  };

  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentKey) {
      currentList.push(unquote(listItem[1] ?? ''));
      continue;
    }

    const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    flush();

    const key = (pair[1] ?? '').trim().toLowerCase();
    const value = (pair[2] ?? '').trim();
    if (value === '') {
      // Either an empty scalar or the header of a `- item` block; the next lines
      // decide which.
      currentKey = key;
      continue;
    }

    const inline = /^\[(.*)\]$/.exec(value);
    if (inline) {
      out[key] = (inline[1] ?? '')
        .split(',')
        .map((part) => unquote(part.trim()))
        .filter((part) => part !== '');
      continue;
    }

    out[key] = unquote(value);
  }
  flush();
  return out;
}

export function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  // Strip a trailing `# comment`, but not a `#` inside quotes (already handled).
  return trimmed.replace(/\s+#.*$/, '');
}

/** The first key in `keys` whose value is a non-empty scalar. */
export function firstString(
  raw: Record<string, string | string[]>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * The first key in `keys` holding a list, accepting a lone scalar as a
 * one-element list — front matter routinely writes `tools: bash` where the
 * schema allows `tools: [bash, read]`.
 */
export function stringList(
  raw: Record<string, string | string[]>,
  keys: string[],
): string[] | null {
  for (const key of keys) {
    const value = raw[key];
    if (Array.isArray(value)) {
      const items = value.map((item) => item.trim()).filter((item) => item !== '');
      if (items.length > 0) return items;
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') continue;
    // A comma-separated scalar is the other common shorthand for a list.
    const items = value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    if (items.length > 0) return items;
  }
  return null;
}

// --- markdown fallback -----------------------------------------------------

export function parseMarkdownHead(body: string): {
  name: string | null;
  description: string | null;
} {
  const lines = body.split('\n');
  let name: string | null = null;
  const paragraph: string[] = [];

  for (const line of lines) {
    const heading = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (heading && !name) {
      name = stripInlineMarkup(heading[1] ?? '');
      continue;
    }
    if (!name) continue;
    if (line.trim() === '') {
      if (paragraph.length > 0) break;
      continue;
    }
    // A second heading means the description paragraph was missing.
    if (/^#{1,6}\s+/.test(line)) break;
    paragraph.push(line.trim());
  }

  const description = paragraph.length > 0 ? stripInlineMarkup(paragraph.join(' ')) : null;
  return { name, description };
}

export function stripInlineMarkup(value: string): string {
  return value
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}
