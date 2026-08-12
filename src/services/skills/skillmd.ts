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
 * The parsing itself lives in `src/util/frontmatter.ts` — the same two
 * conventions describe the per-project files under `.hyperion/`, so the reader is
 * shared rather than reimplemented. What stays here is the part that is specific
 * to skills: which keys name a credential requirement, and the prose sniffing
 * that backs it up.
 */

import {
  clamp,
  firstString,
  parseMarkdownHead,
  parseSimpleYaml,
  splitFrontMatter,
} from '../../util/frontmatter.ts';

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
