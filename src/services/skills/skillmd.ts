/**
 * SKILL.md parsing.
 *
 * A skill declares its own identity, so the user should never have to retype it.
 * Two conventions are supported, in this order:
 *
 *   1. YAML front matter (the Anthropic Agent Skills convention):
 *
 *        ---
 *        name: pdf-filler
 *        description: Fills PDF forms from structured data.
 *        requires_credential: true
 *        ---
 *
 *   2. Plain Markdown, where the first `#` heading is the name and the first
 *      non-empty paragraph after it is the description.
 *
 * The YAML subset parsed here is deliberately tiny — scalars, quoted scalars,
 * inline `[a, b]` lists and simple `- item` blocks. A skill manifest is a handful
 * of flat keys; pulling in a full YAML parser to read them would add a dependency
 * (and a parser attack surface) for no benefit. Anything unrecognised is ignored
 * rather than treated as an error, because a skill that fails to parse should
 * still be installable with a manually typed name.
 */

export interface SkillManifest {
  name: string | null;
  description: string | null;
  /** True when the skill says it needs its own API key/token. */
  needsCredential: boolean;
  /** Why we think a credential is needed, for the UI to explain the prompt. */
  credentialHint: string | null;
  version: string | null;
  license: string | null;
  /** Every front-matter key we recognised, for display/debugging. */
  raw: Record<string, string | string[]>;
  /** Which convention produced the name/description. */
  source: 'frontmatter' | 'markdown' | 'none';
}

/** Front-matter keys that mean "this skill needs a credential". */
const CREDENTIAL_KEYS = [
  'requires_credential',
  'requirescredential',
  'needs_credential',
  'needscredential',
  'requires_token',
  'requires_api_key',
  'requires_key',
  'api_key_required',
  'credential',
  'credentials',
  'env',
  'required_env',
  'env_vars',
  'secrets',
];

/**
 * Phrases in the prose body that also imply a credential. Checked only when the
 * front matter is silent, and only as a *recommendation* — we surface it so the
 * frontend can prompt for a token, we never block on it.
 */
const CREDENTIAL_PROSE =
  /\b(api[ _-]?key|access[ _-]?token|bearer token|secret key|client secret|personal access token)\b/i;

const TRUTHY = new Set(['true', 'yes', 'y', '1', 'required', 'on']);

export function parseSkillMd(text: string): SkillManifest {
  const manifest: SkillManifest = {
    name: null,
    description: null,
    needsCredential: false,
    credentialHint: null,
    version: null,
    license: null,
    raw: {},
    source: 'none',
  };

  const { front, body } = splitFrontMatter(text);
  if (front) {
    manifest.raw = parseSimpleYaml(front);
    const name = firstString(manifest.raw, ['name', 'title', 'skill', 'id']);
    const description = firstString(manifest.raw, ['description', 'summary', 'about']);
    if (name) manifest.name = name;
    if (description) manifest.description = description;
    if (name || description) manifest.source = 'frontmatter';
    manifest.version = firstString(manifest.raw, ['version']) ?? null;
    manifest.license = firstString(manifest.raw, ['license']) ?? null;

    for (const key of CREDENTIAL_KEYS) {
      const value = manifest.raw[key];
      if (value === undefined) continue;
      const declared = Array.isArray(value)
        ? value.length > 0
        : TRUTHY.has(value.trim().toLowerCase()) || value.trim() !== '';
      if (!declared) continue;
      manifest.needsCredential = true;
      manifest.credentialHint = Array.isArray(value)
        ? `The skill declares "${key}": ${value.join(', ')}.`
        : `The skill declares "${key}: ${value}".`;
      break;
    }
  }

  // Fall back to the Markdown body for anything the front matter didn't give us.
  if (!manifest.name || !manifest.description) {
    const fromBody = parseMarkdownHead(body);
    if (!manifest.name && fromBody.name) {
      manifest.name = fromBody.name;
      manifest.source = manifest.source === 'frontmatter' ? 'frontmatter' : 'markdown';
    }
    if (!manifest.description && fromBody.description) {
      manifest.description = fromBody.description;
      if (manifest.source === 'none') manifest.source = 'markdown';
    }
  }

  if (!manifest.needsCredential) {
    const match = CREDENTIAL_PROSE.exec(body);
    if (match) {
      manifest.needsCredential = true;
      manifest.credentialHint =
        `The instructions mention "${match[0]}", so this skill probably needs its own credential.`;
    }
  }

  if (manifest.description) manifest.description = clamp(manifest.description, 500);
  if (manifest.name) manifest.name = clamp(manifest.name, 120);
  return manifest;
}

// --- front matter ----------------------------------------------------------

function splitFrontMatter(text: string): { front: string | null; body: string } {
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
function parseSimpleYaml(front: string): Record<string, string | string[]> {
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

function unquote(value: string): string {
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

function firstString(
  raw: Record<string, string | string[]>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

// --- markdown fallback -----------------------------------------------------

function parseMarkdownHead(body: string): { name: string | null; description: string | null } {
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

function stripInlineMarkup(value: string): string {
  return value
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}
